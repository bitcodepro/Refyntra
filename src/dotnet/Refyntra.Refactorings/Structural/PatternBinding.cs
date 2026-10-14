using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Refyntra.Refactorings.Structural;

/// <summary>
/// A pattern bound in one project: the pattern is compiled inside a synthetic class added to the project's compilation
/// (with the pattern's imports), each placeholder being a parameter of its constraint type (else <c>dynamic</c>), so
/// that the pattern's names resolve to symbols (<c>Console.WriteLine</c> → System.Console.WriteLine). The synthetic
/// tree is never part of the workspace. Constraint types resolve against the project's own compilation.
/// </summary>
public sealed class PatternBinding
{
    public ParsedPattern Pattern { get; }
    public SemanticModel Model { get; }
    /// <summary>The pattern's top-level nodes: one expression, the statements, or the members.</summary>
    public IReadOnlyList<SyntaxNode> Roots { get; }
    /// <summary>The constraint type of each type-constrained placeholder (null: the type does not exist in the project).</summary>
    public IReadOnlyDictionary<string, ITypeSymbol?> Constraints { get; }
    /// <summary>Identifier texts that every match contains (a cheap text pre-filter of documents).</summary>
    public IReadOnlyList<string> RequiredWords { get; }

    private readonly Dictionary<SyntaxNode, (string? Key, bool Global)> _keys = new();

    private PatternBinding(ParsedPattern pattern, SemanticModel model, IReadOnlyList<SyntaxNode> roots, Dictionary<string, ITypeSymbol?> constraints)
    {
        Pattern = pattern;
        Model = model;
        Roots = roots;
        Constraints = constraints;
        RequiredWords = roots.SelectMany(r => r.DescendantTokens())
            .Where(t => t.IsKind(SyntaxKind.IdentifierToken) && ParsedPattern.NameOf(t.ValueText) == null && t.Parent is SimpleNameSyntax sn && !IsTypeOrNamespace(sn))
            .Select(t => t.ValueText).Distinct(StringComparer.Ordinal).ToList();
    }

    private bool IsTypeOrNamespace(SimpleNameSyntax n) => KeyOf(n).Key is { } k && (k.StartsWith("T:", StringComparison.Ordinal) || k.StartsWith("N:", StringComparison.Ordinal));

    public static PatternBinding Create(ParsedPattern pattern, Compilation compilation, CancellationToken ct)
    {
        var constraints = new Dictionary<string, ITypeSymbol?>(StringComparer.Ordinal);
        foreach (var p in pattern.Placeholders.Values.Where(p => !string.IsNullOrWhiteSpace(p.Type)))
            constraints[p.Name] = ResolveType(compilation, p.Type!.Trim(), pattern.Spec.EffectiveImports);

        var sb = new StringBuilder();
        foreach (var ns in pattern.Spec.EffectiveImports) sb.Append("using ").Append(ns).Append(";\n");
        sb.Append("internal static class __SsrPatternHost__\n{\n    private static async void __SsrMethod__(");
        sb.Append(string.Join(", ", pattern.Placeholders.Values.Select(p =>
            (constraints.TryGetValue(p.Name, out var t) && t != null ? ParameterType(t) : "dynamic") + " " + ParsedPattern.Prefix + p.Name)));
        sb.Append(")\n    {\n");
        int start;
        switch (pattern.Kind)
        {
            case PatternKind.Expression:
                sb.Append("        object __ssrValue__ = ");
                start = sb.Length;
                sb.Append(pattern.Text).Append(";\n    }\n");
                break;
            case PatternKind.Statements:
                start = sb.Length;
                sb.Append(pattern.Text).Append("\n    }\n");
                break;
            default:
                sb.Append("    }\n");
                start = sb.Length;
                sb.Append(pattern.Text).Append('\n');
                break;
        }
        sb.Append("}\n");
        var options = compilation.SyntaxTrees.FirstOrDefault()?.Options as CSharpParseOptions ?? CSharpParseOptions.Default;
        var tree = CSharpSyntaxTree.ParseText(sb.ToString(), options.WithKind(SourceCodeKind.Regular), cancellationToken: ct);
        var root = tree.GetRoot(ct);
        var host = root.DescendantNodes().OfType<ClassDeclarationSyntax>().First();
        var method = (MethodDeclarationSyntax)host.Members[0];
        IReadOnlyList<SyntaxNode> roots = pattern.Kind switch
        {
            PatternKind.Expression => new SyntaxNode[] { ((LocalDeclarationStatementSyntax)method.Body!.Statements[0]).Declaration.Variables[0].Initializer!.Value },
            PatternKind.Statements => method.Body!.Statements.ToList(),
            _ => host.Members.Skip(1).Cast<SyntaxNode>().ToList(),
        };
        if (roots.Count == 0 || roots[0].SpanStart < start)
            throw new PatternException("InvalidPattern", "The pattern could not be bound.");
        var model = compilation.AddSyntaxTrees(tree).GetSemanticModel(tree, ignoreAccessibility: true);
        return new PatternBinding(pattern, model, roots, constraints);
    }

