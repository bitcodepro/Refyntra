using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.AspNetCore;

/// <summary>
/// MVC controllers and actions. Controllers are recognised by the verified identity of
/// <c>Microsoft.AspNetCore.Mvc.ControllerBase</c> / <c>[Controller]</c> / <c>[ApiController]</c> (assembly
/// Microsoft.AspNetCore.Mvc.Core); the "XController" naming convention is used only as a heuristic when the base type
/// does not resolve. Attribute routes are combined as ASP.NET Core does for the documented forms; conventional routes
/// (<c>MapControllerRoute</c>) are recorded but never resolved to actions. This is a navigation index, not a routing
/// simulator.
/// </summary>
internal static class MvcEndpoints
{
    private const string MvcCore = "Microsoft.AspNetCore.Mvc.Core";
    private static KnownType Mvc(string name) => new("Microsoft.AspNetCore.Mvc." + name, MvcCore);

    private static readonly KnownType ControllerBase = Mvc("ControllerBase");
    private static readonly KnownType ControllerAttribute = Mvc("ControllerAttribute");
    private static readonly KnownType ApiControllerAttribute = Mvc("ApiControllerAttribute");
    private static readonly KnownType NonControllerAttribute = Mvc("NonControllerAttribute");
    private static readonly KnownType NonActionAttribute = Mvc("NonActionAttribute");
    private static readonly KnownType RouteAttribute = Mvc("RouteAttribute");
    private static readonly KnownType AreaAttribute = Mvc("AreaAttribute");
    private static readonly KnownType ActionNameAttribute = Mvc("ActionNameAttribute");
    private static readonly KnownType AcceptVerbsAttribute = Mvc("AcceptVerbsAttribute");
    private static readonly KnownType ApiExplorerSettingsAttribute = Mvc("ApiExplorerSettingsAttribute");
    private static readonly KnownType HttpMethodAttribute = new("Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute", MvcCore);
    public static readonly KnownType ControllerRouteExtensions = new("Microsoft.AspNetCore.Builder.ControllerEndpointRouteBuilderExtensions", MvcCore);

    private static readonly (KnownType type, string verb)[] VerbAttributes =
    {
        (Mvc("HttpGetAttribute"), "GET"), (Mvc("HttpPostAttribute"), "POST"), (Mvc("HttpPutAttribute"), "PUT"),
        (Mvc("HttpDeleteAttribute"), "DELETE"), (Mvc("HttpPatchAttribute"), "PATCH"), (Mvc("HttpHeadAttribute"), "HEAD"),
        (Mvc("HttpOptionsAttribute"), "OPTIONS"),
    };

    public const string ConventionalNote = "conventional route, not resolved: the URL depends on MapControllerRoute patterns, which are not matched to actions.";

    private static bool InheritsFrom(ITypeSymbol? type, KnownType known)
    {
        for (var t = type as INamedTypeSymbol; t != null; t = t.BaseType)
            if (known.Matches(t)) return true;
        return false;
    }

    private static IEnumerable<INamedTypeSymbol> Chain(INamedTypeSymbol type)
    {
        for (var t = type; t != null && t.SpecialType != SpecialType.System_Object; t = t.BaseType) yield return t;
    }

    private static bool HasAttribute(ISymbol s, KnownType known) => s.GetAttributes().Any(a => known.Matches(a.AttributeClass));

    /// <summary>Proven (identity), heuristic (naming, unresolved base) or null (not a controller).</summary>
    public static string? ControllerConfidence(INamedTypeSymbol type)
    {
        if (type.TypeKind != TypeKind.Class || type.IsAbstract || type.IsStatic || type.IsGenericType) return null;
        if (type.DeclaredAccessibility != Accessibility.Public || type.ContainingType is { DeclaredAccessibility: not Accessibility.Public }) return null;
        var chain = Chain(type).ToList();
        if (chain.Any(t => HasAttribute(t, NonControllerAttribute))) return null;
        if (InheritsFrom(type, ControllerBase)) return Confidences.Proven;
        if (chain.Any(t => HasAttribute(t, ControllerAttribute) || HasAttribute(t, ApiControllerAttribute))) return Confidences.Proven;
        if (type.Name.EndsWith("Controller", StringComparison.Ordinal) && chain.Any(t => t.BaseType is { TypeKind: TypeKind.Error }))
            return Confidences.Heuristic;
        return null;
    }

