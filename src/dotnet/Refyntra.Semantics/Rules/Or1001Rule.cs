using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.CodeAnalysis;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Frameworks.DependencyInjection;
using Refyntra.Workspaces;

namespace Refyntra.Semantics.Rules;

public sealed record RuleDiagnostic(
    string Id,
    string Message,
    Location Location,
    IReadOnlyList<EvidenceItem> Evidence,
    string Confidence,
    string Completeness,
    string CompositionRoot);

public sealed record RuleAbstention(string Reason, string Message, Location? Location, string? CompositionRoot);

public sealed record AnalysisModel(IReadOnlyList<RuleDiagnostic> Diagnostics, IReadOnlyList<RuleAbstention> Abstentions, string Completeness);

/// <summary>
/// OR1001 "scoped service captured by a singleton" (docs/rules/OR1001.md). A warning is produced only for a proven path
/// inside ONE composition root: singleton registration → the single public constructor of its implementation → a
/// parameter whose service is registered in the same root → … → a scoped registration. Anything that cannot be proven
/// (conditional, factory, open generic, keyed, IEnumerable, TryAdd, several constructors, a registration that may be
/// overridden, unresolved types, partial load) is an abstention, never a warning.
///
/// Incrementality: the unit of analysis is a connected component of composition roots (roots linked by calls that pass
/// the service collection). Its result is reused for a new snapshot only when every dependency is unchanged: the
/// documents of its registrations and calls, the documents declaring every type the proof looked at, the document sets
/// of the involved projects and the component's membership. Scope invalidation follows dependencies, not the edited file.
/// </summary>
public static class Or1001Rule
{
    public const string Id = "OR1001";
    public const int MaxDepth = 12;

    // ------------------------------------------------------------------ caches

    private sealed class ComponentEntry
    {
        public required string Fingerprint { get; init; }
        public required List<string> DependencyPaths { get; init; }
        public required HashSet<ProjectId> Projects { get; init; }
        public required List<RuleDiagnostic> Diagnostics { get; init; }
        public required List<RuleAbstention> Abstentions { get; init; }
    }

    private sealed class SessionCache
    {
        public readonly ConcurrentDictionary<string, ComponentEntry> Components = new(StringComparer.Ordinal);
        public long Computed;
        public long Reused;
    }

    private static readonly ConditionalWeakTable<WorkspaceSession, SessionCache> Sessions = new();
    private static readonly ConditionalWeakTable<Solution, Lazy<Task<AnalysisModel>>> Results = new();

    /// <summary>For tests and logs: how many components of this session were analysed, and how many results were reused.</summary>
    public static (long computed, long reused) Stats(WorkspaceSession session)
    {
        var c = Sessions.GetValue(session, _ => new SessionCache());
        return (Interlocked.Read(ref c.Computed), Interlocked.Read(ref c.Reused));
    }

    public static Task<AnalysisModel> RunAsync(Snapshot snapshot, CancellationToken ct)
    {
        var lazy = Results.GetValue(snapshot.Solution, _ => new Lazy<Task<AnalysisModel>>(() => Task.Run(() => ComputeAsync(snapshot, CancellationToken.None))));
        return lazy.Value.WaitAsync(ct);
    }

