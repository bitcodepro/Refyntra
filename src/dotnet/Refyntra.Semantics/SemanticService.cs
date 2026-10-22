using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Frameworks.AspNetCore;
using Refyntra.Frameworks.DependencyInjection;
using Refyntra.Frameworks.EfCore;
using Refyntra.Frameworks.MediatR;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

public sealed record LocationHit(Location Location, Project? Project);

public sealed record SearchHit(ISymbol? Symbol, Project? Project, EndpointFact? Endpoint, double Score, string SortName, string SortPath);

public sealed record SearchModel(List<SearchHit> Items, bool Truncated);

public sealed record SearchFiltersModel(bool Type, bool Member, string? Project, string? Route, string? Method, bool Entity = false, string? Table = null);

public sealed record RelatedModel(ISymbol? Subject, Project? SubjectProject, List<FrameworkRelation> Relations, string Completeness, List<string> ScopeNotes, ScopeDetails Details);

/// <summary>Structured search scope of a Related result (protocol-v1.md "RelatedResult.scopeDetails").</summary>
public sealed record ScopeDetails(int ProjectsTotal, int ProjectsComplete, int ProjectsPartial, int ProjectsFailed,
    ScopeCauses Causes, bool RestoreRecommended, string? SolutionPath, List<FrameworkScope> Frameworks);

/// <summary>Number of projects affected by each load cause (a project may count under several).</summary>
public sealed record ScopeCauses(int MissingAssets, int MissingPackages, int MissingProjectReferences, int LoadFailures, int OtherErrors);

/// <summary>A detected framework. <c>VersionVerified</c> false = its relations are reported with confidence likely.</summary>
public sealed record FrameworkScope(string Id, string Name, string Evidence, bool VersionVerified);

public sealed record LocationsModel(List<LocationHit> Locations, string Completeness);

/// <summary>Read-only semantic queries over one immutable snapshot.</summary>
public static class SemanticService
{
    public const string ProviderRouteId = "csharp.roslyn";
    public const int MaxReferencesInRelated = 50;

    public static readonly IFrameworkModule MediatR = new MediatRModule();
    public static readonly IFrameworkModule AspNetCore = new AspNetCoreModule();
    public static readonly IFrameworkModule DependencyInjection = new DependencyInjectionModule();
    public static readonly IFrameworkModule EfCore = new EfCoreModule();
    public static readonly IFrameworkModule HandlerInterfaces = new HandlerInterfacesModule();
    public static readonly IFrameworkModule[] Modules = { MediatR, HandlerInterfaces, AspNetCore, DependencyInjection, EfCore };

    private static readonly ConditionalWeakTable<Solution, ConcurrentDictionary<string, Lazy<Task<object>>>> FactsCache = new();

    public static FrameworkContext FrameworkContextFor(Snapshot snapshot)
    {
        var loaded = snapshot.Session.Projects.Where(p => p.ProjectId != null && p.State != ProjectStates.Failed)
            .Select(p => p.ProjectId!).ToHashSet();
        return new FrameworkContext(snapshot.Solution, loaded);
    }

    /// <summary>Framework facts are computed once per immutable solution and shared by concurrent requests.</summary>
    public static Task<object> GetFactsAsync(Snapshot snapshot, IFrameworkModule module, CancellationToken ct)
    {
        var perSolution = FactsCache.GetValue(snapshot.Solution, _ => new ConcurrentDictionary<string, Lazy<Task<object>>>());
        var context = FrameworkContextFor(snapshot);
        var lazy = perSolution.GetOrAdd(module.Id, _ => new Lazy<Task<object>>(() => Task.Run(() => module.AnalyzeAsync(context, CancellationToken.None))));
        return lazy.Value.WaitAsync(ct);
    }

