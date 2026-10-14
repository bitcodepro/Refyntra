using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>One postfix template that applies to the expression before the dot (protocol 1.10, code/postfix).</summary>
/// <param name="Name">Template name typed after the dot, e.g. "foreach".</param>
/// <param name="Detail">The inserted code without tab stops (shown in the completion list).</param>
/// <param name="Snippet">VS Code snippet text that replaces the expression, the dot and the typed name.</param>
public sealed record PostfixTemplate(string Name, string Detail, string Snippet);

/// <summary>The templates at a position: the expression's range (start to the dot) and type, or none.</summary>
public sealed record PostfixOutcome(LinePositionSpan? ExpressionRange, string? TypeName, IReadOnlyList<PostfixTemplate> Items)
{
    public static readonly PostfixOutcome None = new(null, null, Array.Empty<PostfixTemplate>());
}

/// <summary>
/// Rider-style postfix templates for C#: `expr.foreach`, `expr.if`, `expr.var`… The expression before the dot is found
/// on a copy of the document where `.name` is replaced by `;` (so `list.` followed by more code still parses as the
/// statement `list;`), its type facts come from the semantic model of that copy, and each statement template is
/// formatted with the document's options (.editorconfig) and turned into a snippet with tab stops. Never writes files.
/// </summary>
public static class PostfixPlanner
{
    /// <summary>All template names, in the order they are offered.</summary>
    public static readonly string[] Names =
    {
        "if", "ifn", "notnull", "not", "var", "foreach", "for", "forr", "await", "return", "throw", "new", "par", "cast", "arg",
        "using", "lock", "switch", "while", "nameof", "yield",
    };

    private const string Body = "__rfy0__";
    private static string Mark(int n) => "__rfy" + n + "__";

    private sealed record Facts(ExpressionSyntax Expr, string Text, bool Statement, ITypeSymbol? Type, ISymbol? Symbol, bool IsTypeName, SemanticModel Model, Document Doc, Microsoft.CodeAnalysis.Options.OptionSet Options)
    {
        public List<Pending> Pending { get; } = new();
    }