    private static async Task<AnalysisModel> ComputeAsync(Snapshot snapshot, CancellationToken ct)
    {
        var facts = (DependencyInjectionModule.Facts)await SemanticService.GetFactsAsync(snapshot, SemanticService.DependencyInjection, ct).ConfigureAwait(false);
        var completeness = SemanticService.Completeness(snapshot);
        var cache = Sessions.GetValue(snapshot.Session, _ => new SessionCache());
        var diagnostics = new List<RuleDiagnostic>();
        var abstentions = new List<RuleAbstention>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var component in Components(facts))
        {
            var key = string.Join("\n", component.OrderBy(r => r, StringComparer.Ordinal));
            seen.Add(key);
            if (cache.Components.TryGetValue(key, out var entry)
                && await FingerprintAsync(snapshot, key, entry.DependencyPaths, entry.Projects, ct).ConfigureAwait(false) == entry.Fingerprint)
            {
                Interlocked.Increment(ref cache.Reused);
                diagnostics.AddRange(await RelocateAsync(snapshot, entry.Diagnostics, ct).ConfigureAwait(false));
                abstentions.AddRange(await RelocateAsync(snapshot, entry.Abstentions, ct).ConfigureAwait(false));
                continue;
            }
            Interlocked.Increment(ref cache.Computed);
            var analysis = new ComponentAnalysis(snapshot, facts, component, completeness);
            analysis.Run(ct);
            var fp = await FingerprintAsync(snapshot, key, analysis.DependencyPaths.ToList(), analysis.Projects, ct).ConfigureAwait(false);
            cache.Components[key] = new ComponentEntry
            {
                Fingerprint = fp,
                DependencyPaths = analysis.DependencyPaths.ToList(),
                Projects = analysis.Projects,
                Diagnostics = analysis.Diagnostics,
                Abstentions = analysis.Abstentions,
            };
            diagnostics.AddRange(analysis.Diagnostics);
            abstentions.AddRange(analysis.Abstentions);
        }
        foreach (var stale in cache.Components.Keys.Where(k => !seen.Contains(k)).ToList()) cache.Components.TryRemove(stale, out _);