    /// <summary>
    /// Starts every module's analysis in the background (once per solution, cached), so the first Related after a load
    /// does not wait for MediatR, ASP.NET Core, DI and EF Core facts of every project.
    /// </summary>
    public static void Prewarm(Snapshot snapshot)
    {
        foreach (var module in Modules) _ = GetFactsAsync(snapshot, module, CancellationToken.None);
    }

    public static string Completeness(Snapshot snapshot) =>
        snapshot.Session.Projects.All(p => p.State == ProjectStates.Loaded) ? "complete" : "partial";

    public static List<string> ScopeNotes(Snapshot snapshot)
    {
        var notes = new List<string>();
        var all = snapshot.Session.Projects;
        var full = all.Count(p => p.State == ProjectStates.Loaded);
        if (full != all.Count) notes.Add($"{full} of {all.Count} projects loaded completely");
        return notes;
    }

    public static ScopeDetails Details(Snapshot snapshot, IReadOnlyList<FrameworkScope> frameworks)
    {
        var all = snapshot.Session.Projects;
        int With(string cause) => all.Count(p => p.Diagnostics.Any(d => d.Cause == cause));
        var other = all.Count(p => p.State == ProjectStates.Partial && p.Diagnostics.Any(d => d.Severity == "error" && d.Cause == null));
        return new ScopeDetails(all.Count,
            all.Count(p => p.State == ProjectStates.Loaded),
            all.Count(p => p.State == ProjectStates.Partial),
            all.Count(p => p.State == ProjectStates.Failed),
            new ScopeCauses(With(LoadCauses.MissingAssets), With(LoadCauses.MissingPackages), With(LoadCauses.MissingProjectReference),
                all.Count(p => p.State == ProjectStates.Failed), other),
            all.Any(p => p.State != ProjectStates.Loaded && p.Diagnostics.Any(d => d.RestoreRecommended)),
            snapshot.Session.SolutionPath,
            frameworks.ToList());
    }

    private static readonly Dictionary<string, string> FrameworkNames = new()
    {
        ["mediatr"] = "MediatR", ["aspnetcore"] = "ASP.NET Core", ["di"] = "Microsoft.Extensions.DependencyInjection", ["efcore"] = "EF Core",
    };

    /// <summary>Only MediatR checks its version; ASP.NET Core and DI detection is evidence and never lowers confidence.</summary>
    private static bool VersionVerified(object facts) => facts is not Frameworks.MediatR.MediatRModule.Facts m || m.VersionVerified;

    // ------------------------------------------------------------------ symbolAt

    public static async Task<(ISymbol symbol, Project project)?> SymbolAtAsync(Snapshot snapshot, string path, int line, int character, CancellationToken ct)
    {
        var ids = snapshot.Session.DocumentIdsForPath(path);
        foreach (var id in ids)
        {
            var doc = snapshot.Solution.GetDocument(id);
            if (doc == null) continue;
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            if (line >= text.Lines.Count)
                throw new EngineException(ErrorCodes.InvalidParams, "InvalidPosition", "The position is outside the document.");
            var pos = SymbolFacts.ToOffset(text, line, character);
            var symbol = await SymbolFinder.FindSymbolAtPositionAsync(doc, pos, ct).ConfigureAwait(false);
            if (symbol == null && pos > 0) symbol = await SymbolFinder.FindSymbolAtPositionAsync(doc, pos - 1, ct).ConfigureAwait(false);
            if (symbol == null) continue;
            symbol = SymbolIds.Normalize(symbol);
            var source = await SymbolFinder.FindSourceDefinitionAsync(symbol, snapshot.Solution, ct).ConfigureAwait(false);
            symbol = source ?? symbol;
            return (symbol, SymbolFacts.OwningProject(snapshot.Solution, symbol) ?? doc.Project);
        }
        // .razor / .cshtml: the symbol at the matching position of the Razor-generated code.
        if (ids.Length == 0 && RazorMapping.IsRazorPath(path) && await RazorMapping.ToGeneratedAsync(snapshot.Solution, path, line, character, ct).ConfigureAwait(false) is { } g)
        {
            var symbol = await SymbolFinder.FindSymbolAtPositionAsync(g.Document, g.Position, ct).ConfigureAwait(false);
            if (symbol == null && g.Position > 0) symbol = await SymbolFinder.FindSymbolAtPositionAsync(g.Document, g.Position - 1, ct).ConfigureAwait(false);
            if (symbol == null) return null;
            symbol = SymbolIds.Normalize(symbol);
            symbol = await SymbolFinder.FindSourceDefinitionAsync(symbol, snapshot.Solution, ct).ConfigureAwait(false) ?? symbol;
            return (symbol, SymbolFacts.OwningProject(snapshot.Solution, symbol) ?? g.Document.Project);
        }
        return null;
    }

