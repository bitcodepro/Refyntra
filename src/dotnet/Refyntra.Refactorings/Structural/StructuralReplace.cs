using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;
using SF = Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace Refyntra.Refactorings.Structural;

/// <summary>A match the replacement was refused for: where, and the first compiler error it would introduce.</summary>
public sealed record RefusedMatch(string Path, int Line, string Error);

/// <summary>
/// Structural replace (protocol 1.19, code/structuralReplace and the quick fixes of pattern inspections): every match
/// of the scope is replaced by the template with the placeholders' code (ADR-012). Inserted code is parenthesised where
/// precedence needs it (redundant parentheses are simplified away), the replaced nodes are formatted with the document's
/// options, a namespace of the pattern's imports is added as a using directive when the replacement needs it, and a
/// document that would get a new compiler error is redone match by match: the matches that add an error are refused and
/// listed. The result is one previewed, revalidated plan (SolutionPlanBuilder); nothing is written here.
/// </summary>
public static class StructuralReplace
{
    public const string ActionId = "csharp.structuralReplace";
    /// <summary>Quick fix of a pattern inspection: "csharp.edit.fix.structural." + rule id ("ORS-name").</summary>
    public const string FixPrefix = "csharp.edit.fix.structural.";
    private const int MaxReplacements = 20000;

    private static readonly SyntaxAnnotation Replaced = new("refyntra.ssr.replaced");
    private static readonly SyntaxAnnotation AddedUsing = new("refyntra.ssr.using");

    /// <summary>The replacement template, parsed the same way as its pattern (an expression, statements or members).</summary>
    public sealed class Template
    {
        public ParsedPattern Pattern { get; }
        public string Text { get; }

        public Template(ParsedPattern pattern)
        {
            Pattern = pattern;
            var raw = pattern.Spec.Replacement ?? throw new PatternException("NoReplacement", "The pattern has no replacement template.");
            foreach (var name in ParsedPattern.NamesIn(raw))
                if (!pattern.Placeholders.ContainsKey(name))
                    throw new PatternException("InvalidReplacement", $"The replacement uses ${name}$, which the pattern does not define.");
            Text = ParsedPattern.Substitute(raw).Trim();
            switch (pattern.Kind)
            {
                case PatternKind.Expression:
                    var e = SF.ParseExpression(Text);
                    if (Text.Length == 0 || e.ContainsDiagnostics || e.FullSpan.Length != Text.Length)
                        throw new PatternException("InvalidReplacement", "The pattern is an expression, so the replacement must be an expression" + FirstError(e));
                    break;
                case PatternKind.Statements:
                    var b = SF.ParseStatement("{\n" + Text + "\n}");
                    if (b.ContainsDiagnostics || b.FullSpan.Length != Text.Length + 4)
                        throw new PatternException("InvalidReplacement", "The pattern is statements, so the replacement must be statements" + FirstError(b));
                    break;
                default:
                    var u = SF.ParseCompilationUnit("class __SsrC {\n" + Text + "\n}");
                    if (u.ContainsDiagnostics)
                        throw new PatternException("InvalidReplacement", "The pattern is members, so the replacement must be members" + FirstError(u));
                    break;
            }
        }

        private static string FirstError(SyntaxNode n) => n.GetDiagnostics().FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error) is { } d ? ": " + d.GetMessage() + "." : ".";