    /// <summary>The templates that apply after the dot before <paramref name="position"/> (the typed name may follow the dot).</summary>
    public static async Task<PostfixOutcome> ListAsync(Snapshot snapshot, string path, LinePosition position, CancellationToken ct)
    {
        var doc = snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);
        if (doc == null) return PostfixOutcome.None;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return PostfixOutcome.None;
        var line = text.Lines[position.Line];
        var pos = Math.Min(line.Start + position.Character, line.End);
        var nameStart = pos;
        while (nameStart > line.Start && (char.IsLetterOrDigit(text[nameStart - 1]) || text[nameStart - 1] == '_')) nameStart--;
        var dot = nameStart - 1;
        if (dot <= line.Start - 1 || dot < 1 || text[dot] != '.') return PostfixOutcome.None;
        var before = text[dot - 1];
        if (char.IsWhiteSpace(before) || before == '.' || before == '?' || char.IsDigit(before) && IsNumberStart(text, dot - 1)) return PostfixOutcome.None;
        var tree0 = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree0 == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree0, ct)) return PostfixOutcome.None;
        // Not in a comment, string or directive.
        var dotToken = (await tree0.GetRootAsync(ct).ConfigureAwait(false)).FindToken(dot);
        if (!dotToken.IsKind(SyntaxKind.DotToken) || dotToken.SpanStart != dot) return PostfixOutcome.None;

        var copy = doc.WithText(text.WithChanges(new TextChange(TextSpan.FromBounds(dot, pos), ";")));
        var root = await copy.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await copy.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null || model == null) return PostfixOutcome.None;
        var token = root.FindToken(dot - 1);
        if (token.Span.End != dot || token.IsKind(SyntaxKind.StringLiteralToken) && token.Span.End != dot) return PostfixOutcome.None;
        ExpressionSyntax? expr = null;
        foreach (var n in token.Parent!.AncestorsAndSelf())
        {
            if (n is AnonymousFunctionExpressionSyntax or StatementSyntax or MemberDeclarationSyntax) break;
            if (n is ExpressionSyntax e && e.Span.End == dot) expr = e;
            else if (n.Span.End != dot) break;
        }
        if (expr is AssignmentExpressionSyntax asg) expr = asg.Right;
        if (expr == null || expr.ContainsDiagnostics && expr.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) return PostfixOutcome.None;
        if (expr.Ancestors().Any(a => a is UsingDirectiveSyntax or AttributeSyntax || a is BaseNamespaceDeclarationSyntax ns && ns.Name.Span.Contains(expr.Span))) return PostfixOutcome.None;
        if (!expr.Ancestors().Any(a => a is StatementSyntax or ArrowExpressionClauseSyntax or EqualsValueClauseSyntax or GlobalStatementSyntax)) return PostfixOutcome.None;

        var info = model.GetTypeInfo(expr, ct);
        var symbolInfo = model.GetSymbolInfo(expr, ct);
        var symbol = symbolInfo.Symbol ?? (symbolInfo.CandidateSymbols.Length == 1 ? symbolInfo.CandidateSymbols[0] : null);
        if (symbol is INamespaceSymbol) return PostfixOutcome.None;
        var isType = symbol is ITypeSymbol && expr is NameSyntax or MemberAccessExpressionSyntax or PredefinedTypeSyntax && symbol is ITypeSymbol;
        var type = isType ? (ITypeSymbol)symbol! : info.Type;
        if (!isType && !(symbol is IMethodSymbol && info.Type == null) && (type == null || type.TypeKind == TypeKind.Error || type.SpecialType == SpecialType.System_Void)) return PostfixOutcome.None;
        var statement = !isType && expr.Parent is ExpressionStatementSyntax es && es.Expression == expr;
        var options = await copy.GetOptionsAsync(ct).ConfigureAwait(false);
        var f = new Facts(expr, expr.ToString(), statement, type, symbol, isType, model, copy, options);
        var items = new List<PostfixTemplate>();
        foreach (var name in Names)
        {
            ct.ThrowIfCancellationRequested();
            var t = Build(f, name, ct);
            if (t != null) items.Add(t);
        }
        var formattedStatements = await FormatPendingAsync(f, ct).ConfigureAwait(false);
        items = items.Select(i => i.Snippet.Length > 0 ? i : formattedStatements.GetValueOrDefault(i.Name)).Where(i => i != null).Select(i => i!).ToList();
        var range = text.Lines.GetLinePositionSpan(expr.Span);
        var typeName = type?.ToMinimalDisplayString(model, expr.SpanStart);
        return new PostfixOutcome(range, typeName, items);
    }

    private static bool IsNumberStart(SourceText text, int i)
    {
        while (i >= 0 && char.IsDigit(text[i])) i--;
        return i < 0 || !(char.IsLetter(text[i]) || text[i] == '_');
    }

    // ------------------------------------------------------------------ type facts

    private static bool Implements(ITypeSymbol t, string metadataName) =>
        t.AllInterfaces.Any(i => i.OriginalDefinition.ToDisplayString() == metadataName) || t.OriginalDefinition.ToDisplayString() == metadataName;

    private static bool IsEnumerable(ITypeSymbol t) =>
        t is IArrayTypeSymbol || t.SpecialType == SpecialType.System_String || Implements(t, "System.Collections.IEnumerable")
        || t.GetMembers("GetEnumerator").Any(m => m is IMethodSymbol { Parameters.Length: 0, IsStatic: false });

    private static string? CountMember(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol || t.SpecialType == SpecialType.System_String) return "Length";
        var hasIndexer = AllMembers(t).OfType<IPropertySymbol>().Any(p => p.IsIndexer && p.Parameters.Length == 1 && p.Parameters[0].Type.SpecialType == SpecialType.System_Int32 && p.GetMethod != null);
        if (!hasIndexer) return null;
        foreach (var n in new[] { "Count", "Length" })
            if (AllMembers(t).OfType<IPropertySymbol>().Any(p => p.Name == n && !p.IsStatic && p.Type.SpecialType == SpecialType.System_Int32)) return n;
        return null;
    }

    private static IEnumerable<ISymbol> AllMembers(ITypeSymbol t)
    {
        for (ITypeSymbol? x = t; x != null; x = x.BaseType)
            foreach (var m in x.GetMembers()) yield return m;
        foreach (var i in t.AllInterfaces)
            foreach (var m in i.GetMembers()) yield return m;
    }

    private static bool IsAwaitable(Facts f) =>
        f.Type != null && !f.Model.LookupSymbols(f.Expr.SpanStart, f.Type, "GetAwaiter", includeReducedExtensionMethods: true)
            .OfType<IMethodSymbol>().Where(m => !m.IsStatic || m.MethodKind == MethodKind.ReducedExtension).All(m => m.Parameters.Length > 0);

    private static bool CanBeNull(ITypeSymbol t) =>
        t.IsReferenceType || t.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T || t is ITypeParameterSymbol { IsValueType: false };

    private static bool IsException(ITypeSymbol t)
    {
        for (var x = t as INamedTypeSymbol; x != null; x = x.BaseType)
            if (x.ToDisplayString() == "System.Exception") return true;
        return false;
    }

    private static bool InIterator(Facts f)
    {
        if (f.Model.GetEnclosingSymbol(f.Expr.SpanStart) is not IMethodSymbol { MethodKind: not MethodKind.AnonymousFunction } m) return false;
        var name = m.ReturnType.OriginalDefinition.ToDisplayString();
        return name is "System.Collections.Generic.IEnumerable<T>" or "System.Collections.Generic.IEnumerator<T>" or "System.Collections.IEnumerable"
            or "System.Collections.IEnumerator" or "System.Collections.Generic.IAsyncEnumerable<T>";
    }

    private static bool ReturnsValue(Facts f) =>
        f.Model.GetEnclosingSymbol(f.Expr.SpanStart) is IMethodSymbol m && !m.ReturnsVoid && !m.IsIterator
        && !(m.IsAsync && m.ReturnType is INamedTypeSymbol { Arity: 0, Name: "Task" or "ValueTask" });

    private static bool IsPrimary(ExpressionSyntax e) =>
        e is IdentifierNameSyntax or GenericNameSyntax or MemberAccessExpressionSyntax or InvocationExpressionSyntax or ElementAccessExpressionSyntax
            or LiteralExpressionSyntax or ParenthesizedExpressionSyntax or ThisExpressionSyntax or BaseExpressionSyntax or ObjectCreationExpressionSyntax
            or ImplicitObjectCreationExpressionSyntax or InterpolatedStringExpressionSyntax or PredefinedTypeSyntax or TypeOfExpressionSyntax
            or DefaultExpressionSyntax or ConditionalAccessExpressionSyntax or PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression };

    // ------------------------------------------------------------------ templates

    private static PostfixTemplate? Build(Facts f, string name, CancellationToken ct)
    {
        var e = f.Text;
        var t = f.Type;
        string P() => IsPrimary(f.Expr) ? e : "(" + e + ")";
        if (f.IsTypeName)
        {
            return name switch
            {
                "new" when t is INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct, IsAbstract: false, IsStatic: false } nt
                    && (nt.TypeKind == TypeKind.Struct || nt.InstanceConstructors.Any(c => f.Model.IsAccessible(f.Expr.SpanStart, c)))
                    => Expression(name, "new " + e + "()", Esc("new " + e + "(") + "$0)"),
                "nameof" => Expression(name, "nameof(" + e + ")", Esc("nameof(" + e + ")") + "$0"),
                _ => null,
            };
        }
        if (t == null)
            return name == "nameof" && f.Symbol is IMethodSymbol ? Expression(name, "nameof(" + e + ")", Esc("nameof(" + e + ")") + "$0") : null;
        var isBool = t.SpecialType == SpecialType.System_Boolean;
        switch (name)
        {
            case "if" when isBool && f.Statement: return Statement(f, name, $"if ({e})\n{{\n{Body};\n}}", ct);
            case "ifn" when f.Statement && CanBeNull(t): return Statement(f, name, $"if ({P()} is null)\n{{\n{Body};\n}}", ct);
            // 'is not null' is C# 9; before it the same test is '!(x is null)'.
            case "notnull" when f.Statement && CanBeNull(t):
                return Statement(f, name, EditActionsPlanner.LangAtLeast(f.Model.SyntaxTree, LanguageVersion.CSharp9) ? $"if ({P()} is not null)\n{{\n{Body};\n}}" : $"if (!({e} is null))\n{{\n{Body};\n}}", ct);
            case "while" when isBool && f.Statement: return Statement(f, name, $"while ({e})\n{{\n{Body};\n}}", ct);
            case "not" when isBool: return Expression(name, "!" + P(), Esc("!" + P()) + "$0");
            case "var" when f.Statement: return Statement(f, name, $"var {Mark(1)} = {e};", ct, (1, SuggestName(f, false)));
            case "foreach" when f.Statement && IsEnumerable(t): return Statement(f, name, $"foreach (var {Mark(1)} in {e})\n{{\n{Body};\n}}", ct, (1, SuggestName(f, true)));
            case "for" when f.Statement && CountMember(t) is { } cnt:
            {
                var i = Unique(f, "i", "j", "k");
                return Statement(f, name, $"for (var {Mark(1)} = 0; {Mark(1)} < {P()}.{cnt}; {Mark(1)}++)\n{{\n{Body};\n}}", ct, (1, i));
            }
            case "forr" when f.Statement && CountMember(t) is { } cnt2:
            {
                var i = Unique(f, "i", "j", "k");
                return Statement(f, name, $"for (var {Mark(1)} = {P()}.{cnt2} - 1; {Mark(1)} >= 0; {Mark(1)}--)\n{{\n{Body};\n}}", ct, (1, i));
            }
            case "await" when IsAwaitable(f): return Expression(name, "await " + P(), Esc("await " + P()) + "$0");
            case "return" when f.Statement && ReturnsValue(f): return Statement(f, name, $"return {e};", ct);
            case "throw" when f.Statement && IsException(t): return Statement(f, name, $"throw {e};", ct);
            case "par": return Expression(name, "(" + e + ")", Esc("(" + e + ")") + "$0");
            case "cast": return Expression(name, "((T)" + P() + ")", "((${1:" + EscPlaceholder(Display(f, t)) + "})" + Esc(P()) + ")$0");
            case "arg": return Expression(name, "Method(" + e + ")", "${1:Method}(" + Esc(e) + ")$0");
            // 'await using' (only IAsyncDisposable) is C# 8.
            case "using" when f.Statement && (Implements(t, "System.IDisposable")
                || Implements(t, "System.IAsyncDisposable") && EditActionsPlanner.LangAtLeast(f.Model.SyntaxTree, LanguageVersion.CSharp8)):
            {
                var aw = !Implements(t, "System.IDisposable") ? "await " : "";
                return Statement(f, name, $"{aw}using (var {Mark(1)} = {e})\n{{\n{Body};\n}}", ct, (1, SuggestName(f, false)));
            }
            case "lock" when f.Statement && t.IsReferenceType: return Statement(f, name, $"lock ({e})\n{{\n{Body};\n}}", ct);
            case "switch" when f.Statement: return Statement(f, name, $"switch ({e})\n{{\ncase {Mark(1)}:\n{Body};\nbreak;\n}}", ct, (1, t.TypeKind == TypeKind.Enum ? Display(f, t) + "." + (t.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(x => x.IsConst)?.Name ?? "Value") : "value"));
            case "nameof" when f.Symbol is ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol or IEventSymbol or IMethodSymbol && f.Expr is IdentifierNameSyntax or MemberAccessExpressionSyntax:
                return Expression(name, "nameof(" + e + ")", Esc("nameof(" + e + ")") + "$0");
            case "yield" when f.Statement && InIterator(f): return Statement(f, name, $"yield return {e};", ct);
        }
        return null;
    }

    private static string Display(Facts f, ITypeSymbol t) =>
        t.ToMinimalDisplayString(f.Model, f.Expr.SpanStart, SymbolDisplayFormat.MinimallyQualifiedFormat.AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier));

    private static PostfixTemplate Expression(string name, string detail, string snippet) => new(name, detail, snippet);

    /// <summary>Escapes text for a VS Code snippet (outside placeholders).</summary>
    public static string Esc(string s) => s.Replace("\\", "\\\\").Replace("$", "\\$");

    /// <summary>Escapes a placeholder default (also '}').</summary>
    public static string EscPlaceholder(string s) => Esc(s).Replace("}", "\\}");

    private sealed record Pending(string Name, StatementSyntax Statement, (int n, string value)[] Stops, SyntaxAnnotation Annotation);

    /// <summary>A statement template: parsed now, formatted later together with the others (<see cref="FormatPendingAsync"/>).</summary>
    private static PostfixTemplate? Statement(Facts f, string name, string code, CancellationToken ct, params (int n, string value)[] stops)
    {
        var stmt = SyntaxFactory.ParseStatement(code);
        if (stmt.ContainsDiagnostics || stmt.FullSpan.Length != code.Length) return null;
        f.Pending.Add(new Pending(name, stmt, stops, new SyntaxAnnotation("refyntra.postfix", name)));
        return new PostfixTemplate(name, "", "");
    }

    /// <summary>
    /// Formats every statement template in place of the expression statement (one block, one formatting pass with the
    /// document's options), removes the statement's own indentation (the editor re-indents snippet lines to the cursor
    /// line), then turns the markers into tab stops: the first occurrence of a numbered marker gets the default, the
    /// others mirror it; the body marker statement becomes the final $0.
    /// </summary>
    private static async Task<Dictionary<string, PostfixTemplate>> FormatPendingAsync(Facts f, CancellationToken ct)
    {
        var result = new Dictionary<string, PostfixTemplate>(StringComparer.Ordinal);
        if (f.Pending.Count == 0 || f.Expr.Parent is not ExpressionStatementSyntax es) return result;
        var block = SyntaxFactory.Block(f.Pending.Select(p => p.Statement.WithAdditionalAnnotations(p.Annotation)))
            .WithTriviaFrom(es).WithAdditionalAnnotations(Formatter.Annotation);
        var root = await f.Doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var doc = await Formatter.FormatAsync(f.Doc.WithSyntaxRoot(root!.ReplaceNode(es, block)), Formatter.Annotation, f.Options, ct).ConfigureAwait(false);
        var formattedRoot = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        foreach (var p in f.Pending)
        {
            var node = formattedRoot!.GetAnnotatedNodes(p.Annotation).FirstOrDefault();
            if (node == null) continue;
            var lines = node.ToString().Replace("\r\n", "\n").Split('\n');
            // The last line of a multi-line statement (its closing brace) is at the statement's own indentation.
            var lastLine = lines[^1];
            var indent = lastLine[..(lastLine.Length - lastLine.TrimStart().Length)];
            var formatted = string.Join("\n", lines.Select((l, i) => i > 0 && l.StartsWith(indent, StringComparison.Ordinal) ? l[indent.Length..] : l));
            var detail = string.Join("\n", formatted.Split('\n').Where(l => l.Trim() != Body + ";"));
            foreach (var (n, value) in p.Stops) detail = detail.Replace(Mark(n), value);
            var snippet = Esc(formatted).Replace(Body + ";", "$0");
            foreach (var (n, value) in p.Stops)
            {
                var m = Mark(n);
                var first = snippet.IndexOf(m, StringComparison.Ordinal);
                if (first < 0) continue;
                snippet = snippet[..first] + "${" + n + ":" + EscPlaceholder(value) + "}" + snippet[(first + m.Length)..].Replace(m, "$" + n);
            }
            if (!snippet.Contains("$0", StringComparison.Ordinal)) snippet += "$0";
            result[p.Name] = new PostfixTemplate(p.Name, detail, snippet);
        }
        return result;
    }

    // ------------------------------------------------------------------ names

    private static string Unique(Facts f, params string[] names)
    {
        var taken = Taken(f);
        foreach (var n in names) if (Free(f, taken, n)) return n;
        var b = names[0];
        for (var i = 2; ; i++) if (Free(f, taken, b + i)) return b + i;
    }

    private static HashSet<string> Taken(Facts f)
    {
        var member = f.Expr.Ancestors().FirstOrDefault(a => a is MemberDeclarationSyntax or LocalFunctionStatementSyntax or GlobalStatementSyntax) ?? f.Expr.Parent!;
        if (member is GlobalStatementSyntax) member = member.Parent!;
        return new HashSet<string>(member.DescendantNodes().Select(n => n switch
        {
            VariableDeclaratorSyntax v => v.Identifier.ValueText,
            SingleVariableDesignationSyntax s => s.Identifier.ValueText,
            ParameterSyntax p => p.Identifier.ValueText,
            ForEachStatementSyntax fe => fe.Identifier.ValueText,
            CatchDeclarationSyntax cd => cd.Identifier.ValueText,
            LocalFunctionStatementSyntax lf => lf.Identifier.ValueText,
            _ => "",
        }), StringComparer.Ordinal);
    }

    private static bool Free(Facts f, HashSet<string> taken, string n) =>
        !taken.Contains(n) && f.Model.LookupSymbols(f.Expr.SpanStart, name: n).IsEmpty;

    /// <summary>A local name from the expression (member or method name without Get, singular for foreach) or its type.</summary>
    public static string SuggestBaseName(ExpressionSyntax expr, ITypeSymbol type, bool element)
    {
        string? baseName = expr switch
        {
            InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } => ma.Name.Identifier.ValueText,
            InvocationExpressionSyntax { Expression: IdentifierNameSyntax id } => id.Identifier.ValueText,
            MemberAccessExpressionSyntax ma2 => ma2.Name.Identifier.ValueText,
            IdentifierNameSyntax id2 => id2.Identifier.ValueText,
            _ => null,
        };
        if (baseName != null && baseName.StartsWith("Get", StringComparison.Ordinal) && baseName.Length > 3 && char.IsUpper(baseName[3])) baseName = baseName[3..];
        baseName = baseName?.TrimStart('_');
        if (baseName != null && baseName.StartsWith("m_", StringComparison.Ordinal)) baseName = baseName[2..];
        if (element)
        {
            var single = baseName == null ? null : Singular(baseName);
            if (single == null)
            {
                var et = ElementType(type);
                single = et != null && et.SpecialType == SpecialType.None && et.Name is { Length: > 0 } en && char.IsLetter(en[0]) && et is not ITypeParameterSymbol ? StripI(et) : "item";
            }
            baseName = single;
        }
        else if (string.IsNullOrEmpty(baseName) || !char.IsLetter(baseName[0]) || expr is IdentifierNameSyntax)
        {
            baseName = type.SpecialType switch
            {
                SpecialType.System_String => "text",
                SpecialType.System_Boolean => "flag",
                _ when type.SpecialType != SpecialType.None => "value",
                _ => type is IArrayTypeSymbol ? "items" : type.Name is { Length: > 0 } n && char.IsLetter(n[0]) && !type.IsTupleType && type is not ITypeParameterSymbol ? StripI(type) : "value",
            };
        }
        var name = char.ToLowerInvariant(baseName![0]) + baseName[1..];
        if (SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None || SyntaxFacts.GetContextualKeywordKind(name) is SyntaxKind.VarKeyword) name = "@" + name;
        return name;
    }

    private static string StripI(ITypeSymbol t) =>
        t.TypeKind == TypeKind.Interface && t.Name.Length > 1 && t.Name[0] == 'I' && char.IsUpper(t.Name[1]) ? t.Name[1..] : t.Name;

    private static ITypeSymbol? ElementType(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol a) return a.ElementType;
        var e = t.AllInterfaces.Concat(t is INamedTypeSymbol nt ? new[] { nt } : Array.Empty<INamedTypeSymbol>())
            .FirstOrDefault(i => i.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.IEnumerable<T>");
        return e?.TypeArguments[0];
    }

    private static string? Singular(string plural)
    {
        if (plural.Length > 3 && plural.EndsWith("ies", StringComparison.Ordinal)) return plural[..^3] + "y";
        if (plural.Length > 3 && (plural.EndsWith("ses", StringComparison.Ordinal) || plural.EndsWith("xes", StringComparison.Ordinal) || plural.EndsWith("ches", StringComparison.Ordinal) || plural.EndsWith("shes", StringComparison.Ordinal))) return plural[..^2];
        if (plural.Length > 1 && plural.EndsWith('s') && !plural.EndsWith("ss", StringComparison.Ordinal)) return plural[..^1];
        return null;
    }

    private static string SuggestName(Facts f, bool element)
    {
        var baseName = SuggestBaseName(f.Expr, f.Type!, element);
        var bare = baseName.TrimStart('@');
        // The expression's own name (list.var → list) is taken: use the type-based name or a numbered one.
        var taken = Taken(f);
        if (Free(f, taken, baseName) && baseName != f.Text) return baseName;
        for (var i = 2; ; i++) if (Free(f, taken, bare + i)) return bare + i;
    }
}
