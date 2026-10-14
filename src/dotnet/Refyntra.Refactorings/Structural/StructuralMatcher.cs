using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Structural;

/// <summary>What a placeholder matched: nodes (an expression, statements, arguments, a member) or an identifier token.</summary>
public sealed class Bound
{
    public IReadOnlyList<SyntaxNode> Nodes { get; }
    public SyntaxToken? Token { get; }
    /// <summary>A list placeholder (statements / arguments with a count): its nodes are a sequence.</summary>
    public bool IsList { get; }

    public Bound(IReadOnlyList<SyntaxNode> nodes, bool isList) { Nodes = nodes; IsList = isList; }
    public Bound(SyntaxToken token) { Nodes = Array.Empty<SyntaxNode>(); Token = token; }

    public string Text
    {
        get
        {
            if (Token is { } t) return t.ValueText;
            if (Nodes.Count == 0) return "";
            var tree = Nodes[0].SyntaxTree;
            return tree.GetText().ToString(TextSpan.FromBounds(Nodes[0].Span.Start, Nodes[^1].Span.End));
        }
    }
}

/// <summary>One structural match in a document: the matched nodes (one, or a run of statements / members) and the placeholders.</summary>
public sealed record StructuralMatch(Document Document, TextSpan Span, IReadOnlyList<SyntaxNode> Nodes, IReadOnlyDictionary<string, Bound> Bindings);

/// <summary>
/// Matches a bound pattern against the syntax of one document (ADR-012): node kinds and tokens must be equal (trivia is
/// ignored; parentheses are ignored on both sides; a block of one statement matches that statement); names that bind to
/// a namespace, a type or a static member match any spelling of the same symbol (qualified, aliased, using static), other
/// pattern names that bind must bind to the same symbol (overloads of a method count as one); placeholders match by kind,
/// type, count and regex, and a placeholder used twice must match equivalent code.
/// </summary>
public sealed class StructuralMatcher
{
    private readonly PatternBinding _b;
    private readonly SemanticModel _m;
    private readonly CancellationToken _ct;
    private ParsedPattern P => _b.Pattern;

    public StructuralMatcher(PatternBinding binding, SemanticModel model, CancellationToken ct)
    {
        _b = binding;
        _m = model;
        _ct = ct;
    }

    private sealed class Bindings
    {
        public Dictionary<string, Bound> Map { get; private set; } = new(StringComparer.Ordinal);
        public Bindings Clone() => new() { Map = new Dictionary<string, Bound>(Map, StringComparer.Ordinal) };
        public void Take(Bindings other) => Map = other.Map;
    }

    /// <summary>Every match in the document, in text order (matches may nest; runs of statements never overlap each other).</summary>
    public List<StructuralMatch> FindAll(Document document, SyntaxNode root)
    {
        var found = new List<StructuralMatch>();
        void Add(IReadOnlyList<SyntaxNode> nodes, Bindings b) =>
            found.Add(new StructuralMatch(document, TextSpan.FromBounds(nodes[0].SpanStart, nodes[^1].Span.End), nodes, b.Map));
        switch (P.Kind)
        {
            case PatternKind.Expression:
            {
                var p = _b.Roots[0];
                var nameLike = IsNameLike(p) && !ContainsPlaceholder(p);
                foreach (var node in root.DescendantNodes())
                {
                    _ct.ThrowIfCancellationRequested();
                    if (node is not ExpressionSyntax e || e is ParenthesizedExpressionSyntax) continue;
                    if (nameLike && node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node) continue;
                    if (nameLike && node.Parent is QualifiedNameSyntax q && q.Right == node) continue;
                    var b = new Bindings();
                    if (Match(p, e, b)) Add(new[] { node }, b);
                }
                break;
            }
            case PatternKind.Statements:
                FindRuns(root, found, Add);
                break;
            case PatternKind.Members:
                FindRuns(root, found, Add);
                break;
        }
        return found.OrderBy(f => f.Span.Start).ThenByDescending(f => f.Span.Length).ToList();
    }

