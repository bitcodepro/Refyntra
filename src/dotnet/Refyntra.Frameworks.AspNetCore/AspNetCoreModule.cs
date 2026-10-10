using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.AspNetCore;

/// <summary>
/// Minimal API endpoints: MapGet/MapPost/MapPut/MapDelete/MapPatch from Microsoft.AspNetCore.Routing, constant route
/// literals and simple MapGroup prefixes. Anything not provably constant is reported with routeIsDynamic = true and
/// only the known prefix. MVC controllers/actions and conventional routes come from <see cref="MvcEndpoints"/> (kind "mvc").
/// </summary>
public sealed class AspNetCoreModule : IFrameworkModule
{
    public static readonly KnownType EndpointRouteBuilderExtensions = new("Microsoft.AspNetCore.Builder.EndpointRouteBuilderExtensions", "Microsoft.AspNetCore.Routing");
    public static readonly KnownType RouteGroupBuilder = new("Microsoft.AspNetCore.Routing.RouteGroupBuilder", "Microsoft.AspNetCore.Routing");
    public static readonly KnownType WebApplication = new("Microsoft.AspNetCore.Builder.WebApplication", "Microsoft.AspNetCore");

    private static readonly Dictionary<string, string> Verbs = new(StringComparer.Ordinal)
    {
        ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapDelete"] = "DELETE", ["MapPatch"] = "PATCH",
    };

    public string Id => "aspnetcore";
    public string ProviderRouteId => "csharp.roslyn/aspnetcore";

    public sealed class Facts
    {
        public List<EndpointFact> Endpoints { get; } = new();
        public SortedSet<string> AssemblyEvidence { get; } = new(StringComparer.Ordinal);
    }