    private sealed record Template(string? Text, string[] Verbs, bool VerbsKnown, AttributeData? Attribute);

    private static string? StringArg(AttributeData a, int index = 0) =>
        a.ConstructorArguments.Length > index && a.ConstructorArguments[index].Kind == TypedConstantKind.Primitive
            ? a.ConstructorArguments[index].Value as string : null;

    private static string? Named(AttributeData a, string name) =>
        a.NamedArguments.FirstOrDefault(n => n.Key == name).Value.Value as string;

    /// <summary>Route template providers on an action: verb attributes, [Route] and [AcceptVerbs]. Null = not one.</summary>
    private static Template? Classify(AttributeData a)
    {
        var cls = a.AttributeClass;
        if (cls == null) return null;
        foreach (var (type, verb) in VerbAttributes)
            if (type.Matches(cls)) return new Template(StringArg(a), new[] { verb }, true, a);
        if (AcceptVerbsAttribute.Matches(cls))
        {
            var verbs = a.ConstructorArguments.SelectMany(c => c.Kind == TypedConstantKind.Array ? c.Values.AsEnumerable() : new[] { c })
                .Select(v => (v.Value as string)?.ToUpperInvariant()).OfType<string>().ToArray();
            return new Template(Named(a, "Route"), verbs, true, a);
        }
        if (RouteAttribute.Matches(cls)) return new Template(StringArg(a), Array.Empty<string>(), true, a);
        if (InheritsFrom(cls, HttpMethodAttribute)) return new Template(StringArg(a), Array.Empty<string>(), false, a);
        return null;
    }

    private static List<Template> ActionTemplates(IMethodSymbol method)
    {
        // Route attributes are inherited from an overridden action when the override declares none.
        for (var m = method; m != null; m = m.OverriddenMethod)
        {
            var list = m.GetAttributes().Select(Classify).OfType<Template>().ToList();
            if (list.Count > 0) return list;
        }
        return new List<Template>();
    }

    private static bool IsNonAction(IMethodSymbol method)
    {
        for (var m = method; m != null; m = m.OverriddenMethod)
            if (HasAttribute(m, NonActionAttribute)) return true;
        return false;
    }

    private static IEnumerable<IMethodSymbol> Actions(INamedTypeSymbol controller)
    {
        var seen = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        foreach (var t in Chain(controller))
        {
            if (!t.Locations.Any(l => l.IsInSource)) break; // ControllerBase/Controller members are not actions
            foreach (var m in t.GetMembers().OfType<IMethodSymbol>())
            {
                if (m.MethodKind != MethodKind.Ordinary || m.IsStatic || m.IsAbstract || m.IsGenericMethod) continue;
                if (m.DeclaredAccessibility != Accessibility.Public) continue;
                if (m.IsOverride && m.OverriddenMethod?.ContainingType.SpecialType == SpecialType.System_Object) continue;
                if (m.Name == "Dispose" && m.Parameters.Length == 0 && controller.AllInterfaces.Any(i => i.SpecialType == SpecialType.System_IDisposable)) continue;
                // A more derived override already produced this action.
                if (seen.Any(d => Overrides(d, m))) continue;
                seen.Add(m);
                if (IsNonAction(m)) continue;
                yield return m;
            }
        }
    }

    private static bool Overrides(IMethodSymbol derived, IMethodSymbol baseMethod)
    {
        for (var m = derived.OverriddenMethod; m != null; m = m.OverriddenMethod)
            if (SymbolEqualityComparer.Default.Equals(m.OriginalDefinition, baseMethod.OriginalDefinition)) return true;
        return false;
    }