    private void FindRuns(SyntaxNode root, List<StructuralMatch> found, Action<IReadOnlyList<SyntaxNode>, Bindings> add)
    {
        var ps = _b.Roots;
        foreach (var node in root.DescendantNodesAndSelf())
        {
            _ct.ThrowIfCancellationRequested();
            IReadOnlyList<SyntaxNode>? list = (P.Kind, node) switch
            {
                (PatternKind.Statements, BlockSyntax bl) => bl.Statements,
                (PatternKind.Statements, SwitchSectionSyntax sw) => sw.Statements,
                (PatternKind.Members, TypeDeclarationSyntax td) => td.Members,
                _ => null,
            };
            if (list != null)
            {
                for (var i = 0; i < list.Count;)
                {
                    var b = new Bindings();
                    if (MatchSeq(ps, 0, list, i, b, open: true, out var end) && end > i)
                    {
                        add(list.Skip(i).Take(end - i).ToList(), b);
                        i = end;
                    }
                    else i++;
                }
                continue;
            }
            // Statements that are not in a list (an if's body without braces, a top-level statement): one-statement patterns.
            if (P.Kind == PatternKind.Statements && ps.Count == 1 && node is StatementSyntax st && st is not BlockSyntax
                && st.Parent is not (BlockSyntax or SwitchSectionSyntax) && st.Parent is not LabeledStatementSyntax)
            {
                var b = new Bindings();
                if (Match(ps[0], st, b)) add(new[] { (SyntaxNode)st }, b);
            }
        }
    }

    // ------------------------------------------------------------------ matching

    private static SyntaxNode Strip(SyntaxNode n)
    {
        while (n is ParenthesizedExpressionSyntax p) n = p.Expression;
        return n;
    }

    private static bool ContainsPlaceholder(SyntaxNode n) =>
        n.DescendantTokens().Any(t => t.IsKind(SyntaxKind.IdentifierToken) && ParsedPattern.NameOf(t.ValueText) != null);

    private string? PlaceholderOf(SyntaxNode p) => p is IdentifierNameSyntax id && ParsedPattern.NameOf(id.Identifier.ValueText) is { } n && P.Placeholders.ContainsKey(n) ? n : null;

    private static bool IsNameLike(SyntaxNode n) => n switch
    {
        IdentifierNameSyntax or GenericNameSyntax or QualifiedNameSyntax or AliasQualifiedNameSyntax or PredefinedTypeSyntax => true,
        MemberAccessExpressionSyntax ma when ma.IsKind(SyntaxKind.SimpleMemberAccessExpression) => IsNameLike(ma.Expression),
        _ => false,
    };

    private bool Match(SyntaxNode p, SyntaxNode t, Bindings b)
    {
        _ct.ThrowIfCancellationRequested();
        p = Strip(p);
        t = Strip(t);
        if (PlaceholderOf(p) is { } name) return BindNodes(name, new[] { t }, isList: false, b);
        if (p is ExpressionStatementSyntax es && PlaceholderOf(es.Expression) is { } sn && IsStatementPlaceholder(sn))
            return t is StatementSyntax && BindNodes(sn, new[] { t }, isList: false, b);
        // 'var' is a keyword in a declaration: it matches 'var' (not the inferred type of the pattern host).
        if (IsNameLike(p) && !ContainsPlaceholder(p) && p is not IdentifierNameSyntax { IsVar: true })
        {
            var (key, global) = _b.KeyOf(p);
            if (key != null && global)
                return IsNameLike(t) && SymbolKeys.Of(_m.GetSymbolInfo(t, _ct)).Key == key;
            if (key != null && t is SimpleNameSyntax)
            {
                // An instance member the pattern resolves: when the target resolves too, it must be the same member.
                var ts = _m.GetSymbolInfo(t, _ct).Symbol;
                if (ts != null && !SymbolKeys.SameOrImplements(ts, key)) return false;
            }
        }
        // A block of exactly one statement matches that statement (and the other way round).
        if (p is StatementSyntax && p is not BlockSyntax && t is BlockSyntax { Statements.Count: 1 } tb) t = tb.Statements[0];
        else if (p is BlockSyntax { Statements.Count: 1 } pb && t is StatementSyntax && t is not BlockSyntax) p = pb.Statements[0];
        if (p.RawKind != t.RawKind) return false;
        return MatchChildren(p, t, b);
    }

