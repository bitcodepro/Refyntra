using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.MediatR;

/// <summary>
/// The project's own handler interfaces, without MediatR: <c>ICommandHandler&lt;TCommand&gt;</c>,
/// <c>IQueryHandler&lt;TQuery, TResult&gt;</c>, <c>IEventHandler&lt;TEvent&gt;</c>… A generic interface whose name ends in
/// "Handler" and has a method taking its first type argument is a handler interface; its source implementations are the
/// handlers. Dispatch sites are calls through such an interface (an injected handler) and calls of a dispatcher method
/// (Send, Dispatch, Execute, Publish, Handle…) whose argument is a request with a handler. Pattern-based: the relations
/// are "likely"; their kinds (handler.*) are shown like MediatR's in Related, CodeLens and hover.
/// </summary>
public sealed class HandlerInterfacesModule : IFrameworkModule
{
    public string Id => "handlers";
    public string ProviderRouteId => "csharp.roslyn/handlers";

    private const string Limitation = "Own handler interface (not MediatR): found by its shape; which implementation runs is chosen at run time (DI registration).";

    public sealed record HandlerFact(INamedTypeSymbol HandlerType, ITypeSymbol Request, INamedTypeSymbol Interface);

    public sealed record DispatchFact(Location Location, ITypeSymbol Request, string MethodName, string Container, SyntaxTree Tree, TextSpan Span);

    public sealed class Facts
    {
        public List<HandlerFact> Handlers { get; } = new();
        public List<DispatchFact> Dispatches { get; } = new();
        public SortedSet<string> Interfaces { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>
    /// A handler interface: generic, named *Handler, and either declaring a method that takes its first type argument
    /// (ICommandHandler&lt;T&gt; { Task Handle(T, …) }) or deriving from another *Handler interface (the CQRS layer over
    /// MediatR: IQueryHandler&lt;TQuery, T&gt; : IRequestHandler&lt;TQuery, T&gt;). A resolved MediatR handler interface is
    /// MediatR's module's; an unresolved one (packages not restored, so MediatR is an error type) is handled here.
    /// </summary>
    public static bool IsHandlerInterface(INamedTypeSymbol iface)
    {
        var def = iface.OriginalDefinition;
        if (iface.TypeArguments.Length == 0 || !def.Name.EndsWith("Handler", StringComparison.Ordinal)) return false;
        if (def.TypeKind == TypeKind.Error) return true;
        if (def.TypeKind != TypeKind.Interface) return false;
        if (IsMediatR(def) || def.AllInterfaces.Any(IsMediatR)) return false;
        var first = def.TypeParameters[0];
        if (def.GetMembers().OfType<IMethodSymbol>().Any(m => m.Parameters.Length > 0 && SymbolEqualityComparer.Default.Equals(m.Parameters[0].Type, first)))
            return true;
        return def.Interfaces.Any(b => b.Name.EndsWith("Handler", StringComparison.Ordinal) && b.TypeArguments.Length > 0);
    }

    /// <summary>A resolved MediatR type (MediatR's module relates those).</summary>
    private static bool IsMediatR(INamedTypeSymbol t) =>
        t.TypeKind != TypeKind.Error && t.ContainingNamespace?.ToDisplayString() is { } ns && (ns == "MediatR" || ns.StartsWith("MediatR.", StringComparison.Ordinal));

    private static async Task AddFromBaseListAsync(INamedTypeSymbol type, Project project, Facts facts, HashSet<ITypeSymbol> requests, CancellationToken ct)
    {
        foreach (var r in type.DeclaringSyntaxReferences)
        {
            if (await r.GetSyntaxAsync(ct).ConfigureAwait(false) is not Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax decl || decl.BaseList == null) continue;
            var doc = project.GetDocument(decl.SyntaxTree);
            var model = doc == null ? null : await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model == null) continue;
            foreach (var b in decl.BaseList.Types)
            {
                var generic = b.Type switch
                {
                    Microsoft.CodeAnalysis.CSharp.Syntax.GenericNameSyntax g => g,
                    Microsoft.CodeAnalysis.CSharp.Syntax.QualifiedNameSyntax { Right: Microsoft.CodeAnalysis.CSharp.Syntax.GenericNameSyntax g } => g,
                    _ => null,
                };
                if (generic == null || !generic.Identifier.ValueText.EndsWith("Handler", StringComparison.Ordinal) || generic.TypeArgumentList.Arguments.Count == 0) continue;
                if (model.GetTypeInfo(b.Type, ct).Type is not INamedTypeSymbol iface || iface.TypeKind != TypeKind.Error) continue;
                if (model.GetTypeInfo(generic.TypeArgumentList.Arguments[0], ct).Type is not { } request || request is ITypeParameterSymbol || request.TypeKind == TypeKind.Error) continue;
                if (!requests.Add(request)) continue;
                facts.Handlers.Add(new HandlerFact(type, request, iface));
                facts.Interfaces.Add(generic.Identifier.ValueText + "<…> (unresolved)");
            }
        }
    }