    public async Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct)
    {
        var facts = new Facts();
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            var routing = compilation.References.Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>()
                .FirstOrDefault(a => a.Identity.Name == "Microsoft.AspNetCore.Routing");
            if (routing == null) continue;
            facts.AssemblyEvidence.Add(SymbolIdentity.VersionEvidence(routing));
            var mvc = compilation.References.Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>()
                .FirstOrDefault(a => a.Identity.Name == "Microsoft.AspNetCore.Mvc.Core");
            if (mvc != null)
            {
                facts.AssemblyEvidence.Add(SymbolIdentity.VersionEvidence(mvc));
                MvcEndpoints.Collect(compilation, project.Id, facts.Endpoints, ct);
            }
            foreach (var (_, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, new[] { "Map" }, ct).ConfigureAwait(false))
            {
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    var name = SymbolIdentity.InvokedName(inv);
                    if (mvc != null && name is "MapControllerRoute" or "MapAreaControllerRoute" or "MapDefaultControllerRoute")
                    {
                        var cm = SymbolIdentity.InvokedMethod(model, inv, ct);
                        if (cm != null && MvcEndpoints.ControllerRouteExtensions.Matches((cm.ReducedFrom ?? cm).ContainingType)
                            && MvcEndpoints.Conventional(inv, cm, model, project.Id, ct) is { } conventional)
                            facts.Endpoints.Add(conventional);
                        continue;
                    }
                    if (name == null || !Verbs.TryGetValue(name, out var verb)) continue;
                    var method = SymbolIdentity.InvokedMethod(model, inv, ct);
                    if (method == null) continue;
                    var def = method.ReducedFrom ?? method;
                    if (!EndpointRouteBuilderExtensions.Matches(def.ContainingType)) continue;
                    var fact = BuildEndpoint(inv, method, verb, model, project.Id, ct);
                    if (fact != null) facts.Endpoints.Add(fact);
                }
            }
        }
        return facts;
    }

    private static EndpointFact? BuildEndpoint(InvocationExpressionSyntax inv, IMethodSymbol method, string verb, SemanticModel model,
        ProjectId projectId, CancellationToken ct)
    {
        var args = inv.ArgumentList.Arguments;
        var reduced = method.ReducedFrom != null;
        var patternIndex = reduced ? 0 : 1;
        if (args.Count <= patternIndex) return null;
        ExpressionSyntax? receiver = reduced ? (inv.Expression as MemberAccessExpressionSyntax)?.Expression : args[0].Expression;
        var limitations = new List<string>();

        var (prefix, prefixDynamic, prefixNote) = receiver != null ? ResolvePrefix(receiver, model, 0, ct) : ("", true, "Unresolved route builder");
        if (prefixNote != null) limitations.Add(prefixNote);
        var (part, partDynamic) = ConstantRoute(args[patternIndex].Expression, model, ct);
        if (partDynamic) limitations.Add("The route pattern is not a compile-time constant; only the known prefix is shown.");
        var dynamic = prefixDynamic || partDynamic;
        var route = prefixDynamic ? Join(prefix, "") : Join(prefix, part);
        if (prefixDynamic && !route.EndsWith('/')) route += "/";

        IMethodSymbol? handler = null;
        var handlerSpan = inv.Span;
        var handlerIndex = patternIndex + 1;
        if (args.Count > handlerIndex)
        {
            var handlerExpr = args[handlerIndex].Expression;
            handlerSpan = handlerExpr.Span;
            if (handlerExpr is not AnonymousFunctionExpressionSyntax)
            {
                var info = model.GetSymbolInfo(handlerExpr, ct);
                handler = info.Symbol as IMethodSymbol ?? info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
            }
        }
        var start = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.SpanStart : inv.SpanStart;
        var location = Location.Create(inv.SyntaxTree, TextSpan.FromBounds(start, inv.Span.End));
        return new EndpointFact(new[] { verb }, route, dynamic, location, handler, inv.SyntaxTree, handlerSpan,
            SymbolIdentity.CompositionRoot(model, inv, ct), projectId, limitations);
    }

    private static (string text, bool dynamic) ConstantRoute(ExpressionSyntax expr, SemanticModel model, CancellationToken ct)
    {
        var constant = model.GetConstantValue(expr, ct);
        if (constant.HasValue && constant.Value is string s) return (s, false);
        if (expr is InterpolatedStringExpressionSyntax interp)
        {
            var known = string.Concat(interp.Contents.TakeWhile(c => c is InterpolatedStringTextSyntax)
                .Cast<InterpolatedStringTextSyntax>().Select(t => t.TextToken.ValueText));
            return (known, true);
        }
        return ("", true);
    }

    private static (string prefix, bool dynamic, string? note) ResolvePrefix(ExpressionSyntax expr, SemanticModel model, int depth, CancellationToken ct)
    {
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;
        if (depth > 8) return ("", true, "Route group chain is too deep to resolve.");
        var type = model.GetTypeInfo(expr, ct).Type;
        if (WebApplication.Matches(type)) return ("", false, null);

        if (expr is InvocationExpressionSyntax inv)
        {
            var m = SymbolIdentity.InvokedMethod(model, inv, ct);
            var recv = (inv.Expression as MemberAccessExpressionSyntax)?.Expression;
            if (m != null && recv != null)
            {
                var def = m.ReducedFrom ?? m;
                if (def.Name == "MapGroup" && EndpointRouteBuilderExtensions.Matches(def.ContainingType) && inv.ArgumentList.Arguments.Count >= 1)
                {
                    var (p, d, n) = ResolvePrefix(recv, model, depth + 1, ct);
                    if (d) return (p, true, n);
                    var (part, partDynamic) = ConstantRoute(inv.ArgumentList.Arguments[0].Expression, model, ct);
                    return partDynamic
                        ? (Join(p, part), true, "A route group prefix is not a compile-time constant.")
                        : (Join(p, part), false, null);
                }
                if (RouteGroupBuilder.Matches(m.ReturnType) && RouteGroupBuilder.Matches(model.GetTypeInfo(recv, ct).Type))
                    return ResolvePrefix(recv, model, depth + 1, ct);
            }
        }
        if (expr is IdentifierNameSyntax id)
        {
            var sym = model.GetSymbolInfo(id, ct).Symbol;
            if (sym is ILocalSymbol local && local.DeclaringSyntaxReferences.Length == 1 &&
                local.DeclaringSyntaxReferences[0].GetSyntax(ct) is VariableDeclaratorSyntax { Initializer: { } init })
            {
                return ResolvePrefix(init.Value, model, depth + 1, ct);
            }
            if (sym is IParameterSymbol ps)
                return ("", true, $"The route prefix depends on the caller of {ps.ContainingSymbol.Name}.");
        }
        return ("", true, "The route builder could not be resolved statically.");
    }

    public static string Join(string prefix, string part)
    {
        var a = prefix.TrimEnd('/');
        var b = part.TrimStart('/');
        var joined = b.Length == 0 ? a : a + "/" + b;
        if (!joined.StartsWith('/')) joined = "/" + joined;
        return joined;
    }

    public string? Detection(object facts)
    {
        var f = (Facts)facts;
        return f.AssemblyEvidence.Count == 0 ? null : string.Join("; ", f.AssemblyEvidence);
    }

    /// <summary>Endpoint whose handler (lambda or argument) contains the span, if any.</summary>
    public static EndpointFact? EnclosingEndpoint(Facts facts, SyntaxTree tree, TextSpan span) =>
        EnclosingEndpoints(facts, tree, span).FirstOrDefault();

    /// <summary>
    /// Every endpoint whose handler contains the span: a Minimal API lambda/handler, or an MVC action body (one action
    /// can serve several routes and an inherited action several controllers).
    /// </summary>
    public static IEnumerable<EndpointFact> EnclosingEndpoints(Facts facts, SyntaxTree tree, TextSpan span) =>
        facts.Endpoints.Where(e => e.Tree == tree && e.HandlerSpan.Length > 0 && e.HandlerSpan.Contains(span));

    public IReadOnlyList<FrameworkRelation> Relate(object factsObj, ISymbol subject, FrameworkContext context)
    {
        var facts = (Facts)factsObj;
        var result = new List<FrameworkRelation>();
        if (subject is INamedTypeSymbol type)
        {
            foreach (var e in facts.Endpoints.Where(e => e.Controller != null && SymbolIdentity.SameDefinition(e.Controller, type)))
            {
                result.Add(new FrameworkRelation(RelationKinds.AspNetEndpoint, RelationGroups.Endpoints,
                    new RelationTarget(Label(e) + " — " + e.Handler?.Name, Endpoint: e),
                    new[] { new EvidenceItem($"{type.Name} is an MVC controller; action {e.Handler?.Name} serves {Label(e)}", e.Location) },
                    e.Confidence, e.Limitations, ProviderRouteId));
            }
            return result;
        }
        if (subject is not IMethodSymbol method) return result;
        foreach (var e in facts.Endpoints.Where(e => e.Handler != null && SymbolIdentity.SameDefinition(e.Handler, method)))
        {
            var role = e.Kind == "mvc" ? $"the MVC action ({e.Controller?.Name})" : "the handler";
            result.Add(new FrameworkRelation(RelationKinds.AspNetEndpoint, RelationGroups.Endpoints,
                new RelationTarget(Label(e), Endpoint: e),
                new[] { new EvidenceItem($"{method.Name} is {role} of {Label(e)}", e.Location) },
                e.Confidence, e.Limitations, ProviderRouteId));
        }
        return result;
    }

    public static string Label(EndpointFact e) =>
        (e.HttpMethods.Count == 0 ? "ANY" : string.Join(",", e.HttpMethods)) + " " + e.Route + (e.RouteIsDynamic ? " (dynamic)" : "");
}
