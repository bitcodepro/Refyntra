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

    private static readonly string[] DispatchNames =
        { "Send", "SendAsync", "Dispatch", "DispatchAsync", "Execute", "ExecuteAsync", "Publish", "PublishAsync", "Handle", "HandleAsync", "Process", "ProcessAsync" };

    private const string Limitation = "Own handler interface (not MediatR): found by its shape; which implementation runs is chosen at run time (DI registration).";

    public sealed record HandlerFact(INamedTypeSymbol HandlerType, ITypeSymbol Request, INamedTypeSymbol Interface);

    public sealed record DispatchFact(Location Location, ITypeSymbol Request, string MethodName, string Container, SyntaxTree Tree, TextSpan Span);

    public sealed class Facts
    {
        public List<HandlerFact> Handlers { get; } = new();
        public List<DispatchFact> Dispatches { get; } = new();
        public SortedSet<string> Interfaces { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>A generic interface named *Handler (not MediatR's) with a method whose first parameter is its first type parameter.</summary>
    public static bool IsHandlerInterface(INamedTypeSymbol iface)
    {
        var def = iface.OriginalDefinition;
        if (def.TypeKind != TypeKind.Interface || def.TypeParameters.Length == 0 || !def.Name.EndsWith("Handler", StringComparison.Ordinal)) return false;
        if (def.ContainingNamespace?.ToDisplayString() is { } ns && (ns == "MediatR" || ns.StartsWith("MediatR.", StringComparison.Ordinal))) return false;
        var first = def.TypeParameters[0];
        return def.GetMembers().OfType<IMethodSymbol>().Any(m => m.Parameters.Length > 0 && SymbolEqualityComparer.Default.Equals(m.Parameters[0].Type, first));
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
                foreach (var iface in type.AllInterfaces.Where(IsHandlerInterface))
                {
                    if (iface.TypeArguments[0] is ITypeParameterSymbol) continue;
                    facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], iface));
                    facts.Interfaces.Add(iface.OriginalDefinition.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat));
                }
            }
        }
        if (facts.Handlers.Count == 0) return facts;

        foreach (var project in context.Projects)
        {
            foreach (var (_, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, DispatchNames, ct).ConfigureAwait(false))
            {
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    var name = SymbolIdentity.InvokedName(inv);
                    if (name == null || Array.IndexOf(DispatchNames, name) < 0) continue;
                    var method = SymbolIdentity.InvokedMethod(model, inv, ct);
                    if (method?.ContainingType == null) continue;
                    var container = method.ContainingType;
                    if (container.ContainingNamespace?.ToDisplayString() is { } ns && (ns == "MediatR" || ns.StartsWith("MediatR.", StringComparison.Ordinal))) continue;
                    ITypeSymbol? request = null;
                    if (container.TypeKind == TypeKind.Interface && IsHandlerInterface(container))
                    {
                        // Through the handler interface (an injected handler): the request type from the interface.
                        request = container.TypeArguments[0];
                    }
                    else if (inv.ArgumentList.Arguments.Count > 0)
                    {
                        // A dispatcher (bus, command processor): its argument is a request that has a handler.
                        var arg = model.GetTypeInfo(inv.ArgumentList.Arguments[0].Expression, ct).Type;
                        if (arg != null && facts.Handlers.Any(h => SymbolIdentity.SameDefinition(h.Request, arg))
                            && !facts.Handlers.Any(h => SymbolIdentity.SameDefinition(h.HandlerType, container)))
                            request = arg;
                    }
                    if (request == null || request.TypeKind is TypeKind.TypeParameter or TypeKind.Error) continue;
                    var at = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.GetLocation();
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