    // ------------------------------------------------------------------ search

    public static async Task<SearchModel> SearchAsync(Snapshot snapshot, string query, SearchFiltersModel filters, int limit, CancellationToken ct)
    {
        query = (query ?? "").Trim();
        // Accept inline filter tokens too ("type: Order", "route:/api", "method:GET").
        var words = new List<string>();
        foreach (var token in query.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var t = token;
            if (t.Equals("type:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Type = true };
            else if (t.Equals("member:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Member = true };
            else if (t.StartsWith("type:", StringComparison.OrdinalIgnoreCase)) { filters = filters with { Type = true }; words.Add(t[5..]); }
            else if (t.StartsWith("member:", StringComparison.OrdinalIgnoreCase)) { filters = filters with { Member = true }; words.Add(t[7..]); }
            else if (t.StartsWith("project:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Project = t[8..] };
            else if (t.StartsWith("route:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Route = t[6..] };
            else if (t.StartsWith("method:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Method = t[7..] };
            else if (t.StartsWith("entity:", StringComparison.OrdinalIgnoreCase)) { filters = filters with { Entity = true }; if (t.Length > 7) words.Add(t[7..]); }
            else if (t.StartsWith("table:", StringComparison.OrdinalIgnoreCase)) filters = filters with { Table = t[6..] };
            else words.Add(t);
        }
        query = string.Join(' ', words).Trim();
        if (limit <= 0) limit = 50;
        var hits = new List<SearchHit>();
        var projects = snapshot.Solution.Projects.Where(p => p.Language == LanguageNames.CSharp)
            .Where(p => string.IsNullOrEmpty(filters.Project) || p.Name.Equals(filters.Project, StringComparison.OrdinalIgnoreCase)
                || p.Name.StartsWith(filters.Project + "(", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var projectIds = projects.Select(p => p.Id).ToHashSet();

        // A C# file name, also with a path ("Orders/OrderService.cs", pasted from the explorer or a stack trace): the types
        // declared in that file come first, then the search goes on with the name without ".cs".
        var fileName = System.Text.RegularExpressions.Regex.Match(query, @"([^\\/\s]+)\.cs$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (fileName.Success && !filters.Entity && filters.Table == null && filters.Route == null && filters.Method == null)
        {
            var wanted = fileName.Groups[1].Value + ".cs";
            foreach (var project in projects)
            foreach (var doc in project.Documents)
            {
                if (doc.FilePath == null || !Path.GetFileName(doc.FilePath).Equals(wanted, StringComparison.OrdinalIgnoreCase)) continue;
                var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                if (root == null || model == null) continue;
                foreach (var decl in root.DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseTypeDeclarationSyntax>())
                    if (model.GetDeclaredSymbol(decl, ct) is { } type)
                        hits.Add(new SearchHit(type, project, null, 110, SymbolFacts.DisplayName(type), doc.FilePath));
            }
            query = fileName.Groups[1].Value;
        }

        if (filters.Entity || filters.Table != null)
        {
            // EF Core entities ("entity:" by type name, "table:" by mapped table name, explicit or convention).
            var ef = await GetFactsAsync(snapshot, EfCore, ct).ConfigureAwait(false);
            var seenEntity = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (entity, tables) in EfCoreModule.EntitiesWithTables(ef))
            {
                var owner = SymbolFacts.OwningProject(snapshot.Solution, entity);
                if (owner == null || !projectIds.Contains(owner.Id)) continue;
                var name = entity.Name;
                if (query.Length > 0 && !name.Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                var tableHit = filters.Table is { Length: > 0 } tn ? tables.FirstOrDefault(t => t.Contains(tn, StringComparison.OrdinalIgnoreCase)) : "";
                if (tableHit == null) continue;
                var loc = SymbolFacts.PrimaryLocation(entity);
                if (!seenEntity.Add((DocumentationCommentId.CreateDeclarationId(entity) ?? name) + "|" + loc?.SourceTree?.FilePath)) continue;
                var needle = filters.Table is { Length: > 0 } ? filters.Table : query;
                var hay = filters.Table is { Length: > 0 } ? tableHit : name;
                var score = needle.Length == 0 ? 50 :
                    hay.Equals(needle, StringComparison.OrdinalIgnoreCase) ? 100 :
                    hay.StartsWith(needle, StringComparison.OrdinalIgnoreCase) ? 80 : 60;
                hits.Add(new SearchHit(entity, owner, null, score, SymbolFacts.DisplayName(entity), loc?.SourceTree?.FilePath ?? ""));
            }
            var orderedEf = hits.OrderByDescending(h => h.Score).ThenBy(h => h.SortName, StringComparer.Ordinal).ThenBy(h => h.SortPath, StringComparer.Ordinal).ToList();
            return new SearchModel(orderedEf.Take(limit).ToList(), orderedEf.Count > limit);
        }

        var endpointSearch = filters.Route != null || filters.Method != null || query.StartsWith('/');
        if (endpointSearch)
        {
            var facts = (AspNetCoreModule.Facts)await GetFactsAsync(snapshot, AspNetCore, ct).ConfigureAwait(false);
            var routeNeedle = filters.Route ?? (query.StartsWith('/') ? query : "");
            foreach (var e in facts.Endpoints.Where(e => projectIds.Contains(e.ProjectId)))
            {
                if (filters.Method != null && e.HttpMethods.Count > 0 && !e.HttpMethods.Contains(filters.Method.ToUpperInvariant())) continue;
                if (routeNeedle.Length > 0 && !e.Route.Contains(routeNeedle, StringComparison.OrdinalIgnoreCase)) continue;
                var score = routeNeedle.Length == 0 ? 50 :
                    e.Route.Equals(routeNeedle, StringComparison.OrdinalIgnoreCase) ? 100 :
                    e.Route.StartsWith(routeNeedle, StringComparison.OrdinalIgnoreCase) ? 80 : 60;
                hits.Add(new SearchHit(null, snapshot.Solution.GetProject(e.ProjectId), e, score, e.Route, e.Location.SourceTree?.FilePath ?? ""));
            }
        }
        else if (query.Length > 0)
        {
            var filter = filters.Type && !filters.Member ? SymbolFilter.Type : filters.Member && !filters.Type ? SymbolFilter.Member : SymbolFilter.TypeAndMember;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var project in projects)
            {
                var found = await SymbolFinder.FindSourceDeclarationsWithPatternAsync(project, query, filter, ct).ConfigureAwait(false);
                foreach (var s in found)
                {
                    if (s is IMethodSymbol { MethodKind: not (MethodKind.Ordinary or MethodKind.Constructor) }) continue;
                    if (s.IsImplicitlyDeclared) continue;
                    var loc = SymbolFacts.PrimaryLocation(s);
                    var key = (DocumentationCommentId.CreateDeclarationId(s) ?? s.Name) + "|" + loc?.SourceTree?.FilePath + "|" + loc?.SourceSpan.Start;
                    if (!seen.Add(key)) continue;
                    var name = SymbolFacts.Name(s);
                    var score = name.Equals(query, StringComparison.Ordinal) ? 100 :
                        name.Equals(query, StringComparison.OrdinalIgnoreCase) ? 95 :
                        name.StartsWith(query, StringComparison.OrdinalIgnoreCase) ? 80 :
                        name.Contains(query, StringComparison.OrdinalIgnoreCase) ? 60 : 40;
                    if (s is INamedTypeSymbol) score += 5;
                    hits.Add(new SearchHit(s, project, null, score, SymbolFacts.DisplayName(s), loc?.SourceTree?.FilePath ?? ""));
                }
            }
        }
        else if (filters.Type && !filters.Member)
        {
            // Empty query + type filter: list the source types (sorted by name, limited).
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var project in projects)
            {
                var found = await SymbolFinder.FindSourceDeclarationsAsync(project, _ => true, SymbolFilter.Type, ct).ConfigureAwait(false);
                foreach (var s in found)
                {
                    if (s.IsImplicitlyDeclared || s is not INamedTypeSymbol) continue;
                    var loc = SymbolFacts.PrimaryLocation(s);
                    if (loc?.SourceTree != null && SymbolFacts.IsGeneratedTree(snapshot.Solution, loc.SourceTree, ct)) continue;
                    var key = (DocumentationCommentId.CreateDeclarationId(s) ?? s.Name) + "|" + loc?.SourceTree?.FilePath + "|" + loc?.SourceSpan.Start;
                    if (!seen.Add(key)) continue;
                    hits.Add(new SearchHit(s, project, null, 50, SymbolFacts.DisplayName(s), loc?.SourceTree?.FilePath ?? ""));
                }
            }
        }
        var ordered = hits.OrderByDescending(h => h.Score).ThenBy(h => h.SortName, StringComparer.Ordinal)
            .ThenBy(h => h.SortPath, StringComparer.Ordinal)
            // A type found by its file and again by its name: once.
            .DistinctBy(h => h.Symbol == null ? $"{h.SortName}|{h.SortPath}|{h.Endpoint?.Location.SourceSpan.Start}" : $"{DocumentationCommentId.CreateDeclarationId(h.Symbol) ?? h.Symbol.Name}|{h.SortPath}|{SymbolFacts.PrimaryLocation(h.Symbol)?.SourceSpan.Start}")
            .ToList();
        var truncated = ordered.Count > limit;
        return new SearchModel(ordered.Take(limit).ToList(), truncated);
    }

    // ------------------------------------------------------------------ references / implementations

    public static async Task<LocationsModel> ReferencesAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        var refs = await SymbolFinder.FindReferencesAsync(symbol, snapshot.Solution, ct).ConfigureAwait(false);
        var list = new List<LocationHit>();
        var seen = new HashSet<(string?, int)>();
        foreach (var r in refs)
        foreach (var rl in r.Locations)
        {
            if (rl.IsImplicit || !rl.Location.IsInSource) continue;
            if (!seen.Add((rl.Location.SourceTree?.FilePath, rl.Location.SourceSpan.Start))) continue;
            list.Add(new LocationHit(rl.Location, rl.Document.Project));
        }
        return new LocationsModel(Sort(list), Completeness(snapshot));
    }

    public static async Task<List<ISymbol>> ImplementationSymbolsAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        var result = new List<ISymbol>();
        switch (symbol)
        {
            case INamedTypeSymbol { TypeKind: TypeKind.Interface } iface:
                result.AddRange(await SymbolFinder.FindImplementationsAsync(iface, solution, transitive: true, cancellationToken: ct).ConfigureAwait(false));
                break;
            case INamedTypeSymbol { TypeKind: TypeKind.Class } cls:
                result.AddRange(await SymbolFinder.FindDerivedClassesAsync(cls, solution, transitive: true, cancellationToken: ct).ConfigureAwait(false));
                break;
            case IMethodSymbol or IPropertySymbol or IEventSymbol:
                if (symbol.ContainingType?.TypeKind == TypeKind.Interface || symbol.IsAbstract || symbol.IsVirtual || symbol.IsOverride)
                {
                    result.AddRange(await SymbolFinder.FindImplementationsAsync(symbol, solution, cancellationToken: ct).ConfigureAwait(false));
                    result.AddRange(await SymbolFinder.FindOverridesAsync(symbol, solution, cancellationToken: ct).ConfigureAwait(false));
                }
                break;
        }
        return result.Where(s => s.Locations.Any(l => l.IsInSource))
            .GroupBy(s => DocumentationCommentId.CreateDeclarationId(s) + "|" + s.ContainingAssembly?.Name).Select(g => g.First()).ToList();
    }

    public static async Task<LocationsModel> ImplementationsAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        var list = new List<LocationHit>();
        foreach (var s in await ImplementationSymbolsAsync(snapshot, symbol, ct).ConfigureAwait(false))
        foreach (var loc in s.Locations.Where(l => l.IsInSource))
            list.Add(new LocationHit(loc, snapshot.Solution.GetDocument(loc.SourceTree!)?.Project));
        return new LocationsModel(Sort(list), Completeness(snapshot));
    }

    private static List<LocationHit> Sort(List<LocationHit> list) =>
        list.OrderBy(h => h.Location.SourceTree?.FilePath, StringComparer.Ordinal).ThenBy(h => h.Location.SourceSpan.Start).ToList();

    // ------------------------------------------------------------------ related

    public static async Task<RelatedModel> RelatedAsync(Snapshot snapshot, ISymbol subject, Project project, CancellationToken ct)
    {
        var relations = new List<FrameworkRelation>();
        var context = FrameworkContextFor(snapshot);
        var notes = ScopeNotes(snapshot);

        foreach (var loc in subject.Locations.Where(l => l.IsInSource))
        {
            var line = loc.GetLineSpan().StartLinePosition.Line + 1;
            relations.Add(new FrameworkRelation(RelationKinds.Declaration, RelationGroups.Declarations,
                new RelationTarget($"{Path.GetFileName(loc.SourceTree?.FilePath)}:{line}", Symbol: subject, Location: loc),
                Array.Empty<EvidenceItem>(), Confidences.Proven, Array.Empty<string>(), ProviderRouteId));
        }

        // The modules' facts in parallel (each is computed once per solution and cached).
        var factsByModule = new Dictionary<string, object>();
        var pending = Modules.Select(m => GetFactsAsync(snapshot, m, ct)).ToArray();
        await Task.WhenAll(pending).ConfigureAwait(false);
        for (var i = 0; i < Modules.Length; i++)
        {
            factsByModule[Modules[i].Id] = pending[i].Result;
            relations.AddRange(Modules[i].Relate(pending[i].Result, subject, context));
        }

        // Cross-framework: a MediatR Send/Publish call site inside a Minimal API handler or an MVC action links the request to that endpoint.
        var aspFacts = (AspNetCoreModule.Facts)factsByModule[AspNetCore.Id];
        var endpointSeen = new HashSet<Location>();
        foreach (var send in relations.Where(r => r.RelationKind is RelationKinds.MediatRSend or RelationKinds.EfCoreQuery).ToList())
        {
            var loc = send.Target.Location;
            if (loc?.SourceTree == null) continue;
            foreach (var endpoint in AspNetCoreModule.EnclosingEndpoints(aspFacts, loc.SourceTree, loc.SourceSpan))
            {
                if (!endpointSeen.Add(endpoint.Location)) continue;
                relations.Add(new FrameworkRelation(RelationKinds.AspNetEndpoint, RelationGroups.Endpoints,
                    new RelationTarget(AspNetCoreModule.Label(endpoint), Location: endpoint.Location, Endpoint: endpoint),
                    new[] { new EvidenceItem($"{subject.Name} is {(send.RelationKind == RelationKinds.EfCoreQuery ? "queried" : "sent")} inside the handler of {AspNetCoreModule.Label(endpoint)}", loc) },
                    Weaker(send.Confidence, endpoint.Confidence), endpoint.Limitations, AspNetCore.ProviderRouteId));
            }
        }

        // Generic semantic relations.
        foreach (var impl in await ImplementationSymbolsAsync(snapshot, subject, ct).ConfigureAwait(false))
        {
            relations.Add(new FrameworkRelation(RelationKinds.Implementation, RelationGroups.Implementations,
                new RelationTarget(impl.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), Symbol: impl),
                Array.Empty<EvidenceItem>(), Confidences.Proven, Array.Empty<string>(), ProviderRouteId));
        }
        if (subject.Kind is not SymbolKind.Namespace)
        {
            var refs = await ReferencesAsync(snapshot, subject, ct).ConfigureAwait(false);
            // Code ↔ tests: tests that reference the subject, name matches, and the reverse direction.
            relations.AddRange(await TestNavigation.TestsForAsync(snapshot, subject, refs.Locations, ct).ConfigureAwait(false));
            relations.AddRange(await TestNavigation.SubjectsOfTestAsync(snapshot, subject, ct).ConfigureAwait(false));
            var limit = refs.Locations.Count > MaxReferencesInRelated
                ? new[] { $"Showing {MaxReferencesInRelated} of {refs.Locations.Count} references; use Find References for all." }
                : Array.Empty<string>();
            foreach (var r in refs.Locations.Take(MaxReferencesInRelated))
            {
                var line = r.Location.GetLineSpan().StartLinePosition.Line + 1;
                relations.Add(new FrameworkRelation(RelationKinds.Reference, RelationGroups.References,
                    new RelationTarget($"{Path.GetFileName(r.Location.SourceTree?.FilePath)}:{line}", Location: r.Location),
                    Array.Empty<EvidenceItem>(), Confidences.Proven, limit, ProviderRouteId));
            }
        }

        var frameworks = new List<FrameworkScope>();
        foreach (var module in Modules)
        {
            var detection = module.Detection(factsByModule[module.Id]);
            if (detection == null) continue;
            notes.Add($"{module.Id}: {detection}");
            frameworks.Add(new FrameworkScope(module.Id, FrameworkNames.GetValueOrDefault(module.Id, module.Id), detection, VersionVerified(factsByModule[module.Id])));
        }

        var ordered = relations
            .OrderBy(r => RelationGroups.IndexOf(r.Group))
            .ThenBy(r => r.Target.Registration?.CompositionRoot ?? "", StringComparer.Ordinal)
            .ThenBy(r => SortPath(r), StringComparer.Ordinal)
            .ThenBy(r => SortPos(r))
            .ThenBy(r => r.Target.Label, StringComparer.Ordinal)
            .ToList();
        return new RelatedModel(subject, project, ordered, Completeness(snapshot), notes, Details(snapshot, frameworks));
    }

    private static string Weaker(string a, string b) =>
        a == Confidences.Heuristic || b == Confidences.Heuristic ? Confidences.Heuristic
        : a == Confidences.Likely || b == Confidences.Likely ? Confidences.Likely : Confidences.Proven;

    private static Location? MainLocation(FrameworkRelation r) =>
        r.Target.Location ?? r.Target.Endpoint?.Location ?? r.Target.Registration?.Location ?? r.Target.Symbol?.Locations.FirstOrDefault(l => l.IsInSource);

    private static string SortPath(FrameworkRelation r) => MainLocation(r)?.SourceTree?.FilePath ?? "";
    private static int SortPos(FrameworkRelation r) => MainLocation(r)?.SourceSpan.Start ?? 0;
}