    public static void Collect(Compilation compilation, ProjectId projectId, List<EndpointFact> endpoints, CancellationToken ct)
    {
        var assemblyName = compilation.AssemblyName ?? "<unknown>";
        var root = $"MVC controllers ({assemblyName})";
        foreach (var type in AllSourceTypes(compilation.Assembly.GlobalNamespace))
        {
            ct.ThrowIfCancellationRequested();
            var confidence = ControllerConfidence(type);
            if (confidence == null) continue;
            var chain = Chain(type).ToList();
            var controllerRoutes = chain.SelectMany(t => t.GetAttributes()).Where(a => RouteAttribute.Matches(a.AttributeClass))
                .Select(a => StringArg(a)).ToList();
            var area = chain.SelectMany(t => t.GetAttributes()).Where(a => AreaAttribute.Matches(a.AttributeClass)).Select(a => StringArg(a)).FirstOrDefault();
            var controllerName = type.Name.EndsWith("Controller", StringComparison.Ordinal) && type.Name.Length > "Controller".Length
                ? type.Name[..^"Controller".Length] : type.Name;

            foreach (var action in Actions(type))
            {
                var decl = action.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) as MethodDeclarationSyntax;
                if (decl == null) continue;
                var actionName = action.GetAttributes().Where(a => ActionNameAttribute.Matches(a.AttributeClass)).Select(a => StringArg(a)).FirstOrDefault()
                    ?? (action.Name.EndsWith("Async", StringComparison.Ordinal) && action.Name.Length > 5 ? action.Name[..^5] : action.Name);
                var templates = ActionTemplates(action);
                var bareVerbs = templates.Where(t => t.Text == null && t.Attribute != null && !RouteAttribute.Matches(t.Attribute.AttributeClass))
                    .SelectMany(t => t.Verbs).Distinct().ToArray();
                var unknownVerbs = templates.Any(t => !t.VerbsKnown);
                var selectors = templates.Where(t => t.Text != null)
                    .Select(t => t.Attribute != null && RouteAttribute.Matches(t.Attribute.AttributeClass) ? t with { Verbs = bareVerbs } : t)
                    .ToList();
                if (selectors.Count == 0) selectors.Add(new Template(null, bareVerbs, !unknownVerbs, templates.FirstOrDefault()?.Attribute));

                var common = new List<string>();
                if (unknownVerbs) common.Add("A custom HTTP method attribute is not resolved; its verbs are not shown.");
                if (action.GetAttributes().Concat(type.GetAttributes()).Any(a => ApiExplorerSettingsAttribute.Matches(a.AttributeClass)
                        && a.NamedArguments.Any(n => n.Key == "IgnoreApi" && n.Value.Value is true)))
                    common.Add("Hidden from API descriptions (ApiExplorerSettings IgnoreApi); still an endpoint.");
                if (confidence == Confidences.Heuristic)
                    common.Add("Recognised as a controller by its name only: the base type does not resolve.");
                if (!SymbolEqualityComparer.Default.Equals(action.ContainingType, type))
                    common.Add($"Action inherited from {action.ContainingType.Name}.");

                foreach (var sel in selectors)
                {
                    var absolute = sel.Text != null && (sel.Text.StartsWith('/') || sel.Text.StartsWith("~/", StringComparison.Ordinal));
                    var prefixes = absolute || controllerRoutes.Count == 0 ? new List<string?> { null } : controllerRoutes;
                    foreach (var prefix in prefixes)
                    {
                        var limitations = new List<string>(common);
                        string route;
                        bool dynamic;
                        if (prefix == null && sel.Text == null)
                        {
                            route = "/";
                            dynamic = true;
                            limitations.Add("MVC action without attribute route: " + ConventionalNote);
                        }
                        else
                        {
                            var text = absolute ? sel.Text!.TrimStart('~') : AspNetCoreModule.Join(prefix ?? "", sel.Text ?? "");
                            (route, dynamic) = ReplaceTokens(text, controllerName, actionName, area, limitations);
                            route = AspNetCoreModule.Join("", route);
                        }
                        var attrSyntax = sel.Attribute?.ApplicationSyntaxReference;
                        var location = attrSyntax != null && sel.Text != null
                            ? Location.Create(attrSyntax.SyntaxTree, attrSyntax.Span)
                            : decl.Identifier.GetLocation();
                        endpoints.Add(new EndpointFact(sel.Verbs, route, dynamic, location, action, decl.SyntaxTree, decl.Span, root,
                            projectId, limitations, "mvc", type, confidence));
                    }
                }
            }
        }
    }

    private static (string route, bool dynamic) ReplaceTokens(string template, string controller, string action, string? area, List<string> limitations)
    {
        var sb = new System.Text.StringBuilder();
        var dynamic = false;
        for (var i = 0; i < template.Length; i++)
        {
            var c = template[i];
            if (c == '[' && i + 1 < template.Length && template[i + 1] == '[') { sb.Append('['); i++; continue; }
            if (c == ']' && i + 1 < template.Length && template[i + 1] == ']') { sb.Append(']'); i++; continue; }
            if (c == '[')
            {
                var end = template.IndexOf(']', i + 1);
                if (end < 0) { sb.Append(template, i, template.Length - i); break; }
                var token = template.Substring(i + 1, end - i - 1);
                string? value = token.ToLowerInvariant() switch
                {
                    "controller" => controller,
                    "action" => action,
                    "area" => area,
                    _ => null,
                };
                if (value == null)
                {
                    dynamic = true;
                    limitations.Add($"Route token [{token}] is not resolved.");
                    sb.Append('[').Append(token).Append(']');
                }
                else sb.Append(value);
                i = end;
                continue;
            }
            sb.Append(c);
        }
        return (sb.ToString(), dynamic);
    }

    /// <summary>MapControllerRoute / MapAreaControllerRoute / MapDefaultControllerRoute: recorded as dynamic, never resolved.</summary>
    public static EndpointFact? Conventional(InvocationExpressionSyntax inv, IMethodSymbol method, SemanticModel model, ProjectId projectId, CancellationToken ct)
    {
        var def = method.ReducedFrom ?? method;
        string pattern;
        var limitations = new List<string> { "MVC " + ConventionalNote };
        if (def.Name == "MapDefaultControllerRoute") pattern = "{controller=Home}/{action=Index}/{id?}";
        else
        {
            var parameters = method.ReducedFrom != null ? method.Parameters.ToList() : method.Parameters.Skip(1).ToList();
            var index = parameters.FindIndex(p => p.Name == "pattern");
            if (index < 0) return null;
            var args = inv.ArgumentList.Arguments;
            var arg = args.FirstOrDefault(a => a.NameColon?.Name.Identifier.ValueText == "pattern")
                      ?? (index < args.Count && args.Take(index + 1).All(a => a.NameColon == null) ? args[index] : null);
            if (arg == null) return null;
            var constant = model.GetConstantValue(arg.Expression, ct);
            if (constant.HasValue && constant.Value is string s) pattern = s;
            else
            {
                pattern = arg.Expression is InterpolatedStringExpressionSyntax interp
                    ? string.Concat(interp.Contents.TakeWhile(c => c is InterpolatedStringTextSyntax).Cast<InterpolatedStringTextSyntax>().Select(t => t.TextToken.ValueText))
                    : "";
                limitations.Add("The route pattern is not a compile-time constant; only the known prefix is shown.");
            }
        }
        var start = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.SpanStart : inv.SpanStart;
        var location = Location.Create(inv.SyntaxTree, TextSpan.FromBounds(start, inv.Span.End));
        return new EndpointFact(Array.Empty<string>(), AspNetCoreModule.Join("", pattern), true, location, null, inv.SyntaxTree,
            new TextSpan(inv.SpanStart, 0), SymbolIdentity.CompositionRoot(model, inv, ct), projectId, limitations, "mvc");
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
}
