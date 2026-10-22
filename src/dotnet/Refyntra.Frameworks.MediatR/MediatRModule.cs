using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.MediatR;

/// <summary>
/// MediatR request/notification ↔ handler and Send/Publish call sites. Identity is checked by metadata name, generic
/// arity and declaring assembly ("MediatR" / "MediatR.Contracts"); a same-name interface elsewhere never matches.
/// </summary>
public sealed class MediatRModule : IFrameworkModule
{
    private static readonly string[] ContractAssemblies = { "MediatR", "MediatR.Contracts" };
    private static readonly string[] CoreAssembly = { "MediatR" };

    public static readonly KnownType IRequest1 = new("MediatR.IRequest`1", ContractAssemblies);
    public static readonly KnownType IRequest0 = new("MediatR.IRequest", ContractAssemblies);
    public static readonly KnownType IBaseRequest = new("MediatR.IBaseRequest", ContractAssemblies);
    public static readonly KnownType INotification = new("MediatR.INotification", ContractAssemblies);
    public static readonly KnownType IRequestHandler2 = new("MediatR.IRequestHandler`2", CoreAssembly);
    public static readonly KnownType IRequestHandler1 = new("MediatR.IRequestHandler`1", CoreAssembly);
    public static readonly KnownType INotificationHandler1 = new("MediatR.INotificationHandler`1", CoreAssembly);
    public static readonly KnownType ISender = new("MediatR.ISender", CoreAssembly);
    public static readonly KnownType IPublisher = new("MediatR.IPublisher", CoreAssembly);
    public static readonly KnownType IMediator = new("MediatR.IMediator", CoreAssembly);
    public static readonly KnownType Mediator = new("MediatR.Mediator", CoreAssembly);
    public static readonly KnownType IStreamRequest1 = new("MediatR.IStreamRequest`1", ContractAssemblies);
    public static readonly KnownType IStreamRequestHandler2 = new("MediatR.IStreamRequestHandler`2", CoreAssembly);
    public static readonly KnownType IPipelineBehavior2 = new("MediatR.IPipelineBehavior`2", CoreAssembly);
    public static readonly KnownType IStreamPipelineBehavior2 = new("MediatR.IStreamPipelineBehavior`2", CoreAssembly);

    public string Id => "mediatr";
    public string ProviderRouteId => "csharp.roslyn/mediatr";

    public sealed record HandlerFact(INamedTypeSymbol HandlerType, ITypeSymbol Request, ITypeSymbol? Response, bool IsNotification,
        INamedTypeSymbol Interface, ProjectId ProjectId);

    /// <summary>An IPipelineBehavior / IStreamPipelineBehavior implementation; open generic when its request is a type parameter.</summary>
    public sealed record BehaviorFact(INamedTypeSymbol BehaviorType, INamedTypeSymbol Interface, bool IsStream, ProjectId ProjectId)
    {
        public ITypeSymbol Request => Interface.TypeArguments[0];
        public bool IsOpenGeneric => Request is ITypeParameterSymbol;
    }

    /// <summary>
    /// A place that dispatches a request: Send / Publish / CreateStream on a MediatR sender, or Handle called on an
    /// injected handler interface (IRequestHandler&lt;TRequest, TResponse&gt;; DI picks the implementation at run time).
    /// </summary>
    public sealed record SendFact(Location Location, ITypeSymbol RequestType, string MethodName, string Container, ProjectId ProjectId,
        SyntaxTree Tree, TextSpan Span, bool Notification = false, bool Inferred = false);

    public sealed class Facts
    {
        public List<HandlerFact> Handlers { get; } = new();
        public List<BehaviorFact> Behaviors { get; } = new();
        public List<SendFact> Sends { get; } = new();
        public SortedSet<string> AssemblyEvidence { get; } = new(StringComparer.Ordinal);
        public bool VersionVerified { get; set; } = true;
        public int UnresolvedSendSites { get; set; }
    }

    /// <summary>A method that forwards one of its parameters to Send / Publish (or to another wrapper).</summary>
    private sealed record Wrapper(IMethodSymbol Method, int Ordinal, bool Notification);