        /// <summary>The replacement nodes of one match: one expression, or statements, or members (possibly none).</summary>
        public IReadOnlyList<SyntaxNode> Instantiate(IReadOnlyDictionary<string, Bound> bindings)
        {
            var rewriter = new TemplateRewriter(bindings);
            switch (Pattern.Kind)
            {
                case PatternKind.Expression:
                    return new[] { rewriter.Visit(SF.ParseExpression(Text)) };
                case PatternKind.Statements:
                    if (Text.Length == 0) return Array.Empty<SyntaxNode>();
                    return ((BlockSyntax)rewriter.Visit(SF.ParseStatement("{\n" + Text + "\n}"))).Statements.ToList();
                default:
                    if (Text.Length == 0) return Array.Empty<SyntaxNode>();
                    var c = (ClassDeclarationSyntax)SF.ParseCompilationUnit("class __SsrC {\n" + Text + "\n}").Members[0];
                    return ((ClassDeclarationSyntax)rewriter.Visit(c)).Members.ToList();
            }
        }
    }

    /// <summary>Puts the matched code into the template: expressions (parenthesised when needed), statement and argument runs, identifiers.</summary>
    private sealed class TemplateRewriter : CSharpSyntaxRewriter
    {
        private readonly IReadOnlyDictionary<string, Bound> _b;
        public TemplateRewriter(IReadOnlyDictionary<string, Bound> b) => _b = b;

        private Bound? Of(SyntaxNode? n) => n is IdentifierNameSyntax id && ParsedPattern.NameOf(id.Identifier.ValueText) is { } name && _b.TryGetValue(name, out var v) ? v : null;

        public override SyntaxNode? VisitIdentifierName(IdentifierNameSyntax node)
        {
            var b = Of(node);
            if (b == null) return base.VisitIdentifierName(node);
            if (b.Token is { } t) return SF.IdentifierName(SF.Identifier(t.ValueText)).WithTriviaFrom(node);
            if (b.Nodes.Count == 1)
            {
                var n = b.Nodes[0] is ArgumentSyntax { NameColon: null, RefKindKeyword.RawKind: 0 } a ? a.Expression : b.Nodes[0];
                if (n is ExpressionSyntax e)
                {
                    e = e.WithoutTrivia();
                    if (NeedsParentheses(e, node)) e = SF.ParenthesizedExpression(e).WithAdditionalAnnotations(Simplifier.Annotation);
                    return e.WithTriviaFrom(node);
                }
            }
            // Text of a list in an expression position (e.g. arguments used elsewhere): parsed back as an expression.
            return SF.ParseExpression(b.Text).WithTriviaFrom(node);
        }

        public override SyntaxToken VisitToken(SyntaxToken token)
        {
            if (token.IsKind(SyntaxKind.IdentifierToken) && token.Parent is not IdentifierNameSyntax
                && ParsedPattern.NameOf(token.ValueText) is { } name && _b.TryGetValue(name, out var b))
            {
                var text = b.Token?.ValueText ?? (b.Nodes.Count == 1 && b.Nodes[0] is SimpleNameSyntax sn ? sn.Identifier.ValueText : b.Text);
                return SF.Identifier(token.LeadingTrivia, text, token.TrailingTrivia);
            }
            return base.VisitToken(token);
        }

        public override SyntaxNode? VisitArgumentList(ArgumentListSyntax node) => node.WithArguments(Expand(node.Arguments));
        public override SyntaxNode? VisitBracketedArgumentList(BracketedArgumentListSyntax node) => node.WithArguments(Expand(node.Arguments));

        private SeparatedSyntaxList<ArgumentSyntax> Expand(SeparatedSyntaxList<ArgumentSyntax> args)
        {
            var list = new List<ArgumentSyntax>();
            foreach (var a in args)
            {
                if (a.NameColon == null && a.RefKindKeyword.RawKind == 0 && Of(a.Expression) is { } b && (b.IsList || b.Nodes.Any(n => n is ArgumentSyntax)))
                {
                    list.AddRange(b.Nodes.Select(n => n is ArgumentSyntax arg ? arg.WithoutTrivia() : SF.Argument(((ExpressionSyntax)n).WithoutTrivia())));
                    continue;
                }
                list.Add((ArgumentSyntax)Visit(a)!);
            }
            return SF.SeparatedList(list);
        }

        public override SyntaxNode? VisitBlock(BlockSyntax node)
        {
            var list = new List<StatementSyntax>();
            foreach (var s in node.Statements)
            {
                if (s is ExpressionStatementSyntax es && Of(es.Expression) is { } b && b.Nodes.All(n => n is StatementSyntax))
                {
                    list.AddRange(b.Nodes.Cast<StatementSyntax>().Select((x, i) => i == 0 ? x.WithLeadingTrivia(s.GetLeadingTrivia()) : x));
                    continue;
                }
                list.Add((StatementSyntax)Visit(s)!);
            }
            return node.WithStatements(SF.List(list));
        }

        public override SyntaxNode? VisitExpressionStatement(ExpressionStatementSyntax node)
        {
            // A statement placeholder outside a block (an if's body): the one statement it matched.
            if (Of(node.Expression) is { Nodes: [StatementSyntax st] }) return st.WithTriviaFrom(node);
            return base.VisitExpressionStatement(node);
        }
    }

    /// <summary>Whether an inserted expression needs parentheses at <paramref name="slot"/> (the simplifier removes unneeded ones).</summary>
    private static bool NeedsParentheses(ExpressionSyntax e, SyntaxNode slot) =>
        !IsAtomic(e) && slot.Parent is ExpressionSyntax && slot.Parent is not (ParenthesizedExpressionSyntax or InitializerExpressionSyntax);

    private static bool IsAtomic(ExpressionSyntax e) => e is SimpleNameSyntax or QualifiedNameSyntax or AliasQualifiedNameSyntax or PredefinedTypeSyntax
        or MemberAccessExpressionSyntax or InvocationExpressionSyntax or ElementAccessExpressionSyntax or LiteralExpressionSyntax
        or ParenthesizedExpressionSyntax or ThisExpressionSyntax or BaseExpressionSyntax or ObjectCreationExpressionSyntax
        or ImplicitObjectCreationExpressionSyntax or ArrayCreationExpressionSyntax or ImplicitArrayCreationExpressionSyntax
        or TypeOfExpressionSyntax or DefaultExpressionSyntax or SizeOfExpressionSyntax or InterpolatedStringExpressionSyntax
        or TupleExpressionSyntax or CheckedExpressionSyntax or ConditionalAccessExpressionSyntax
        || e is PostfixUnaryExpressionSyntax;

    // ------------------------------------------------------------------ applying matches to a document

    /// <summary>The matches that do not overlap an earlier (outer) match.</summary>
    public static List<StructuralMatch> Outermost(IEnumerable<StructuralMatch> matches)
    {
        var kept = new List<StructuralMatch>();
        foreach (var m in matches.OrderBy(m => m.Span.Start).ThenByDescending(m => m.Span.Length))
            if (kept.Count == 0 || !kept[^1].Span.IntersectsWith(m.Span) && kept[^1].Span.End <= m.Span.Start) kept.Add(m);
        return kept;
    }

    /// <summary>The document with the matches replaced, imports added where needed, simplified and formatted (not compile-checked).</summary>
    public static async Task<Document> ApplyAsync(Document doc, IReadOnlyList<StructuralMatch> matches, Template template, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var source = (await doc.GetTextAsync(ct).ConfigureAwait(false)).ToString();
        var eol = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var singles = new Dictionary<SyntaxNode, SyntaxNode>();
        var runs = new Dictionary<SyntaxNode, List<(int Start, int Count, IReadOnlyList<SyntaxNode> New)>>();
        foreach (var m in matches)
        {
            ct.ThrowIfCancellationRequested();
            var created = template.Instantiate(m.Bindings).Select(n => n.WithAdditionalAnnotations(Formatter.Annotation, Replaced)).ToList();
            var first = m.Nodes[0];
            switch (first)
            {
                case ExpressionSyntax old:
                {
                    var e = (ExpressionSyntax)created[0];
                    if (!IsAtomic(e) && old.Parent is ExpressionSyntax && old.Parent is not ParenthesizedExpressionSyntax)
                        e = SF.ParenthesizedExpression(e).WithAdditionalAnnotations(Simplifier.Annotation, Formatter.Annotation, Replaced);
                    singles[old] = e.WithTriviaFrom(old);
                    break;
                }
                case StatementSyntax when first.Parent is BlockSyntax or SwitchSectionSyntax:
                case MemberDeclarationSyntax when first.Parent is TypeDeclarationSyntax:
                {
                    var parent = first.Parent!;
                    var list = Elements(parent);
                    var start = list.IndexOf(first);
                    if (!runs.TryGetValue(parent, out var r)) runs[parent] = r = new();
                    var withTrivia = created.ToList();
                    if (withTrivia.Count > 0)
                    {
                        withTrivia[0] = withTrivia[0].WithLeadingTrivia(first.GetLeadingTrivia());
                        withTrivia[^1] = withTrivia[^1].WithTrailingTrivia(m.Nodes[^1].GetTrailingTrivia());
                        // One statement / member per line (the formatter indents them).
                        for (var k = 0; k < withTrivia.Count - 1; k++)
                            if (!withTrivia[k].GetTrailingTrivia().Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)))
                                withTrivia[k] = withTrivia[k].WithTrailingTrivia(withTrivia[k].GetTrailingTrivia().Where(t => !t.IsKind(SyntaxKind.WhitespaceTrivia)).Append(SF.EndOfLine(eol)));
                    }
                    r.Add((start, m.Nodes.Count, withTrivia));
                    break;
                }
                case StatementSyntax st:
                {
                    SyntaxNode replacement = created.Count == 1 ? created[0] : SF.Block(created.Cast<StatementSyntax>()).WithAdditionalAnnotations(Formatter.Annotation, Replaced);
                    singles[st] = replacement.WithTriviaFrom(st);
                    break;
                }
            }
        }
        var newRoot = root!.ReplaceNodes(singles.Keys.Concat(runs.Keys), (orig, rewritten) =>
        {
            if (singles.TryGetValue(orig, out var s)) return s;
            var edits = runs[orig].OrderBy(x => x.Start).ToList();
            var current = Elements(rewritten);
            var result = new List<SyntaxNode>();
            var i = 0;
            foreach (var (start, count, created) in edits)
            {
                while (i < start) result.Add(current[i++]);
                result.AddRange(created);
                i = start + count;
            }
            while (i < current.Count) result.Add(current[i++]);
            return rewritten switch
            {
                BlockSyntax b => b.WithStatements(SF.List(result.Cast<StatementSyntax>())),
                SwitchSectionSyntax sw => sw.WithStatements(SF.List(result.Cast<StatementSyntax>())),
                TypeDeclarationSyntax td => td.WithMembers(SF.List(result.Cast<MemberDeclarationSyntax>())),
                _ => rewritten,
            };
        });
        var changed = doc.WithSyntaxRoot(AddImports(newRoot, await MissingImportsAsync(doc, template.Pattern.Spec.EffectiveImports, ct).ConfigureAwait(false), eol));
        changed = await Simplifier.ReduceAsync(changed, Simplifier.Annotation, cancellationToken: ct).ConfigureAwait(false);
        changed = await RemoveUnneededImportsAsync(changed, ct).ConfigureAwait(false);
        changed = await Formatter.FormatAsync(changed, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
        return changed;
    }

    private static List<SyntaxNode> Elements(SyntaxNode parent) => parent switch
    {
        BlockSyntax b => b.Statements.Cast<SyntaxNode>().ToList(),
        SwitchSectionSyntax s => s.Statements.Cast<SyntaxNode>().ToList(),
        TypeDeclarationSyntax t => t.Members.Cast<SyntaxNode>().ToList(),
        _ => new List<SyntaxNode>(),
    };

    // ------------------------------------------------------------------ usings

    /// <summary>The pattern imports that the document does not import yet (its own usings and the project's global usings).</summary>
    private static async Task<List<string>> MissingImportsAsync(Document doc, IReadOnlyList<string> imports, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var present = new HashSet<string>(StringComparer.Ordinal);
        void AddFrom(IEnumerable<UsingDirectiveSyntax> us)
        {
            foreach (var u in us)
                if (u.Alias == null && u.StaticKeyword.RawKind == 0 && u.Name != null) present.Add(u.Name.ToString().Replace(" ", ""));
        }
        AddFrom(root!.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).OfType<UsingDirectiveSyntax>());
        var compilation = await doc.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        foreach (var tree in compilation?.SyntaxTrees ?? Enumerable.Empty<SyntaxTree>())
        {
            if (tree.GetRoot(ct) is CompilationUnitSyntax cu) AddFrom(cu.Usings.Where(u => u.GlobalKeyword.RawKind != 0));
        }
        return imports.Where(ns => !present.Contains(ns)).ToList();
    }

    private static SyntaxNode AddImports(SyntaxNode root, IReadOnlyList<string> namespaces, string eol)
    {
        if (namespaces.Count == 0 || root is not CompilationUnitSyntax cu) return root;
        var usings = cu.Usings.ToList();
        var hadUsings = usings.Count > 0;
        foreach (var ns in namespaces)
        {
            var directive = SF.UsingDirective(SF.ParseName(ns)).WithAdditionalAnnotations(AddedUsing, Formatter.Annotation)
                .WithTrailingTrivia(SF.EndOfLine(eol));
            var at = usings.FindIndex(u => u.Alias == null && u.StaticKeyword.RawKind == 0 && u.GlobalKeyword.RawKind == 0 && Compare(u.Name?.ToString() ?? "", ns) > 0);
            if (at < 0) at = usings.FindLastIndex(u => u.Alias == null && u.StaticKeyword.RawKind == 0 && u.GlobalKeyword.RawKind == 0) + 1;
            if (at < 0) at = 0;
            usings.Insert(at, directive);
        }
        if (!hadUsings)
        {
            // The first usings of the file: a blank line between them and the code.
            var last = usings.Count - 1;
            usings[last] = usings[last].WithTrailingTrivia(SF.EndOfLine(eol), SF.EndOfLine(eol));
        }
        return cu.WithUsings(SF.List(usings));
    }

    private static int Compare(string a, string b)
    {
        static int Rank(string s) => s == "System" || s.StartsWith("System.", StringComparison.Ordinal) ? 0 : 1;
        var r = Rank(a).CompareTo(Rank(b));
        return r != 0 ? r : string.CompareOrdinal(a, b);
    }

    /// <summary>Removes the added usings that no replaced code uses (a type named without qualification, an extension method).</summary>
    private static async Task<Document> RemoveUnneededImportsAsync(Document doc, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var added = root!.GetAnnotatedNodes(AddedUsing).OfType<UsingDirectiveSyntax>().ToList();
        if (added.Count == 0) return doc;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var needed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in root.GetAnnotatedNodes(Replaced))
            foreach (var name in node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().Where(n => n is not IdentifierNameSyntax { IsVar: true }))
            {
                var symbol = model!.GetSymbolInfo(name, ct).Symbol;
                var qualified = name.Parent is QualifiedNameSyntax q && q.Right == name || name.Parent is AliasQualifiedNameSyntax;
                var memberName = name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name;
                INamespaceSymbol? ns = symbol switch
                {
                    IMethodSymbol { ReducedFrom: not null } ext => ext.ContainingNamespace,
                    ITypeSymbol t when !qualified && !memberName => t.ContainingNamespace,
                    _ => null,
                };
                if (ns != null && !ns.IsGlobalNamespace) needed.Add(ns.ToDisplayString());
            }
        var remove = added.Where(u => !needed.Contains(u.Name!.ToString())).ToList();
        if (remove.Count == 0) return doc;
        return doc.WithSyntaxRoot(root.RemoveNodes(remove, SyntaxRemoveOptions.KeepNoTrivia)!);
    }

    // ------------------------------------------------------------------ compile check

    private static Dictionary<string, (int Count, Diagnostic First)> Errors(SemanticModel model, CancellationToken ct)
    {
        var d = new Dictionary<string, (int, Diagnostic)>(StringComparer.Ordinal);
        foreach (var x in model.GetDiagnostics(cancellationToken: ct).Where(x => x.Severity == DiagnosticSeverity.Error))
        {
            var k = x.Id + ": " + x.GetMessage();
            d[k] = d.TryGetValue(k, out var v) ? (v.Item1 + 1, v.Item2) : (1, x);
        }
        return d;
    }

    /// <summary>The first compiler error of <paramref name="changed"/> that <paramref name="original"/> did not have, or null.</summary>
    public static async Task<string?> NewErrorAsync(Document original, Document changed, CancellationToken ct)
    {
        var before = Errors((await original.GetSemanticModelAsync(ct).ConfigureAwait(false))!, ct);
        var after = Errors((await changed.GetSemanticModelAsync(ct).ConfigureAwait(false))!, ct);
        foreach (var (k, v) in after)
            if (v.Count > (before.TryGetValue(k, out var b) ? b.Count : 0)) return k;
        return null;
    }

    /// <summary>Replaces the matches of one document; when that adds an error, each match is checked alone and the failing ones are refused.</summary>
    public static async Task<(Document Doc, int Applied, List<RefusedMatch> Refused)> ApplyCheckedAsync(Document doc, IReadOnlyList<StructuralMatch> matches, Template template, CancellationToken ct)
    {
        var refused = new List<RefusedMatch>();
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        int LineOf(StructuralMatch m) => text.Lines.GetLineFromPosition(m.Span.Start).LineNumber + 1;
        var all = Outermost(matches);
        if (all.Count == 0) return (doc, 0, refused);
        var changed = await ApplyAsync(doc, all, template, ct).ConfigureAwait(false);
        if (await NewErrorAsync(doc, changed, ct).ConfigureAwait(false) == null) return (changed, all.Count, refused);
        var ok = new List<StructuralMatch>();
        foreach (var m in all)
        {
            ct.ThrowIfCancellationRequested();
            var one = await ApplyAsync(doc, new[] { m }, template, ct).ConfigureAwait(false);
            if (await NewErrorAsync(doc, one, ct).ConfigureAwait(false) is { } error) refused.Add(new RefusedMatch(doc.FilePath ?? "", LineOf(m), error));
            else ok.Add(m);
        }
        if (ok.Count == 0) return (doc, 0, refused);
        changed = await ApplyAsync(doc, ok, template, ct).ConfigureAwait(false);
        if (await NewErrorAsync(doc, changed, ct).ConfigureAwait(false) is { } together)
        {
            // Each one alone is fine but not all together: the document is left unchanged.
            refused.AddRange(ok.Select(m => new RefusedMatch(doc.FilePath ?? "", LineOf(m), "together with the other replacements of the file: " + together)));
            return (doc, 0, refused);
        }
        return (changed, ok.Count, refused);
    }

    // ------------------------------------------------------------------ plan

    /// <summary>One match to replace: the document and the start of its match (the result list's "Replace" of one row).</summary>
    public sealed record MatchRef(string Path, LinePosition Start);

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, PatternSpec spec, string scope, string? path, IReadOnlyList<MatchRef>? only, CancellationToken ct)
    {
        ParsedPattern parsed;
        Template template;
        try
        {
            parsed = ParsedPattern.Parse(spec);
            template = new Template(parsed);
        }
        catch (PatternException ex)
        {
            return RenameOutcome.Unavailable(ex.Reason, ex.Message);
        }
        if (Array.IndexOf(StructuralSearch.Scopes, scope) < 0) return RenameOutcome.Unavailable("InvalidParams", "scope must be document, project or solution.");
        var docs = StructuralSearch.ScopeDocuments(snapshot, scope, path);
        if (docs == null) return RenameOutcome.Unavailable("NoDocument", "The file is not a C# document of the loaded solution.");
        var binder = new StructuralSearch.Binder(parsed);
        var after = snapshot.Solution;
        int files = 0, applied = 0, readOnly = 0;
        var refused = new List<RefusedMatch>();
        foreach (var doc in docs)
        {
            ct.ThrowIfCancellationRequested();
            if (only != null && !only.Any(o => UriPaths.PathComparer.Equals(o.Path, doc.FilePath))) continue;
            List<StructuralMatch> matches;
            try
            {
                matches = await StructuralSearch.MatchDocumentAsync(snapshot, doc, binder, ct).ConfigureAwait(false);
            }
            catch (PatternException ex)
            {
                return RenameOutcome.Unavailable(ex.Reason, ex.Message);
            }
            if (matches.Count == 0) continue;
            if (only != null)
            {
                var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                matches = matches.Where(m => only.Any(o => UriPaths.PathComparer.Equals(o.Path, doc.FilePath) && text.Lines.GetLinePosition(m.Span.Start) == o.Start)).ToList();
                if (matches.Count == 0) continue;
            }
            if (RenamePlanner.IsReadOnly(doc.FilePath!)) { readOnly++; continue; }
            var (changed, n, r) = await ApplyCheckedAsync(doc, matches, template, ct).ConfigureAwait(false);
            refused.AddRange(r);
            if (n == 0) continue;
            var newText = await changed.GetTextAsync(ct).ConfigureAwait(false);
            foreach (var id in snapshot.Session.DocumentIdsForPath(doc.FilePath!)) after = after.WithDocumentText(id, newText);
            files++;
            applied += n;
            if (applied > MaxReplacements)
                return RenameOutcome.Unavailable("TooManyOccurrences", $"More than {MaxReplacements} replacements; replace in a project or a document first.");
        }
        var refusedText = refused.Take(10).Select(r => $"{Path.GetFileName(r.Path)}:{r.Line}: {r.Error}").ToList();
        if (refused.Count > 10) refusedText.Add($"… and {refused.Count - 10} more");
        if (applied == 0)
            return RenameOutcome.Unavailable(refused.Count > 0 ? "CompilationErrors" : "NoChanges",
                refused.Count > 0 ? $"Every replacement would introduce compiler errors: {string.Join("; ", refusedText)}" : "The pattern has no matches to replace in the " + scope + ".");
        var limitations = new List<string>();
        if (refused.Count > 0) limitations.Add($"{refused.Count} match(es) not replaced because the replacement would introduce compiler errors: {string.Join("; ", refusedText)}");
        if (readOnly > 0) limitations.Add($"{readOnly} read-only file(s) skipped.");
        var title = $"Structural replace ({applied} match(es) in {files} file(s))";
        var o = new SolutionPlanBuilder.Options(ActionId, title, limitations,
            new List<(string, Location?)> { ($"{applied} match(es) of the pattern replaced in {files} file(s)", null) }, new List<string>());
        return await SolutionPlanBuilder.BuildAsync(snapshot, after, o, ct).ConfigureAwait(false);
    }

    /// <summary>The quick fix of a pattern inspection: the match at <paramref name="at"/> replaced, compile-checked, as text edits.</summary>
    public static async Task<EditActionOutcome> ComputeFixAsync(Snapshot snapshot, string path, LinePosition at, PatternSpec spec, CancellationToken ct)
    {
        try
        {
            var parsed = ParsedPattern.Parse(spec);
            var template = new Template(parsed);
            var doc = snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);
            if (doc == null) return EditActionOutcome.Refused("NoDocument", "The file is not a C# document of the loaded solution.");
            if (RenamePlanner.IsReadOnly(path)) return EditActionOutcome.Refused("ReadOnlyFile", "The file is read-only.");
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            if (at.Line >= text.Lines.Count) return EditActionOutcome.Refused("NotApplicable", "The pattern does not match here.");
            var pos = text.Lines.GetPosition(at);
            var matches = await StructuralSearch.MatchDocumentAsync(snapshot, doc, new StructuralSearch.Binder(parsed), ct).ConfigureAwait(false);
            var m = matches.Where(x => x.Span.Start <= pos && pos <= x.Span.End).OrderByDescending(x => x.Span.Start == pos).ThenBy(x => x.Span.Length).FirstOrDefault();
            if (m == null) return EditActionOutcome.Refused("NotApplicable", "The pattern does not match here.");
            var changed = await ApplyAsync(doc, new[] { m }, template, ct).ConfigureAwait(false);
            if (await NewErrorAsync(doc, changed, ct).ConfigureAwait(false) is { } error)
                return EditActionOutcome.Refused("CompilationErrors", "The replacement would introduce compiler errors: " + error);
            var newText = await changed.GetTextAsync(ct).ConfigureAwait(false);
            var edits = newText.GetTextChanges(text).OrderBy(x => x.Span.Start).Select(x => (text.Lines.GetLinePositionSpan(x.Span), x.NewText ?? "")).ToList();
            if (edits.Count == 0) return EditActionOutcome.Refused("NoChanges", "The replacement produces no edits.");
            return new EditActionOutcome(edits, Hashing.Sha256Text(text.ToString()), null, null);
        }
        catch (PatternException ex)
        {
            return EditActionOutcome.Refused(ex.Reason, ex.Message);
        }
    }
}