    private bool MatchChildren(SyntaxNode p, SyntaxNode t, Bindings b)
    {
        switch (p)
        {
            case BaseArgumentListSyntax pa:
                return MatchSeq(pa.Arguments.Cast<SyntaxNode>().ToList(), 0, ((BaseArgumentListSyntax)t).Arguments.Cast<SyntaxNode>().ToList(), 0, b, open: false, out _);
            case BlockSyntax pbk:
                return MatchSeq(pbk.Statements.Cast<SyntaxNode>().ToList(), 0, ((BlockSyntax)t).Statements.Cast<SyntaxNode>().ToList(), 0, b, open: false, out _);
        }
        var pc = p.ChildNodesAndTokens();
        var tc = t.ChildNodesAndTokens();
        if (pc.Count != tc.Count) return false;
        for (var i = 0; i < pc.Count; i++)
        {
            var a = pc[i];
            var c = tc[i];
            if (a.IsNode != c.IsNode) return false;
            if (a.IsNode)
            {
                if (!Match(a.AsNode()!, c.AsNode()!, b)) return false;
            }
            else if (!MatchToken(a.AsToken(), c.AsToken(), b)) return false;
        }
        return true;
    }

    private bool MatchToken(SyntaxToken p, SyntaxToken t, Bindings b)
    {
        if (p.IsKind(SyntaxKind.IdentifierToken) && ParsedPattern.NameOf(p.ValueText) is { } n && P.Placeholders.ContainsKey(n))
            return t.IsKind(SyntaxKind.IdentifierToken) && BindToken(n, t, b);
        return p.RawKind == t.RawKind && p.ValueText == t.ValueText;
    }

    private bool IsStatementPlaceholder(string name) => P.Placeholders[name].Kind is "statement" or "any";

    /// <summary>A pattern element that stands for a run of list elements: (name, min, max).</summary>
    private (string Name, int Min, int Max)? ListPlaceholder(SyntaxNode p)
    {
        string? name = p switch
        {
            ArgumentSyntax { NameColon: null, RefKindKeyword.RawKind: 0 } a when PlaceholderOf(a.Expression) is { } n
                && (P.Placeholders[n].Kind == "argument" || P.Placeholders[n].MinCount != null || P.Placeholders[n].MaxCount != null) => n,
            ExpressionStatementSyntax es when PlaceholderOf(es.Expression) is { } n && IsStatementPlaceholder(n) => n,
            _ => null,
        };
        if (name == null) return null;
        var s = P.Placeholders[name];
        var min = s.MinCount ?? 1;
        var max = s.MaxCount ?? (s.MinCount != null ? int.MaxValue : 1);
        return (name, min, max);
    }