    public async Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct)
    {
        var facts = new Facts();
        var wrappers = new Dictionary<IMethodSymbol, Wrapper>(SymbolEqualityComparer.Default);
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            var mediatrAssemblies = compilation.References
                .Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>()
                .Where(a => ContractAssemblies.Contains(a.Identity.Name)).ToList();
            if (mediatrAssemblies.Count == 0) continue;
            foreach (var a in mediatrAssemblies)
            {
                facts.AssemblyEvidence.Add(SymbolIdentity.VersionEvidence(a));
                if (!IsVerifiedVersion(a.Identity)) facts.VersionVerified = false;
            }

            foreach (var type in AllSourceTypes(compilation.Assembly.GlobalNamespace))
            {
                foreach (var iface in type.AllInterfaces)
                {
                    if (IRequestHandler2.Matches(iface))
                        facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], iface.TypeArguments[1], false, iface, project.Id));
                    else if (IRequestHandler1.Matches(iface))
                        facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], null, false, iface, project.Id));
                    else if (INotificationHandler1.Matches(iface))
                        facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], null, true, iface, project.Id));
                    else if (IStreamRequestHandler2.Matches(iface))
                        facts.Handlers.Add(new HandlerFact(type, iface.TypeArguments[0], iface.TypeArguments[1], false, iface, project.Id));
                    else if ((IPipelineBehavior2.Matches(iface) || IStreamPipelineBehavior2.Matches(iface)) && !type.IsAbstract)
                        facts.Behaviors.Add(new BehaviorFact(type, iface, IStreamPipelineBehavior2.Matches(iface), project.Id));
                }
            }

            foreach (var (doc, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, new[] { "Send", "Publish", "CreateStream", "Handle" }, ct).ConfigureAwait(false))
            {
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    var name = SymbolIdentity.InvokedName(inv);
                    if (name is not ("Send" or "Publish" or "CreateStream" or "Handle")) continue;
                    var method = SymbolIdentity.InvokedMethod(model, inv, ct);
                    if (method == null) continue;
                    var container = method.ContainingType;
                    if (name == "Handle")
                    {
                        // Only a call through the handler interface (an injected IRequestHandler<,>): the request type
                        // comes from the interface, the implementation from DI. A call on a concrete handler is a
                        // plain reference.
                        if (container.TypeKind != TypeKind.Interface || container.TypeArguments.Length == 0) continue;
                        var notification = INotificationHandler1.Matches(container);
                        if (!(notification || IRequestHandler2.Matches(container) || IRequestHandler1.Matches(container) || IStreamRequestHandler2.Matches(container))) continue;
                        var requestType = container.TypeArguments[0];
                        if (requestType.TypeKind is TypeKind.TypeParameter or TypeKind.Error) { facts.UnresolvedSendSites++; continue; }
                        var at = inv.Expression is MemberAccessExpressionSyntax hm ? hm.Name.GetLocation() : inv.GetLocation();
                        facts.Sends.Add(new SendFact(at, requestType, "Handle", SymbolIdentity.CompositionRoot(model, inv, ct), project.Id,
                            inv.SyntaxTree, inv.Span, notification));
                        continue;
                    }
                    if (!(ISender.Matches(container) || IPublisher.Matches(container) || IMediator.Matches(container) || Mediator.Matches(container)))
                        continue;
                    if (inv.ArgumentList.Arguments.Count == 0) continue;
                    var argType = model.GetTypeInfo(inv.ArgumentList.Arguments[0].Expression, ct).Type;
                    if (argType == null || argType.TypeKind is TypeKind.Interface or TypeKind.TypeParameter or TypeKind.Error
                        || argType.SpecialType == SpecialType.System_Object)
                    {
                        // Send(request) where request is a parameter of the enclosing method: that method is a wrapper
                        // (a base controller's HandleRequest<T>(T request), an extension method…); its callers name the type.
                        if (!TryAddWrapper(model, inv.ArgumentList.Arguments[0].Expression, name, name == "Publish", wrappers, ct))
                            facts.UnresolvedSendSites++;
                        continue;
                    }
                    var location = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.GetLocation();
                    facts.Sends.Add(new SendFact(location, argType, name, SymbolIdentity.CompositionRoot(model, inv, ct), project.Id,
                        inv.SyntaxTree, inv.Span, name == "Publish"));
                }
            }
        }
        await ResolveWrapperCallsAsync(context, facts, wrappers, ct).ConfigureAwait(false);
        await ScanRequestArgumentsAsync(context, facts, ct).ConfigureAwait(false);
        return facts;
    }

    /// <summary>
    /// Any other call that receives a request object with a handler in source (a helper of a base controller shipped in a
    /// package, a dispatcher interface without source, Mediator.Send through dynamic…): a likely dispatch, named after
    /// the called method. Calls already found (Send, wrappers) are not repeated; constructors and the handlers' own
    /// calls are not counted.
    /// </summary>
    private static async Task ScanRequestArgumentsAsync(FrameworkContext context, Facts facts, CancellationToken ct)
    {
        if (facts.Handlers.Count == 0) return;
        // By identity across projects (a request type seen from the controller's project is another symbol instance).
        var handled = facts.Handlers.Select(h => DefinitionKey(h.Request.OriginalDefinition)).ToHashSet(StringComparer.Ordinal);
        var handlerTypes = facts.Handlers.Select(h => DefinitionKey(h.HandlerType.OriginalDefinition)).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<(SyntaxTree, TextSpan)>(facts.Sends.Select(x => (x.Tree, x.Span)));
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null || !compilation.References.Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>().Any(a => ContractAssemblies.Contains(a.Identity.Name)))
                continue;
            foreach (var doc in project.Documents)
            {
                var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                if (root == null) continue;
                SemanticModel? model = null;
                foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    if (inv.ArgumentList.Arguments.Count == 0 || seen.Contains((inv.SyntaxTree, inv.Span))) continue;
                    model ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                    if (model == null) break;
                    foreach (var arg in inv.ArgumentList.Arguments)
                    {
                        if (model.GetTypeInfo(arg.Expression, ct).Type is not INamedTypeSymbol t || t.TypeKind is not (TypeKind.Class or TypeKind.Struct)) continue;
                        if (!handled.Contains(DefinitionKey(t.OriginalDefinition))) continue;
                        var container = model.GetEnclosingSymbol(inv.SpanStart, ct)?.ContainingType;
                        if (container != null && handlerTypes.Contains(DefinitionKey(container.OriginalDefinition))) continue;
                        var notification = t.AllInterfaces.Any(i => INotification.Matches(i));
                        var name = SymbolIdentity.InvokedName(inv) ?? "call";
                        var at = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.Expression.GetLocation();
                        facts.Sends.Add(new SendFact(at, t, name, SymbolIdentity.CompositionRoot(model, inv, ct), project.Id, inv.SyntaxTree, inv.Span, notification, Inferred: true));
                        seen.Add((inv.SyntaxTree, inv.Span));
                        break;
                    }
                }
            }
        }
    }

    /// <summary>A symbol's identity across compilations (as SymbolIdentity.SameDefinition compares it).</summary>
    private static string DefinitionKey(ISymbol s) => (DocumentationCommentId.CreateDeclarationId(s) ?? s.ToDisplayString()) + "|" + s.ContainingAssembly?.Identity.Name;

    /// <summary>Records the enclosing method as a wrapper when <paramref name="argument"/> is one of its parameters.</summary>
    private static bool TryAddWrapper(SemanticModel model, ExpressionSyntax argument, string sendName, bool notification,
        Dictionary<IMethodSymbol, Wrapper> wrappers, CancellationToken ct)
    {
        var expr = argument;
        while (expr is CastExpressionSyntax c) expr = c.Expression;
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;
        if (model.GetSymbolInfo(expr, ct).Symbol is not IParameterSymbol parameter) return false;
        if (parameter.ContainingSymbol is not IMethodSymbol method || method.MethodKind is MethodKind.AnonymousFunction or MethodKind.LambdaMethod) return false;
        var key = method.OriginalDefinition;
        if (!wrappers.ContainsKey(key)) wrappers[key] = new Wrapper(key, parameter.Ordinal, notification);
        return true;
    }

    /// <summary>
    /// Calls of the wrappers (and of wrappers of wrappers, a few levels): the request type comes from the call's
    /// argument, e.g. <c>HandleRequest(new RefreshSettingsCommand())</c> in a controller derived from a base
    /// controller whose HandleRequest&lt;T&gt; sends it.
    /// </summary>
    private static async Task ResolveWrapperCallsAsync(FrameworkContext context, Facts facts, Dictionary<IMethodSymbol, Wrapper> wrappers, CancellationToken ct)
    {
        var done = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        var seen = new HashSet<(SyntaxTree, TextSpan)>(facts.Sends.Select(x => (x.Tree, x.Span)));
        for (var level = 0; level < 4; level++)
        {
            var pending = wrappers.Values.Where(w => !done.Contains(w.Method)).ToList();
            if (pending.Count == 0) break;
            foreach (var w in pending) done.Add(w.Method);
            var names = pending.Select(w => w.Method.Name).Distinct().ToArray();
            foreach (var project in context.Projects)
            {
                foreach (var (_, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, names, ct).ConfigureAwait(false))
                {
                    foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        if (SymbolIdentity.InvokedName(inv) is not { } n || Array.IndexOf(names, n) < 0) continue;
                        if (SymbolIdentity.InvokedMethod(model, inv, ct) is not { } called) continue;
                        var target = (called.ReducedFrom ?? called).OriginalDefinition;
                        // An override or an implementation of the wrapper counts as the wrapper.
                        // By identity, not by symbol instance: the wrapper is often in another project (a shared base
                        // controller) than the controllers that call it.
                        var targetKey = DefinitionKey(target);
                        var overriddenKey = target.OverriddenMethod is { } o ? DefinitionKey(o.OriginalDefinition) : null;
                        var w = pending.FirstOrDefault(x => DefinitionKey(x.Method) == targetKey || DefinitionKey(x.Method) == overriddenKey);
                        if (w == null) continue;
                        var ordinal = called.ReducedFrom != null ? w.Ordinal - 1 : w.Ordinal;
                        if (ordinal < 0 || ordinal >= inv.ArgumentList.Arguments.Count) continue;
                        var argExpr = inv.ArgumentList.Arguments[ordinal].Expression;
                        var argType = model.GetTypeInfo(argExpr, ct).Type;
                        if (argType == null || argType.TypeKind is TypeKind.Interface or TypeKind.TypeParameter or TypeKind.Error
                            || argType.SpecialType == SpecialType.System_Object)
                        {
                            TryAddWrapper(model, argExpr, n, w.Notification, wrappers, ct);
                            continue;
                        }
                        if (!seen.Add((inv.SyntaxTree, inv.Span))) continue;
                        var location = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.Expression.GetLocation();
                        facts.Sends.Add(new SendFact(location, argType, n, SymbolIdentity.CompositionRoot(model, inv, ct), project.Id,
                            inv.SyntaxTree, inv.Span, w.Notification));
                    }
                }
            }
        }
    }

    private static bool IsVerifiedVersion(AssemblyIdentity id) => id.Name switch
    {
        // MediatR 12.x ships assembly version 12.0.0.0; MediatR.Contracts 2.x ships 2.0.0.0 (Apache-2.0 line).
        "MediatR" => id.Version.Major is >= 10 and <= 12,
        "MediatR.Contracts" => id.Version.Major is 1 or 2,
        _ => false,
    };

    public string? Detection(object facts)
    {
        var f = (Facts)facts;
        return f.AssemblyEvidence.Count == 0 ? null : string.Join("; ", f.AssemblyEvidence);
    }

    private static IEnumerable<INamedTypeSymbol> AllSourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol child)
                foreach (var t in AllSourceTypes(child)) yield return t;
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

    /// <summary>
    /// Contravariance: INotificationHandler&lt;in TNotification&gt; — a handler of a base notification (class or
    /// interface) also receives this one when the container resolves handlers variantly. Reported as likely.
    /// </summary>
    private void RelateBaseNotificationHandlers(Facts facts, INamedTypeSymbol type, IReadOnlyList<string> versionLimit,
        EvidenceItem assemblyEvidence, List<FrameworkRelation> result)
    {
        foreach (var h in facts.Handlers.Where(h => h.IsNotification && h.Request is INamedTypeSymbol
                     && !SymbolIdentity.SameDefinition(h.Request, type) && IsBaseOf(h.Request, type)))
        {
            result.Add(new FrameworkRelation(RelationKinds.MediatRNotificationHandler, RelationGroups.Handlers,
                new RelationTarget($"{h.HandlerType.Name} (handles base {h.Request.Name})", Symbol: h.HandlerType),
                new[]
                {
                    new EvidenceItem($"{h.HandlerType.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)} and {type.Name} derives from {h.Request.Name}",
                        h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource)),
                    assemblyEvidence,
                },
                Confidences.Likely,
                versionLimit.Append("Applies through contravariance (INotificationHandler<in T>); whether the container dispatches variantly depends on the MediatR/DI version and registration.").ToList(),
                ProviderRouteId));
        }
    }

    /// <summary>
    /// Pipeline behaviors as known relations of a request: closed ones for exactly this request (version confidence),
    /// open generic ones whose constraints the request satisfies as likely. Registration and order are never claimed.
    /// </summary>
    private void RelateBehaviors(Facts facts, INamedTypeSymbol type, bool isStream, string confidence, IReadOnlyList<string> versionLimit,
        EvidenceItem assemblyEvidence, List<FrameworkRelation> result)
    {
        foreach (var b in facts.Behaviors.Where(b => b.IsStream == isStream))
        {
            string label, relConfidence;
            var limitations = new List<string>(versionLimit) { "Pipeline order is not claimed: the runtime order depends on registration order." };
            if (b.IsOpenGeneric)
            {
                if (!SatisfiesConstraints((ITypeParameterSymbol)b.Request, type)) continue;
                label = $"{b.BehaviorType.Name} — applies to every request (open generic)";
                relConfidence = Confidences.Likely;
                limitations.Add("Open generic behavior: applies only if it is registered (as an open generic); constraints are checked statically.");
            }
            else
            {
                if (!SymbolIdentity.SameDefinition(b.Request, type)) continue;
                label = b.BehaviorType.Name;
                relConfidence = confidence;
                limitations.Add("Whether the behavior is registered is not proven.");
            }
            result.Add(new FrameworkRelation(RelationKinds.MediatRBehavior, RelationGroups.Handlers,
                new RelationTarget(label, Symbol: b.BehaviorType),
                new[]
                {
                    new EvidenceItem($"{b.BehaviorType.Name} implements {b.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}",
                        b.BehaviorType.Locations.FirstOrDefault(l => l.IsInSource)),
                    assemblyEvidence,
                },
                relConfidence, limitations, ProviderRouteId));
        }
    }

    /// <summary>True when <paramref name="baseType"/> is a base class or an implemented interface of <paramref name="type"/>.</summary>
    private static bool IsBaseOf(ITypeSymbol baseType, INamedTypeSymbol type)
    {
        for (var t = type.BaseType; t != null; t = t.BaseType)
            if (SymbolEqualityComparer.Default.Equals(t, baseType) || SymbolIdentity.SameDefinition(t, baseType) && !t.IsGenericType) return true;
        return type.AllInterfaces.Any(i => SymbolEqualityComparer.Default.Equals(i, baseType) || SymbolIdentity.SameDefinition(i, baseType) && !i.IsGenericType);
    }

    /// <summary>
    /// Static check that the request can be the open behavior's TRequest: class/struct constraints and constraint types.
    /// A constraint that mentions another type parameter (e.g. IRequest&lt;TResponse&gt;) is accepted when the request
    /// implements or derives from that generic definition at all.
    /// </summary>
    private static bool SatisfiesConstraints(ITypeParameterSymbol tp, INamedTypeSymbol request)
    {
        if (tp.HasReferenceTypeConstraint && !request.IsReferenceType) return false;
        if (tp.HasValueTypeConstraint && !request.IsValueType) return false;
        foreach (var c in tp.ConstraintTypes)
        {
            if (c is not INamedTypeSymbol nc) return false;
            if (nc.TypeArguments.Any(a => a is ITypeParameterSymbol))
            {
                var def = nc.OriginalDefinition;
                var found = request.AllInterfaces.Any(i => SymbolEqualityComparer.Default.Equals(i.OriginalDefinition, def));
                for (var t = request.BaseType; t != null && !found; t = t.BaseType)
                    found = SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, def);
                if (!found) return false;
                continue;
            }
            if (SymbolEqualityComparer.Default.Equals(nc, request) || IsBaseOf(nc, request)) continue;
            return false;
        }
        return true;
    }

    /// <summary>
    /// The other direction: a controller, endpoint method or any code that calls Send / Publish / CreateStream gets, per
    /// request it sends, the handler(s) that serve it ("GetOrderQuery → GetOrderQueryHandler"). Subject: a method (its
    /// body) or a type (all its members); the request type comes from the call's argument, as for the Send callers.
    /// </summary>
    private void RelateOutgoingSends(Facts facts, ISymbol subject, List<FrameworkRelation> result)
    {
        if (subject is not (IMethodSymbol or INamedTypeSymbol)) return;
        var declarations = subject.DeclaringSyntaxReferences;
        if (declarations.Length == 0) return;
        var inside = facts.Sends.Where(s => declarations.Any(d => d.SyntaxTree == s.Tree && d.Span.Contains(s.Span))).ToList();
        if (inside.Count == 0) return;
        var confidence = facts.VersionVerified ? Confidences.Proven : Confidences.Likely;
        var versionLimit = facts.VersionVerified ? Array.Empty<string>() : new[] { "Unverified MediatR version: " + string.Join("; ", facts.AssemblyEvidence) };
        foreach (var byRequest in inside.GroupBy(s => s.RequestType.OriginalDefinition, SymbolEqualityComparer.Default))
        {
            var request = (ITypeSymbol)byRequest.Key!;
            var sends = byRequest.ToList();
            var isNotification = sends[0].Notification;
            var callEvidence = sends.Select(s => new EvidenceItem($"{s.MethodName}({request.Name}) in {s.Container}", s.Location)).ToList();
            var handlers = facts.Handlers.Where(h => h.IsNotification == isNotification && SymbolIdentity.SameDefinition(h.Request, request)).ToList();
            if (handlers.Count == 0)
            {
                result.Add(new FrameworkRelation(RelationKinds.MediatRRequest, RelationGroups.Handlers,
                    new RelationTarget($"{request.Name} → no handler in source", Symbol: request),
                    callEvidence, Confidences.Likely,
                    versionLimit.Append("No handler of this request was found in the loaded projects (it may live in another solution or a package).").ToList(),
                    ProviderRouteId));
                continue;
            }
            // Only through calls that merely receive the request (not Send or a wrapper seen in source): likely.
            var inferred = sends.All(x => x.Inferred);
            foreach (var h in handlers)
            {
                var limitations = new List<string>(versionLimit);
                if (!isNotification && handlers.Count > 1)
                    limitations.Add($"{handlers.Count} source handlers found; which one runs depends on runtime registration.");
                if (inferred)
                    limitations.Add($"The request is passed to {string.Join(", ", sends.Select(x => x.MethodName).Distinct())}, whose Send is not in source (a package, an interface): the dispatch is assumed.");
                result.Add(new FrameworkRelation(
                    isNotification ? RelationKinds.MediatRNotificationHandler : RelationKinds.MediatRHandler,
                    RelationGroups.Handlers,
                    new RelationTarget($"{request.Name} → {h.HandlerType.Name}", Symbol: h.HandlerType),
                    callEvidence.Append(new EvidenceItem($"{h.HandlerType.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}",
                        h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource))).ToList(),
                    inferred ? Confidences.Likely : confidence, limitations, ProviderRouteId));
            }
        }
    }

    public IReadOnlyList<FrameworkRelation> Relate(object factsObj, ISymbol subject, FrameworkContext context)
    {
        var facts = (Facts)factsObj;
        var result = new List<FrameworkRelation>();
        if (facts.AssemblyEvidence.Count == 0) return result;
        RelateOutgoingSends(facts, subject, result);
        var type = subject switch
        {
            INamedTypeSymbol t => t,
            IMethodSymbol { MethodKind: MethodKind.Constructor } c => c.ContainingType,
            IMethodSymbol { Name: "Handle" } h => h.ContainingType,
            _ => null,
        };
        if (type == null) return result;

        var confidence = facts.VersionVerified ? Confidences.Proven : Confidences.Likely;
        var versionLimit = facts.VersionVerified ? Array.Empty<string>() : new[] { "Unverified MediatR version: " + string.Join("; ", facts.AssemblyEvidence) };
        var assemblyEvidence = new EvidenceItem("MediatR identity: " + string.Join("; ", facts.AssemblyEvidence));

        var isStream = type.AllInterfaces.Any(i => IStreamRequest1.Matches(i));
        var isRequest = isStream || type.AllInterfaces.Any(i => IRequest1.Matches(i) || IRequest0.Matches(i));
        var isNotification = type.AllInterfaces.Any(i => INotification.Matches(i));

        if (isRequest || isNotification)
        {
            var handlers = facts.Handlers.Where(h => h.IsNotification == isNotification && SymbolIdentity.SameDefinition(h.Request, type)).ToList();
            foreach (var h in handlers)
            {
                var limitations = new List<string>(versionLimit);
                if (!isNotification && handlers.Count > 1)
                    limitations.Add($"{handlers.Count} source handlers found; which one runs depends on runtime registration.");
                result.Add(new FrameworkRelation(
                    isNotification ? RelationKinds.MediatRNotificationHandler : RelationKinds.MediatRHandler,
                    RelationGroups.Handlers,
                    new RelationTarget(h.HandlerType.Name, Symbol: h.HandlerType),
                    new[]
                    {
                        new EvidenceItem($"{h.HandlerType.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}",
                            h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource)),
                        assemblyEvidence,
                    },
                    confidence, limitations, ProviderRouteId));
            }
            if (isNotification) RelateBaseNotificationHandlers(facts, type, versionLimit, assemblyEvidence, result);
            else RelateBehaviors(facts, type, isStream, confidence, versionLimit, assemblyEvidence, result);
            foreach (var s in facts.Sends.Where(s => SymbolIdentity.SameDefinition(s.RequestType, type)))
            {
                result.Add(new FrameworkRelation(RelationKinds.MediatRSend, RelationGroups.Callers,
                    new RelationTarget($"{s.MethodName} in {s.Container}", Location: s.Location),
                    new[] { new EvidenceItem($"{s.MethodName}({type.Name}) resolved to a MediatR sender", s.Location) },
                    confidence, versionLimit, ProviderRouteId));
            }
        }

        foreach (var h in facts.Handlers.Where(h => SymbolIdentity.SameDefinition(h.HandlerType, type)))
        {
            result.Add(new FrameworkRelation(RelationKinds.MediatRRequest, RelationGroups.Declarations,
                new RelationTarget(h.Request.Name, Symbol: h.Request),
                new[] { new EvidenceItem($"{type.Name} implements {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}"), assemblyEvidence },
                confidence, versionLimit, ProviderRouteId));
            // Where this handler is called from: every place that sends its request (a controller action, a service, an
            // injected handler interface), so the handler shows its controllers without a detour through the request.
            foreach (var s in facts.Sends.Where(s => s.Notification == h.IsNotification && SymbolIdentity.SameDefinition(s.RequestType, h.Request)))
            {
                result.Add(new FrameworkRelation(RelationKinds.MediatRSend, RelationGroups.Callers,
                    new RelationTarget($"{s.MethodName}({h.Request.Name}) in {s.Container}", Location: s.Location),
                    new[] { new EvidenceItem($"{s.MethodName}({h.Request.Name}) dispatches to {h.HandlerType.Name}", s.Location), assemblyEvidence },
                    confidence, versionLimit, ProviderRouteId));
            }
            if (h.Response != null && h.Response.Name != "Unit")
            {
                result.Add(new FrameworkRelation(RelationKinds.MediatRResponse, RelationGroups.Declarations,
                    new RelationTarget(h.Response.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), Symbol: h.Response),
                    new[] { new EvidenceItem($"Response type of {h.Interface.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}") },
                    confidence, versionLimit, ProviderRouteId));
            }
        }
        return result;
    }
}
