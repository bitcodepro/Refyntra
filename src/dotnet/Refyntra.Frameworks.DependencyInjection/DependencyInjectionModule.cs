using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.DependencyInjection;

/// <summary>
/// Explicit Microsoft.Extensions.DependencyInjection registrations: AddSingleton/AddScoped/AddTransient and TryAdd*
/// in generic and typeof forms. The composition root is the method containing the call; different roots are never merged.
/// </summary>
public sealed class DependencyInjectionModule : IFrameworkModule
{
    private const string Abstractions = "Microsoft.Extensions.DependencyInjection.Abstractions";
    public static readonly KnownType ServiceCollectionServiceExtensions = new("Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions", Abstractions);
    public static readonly KnownType ServiceCollectionDescriptorExtensions = new("Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions", Abstractions);

    private static readonly Dictionary<string, string> Lifetimes = new(StringComparer.Ordinal)
    {
        ["AddSingleton"] = "singleton", ["AddScoped"] = "scoped", ["AddTransient"] = "transient",
        ["TryAddSingleton"] = "singleton", ["TryAddScoped"] = "scoped", ["TryAddTransient"] = "transient",
        ["AddKeyedSingleton"] = "singleton", ["AddKeyedScoped"] = "scoped", ["AddKeyedTransient"] = "transient",
        ["TryAddKeyedSingleton"] = "singleton", ["TryAddKeyedScoped"] = "scoped", ["TryAddKeyedTransient"] = "transient",
    };

    /// <summary>
    /// Framework extension methods that register a service internally. Matched by method name AND containing type
    /// AND assembly (never by name only). Lifetime: a constant argument named <c>LifetimeParameter</c> when present,
    /// otherwise the documented default.
    /// </summary>
    private sealed record FrameworkExtension(KnownType Type, string DefaultLifetime, string? LifetimeParameter, string Note);

    private static readonly KnownType EfExtensions = new("Microsoft.Extensions.DependencyInjection.EntityFrameworkServiceCollectionExtensions", "Microsoft.EntityFrameworkCore");
    private static readonly KnownType HostedExtensions = new("Microsoft.Extensions.DependencyInjection.ServiceCollectionHostedServiceExtensions", "Microsoft.Extensions.Hosting.Abstractions");
    private static readonly KnownType HttpExtensions = new("Microsoft.Extensions.DependencyInjection.HttpClientFactoryServiceCollectionExtensions", "Microsoft.Extensions.Http");
    private static readonly KnownType OptionsExtensions = new("Microsoft.Extensions.DependencyInjection.OptionsServiceCollectionExtensions", "Microsoft.Extensions.Options");

    private static readonly Dictionary<string, FrameworkExtension> FrameworkMethods = new(StringComparer.Ordinal)
    {
        ["AddDbContext"] = new(EfExtensions, "scoped", "contextLifetime", "EF Core registers the context (default scoped) and its options."),
        ["AddDbContextPool"] = new(EfExtensions, "scoped", null, "EF Core pools context instances; each scope leases one."),
        ["AddDbContextFactory"] = new(EfExtensions, "singleton", "lifetime", "EF Core registers IDbContextFactory<TContext> (default singleton)."),
        ["AddHostedService"] = new(HostedExtensions, "singleton", null, "Registered as IHostedService (singleton)."),
        ["AddHttpClient"] = new(HttpExtensions, "transient", null, "Typed HttpClient: the client type is registered transient."),
        ["AddOptions"] = new(OptionsExtensions, "singleton", null, "Registers the options infrastructure: IOptions<T> singleton, IOptionsSnapshot<T> scoped, IOptionsMonitor<T> singleton."),
    };

    public string Id => "di";
    public string ProviderRouteId => "csharp.roslyn/di";

    public sealed class Facts
    {
        public List<DiRegistrationFact> Registrations { get; } = new();
        public SortedSet<string> AssemblyEvidence { get; } = new(StringComparer.Ordinal);
        /// <summary>Calls that pass the service collection to a method that is not a recognised registration.</summary>
        public List<DiCollectionCallFact> CollectionCalls { get; } = new();
        /// <summary>Roots that pass the collection to a target that cannot be resolved (delegate, virtual, unknown).</summary>
        public HashSet<string> RootsWithUnresolvedCalls { get; } = new(StringComparer.Ordinal);
        /// <summary>Constructor parameters whose type is a closed construction of a generic type (matched to open generic registrations).</summary>
        public List<ClosedGenericUsage> ClosedGenericUsages { get; } = new();
    }