    private static string ParameterType(ITypeSymbol t)
    {
        if (t is INamedTypeSymbol { IsGenericType: true } n && SymbolEqualityComparer.Default.Equals(n, n.OriginalDefinition))
        {
            // An open generic constraint (IEnumerable`1): bind members against IEnumerable<object>.
            var c = n.Construct(n.TypeParameters.Select(_ => (ITypeSymbol)n.ContainingAssembly.GetTypeByMetadataName("System.Object")!).Where(x => x != null).ToArray());
            return c.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        }
        return t.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    }

    private static readonly Dictionary<string, SpecialType> Keywords = new(StringComparer.Ordinal)
    {
        ["object"] = SpecialType.System_Object, ["string"] = SpecialType.System_String, ["bool"] = SpecialType.System_Boolean,
        ["char"] = SpecialType.System_Char, ["byte"] = SpecialType.System_Byte, ["sbyte"] = SpecialType.System_SByte,
        ["short"] = SpecialType.System_Int16, ["ushort"] = SpecialType.System_UInt16, ["int"] = SpecialType.System_Int32,
        ["uint"] = SpecialType.System_UInt32, ["long"] = SpecialType.System_Int64, ["ulong"] = SpecialType.System_UInt64,
        ["float"] = SpecialType.System_Single, ["double"] = SpecialType.System_Double, ["decimal"] = SpecialType.System_Decimal,
    };

    /// <summary>
    /// A constraint type by name: a C# keyword, a metadata name ("System.Collections.Generic.IEnumerable`1"), a C# name
    /// with type arguments ("System.Collections.Generic.List&lt;int&gt;", "IEnumerable&lt;T&gt;": open) or a simple name in one of
    /// the imports. Null when the project has no such type.
    /// </summary>
    public static ITypeSymbol? ResolveType(Compilation c, string name, IReadOnlyList<string> imports)
    {
        name = name.Trim();
        if (name.StartsWith("global::", StringComparison.Ordinal)) name = name.Substring(8);
        if (Keywords.TryGetValue(name, out var special)) return c.GetSpecialType(special);
        var lt = name.IndexOf('<');
        if (lt > 0 && name.EndsWith('>'))
        {
            var args = SplitArgs(name.Substring(lt + 1, name.Length - lt - 2));
            var def = ResolveType(c, name.Substring(0, lt) + "`" + args.Count, imports) as INamedTypeSymbol;
            if (def == null) return null;
            // Single-letter / unresolvable arguments ("T") mean "any": the open definition.
            var resolved = args.Select(a => a.Length <= 2 && char.IsUpper(a[0]) ? null : ResolveType(c, a, imports)).ToList();
            if (resolved.Any(r => r == null)) return def;
            return def.Construct(resolved.ToArray()!);
        }
        if (c.GetTypeByMetadataName(name) is { } t) return t;
        foreach (var ns in imports)
            if (c.GetTypeByMetadataName(ns + "." + name) is { } t2) return t2;
        return null;
    }