    private bool MatchSeq(IReadOnlyList<SyntaxNode> ps, int pi, IReadOnlyList<SyntaxNode> ts, int ti, Bindings b, bool open, out int end)
    {
        end = ti;
        if (pi == ps.Count) return open || ti == ts.Count;
        var p = ps[pi];
        if (ListPlaceholder(p) is { } lp)
        {
            var max = Math.Min(lp.Max, ts.Count - ti);
            for (var n = lp.Min; n <= max; n++)
            {
                var c = b.Clone();
                if (BindNodes(lp.Name, ts.Skip(ti).Take(n).ToList(), isList: true, c) && MatchSeq(ps, pi + 1, ts, ti + n, c, open, out end))
                {
                    b.Take(c);
                    return true;
                }
            }
            return false;
        }
        if (ti >= ts.Count) return false;
        var c2 = b.Clone();
        if (Match(p, ts[ti], c2) && MatchSeq(ps, pi + 1, ts, ti + 1, c2, open, out end))
        {
            b.Take(c2);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ placeholders

    private bool BindToken(string name, SyntaxToken t, Bindings b)
    {
        var s = P.Placeholders[name];
        if (s.Kind is not ("any" or "identifier")) return false;
        if (P.Regexes.TryGetValue(name, out var rx) && !SafeMatch(rx, t.ValueText)) return false;
        if (b.Map.TryGetValue(name, out var existing))
            return existing.Text == t.ValueText;
        b.Map[name] = new Bound(t);
        return true;
    }

    private bool BindNodes(string name, IReadOnlyList<SyntaxNode> nodes, bool isList, Bindings b)
    {
        var s = P.Placeholders[name];
        foreach (var n in nodes)
            if (!Accepts(s, n)) return false;
        if (b.Map.TryGetValue(name, out var existing))
        {
            if (existing.Token is { } tok) return nodes.Count == 1 && nodes[0] is IdentifierNameSyntax id && id.Identifier.ValueText == tok.ValueText;
            if (existing.Nodes.Count != nodes.Count) return false;
            for (var i = 0; i < nodes.Count; i++)
                if (!Equivalent(existing.Nodes[i], nodes[i])) return false;
            return true;
        }
        b.Map[name] = new Bound(nodes, isList);
        return true;
    }

    private bool Accepts(PlaceholderSpec s, SyntaxNode n)
    {
        var kindOk = s.Kind switch
        {
            "expression" => n is ExpressionSyntax e && !IsTypeOrNamespace(e),
            "identifier" => n is IdentifierNameSyntax,
            "type" => n is TypeSyntax ty && (SyntaxFacts.IsInTypeOnlyContext(ty) || _m.GetSymbolInfo(ty, _ct).Symbol is ITypeSymbol),
            "statement" => n is StatementSyntax,
            "argument" => n is ArgumentSyntax || n is ExpressionSyntax { Parent: ArgumentSyntax },
            "member" => n is MemberDeclarationSyntax,
            _ => true,
        };
        if (!kindOk) return false;
        if (s.Type != null)
        {
            var expr = n switch { ArgumentSyntax a => a.Expression, ExpressionSyntax e => e, _ => null };
            if (expr == null || !_b.Constraints.TryGetValue(s.Name, out var constraint) || constraint == null) return false;
            if (IsTypeOrNamespace(expr)) return false;
            var type = _m.GetTypeInfo(expr, _ct).Type;
            if (type == null || type.TypeKind == TypeKind.Error || !TypeMatches(type, constraint, s.ExactType)) return false;
        }
        if (P.Regexes.TryGetValue(s.Name, out var rx))
        {
            var text = n switch
            {
                SimpleNameSyntax sn => sn.Identifier.ValueText,
                MemberDeclarationSyntax md => DeclaredName(md) ?? md.ToString(),
                _ => n.ToString(),
            };
            if (!SafeMatch(rx, text)) return false;
        }
        return true;
    }

    private static string? DeclaredName(MemberDeclarationSyntax m) => m switch
    {
        BaseTypeDeclarationSyntax t => t.Identifier.ValueText,
        MethodDeclarationSyntax md => md.Identifier.ValueText,
        PropertyDeclarationSyntax pd => pd.Identifier.ValueText,
        EventDeclarationSyntax ed => ed.Identifier.ValueText,
        BaseFieldDeclarationSyntax f when f.Declaration.Variables.Count == 1 => f.Declaration.Variables[0].Identifier.ValueText,
        _ => null,
    };

    private static bool SafeMatch(System.Text.RegularExpressions.Regex rx, string text)
    {
        try { return rx.IsMatch(text); }
        catch (System.Text.RegularExpressions.RegexMatchTimeoutException) { return false; }
    }

    private bool IsTypeOrNamespace(ExpressionSyntax e) => _m.GetSymbolInfo(e, _ct).Symbol is INamespaceOrTypeSymbol;

    /// <summary>The expression's type is the constraint, or derives from / implements it (open generics: any construction).</summary>
    public static bool TypeMatches(ITypeSymbol type, ITypeSymbol constraint, bool exact)
    {
        var open = constraint is INamedTypeSymbol { IsGenericType: true } nc && SymbolEqualityComparer.Default.Equals(nc, nc.OriginalDefinition);
        bool Same(ITypeSymbol a) => open
            ? SymbolEqualityComparer.Default.Equals(a.OriginalDefinition, constraint.OriginalDefinition)
            : SymbolEqualityComparer.Default.Equals(a, constraint) || (a.SpecialType != SpecialType.None && a.SpecialType == constraint.SpecialType)
              || a.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == constraint.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        if (Same(type)) return true;
        if (exact) return false;
        if (type is ITypeParameterSymbol tp) return tp.ConstraintTypes.Any(c => TypeMatches(c, constraint, false));
        for (var bt = type.BaseType; bt != null; bt = bt.BaseType)
            if (Same(bt)) return true;
        return type.AllInterfaces.Any(Same);
    }

    /// <summary>Two matched nodes are the same code: equal syntax (trivia and parentheses ignored) and the same symbols.</summary>
    private bool Equivalent(SyntaxNode a, SyntaxNode b)
    {
        a = Strip(a);
        b = Strip(b);
        if (!SyntaxFactory.AreEquivalent(a, b, topLevel: false)) return false;
        var na = a.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().ToList();
        var nb = b.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().ToList();
        if (na.Count != nb.Count) return false;
        for (var i = 0; i < na.Count; i++)
        {
            var sa = _m.GetSymbolInfo(na[i], _ct).Symbol;
            var sb = _m.GetSymbolInfo(nb[i], _ct).Symbol;
            if (sa != null && sb != null && !SymbolEqualityComparer.Default.Equals(sa, sb)) return false;
        }
        return true;
    }
}