        static string SortPath(Location? l) => l?.SourceTree?.FilePath ?? "";
        return new AnalysisModel(
            diagnostics.OrderBy(d => SortPath(d.Location), StringComparer.Ordinal).ThenBy(d => d.Location.SourceSpan.Start).ToList(),
            abstentions.OrderBy(a => SortPath(a.Location), StringComparer.Ordinal).ThenBy(a => a.Location?.SourceSpan.Start ?? 0).ThenBy(a => a.Reason, StringComparer.Ordinal).ToList(),
            completeness);
    }

    /// <summary>
    /// A reused result was computed on an older solution: its locations point into older syntax trees. The dependency
    /// documents are textually identical (that is what the fingerprint proves), so the same spans are re-created on the
    /// current trees of the same files.
    /// </summary>
    private static async Task<List<RuleDiagnostic>> RelocateAsync(Snapshot snapshot, List<RuleDiagnostic> items, CancellationToken ct)
    {
        var result = new List<RuleDiagnostic>();
        foreach (var d in items)
        {
            var evidence = new List<EvidenceItem>();
            foreach (var e in d.Evidence) evidence.Add(e with { Location = await RelocateAsync(snapshot, e.Location, ct).ConfigureAwait(false) });
            result.Add(d with { Location = (await RelocateAsync(snapshot, d.Location, ct).ConfigureAwait(false))!, Evidence = evidence });
        }
        return result;
    }

    private static async Task<List<RuleAbstention>> RelocateAsync(Snapshot snapshot, List<RuleAbstention> items, CancellationToken ct)
    {
        var result = new List<RuleAbstention>();
        foreach (var a in items) result.Add(a with { Location = await RelocateAsync(snapshot, a.Location, ct).ConfigureAwait(false) });
        return result;
    }

    private static async Task<Location?> RelocateAsync(Snapshot snapshot, Location? location, CancellationToken ct)
    {
        if (location?.SourceTree?.FilePath is not { Length: > 0 } path) return location;
        foreach (var id in snapshot.Session.DocumentIdsForPath(path))
        {
            var doc = snapshot.Solution.GetDocument(id);
            if (doc == null) continue;
            var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
            if (tree != null) return Location.Create(tree, location.SourceSpan);
        }
        return location;
    }

    private static async Task<string> FingerprintAsync(Snapshot snapshot, string componentKey, List<string> paths, HashSet<ProjectId> projects, CancellationToken ct)
    {
        var sb = new StringBuilder(componentKey).Append('\n');
        foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            sb.Append(path).Append('=');
            foreach (var id in snapshot.Session.DocumentIdsForPath(path))
            {
                var doc = snapshot.Solution.GetDocument(id);
                if (doc == null) continue;
                var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                sb.Append(Convert.ToHexString(text.GetChecksum().AsSpan())).Append(';');
            }
            sb.Append('\n');
        }
        foreach (var pid in projects.OrderBy(p => p.Id))
        {
            var project = snapshot.Solution.GetProject(pid);
            var state = snapshot.Session.ContextFor(pid)?.State ?? "absent";
            sb.Append("project ").Append(project?.FilePath ?? pid.Id.ToString()).Append(' ').Append(state).Append(':');
            if (project != null)
                foreach (var d in project.Documents.Select(d => d.FilePath ?? d.Name).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
                    sb.Append(d).Append('|');
            sb.Append('\n');
        }
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())));
    }

    /// <summary>Weakly connected components of composition roots (edges: calls that pass the service collection).</summary>
    private static List<List<string>> Components(DependencyInjectionModule.Facts facts)
    {
        var roots = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in facts.Registrations.Where(Checked)) roots.Add(r.CompositionRoot);
        var adj = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        void Edge(string a, string b)
        {
            if (!adj.TryGetValue(a, out var s)) adj[a] = s = new HashSet<string>(StringComparer.Ordinal);
            s.Add(b);
        }
        foreach (var c in facts.CollectionCalls)
        {
            if (c.CalleeRoot == null || c.CalleeRoot == c.CallerRoot) continue;
            roots.Add(c.CallerRoot);
            roots.Add(c.CalleeRoot);
            Edge(c.CallerRoot, c.CalleeRoot);
            Edge(c.CalleeRoot, c.CallerRoot);
        }
        var result = new List<List<string>>();
        var done = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in roots.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!done.Add(r)) continue;
            var comp = new List<string> { r };
            var queue = new Queue<string>();
            queue.Enqueue(r);
            while (queue.Count > 0)
            {
                var x = queue.Dequeue();
                if (!adj.TryGetValue(x, out var next)) continue;
                foreach (var n in next)
                    if (done.Add(n)) { comp.Add(n); queue.Enqueue(n); }
            }
            // A component without any singleton registration cannot produce a result.
            if (facts.Registrations.Where(Checked).Any(g => g.Lifetime == "singleton" && comp.Contains(g.CompositionRoot)))
                result.Add(comp);
        }
        return result;
    }

    // ------------------------------------------------------------------ type identity

    /// <summary>Identity of a service type: full metadata name, type arguments and declaring assembly.</summary>
    public static string TypeKey(ITypeSymbol t)
    {
        switch (t)
        {
            case INamedTypeSymbol n:
            {
                var def = n.OriginalDefinition;
                var name = SymbolIdentity.FullMetadataName(def);
                var args = n.IsUnboundGenericType ? "<>"
                    : n.TypeArguments.Length > 0 && !SymbolEqualityComparer.Default.Equals(n, def)
                        ? "<" + string.Join(",", n.TypeArguments.Select(TypeKey)) + ">" : "";
                return name + args + "|" + def.ContainingAssembly?.Identity.Name;
            }
            case IArrayTypeSymbol a:
                return TypeKey(a.ElementType) + "[]";
            default:
                return t.ToDisplayString();
        }
    }

    private static string DefinitionKey(INamedTypeSymbol n) =>
        SymbolIdentity.FullMetadataName(n.OriginalDefinition) + "<>|" + n.OriginalDefinition.ContainingAssembly?.Identity.Name;

    /// <summary>
    /// Keyed registrations never satisfy a non-keyed constructor parameter and keyed singletons are not followed
    /// (a [FromKeyedServices] parameter abstains with KeyedService), so OR1001 does not look at them at all.
    /// </summary>
    private static bool Checked(DiRegistrationFact r) => !r.Has(DiTraits.Keyed);

    private static readonly string[] BuiltInServices =
    {
        "System.IServiceProvider", "Microsoft.Extensions.DependencyInjection.IServiceScopeFactory",
        "Microsoft.Extensions.DependencyInjection.IServiceProviderIsService", "Microsoft.Extensions.DependencyInjection.IServiceProviderIsKeyedService",
        "Microsoft.Extensions.DependencyInjection.IKeyedServiceProvider",
    };

    private static readonly KnownType FromKeyedServices = new("Microsoft.Extensions.DependencyInjection.FromKeyedServicesAttribute", "Microsoft.Extensions.DependencyInjection.Abstractions");
    private static readonly KnownType EnumerableOfT = new("System.Collections.Generic.IEnumerable`1", "System.Runtime", "System.Private.CoreLib", "mscorlib", "netstandard");

    private static string Show(ITypeSymbol? t) => t?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "?";

    // ------------------------------------------------------------------ one component

    private sealed class ComponentAnalysis
    {
        private readonly Snapshot _snapshot;
        private readonly DependencyInjectionModule.Facts _facts;
        private readonly HashSet<string> _roots;
        private readonly string _completeness;
        private readonly Dictionary<string, List<DiRegistrationFact>> _byServiceInComponent = new(StringComparer.Ordinal);
        private readonly HashSet<string> _openGenericDefinitions = new(StringComparer.Ordinal);
        private readonly HashSet<string> _registeredOutside = new(StringComparer.Ordinal);

        public List<RuleDiagnostic> Diagnostics { get; } = new();
        public List<RuleAbstention> Abstentions { get; } = new();
        public HashSet<string> DependencyPaths { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<ProjectId> Projects { get; } = new();

        public ComponentAnalysis(Snapshot snapshot, DependencyInjectionModule.Facts facts, List<string> roots, string completeness)
        {
            _snapshot = snapshot;
            _facts = facts;
            _roots = new HashSet<string>(roots, StringComparer.Ordinal);
            _completeness = completeness;
            foreach (var r in facts.Registrations.Where(Checked))
            {
                var key = TypeKey(r.ServiceType);
                if (!_roots.Contains(r.CompositionRoot))
                {
                    _registeredOutside.Add(key);
                    continue;
                }
                if (!_byServiceInComponent.TryGetValue(key, out var list)) _byServiceInComponent[key] = list = new List<DiRegistrationFact>();
                list.Add(r);
                if (r.Has(DiTraits.OpenGeneric)) _openGenericDefinitions.Add(key);
                AddDependency(r.Location);
                Projects.Add(r.ProjectId);
            }
            foreach (var c in facts.CollectionCalls.Where(c => _roots.Contains(c.CallerRoot)))
            {
                AddDependency(c.Location);
                Projects.Add(c.ProjectId);
            }
        }

        private void AddDependency(Location? l)
        {
            if (l?.SourceTree?.FilePath is { Length: > 0 } p) DependencyPaths.Add(p);
        }

        private void AddTypeDependency(ITypeSymbol? t)
        {
            if (t == null) return;
            foreach (var r in t.OriginalDefinition.DeclaringSyntaxReferences) if (r.SyntaxTree.FilePath is { Length: > 0 } p) DependencyPaths.Add(p);
            if (t is INamedTypeSymbol n) foreach (var a in n.TypeArguments) if (a is not ITypeParameterSymbol) AddTypeDependency(a);
        }

        private string? PartialLoadReason(ProjectId projectId)
        {
            var solution = _snapshot.Solution;
            var stack = new Stack<ProjectId>();
            var seen = new HashSet<ProjectId>();
            stack.Push(projectId);
            while (stack.Count > 0)
            {
                var id = stack.Pop();
                if (!seen.Add(id)) continue;
                var ctx = _snapshot.Session.ContextFor(id);
                if (ctx == null || ctx.State != ProjectStates.Loaded)
                    return $"project {ctx?.Name ?? solution.GetProject(id)?.Name ?? "?"} is not completely loaded";
                var p = solution.GetProject(id);
                if (p == null) continue;
                foreach (var r in p.ProjectReferences) stack.Push(r.ProjectId);
            }
            return null;
        }

        private sealed record Resolution(DiRegistrationFact? Registration, string? Reason, string? Detail);

        /// <summary>The registration DI uses for a service in this root, or why it is not proven.</summary>
        private Resolution Resolve(ITypeSymbol service, string root)
        {
            AddTypeDependency(service);
            var key = TypeKey(service);
            if (!_byServiceInComponent.TryGetValue(key, out var all) || all.Count == 0)
            {
                if (service is INamedTypeSymbol { IsGenericType: true } g && _openGenericDefinitions.Contains(DefinitionKey(g)))
                    return new Resolution(null, "OpenGeneric", $"'{Show(service)}' is provided by an open generic registration (not followed)");
                if (_registeredOutside.Contains(key))
                    return new Resolution(null, "RegisteredInAnotherRoot", $"'{Show(service)}' is registered only in another, unconnected composition root");
                return service.Locations.Any(l => l.IsInSource)
                    ? new Resolution(null, "UnregisteredService", $"'{service.ToDisplayString()}' has no registration in this composition root")
                    : new Resolution(null, "FrameworkService", $"'{Show(service)}' is not registered in source (framework or library service; lifetime not modelled)");
            }
            var inRoot = all.Where(r => r.CompositionRoot == root).ToList();
            if (inRoot.Count == 0)
                return new Resolution(null, "RegisteredInAnotherRoot", $"'{Show(service)}' is registered in {all[0].CompositionRoot}, not in {root}; OR1001 proves paths inside one composition root");
            var first = inRoot[0];
            bool Plain(DiRegistrationFact r) => !r.Has(DiTraits.Factory) && !r.Has(DiTraits.Instance) && !r.Has(DiTraits.OpenGeneric) && r.ImplementationType != null;
            bool Equivalent(DiRegistrationFact r) => Plain(r) && r.Lifetime == first.Lifetime
                && r.ImplementationType != null && first.ImplementationType != null && TypeKey(r.ImplementationType) == TypeKey(first.ImplementationType);
            var definite = inRoot.Where(r => Plain(r) && !r.Has(DiTraits.Conditional) && !r.Has(DiTraits.TryAdd)).ToList();
            if (Plain(first) && all.All(Equivalent) && definite.Count > 0) return new Resolution(definite[^1], null, null);
            if (inRoot.Any(r => r.Has(DiTraits.Factory)))
                return new Resolution(null, "FactoryRegistration", $"'{Show(service)}' is registered with a factory ({inRoot.First(r => r.Has(DiTraits.Factory)).Form})");
            if (inRoot.Any(r => r.Has(DiTraits.Instance)))
                return new Resolution(null, "InstanceRegistration", $"'{Show(service)}' is registered with an instance");
            if (inRoot.Any(r => r.Has(DiTraits.Conditional)))
                return new Resolution(null, "ConditionalRegistration", $"the registration of '{Show(service)}' is conditional ({inRoot.First(r => r.Has(DiTraits.Conditional)).Form})");
            if (inRoot.Any(r => r.Has(DiTraits.TryAdd)))
                return new Resolution(null, "TryAdd", $"'{Show(service)}' is registered with TryAdd; an earlier registration may win");
            if (inRoot.Count > 1)
                return new Resolution(null, "MultipleRegistrations", $"'{Show(service)}' is registered {inRoot.Count} times with different lifetimes or implementations");
            var other = all.First(r => r.CompositionRoot != root);
            return new Resolution(null, "MayBeOverridden", $"'{Show(service)}' is registered differently in {other.CompositionRoot} ({other.Form}), which runs with this root; the last registration wins");
        }

        private sealed record Step(DiRegistrationFact Registration, IParameterSymbol? Parameter, Step? Previous);

        public void Run(CancellationToken ct)
        {
            var starts = _facts.Registrations.Where(Checked)
                .Where(r => _roots.Contains(r.CompositionRoot) && r.Lifetime == "singleton")
                .Where(r => !r.Has(DiTraits.FrameworkExtension) || r.Form.StartsWith("AddHostedService", StringComparison.Ordinal))
                .OrderBy(r => r.Location.SourceTree?.FilePath, StringComparer.Ordinal).ThenBy(r => r.Location.SourceSpan.Start)
                .ToList();
            foreach (var start in starts)
            {
                ct.ThrowIfCancellationRequested();
                Analyze(start);
            }
        }

        private string Subject(DiRegistrationFact r) =>
            r.ImplementationType != null && TypeKey(r.ImplementationType) != TypeKey(r.ServiceType)
                ? $"singleton '{Show(r.ServiceType)}' (implementation '{Show(r.ImplementationType)}')"
                : $"singleton '{Show(r.ServiceType)}'";

        private void Abstain(DiRegistrationFact start, string reason, string detail) =>
            Abstentions.Add(new RuleAbstention(reason, $"OR1001 not proven for {Subject(start)} in {start.CompositionRoot}: {detail}.", start.Location, start.CompositionRoot));

        private void Analyze(DiRegistrationFact start)
        {
            var root = start.CompositionRoot;
            if (_facts.RootsWithUnresolvedCalls.Overlaps(_roots))
            {
                var bad = _facts.CollectionCalls.First(c => _roots.Contains(c.CallerRoot) && c.CalleeRoot == null && _facts.RootsWithUnresolvedCalls.Contains(c.CallerRoot));
                Abstain(start, "UnresolvedRegistrationCall", $"{bad.CallerRoot} passes the service collection to {bad.Method}, whose registrations cannot be resolved");
                return;
            }
            if (PartialLoadReason(start.ProjectId) is { } partial)
            {
                Abstain(start, "PartialLoad", partial);
                return;
            }
            if (start.Has(DiTraits.Factory)) { Abstain(start, "FactoryRegistration", $"the singleton is created by a factory ({start.Form})"); return; }
            if (start.Has(DiTraits.Instance)) { Abstain(start, "InstanceRegistration", "the singleton is a supplied instance"); return; }
            if (start.Has(DiTraits.OpenGeneric) || start.ImplementationType == null) { Abstain(start, "OpenGeneric", "open generic singleton registrations are not followed"); return; }

            var blocked = new List<(string reason, string detail)>();
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var queue = new Queue<(Step step, int depth)>();
            queue.Enqueue((new Step(start, null, null), 0));
            Step? found = null;
            while (queue.Count > 0 && found == null)
            {
                var (step, depth) = queue.Dequeue();
                var impl = step.Registration.ImplementationType!;
                AddTypeDependency(impl);
                if (!visited.Add(TypeKey(impl))) continue;
                if (depth >= MaxDepth) { blocked.Add(("DepthLimit", $"the dependency chain is longer than {MaxDepth}")); continue; }
                if (impl is not INamedTypeSymbol { TypeKind: TypeKind.Class, IsAbstract: false, IsStatic: false } cls || impl.TypeKind == TypeKind.Error)
                {
                    blocked.Add((impl.TypeKind == TypeKind.Error ? "UnresolvedType" : "NotConstructible", $"'{Show(impl)}' is not a constructible class"));
                    continue;
                }
                var ctors = cls.InstanceConstructors.Where(c => c.DeclaredAccessibility == Accessibility.Public).ToList();
                if (ctors.Count == 0) { blocked.Add(("NoPublicConstructor", $"'{Show(impl)}' has no public constructor")); continue; }
                if (ctors.Count > 1) { blocked.Add(("MultipleConstructors", $"'{Show(impl)}' has {ctors.Count} public constructors (constructor selection is not modelled)")); continue; }
                foreach (var p in ctors[0].Parameters)
                {
                    var t = p.Type;
                    if (p.GetAttributes().Any(a => FromKeyedServices.Matches(a.AttributeClass)))
                    {
                        blocked.Add(("KeyedService", $"parameter '{p.Name}' of {Show(impl)} is a keyed service (not followed)"));
                        continue;
                    }
                    if (t is INamedTypeSymbol nt && EnumerableOfT.Matches(nt))
                    {
                        blocked.Add(("EnumerableService", $"parameter '{p.Name}' of {Show(impl)} is IEnumerable<{Show(nt.TypeArguments[0])}> (not followed in this version)"));
                        continue;
                    }
                    if (t is INamedTypeSymbol bt && BuiltInServices.Contains(SymbolIdentity.FullMetadataName(bt.OriginalDefinition))) continue;
                    if (t.TypeKind == TypeKind.Error) { blocked.Add(("UnresolvedType", $"parameter '{p.Name}' of {Show(impl)} has an unresolved type")); continue; }
                    var res = Resolve(t, root);
                    if (res.Registration == null)
                    {
                        if (p.HasExplicitDefaultValue && res.Reason is "UnregisteredService" or "FrameworkService" or "RegisteredInAnotherRoot") continue;
                        blocked.Add((res.Reason!, res.Detail!));
                        continue;
                    }
                    var reg = res.Registration;
                    var next = new Step(reg, p, step);
                    switch (reg.Lifetime)
                    {
                        case "scoped":
                            found = next;
                            break;
                        case "singleton":
                            break; // reported for that singleton itself
                        case "transient":
                            if (reg.Has(DiTraits.FrameworkExtension)) blocked.Add(("FrameworkRegistration", $"'{Show(reg.ServiceType)}' is registered by {reg.Form} (its activation is not modelled)"));
                            else queue.Enqueue((next, depth + 1));
                            break;
                        default:
                            blocked.Add(("UnknownLifetime", $"the lifetime of '{Show(reg.ServiceType)}' is not a constant ({reg.Form})"));
                            break;
                    }
                    if (found != null) break;
                }
            }

            if (found == null)
            {
                if (blocked.Count > 0)
                {
                    var (reason, detail) = blocked[0];
                    var more = blocked.Count > 1 ? $" (and {blocked.Count - 1} more: {string.Join(", ", blocked.Skip(1).Select(b => b.reason).Distinct())})" : "";
                    Abstain(start, reason, detail + more);
                }
                return;
            }
            // A proven path: the singleton registration itself must be certain too.
            if (start.Has(DiTraits.Conditional)) { Abstain(start, "ConditionalRegistration", $"a scoped dependency is reachable, but the singleton registration is conditional ({start.Form})"); return; }
            if (start.Has(DiTraits.TryAdd)) { Abstain(start, "TryAdd", "a scoped dependency is reachable, but the singleton is registered with TryAdd and an earlier registration may win"); return; }
            var startResolution = Resolve(start.ServiceType, root);
            if (startResolution.Registration == null && startResolution.Reason is not ("UnregisteredService" or "FrameworkService"))
            {
                Abstain(start, startResolution.Reason!, "a scoped dependency is reachable, but " + startResolution.Detail);
                return;
            }
            Diagnostics.Add(Build(start, found));
        }

        private RuleDiagnostic Build(DiRegistrationFact start, Step last)
        {
            var steps = new List<Step>();
            for (var s = last; s != null; s = s.Previous) steps.Insert(0, s);
            var evidence = new List<EvidenceItem>
            {
                new($"Singleton registration {start.Form} in {start.CompositionRoot}", start.Location),
            };
            var via = new List<string>();
            for (var i = 1; i < steps.Count; i++)
            {
                var prevImpl = steps[i - 1].Registration.ImplementationType!;
                var p = steps[i].Parameter!;
                var ctor = (IMethodSymbol)p.ContainingSymbol;
                var signature = $"{prevImpl.Name}({string.Join(", ", ctor.Parameters.Select(x => Show(x.Type) + " " + x.Name))})";
                via.Add($"{prevImpl.Name}({Show(p.Type)} {p.Name})");
                evidence.Add(new($"Constructor parameter '{p.Name}' of {signature} requires '{Show(p.Type)}'", p.Locations.FirstOrDefault(l => l.IsInSource)));
                var reg = steps[i].Registration;
                evidence.Add(new($"{Capitalize(reg.Lifetime)} registration {reg.Form} in {reg.CompositionRoot}", reg.Location));
            }
            var scoped = steps[^1].Registration;
            var message = $"{Capitalize(Subject(start))} captures scoped '{Show(scoped.ServiceType)}' via {string.Join(" → ", via)} in {start.CompositionRoot}. " +
                          "The scoped instance then lives as long as the singleton.";
            return new RuleDiagnostic(Id, message, start.Location, evidence, Confidences.Proven, _completeness, start.CompositionRoot);
        }

        private static string Capitalize(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
    }
}