    private static List<string> SplitArgs(string s)
    {
        var list = new List<string>();
        int depth = 0, from = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '<') depth++;
            else if (s[i] == '>') depth--;
            else if (s[i] == ',' && depth == 0)
            {
                list.Add(s.Substring(from, i - from).Trim());
                from = i + 1;
            }
        }
        list.Add(s.Substring(from).Trim());
        return list;
    }

    /// <summary>
    /// The comparison key of the symbol a pattern node names, and whether it is "global" (a namespace, a type or a static
    /// member: such names match any spelling of the same symbol: qualified, aliased, through <c>using static</c>).
    /// </summary>
    public (string? Key, bool Global) KeyOf(SyntaxNode patternNode)
    {
        if (_keys.TryGetValue(patternNode, out var k)) return k;
        var info = Model.GetSymbolInfo(patternNode);
        k = SymbolKeys.Of(info);
        _keys[patternNode] = k;
        return k;
    }
}

/// <summary>Symbol comparison keys for structural matching (overloads of a method share one key).</summary>
public static class SymbolKeys
{
    private static readonly SymbolDisplayFormat Format = SymbolDisplayFormat.FullyQualifiedFormat.WithGenericsOptions(SymbolDisplayGenericsOptions.IncludeTypeParameters);

    public static (string? Key, bool Global) Of(SymbolInfo info)
    {
        if (info.Symbol is { } s) return Of(s);
        var keys = info.CandidateSymbols.Select(Of).Where(x => x.Key != null).Distinct().ToList();
        return keys.Count == 1 ? keys[0] : (null, false);
    }

    /// <summary>The symbol has the key, or overrides / implements a member that has it (an interface or base member in the pattern).</summary>
    public static bool SameOrImplements(ISymbol s, string key)
    {
        if (Of(s).Key == key) return true;
        if (s is IMethodSymbol { ReducedFrom: not null }) return false;
        for (var o = Overridden(s); o != null; o = Overridden(o))
            if (Of(o).Key == key) return true;
        if (s.ContainingType is { } type)
            foreach (var iface in type.AllInterfaces)
                foreach (var member in iface.GetMembers(s.Name))
                    if (Of(member).Key == key && SymbolEqualityComparer.Default.Equals(type.FindImplementationForInterfaceMember(member)?.OriginalDefinition, s.OriginalDefinition))
                        return true;
        return false;
    }

    private static ISymbol? Overridden(ISymbol s) => s switch
    {
        IMethodSymbol m => m.OverriddenMethod,
        IPropertySymbol p => p.OverriddenProperty,
        IEventSymbol e => e.OverriddenEvent,
        _ => null,
    };

    public static (string? Key, bool Global) Of(ISymbol s)
    {
        switch (s)
        {
            case IAliasSymbol a:
                return Of(a.Target);
            case INamespaceSymbol ns:
                return ("N:" + ns.ToDisplayString(Format), true);
            case ITypeParameterSymbol:
                return (null, false);
            case ITypeSymbol t:
                return ("T:" + (t.OriginalDefinition).ToDisplayString(Format), true);
            case IMethodSymbol m:
            {
                var def = (m.ReducedFrom ?? m).OriginalDefinition;
                if (def.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) return (null, false);
                return ("M:" + def.ContainingType?.ToDisplayString(Format) + "." + def.Name, def.IsStatic && m.ReducedFrom == null);
            }
            case IFieldSymbol or IPropertySymbol or IEventSymbol:
                return (s.Kind + ":" + s.OriginalDefinition.ContainingType?.ToDisplayString(Format) + "." + s.Name, s.IsStatic || s is IFieldSymbol { IsConst: true });
            default:
                return (null, false);
        }
    }
}