    public async Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct)
    {
        var facts = new Facts();
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            foreach (var type in SourceTypes(compilation.Assembly.GlobalNamespace))
            {
                if (type.IsAbstract || type.TypeKind != TypeKind.Class) continue;
                // One fact per handler and request: IQueryHandler<Q, R> and the IRequestHandler<Q, R> it derives from are
                // the same handler; the most specific interface (the first, the project's own) names it.
                var requests = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
                foreach (var iface in type.AllInterfaces.Where(IsHandlerInterface))
                {
                    if (iface.TypeArguments[0] is ITypeParameterSymbol || !requests.Add(iface.TypeArguments[0])) continue;
                    facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], iface));
                    facts.Interfaces.Add(iface.OriginalDefinition.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat));
                }
                // An unresolved generic base (IRequestHandler<X> while MediatR's package is not restored) keeps no type
                // arguments in its error symbol: the request is read from the declaration's base list.
                if (requests.Count == 0) await AddFromBaseListAsync(type, project, facts, requests, ct).ConfigureAwait(false);
            }
        }
        if (facts.Handlers.Count == 0) return facts;

        // Dispatch sites, whatever the method is called (HandleRequest, QueryAsync, RunCommand…): a call through the handler
        // interface, or any call that receives a request object whose handler is in source. Compared by identity: the
        // request type seen from the controller's project is another symbol instance than in the handler's project.
        string Key(ISymbol x) => (DocumentationCommentId.CreateDeclarationId(x.OriginalDefinition) ?? x.ToDisplayString()) + "|" + x.ContainingAssembly?.Identity.Name;
        var handled = facts.Handlers.Select(h => Key(h.Request)).ToHashSet(StringComparer.Ordinal);
        var handlerTypes = facts.Handlers.Select(h => Key(h.HandlerType)).ToHashSet(StringComparer.Ordinal);
        foreach (var project in context.Projects)
        {
            foreach (var doc in project.Documents)
            {
                var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                if (root == null) continue;
                SemanticModel? model = null;
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    if (inv.ArgumentList.Arguments.Count == 0) continue;
                    model ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                    if (model == null) break;
                    var method = SymbolIdentity.InvokedMethod(model, inv, ct);
                    var container = method?.ContainingType;
                    if (container?.ContainingNamespace?.ToDisplayString() is { } ns && (ns == "MediatR" || ns.StartsWith("MediatR.", StringComparison.Ordinal))) continue;
                    var name = SymbolIdentity.InvokedName(inv) ?? method?.Name ?? "call";
                    ITypeSymbol? request = null;
                    if (container is { TypeKind: TypeKind.Interface } && IsHandlerInterface(container))
                        request = container.TypeArguments[0];
                    else
                    {
                        var enclosing = model.GetEnclosingSymbol(inv.SpanStart, ct)?.ContainingType;
                        if (enclosing != null && handlerTypes.Contains(Key(enclosing))) continue;
                        foreach (var arg in inv.ArgumentList.Arguments)
                            if (model.GetTypeInfo(arg.Expression, ct).Type is INamedTypeSymbol t && t.TypeKind is TypeKind.Class or TypeKind.Struct && handled.Contains(Key(t)))
                            {
                                request = t;
                                break;
                            }
                    }
                    if (request == null || request.TypeKind is TypeKind.TypeParameter or TypeKind.Error) continue;
                    var at = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.Expression.GetLocation();
                    facts.Dispatches.Add(new DispatchFact(at, request, name, SymbolIdentity.CompositionRoot(model, inv, ct), inv.SyntaxTree, inv.Span));
                }
            }
        }
        return facts;
    }

    public string? Detection(object facts)
    {
        var f = (Facts)facts;
        return f.Handlers.Count == 0 ? null : "Handler interfaces: " + string.Join(", ", f.Interfaces);
    }

    public IReadOnlyList<FrameworkRelation> Relate(object factsObj, ISymbol subject, FrameworkContext context)
    {
        var facts = (Facts)factsObj;
        var result = new List<FrameworkRelation>();
        if (facts.Handlers.Count == 0) return result;
        var limitations = new[] { Limitation };

        // Outgoing: a method or type that dispatches → the handler of each request.
        if (subject is IMethodSymbol or INamedTypeSymbol && subject.DeclaringSyntaxReferences.Length > 0)
        {
            var declarations = subject.DeclaringSyntaxReferences;
            foreach (var byRequest in facts.Dispatches.Where(d => declarations.Any(r => r.SyntaxTree == d.Tree && r.Span.Contains(d.Span)))
                         .GroupBy(d => d.Request.OriginalDefinition, SymbolEqualityComparer.Default))
            {
                var request = (ITypeSymbol)byRequest.Key!;
                var evidence = byRequest.Select(d => new EvidenceItem($"{d.MethodName}({request.Name}) in {d.Container}", d.Location)).ToList();
                foreach (var h in facts.Handlers.Where(h => SymbolIdentity.SameDefinition(h.Request, request)))
                    result.Add(new FrameworkRelation(RelationKinds.Handler, RelationGroups.Handlers,
                        new RelationTarget($"{request.Name} → {h.HandlerType.Name}", Symbol: h.HandlerType),
                        evidence.Append(new EvidenceItem($"{h.HandlerType.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}",
                            h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource))).ToList(),
                        Confidences.Likely, limitations, ProviderRouteId));
            }
        }

        var type = subject switch
        {
            INamedTypeSymbol t => t,
            IMethodSymbol { MethodKind: MethodKind.Constructor } c => c.ContainingType,
            IMethodSymbol m when facts.Handlers.Any(h => SymbolIdentity.SameDefinition(h.HandlerType, m.ContainingType)) => m.ContainingType,
            _ => null,
        };
        if (type == null) return result;

        // A request type: its handlers and where it is dispatched.
        var handlers = facts.Handlers.Where(h => SymbolIdentity.SameDefinition(h.Request, type)).ToList();
        foreach (var h in handlers)
            result.Add(new FrameworkRelation(RelationKinds.Handler, RelationGroups.Handlers,
                new RelationTarget(h.HandlerType.Name, Symbol: h.HandlerType),
                new[] { new EvidenceItem($"{h.HandlerType.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}", h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource)) },
                Confidences.Likely, limitations, ProviderRouteId));
        if (handlers.Count > 0) AddDispatches(facts, type, type.Name, result, limitations);

        // A handler: its request, and every place that reaches it.
        foreach (var h in facts.Handlers.Where(h => SymbolIdentity.SameDefinition(h.HandlerType, type)))
        {
            result.Add(new FrameworkRelation(RelationKinds.HandlerRequest, RelationGroups.Declarations,
                new RelationTarget(h.Request.Name, Symbol: h.Request),
                new[] { new EvidenceItem($"{type.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}") },
                Confidences.Likely, limitations, ProviderRouteId));
            AddDispatches(facts, h.Request, h.Request.Name, result, limitations);
        }
        return result;
    }

    private void AddDispatches(Facts facts, ITypeSymbol request, string requestName, List<FrameworkRelation> result, IReadOnlyList<string> limitations)
    {
        foreach (var d in facts.Dispatches.Where(d => SymbolIdentity.SameDefinition(d.Request, request)))
            result.Add(new FrameworkRelation(RelationKinds.HandlerDispatch, RelationGroups.Callers,
                new RelationTarget($"{d.MethodName}({requestName}) in {d.Container}", Location: d.Location),
                new[] { new EvidenceItem($"{d.MethodName}({requestName}) dispatches to a {requestName} handler", d.Location) },
                Confidences.Likely, limitations, ProviderRouteId));
    }

    private static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol child)
                foreach (var t in SourceTypes(child)) yield return t;
            else if (member is INamedTypeSymbol type)
                foreach (var t in WithNested(type)) yield return t;
        }
    }

    private static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
    {
        if (type.Locations.Any(l => l.IsInSource)) yield return type;
        foreach (var nested in type.GetTypeMembers())
            foreach (var t in WithNested(nested)) yield return t;
    }
}