    /// <summary>A constructor parameter of a source type whose type is a closed generic, e.g. <c>IRepo&lt;Widget&gt;</c>.</summary>
    public sealed record ClosedGenericUsage(IParameterSymbol Parameter, INamedTypeSymbol ClosedType, Location Location, ProjectId ProjectId);

    public static readonly KnownType ServiceCollectionInterface = new("Microsoft.Extensions.DependencyInjection.IServiceCollection", Abstractions);

    public async Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct)
    {
        var facts = new Facts();
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            var asm = compilation.References.Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>()
                .FirstOrDefault(a => a.Identity.Name == Abstractions);
            if (asm == null) continue;
            facts.AssemblyEvidence.Add(SymbolIdentity.VersionEvidence(asm));
            var orderByRoot = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var (_, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, new[] { "Add", "ervices", "IServiceCollection" }, ct).ConfigureAwait(false))
            {
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    var name = SymbolIdentity.InvokedName(inv);
                    if (name == null) continue;
                    if (!FrameworkMethods.ContainsKey(name) && !Lifetimes.ContainsKey(name))
                    {
                        CollectCall(inv, name, model, project.Id, facts, ct);
                        continue;
                    }
                    if (FrameworkMethods.TryGetValue(name, out var ext))
                    {
                        var fm = SymbolIdentity.InvokedMethod(model, inv, ct);
                        if (fm == null || !ext.Type.Matches((fm.ReducedFrom ?? fm).ContainingType)) continue;
                        var freg = BuildFrameworkExtension(inv, fm, name, ext, model, project.Id, orderByRoot, ct);
                        if (freg != null) facts.Registrations.Add(freg);
                        continue;
                    }
                    if (!Lifetimes.TryGetValue(name, out var lifetime)) continue;
                    var method = SymbolIdentity.InvokedMethod(model, inv, ct);
                    if (method == null) continue;
                    var def = method.ReducedFrom ?? method;
                    if (!ServiceCollectionServiceExtensions.Matches(def.ContainingType) && !ServiceCollectionDescriptorExtensions.Matches(def.ContainingType))
                        continue;
                    var reg = Build(inv, method, name, lifetime, model, project.Id, orderByRoot, ct);
                    if (reg != null) facts.Registrations.Add(reg);
                }
            }
            if (facts.Registrations.Any(r => r.Has(DiTraits.OpenGeneric)))
                CollectClosedGenericUsages(compilation.Assembly.GlobalNamespace, project.Id, facts.ClosedGenericUsages, ct);
        }
        return facts;
    }

    private static void CollectClosedGenericUsages(INamespaceSymbol ns, ProjectId projectId, List<ClosedGenericUsage> into, CancellationToken ct)
    {
        foreach (var member in ns.GetMembers())
        {
            ct.ThrowIfCancellationRequested();
            if (member is INamespaceSymbol child) { CollectClosedGenericUsages(child, projectId, into, ct); continue; }
            if (member is not INamedTypeSymbol type) continue;
            foreach (var t in new[] { type }.Concat(type.GetTypeMembers()))
            {
                if (!t.Locations.Any(l => l.IsInSource) || t.IsAbstract || t.TypeKind != TypeKind.Class) continue;
                foreach (var ctor in t.InstanceConstructors.Where(c => !c.IsImplicitlyDeclared))
                foreach (var p in ctor.Parameters)
                {
                    if (p.Type is not INamedTypeSymbol { IsGenericType: true, IsUnboundGenericType: false } closed) continue;
                    if (closed.TypeArguments.Any(a => a is ITypeParameterSymbol)) continue;
                    var loc = p.Locations.FirstOrDefault(l => l.IsInSource);
                    if (loc != null) into.Add(new ClosedGenericUsage(p, closed, loc, projectId));
                }
            }
        }
    }

    private static DiRegistrationFact? Build(InvocationExpressionSyntax inv, IMethodSymbol method, string name, string lifetime,
        SemanticModel model, ProjectId projectId, Dictionary<string, int> orderByRoot, CancellationToken ct)
    {
        var limitations = new List<string>();
        ITypeSymbol? service = null, impl = null;
        string form;
        var display = SymbolDisplayFormat.MinimallyQualifiedFormat;
        var parameters = method.ReducedFrom != null ? method.Parameters : method.Parameters.Skip(1).ToList().AsReadOnly() as IReadOnlyList<IParameterSymbol>;
        var hasFactory = parameters.Any(p => p.Type is INamedTypeSymbol { DelegateInvokeMethod: not null });
        var hasInstance = parameters.Any(p => p.Name == "implementationInstance");
        var keyed = name.Contains("Keyed", StringComparison.Ordinal);
        string? key = null, keyText = null;
        var keyLimitations = new List<string>();
        if (keyed)
        {
            var keyArg = ArgumentFor(inv, method, "serviceKey");
            if (keyArg == null) return null;
            keyText = keyArg.Expression.ToString();
            var constant = model.GetConstantValue(keyArg.Expression, ct);
            if (constant.HasValue) key = constant.Value?.ToString() ?? "null";
            else
            {
                key = keyText;
                keyLimitations.Add("The service key is not a compile-time constant; it is shown as written.");
            }
            keyLimitations.Add("Keyed registration: it satisfies only [FromKeyedServices] parameters and keyed lookups with the same key.");
        }
        var factoryArg = hasFactory ? inv.ArgumentList.Arguments.FirstOrDefault(a => model.GetTypeInfo(a.Expression, ct).ConvertedType is INamedTypeSymbol { DelegateInvokeMethod: not null }) : null;
        var factoryLocation = factoryArg?.Expression.GetLocation();

        if (method.TypeArguments.Length >= 1)
        {
            service = method.TypeArguments[0];
            impl = method.TypeArguments.Length >= 2 ? method.TypeArguments[1] : (hasFactory || hasInstance ? null : service);
            var extra = string.Join(", ", new[] { keyText, hasFactory ? "factory" : hasInstance ? "instance" : null }.Where(x => x != null));
            form = $"{name}<{string.Join(", ", method.TypeArguments.Select(t => t.ToDisplayString(display)))}>({extra})";
        }
        else
        {
            var typeofs = inv.ArgumentList.Arguments.Select(a => a.Expression).OfType<TypeOfExpressionSyntax>().ToList();
            if (typeofs.Count == 0) return null; // Type taken from a variable: not resolved in this scope.
            service = model.GetTypeInfo(typeofs[0].Type, ct).Type;
            impl = typeofs.Count >= 2 ? model.GetTypeInfo(typeofs[1].Type, ct).Type : (hasFactory || hasInstance ? null : service);
            form = $"{name}({string.Join(", ", typeofs.Select(t => "typeof(" + (model.GetTypeInfo(t.Type, ct).Type?.ToDisplayString(display) ?? "?") + ")"))}{(keyText != null ? ", " + keyText : "")}{(hasFactory ? ", factory" : hasInstance ? ", instance" : "")})";
        }
        if (service == null || service.TypeKind == TypeKind.Error) return null;
        limitations.AddRange(keyLimitations);
        if (hasFactory) limitations.Add("Factory registration: the implementation is created by the delegate; its type is not resolved.");
        if (hasInstance)
        {
            limitations.Add("Instance registration: the implementation is the type of the supplied instance.");
            var instArg = inv.ArgumentList.Arguments.LastOrDefault();
            if (instArg != null) impl = model.GetTypeInfo(instArg.Expression, ct).Type;
        }
        if (service is INamedTypeSymbol { IsUnboundGenericType: true })
            limitations.Add("Open generic registration: closed constructions are not tracked.");
        if (name.StartsWith("TryAdd", StringComparison.Ordinal))
            limitations.Add("TryAdd: skipped at runtime when the service type is already registered earlier.");
        var traits = new HashSet<string>(StringComparer.Ordinal);
        if (hasFactory) traits.Add(DiTraits.Factory);
        if (hasInstance) traits.Add(DiTraits.Instance);
        if (service is INamedTypeSymbol { IsUnboundGenericType: true }) traits.Add(DiTraits.OpenGeneric);
        if (name.StartsWith("TryAdd", StringComparison.Ordinal)) traits.Add(DiTraits.TryAdd);
        if (keyed) traits.Add(DiTraits.Keyed);
        if (IsConditional(inv))
        {
            traits.Add(DiTraits.Conditional);
            limitations.Add("Conditional registration: whether it executes depends on runtime conditions.");
        }

        var root = SymbolIdentity.CompositionRoot(model, inv, ct);
        orderByRoot[root] = orderByRoot.TryGetValue(root, out var o) ? o + 1 : 1;
        var start = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.SpanStart : inv.SpanStart;
        var location = Location.Create(inv.SyntaxTree, Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(start, inv.Span.End));
        return new DiRegistrationFact(lifetime, service, impl, form, root, location, orderByRoot[root], projectId, limitations,
            hasFactory ? Confidences.Likely : Confidences.Proven, traits, key, factoryLocation);
    }

    private static DiRegistrationFact? BuildFrameworkExtension(InvocationExpressionSyntax inv, IMethodSymbol method, string name, FrameworkExtension ext,
        SemanticModel model, ProjectId projectId, Dictionary<string, int> orderByRoot, CancellationToken ct)
    {
        if (method.TypeArguments.Length == 0) return null; // e.g. AddHttpClient("name"): no service type
        var service = method.TypeArguments[0];
        var impl = method.TypeArguments.Length >= 2 ? method.TypeArguments[1] : service;
        if (service.TypeKind == TypeKind.Error) return null;
        var limitations = new List<string> { "Framework extension method: the registration is made inside " + (method.ReducedFrom ?? method).ContainingAssembly.Identity.Name + ". " + ext.Note };
        var lifetime = ext.DefaultLifetime;
        var lifetimeText = "";
        if (ext.LifetimeParameter != null)
        {
            var arg = ArgumentFor(inv, method, ext.LifetimeParameter);
            if (arg != null)
            {
                var constant = model.GetConstantValue(arg.Expression, ct);
                lifetime = constant.HasValue && constant.Value is int v ? v switch { 0 => "singleton", 1 => "scoped", 2 => "transient", _ => "unknown" } : "unknown";
                if (lifetime == "unknown") limitations.Add("The lifetime argument is not a constant.");
                lifetimeText = $"{ext.LifetimeParameter}: {lifetime}";
            }
        }
        var traits = new HashSet<string>(StringComparer.Ordinal) { DiTraits.FrameworkExtension };
        if (IsConditional(inv))
        {
            traits.Add(DiTraits.Conditional);
            limitations.Add("Conditional registration: whether it executes depends on runtime conditions.");
        }
        var display = SymbolDisplayFormat.MinimallyQualifiedFormat;
        var form = $"{name}<{string.Join(", ", method.TypeArguments.Select(t => t.ToDisplayString(display)))}>({lifetimeText})";
        var root = SymbolIdentity.CompositionRoot(model, inv, ct);
        orderByRoot[root] = orderByRoot.TryGetValue(root, out var o) ? o + 1 : 1;
        var start = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.SpanStart : inv.SpanStart;
        var location = Location.Create(inv.SyntaxTree, Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(start, inv.Span.End));
        return new DiRegistrationFact(lifetime, service, impl, form, root, location, orderByRoot[root], projectId, limitations, Confidences.Likely, traits);
    }

    /// <summary>
    /// True when the statement may not run exactly once whenever its method runs: inside if/switch/?:/?./&&/||/??,
    /// a loop, try/catch, a lambda or a local function, or after an earlier return/throw/goto/yield in the same method.
    /// </summary>
    public static bool IsConditional(SyntaxNode node)
    {
        SyntaxNode? body = null;
        for (var a = node.Parent; a != null; a = a.Parent)
        {
            switch (a)
            {
                case IfStatementSyntax or SwitchStatementSyntax or SwitchExpressionSyntax or ConditionalExpressionSyntax
                    or ConditionalAccessExpressionSyntax or ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax
                    or DoStatementSyntax or TryStatementSyntax or CatchClauseSyntax or AnonymousFunctionExpressionSyntax
                    or LocalFunctionStatementSyntax:
                    return true;
                case BinaryExpressionSyntax b when b.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalAndExpression)
                    || b.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalOrExpression)
                    || b.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression):
                    return true;
            }
            if (a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or CompilationUnitSyntax) { body = a; break; }
        }
        if (body == null) return false;
        // An earlier exit in the same method (not inside a nested lambda/local function) makes the call conditional.
        return body.DescendantNodes(n => n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
            .Any(n => n.SpanStart < node.SpanStart
                && n is ReturnStatementSyntax or ThrowStatementSyntax or GotoStatementSyntax or YieldStatementSyntax
                && !n.Span.Contains(node.Span));
    }

    /// <summary>Records a call that receives the service collection and is not a recognised registration.</summary>
    private static void CollectCall(InvocationExpressionSyntax inv, string name, SemanticModel model, ProjectId projectId, Facts facts, CancellationToken ct)
    {
        static bool IsCollection(ITypeSymbol? t) => t != null && (ServiceCollectionInterface.Matches(t) || t.AllInterfaces.Any(ServiceCollectionInterface.Matches));
        var passesCollection = false;
        if (inv.Expression is MemberAccessExpressionSyntax ma && IsCollection(model.GetTypeInfo(ma.Expression, ct).Type))
            passesCollection = true;
        if (!passesCollection)
            foreach (var a in inv.ArgumentList.Arguments)
                if (IsCollection(model.GetTypeInfo(a.Expression, ct).Type)) { passesCollection = true; break; }
        if (!passesCollection) return;
        var callerRoot = SymbolIdentity.CompositionRoot(model, inv, ct);
        var method = SymbolIdentity.InvokedMethod(model, inv, ct);
        var def = (method?.ReducedFrom ?? method)?.OriginalDefinition;
        // Keyed registrations do not satisfy non-keyed parameters; they are not followed and are no hazard here.
        if (def != null && (ServiceCollectionServiceExtensions.Matches(def.ContainingType) || ServiceCollectionDescriptorExtensions.Matches(def.ContainingType))
            && name.StartsWith("AddKeyed", StringComparison.Ordinal)) return;
        string? callee = null;
        var isSource = false;
        var resolvedMetadata = false;
        if (def != null && def.MethodKind == MethodKind.LocalFunction)
        {
            callee = callerRoot; // registrations of a local function belong to the same root (and are conditional)
        }
        else if (def != null && !def.IsAbstract && !def.IsVirtual && def.MethodKind is MethodKind.Ordinary or MethodKind.ReducedExtension)
        {
            if (def.DeclaringSyntaxReferences.Length > 0)
            {
                isSource = true;
                callee = $"{def.ContainingType.ToDisplayString()}.{def.Name} ({def.ContainingAssembly.Name})";
            }
            else resolvedMetadata = true; // framework/library method: recorded, not followed
        }
        var start = inv.Expression is MemberAccessExpressionSyntax m2 ? m2.Name.SpanStart : inv.SpanStart;
        var location = Location.Create(inv.SyntaxTree, Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(start, inv.Span.End));
        var display = def != null ? $"{def.ContainingType?.Name}.{def.Name}" : name;
        facts.CollectionCalls.Add(new DiCollectionCallFact(callerRoot, callee, display, isSource, IsConditional(inv), location, projectId));
        if (callee == null && !resolvedMetadata) facts.RootsWithUnresolvedCalls.Add(callerRoot);
    }

    /// <summary>The argument bound to a parameter (named or positional; the extension receiver excluded).</summary>
    private static ArgumentSyntax? ArgumentFor(InvocationExpressionSyntax inv, IMethodSymbol method, string parameterName)
    {
        var parameters = method.ReducedFrom != null ? method.Parameters.ToList() : method.Parameters.Skip(1).ToList();
        var index = parameters.FindIndex(p => p.Name == parameterName);
        if (index < 0) return null;
        var args = inv.ArgumentList.Arguments;
        foreach (var a in args) if (a.NameColon?.Name.Identifier.ValueText == parameterName) return a;
        return index < args.Count && args.Take(index + 1).All(a => a.NameColon == null) ? args[index] : null;
    }

    public string? Detection(object facts)
    {
        var f = (Facts)facts;
        return f.AssemblyEvidence.Count == 0 ? null : string.Join("; ", f.AssemblyEvidence);
    }

    public IReadOnlyList<FrameworkRelation> Relate(object factsObj, ISymbol subject, FrameworkContext context)
    {
        var facts = (Facts)factsObj;
        var result = new List<FrameworkRelation>();
        if (subject is IParameterSymbol parameter)
        {
            RelateKeyedParameter(facts, parameter, result);
            return result;
        }
        var type = subject switch
        {
            INamedTypeSymbol t => t,
            IMethodSymbol { MethodKind: MethodKind.Constructor } c => c.ContainingType,
            _ => null,
        };
        if (type == null) return result;
        var seenImpl = new HashSet<(string root, string impl)>();
        foreach (var r in facts.Registrations.OrderBy(r => r.CompositionRoot, StringComparer.Ordinal).ThenBy(r => r.Order))
        {
            var asService = SymbolIdentity.SameDefinition(r.ServiceType, type);
            var asImpl = r.ImplementationType != null && SymbolIdentity.SameDefinition(r.ImplementationType, type);
            if (!asService && !asImpl) continue;
            var evidence = new[] { new EvidenceItem($"{r.Form} in {r.CompositionRoot}", r.Location) };
            var limits = r.Limitations.Append("Source registration; whether this composition root runs is not proven.").ToList();
            result.Add(new FrameworkRelation(asService ? RelationKinds.DiRegistration : RelationKinds.DiService, RelationGroups.Registrations,
                new RelationTarget($"{r.Form} — {r.CompositionRoot}", Symbol: asService ? null : r.ServiceType, Location: r.Location, Registration: r),
                evidence, r.Confidence, limits, ProviderRouteId));
            if (asService && r.ImplementationType != null && !SymbolIdentity.SameDefinition(r.ImplementationType, type)
                && seenImpl.Add((r.CompositionRoot, r.ImplementationType.ToDisplayString())))
            {
                result.Add(new FrameworkRelation(RelationKinds.DiImplementation, RelationGroups.Implementations,
                    new RelationTarget($"{r.ImplementationType.Name} ({r.Lifetime}, {r.CompositionRoot})", Symbol: r.ImplementationType),
                    evidence, r.Confidence, limits, ProviderRouteId));
            }
        }
        RelateOpenGenericUsages(facts, type, result);
        return result;
    }

    private static string Label(DiRegistrationFact r) => $"{r.Form} — {r.CompositionRoot}";

    /// <summary>A [FromKeyedServices(key)] parameter → the keyed registrations of its type with the same key.</summary>
    private void RelateKeyedParameter(Facts facts, IParameterSymbol parameter, List<FrameworkRelation> result)
    {
        var attr = parameter.GetAttributes().FirstOrDefault(a => FromKeyedServices.Matches(a.AttributeClass));
        if (attr == null || attr.ConstructorArguments.Length == 0) return;
        var keyValue = attr.ConstructorArguments[0];
        var key = keyValue.IsNull ? "null" : keyValue.Value?.ToString();
        foreach (var r in facts.Registrations.Where(r => r.Has(DiTraits.Keyed) && SymbolIdentity.SameDefinition(r.ServiceType, parameter.Type)))
        {
            var exact = r.Key == key && !r.Limitations.Any(l => l.StartsWith("The service key is not a compile-time constant", StringComparison.Ordinal));
            if (!exact && r.Key != key) continue;
            result.Add(new FrameworkRelation(RelationKinds.DiRegistration, RelationGroups.Registrations,
                new RelationTarget(Label(r), Location: r.Location, Registration: r),
                new[] { new EvidenceItem($"[FromKeyedServices({key})] {parameter.Name} matches {r.Form} in {r.CompositionRoot}", r.Location) },
                exact ? r.Confidence : Confidences.Likely,
                r.Limitations.Append("Source registration; whether this composition root runs is not proven.").ToList(), ProviderRouteId));
        }
    }

    /// <summary>
    /// An open generic registration (typeof(IRepo&lt;&gt;), typeof(Repo&lt;&gt;)) → constructor parameters that consume a
    /// closed construction of the service (IRepo&lt;Widget&gt;). Likely: a closed registration or another root may win.
    /// </summary>
    private void RelateOpenGenericUsages(Facts facts, INamedTypeSymbol type, List<FrameworkRelation> result)
    {
        var services = facts.Registrations.Where(r => r.Has(DiTraits.OpenGeneric)
                && (SymbolIdentity.SameDefinition(r.ServiceType, type) || r.ImplementationType != null && SymbolIdentity.SameDefinition(r.ImplementationType, type)))
            .ToList();
        var seen = new HashSet<Location>();
        foreach (var r in services)
        foreach (var u in facts.ClosedGenericUsages.Where(u => SymbolIdentity.SameDefinition(u.ClosedType, r.ServiceType)))
        {
            if (!seen.Add(u.Location)) continue;
            var display = u.ClosedType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            var ctor = u.Parameter.ContainingSymbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            result.Add(new FrameworkRelation(RelationKinds.DiOpenGenericUsage, RelationGroups.Registrations,
                new RelationTarget($"{display} in {ctor}", Location: u.Location),
                new[] { new EvidenceItem($"{r.Form} in {r.CompositionRoot} supplies {display}", r.Location), new EvidenceItem($"Parameter '{u.Parameter.Name}' of {ctor}", u.Location) },
                Confidences.Likely,
                new[] { "Matched by generic definition: a closed registration of the same type, another composition root or a constraint may decide otherwise; activation is not proven." },
                ProviderRouteId));
        }
    }

    private static readonly KnownType FromKeyedServices = new("Microsoft.Extensions.DependencyInjection.FromKeyedServicesAttribute", Abstractions);
}
