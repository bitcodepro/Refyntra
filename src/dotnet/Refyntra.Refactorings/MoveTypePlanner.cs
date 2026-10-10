using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>Whether an action is shown in Actions at all, and if so whether it is available (null reason) or why not.</summary>
public sealed record ActionApplicability(bool Show, string? ReasonCode = null, string? Message = null)
{
    public static readonly ActionApplicability Hidden = new(false);
    public static readonly ActionApplicability Available = new(true);
    public static ActionApplicability Unavailable(string code, string message) => new(true, code, message);
}

/// <summary>
/// Move Type to File: moves a top-level type out of a file with several top-level types into a new file named after
/// it, in the same folder, with the same namespace declarations (file-scoped or block), only the usings the moved code
/// needs and its comments, documentation and attributes. Refused: partial and file-local types, generated files,
/// preprocessor directives that could change what the moved code means (#if and friends, #nullable, #pragma), a layout
/// that does not put the type on its own lines. The new file must bind every name of the moved code to exactly the
/// symbols it bound before. Never writes files.
/// </summary>
public static class MoveTypePlanner
{
    public const string ActionId = "csharp.moveTypeToFile";

    private static readonly SyntaxKind[] ConditionalDirectives =
    {
        SyntaxKind.IfDirectiveTrivia, SyntaxKind.ElifDirectiveTrivia, SyntaxKind.ElseDirectiveTrivia, SyntaxKind.EndIfDirectiveTrivia,
        SyntaxKind.DefineDirectiveTrivia, SyntaxKind.UndefDirectiveTrivia, SyntaxKind.NullableDirectiveTrivia,
        SyntaxKind.PragmaWarningDirectiveTrivia, SyntaxKind.PragmaChecksumDirectiveTrivia, SyntaxKind.LineDirectiveTrivia,
        SyntaxKind.LineSpanDirectiveTrivia, SyntaxKind.ErrorDirectiveTrivia, SyntaxKind.WarningDirectiveTrivia,
    };

    private sealed record Located(INamedTypeSymbol Type, Document Document, SyntaxTree Tree, CompilationUnitSyntax Root, MemberDeclarationSyntax Declaration);

    /// <summary>
    /// Whether Move Type to File is offered for <paramref name="symbol"/> at a position in <paramref name="documentPath"/>:
    /// hidden unless the cursor is on the declaration of a top-level type (nested types are not offered) in a file with
    /// other top-level types; unavailable with the reason for the refusals.
    /// </summary>
    public static ActionApplicability Applicability(Snapshot snapshot, ISymbol symbol, string? documentPath, CancellationToken ct)
    {
        var located = Locate(snapshot, symbol, documentPath, ct, out var hidden);
        if (located == null) return hidden ?? ActionApplicability.Hidden;
        return Refusal(snapshot, located, ct) is { } r ? ActionApplicability.Unavailable(r.code, r.message) : ActionApplicability.Available;
    }

    private static Located? Locate(Snapshot snapshot, ISymbol symbol, string? documentPath, CancellationToken ct, out ActionApplicability? result)
    {
        result = null;
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) symbol = ctor.ContainingType;
        if (symbol is not INamedTypeSymbol type || type.ContainingType != null || type.IsImplicitlyDeclared) return null;
        var refs = type.DeclaringSyntaxReferences;
        if (refs.Length == 0) return null;
        // Offered on the declaration only: the cursor's document declares the type.
        var here = refs.FirstOrDefault(r => documentPath != null && UriPaths.PathComparer.Equals(r.SyntaxTree.FilePath, documentPath));
        if (here == null) return null;
        var tree = here.SyntaxTree;
        if (tree.GetRoot(ct) is not CompilationUnitSyntax root) return null;
        if (here.GetSyntax(ct) is not MemberDeclarationSyntax decl) return null;
        var topLevel = TopLevelTypes(root).ToList();
        if (topLevel.Count < 2 || !topLevel.Contains(decl)) return null; // alone in its file: nothing to move (Rename names files)
        var doc = snapshot.Solution.GetDocument(tree);
        if (doc?.FilePath == null) return null;
        if (refs.Length > 1 || type.DeclaringSyntaxReferences.Any(r => r.GetSyntax(ct) is TypeDeclarationSyntax t && t.Modifiers.Any(SyntaxKind.PartialKeyword)))
            result = ActionApplicability.Unavailable("PartialType", $"{type.Name} is a partial type; this version does not move partial types (all parts would have to move consistently).");
        else if (type.IsFileLocal)
            result = ActionApplicability.Unavailable("FileLocalType", $"{type.Name} is a file-local type; moving it to another file would change which code can see it.");
        else if (SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct))
            result = ActionApplicability.Unavailable("GeneratedCode", $"{Path.GetFileName(doc.FilePath)} is generated code.");
        return result == null ? new Located(type, doc, tree, root, decl) : null;
    }

    /// <summary>Top-level type and delegate declarations of a file (inside namespaces, not nested in types).</summary>
    private static IEnumerable<MemberDeclarationSyntax> TopLevelTypes(CompilationUnitSyntax root) =>
        root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
            .OfType<MemberDeclarationSyntax>().Where(m => m is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax);

    private static string NewPath(Located l) => Path.Combine(Path.GetDirectoryName(l.Document.FilePath!)!, l.Type.Name + ".cs");

    /// <summary>Cheap refusals (Actions and prepare): directives, layout, target present.</summary>
    private static (string code, string message)? Refusal(Snapshot snapshot, Located l, CancellationToken ct)
    {
        var file = Path.GetFileName(l.Document.FilePath!);
        if (l.Root.DescendantTrivia(descendIntoTrivia: true).Any(t => ConditionalDirectives.Contains(t.Kind())))
            return ("PreprocessorDirectives", $"{file} contains preprocessor directives (#if, #nullable, #pragma, ...) that could change what the moved code means; this version does not move types out of such files.");
        if (Layout(l.Tree.GetText(ct), l.Declaration) is { Problem: { } problem }) return ("UnsupportedLayout", problem);
        if (CreateFilePlanner.CheckTarget(NewPath(l), l.Document.FilePath!) is { } t) return t;
        return null;
    }

    private sealed record Span(int Start, int End, int RemoveStart, int RemoveEnd, string? Problem);

    /// <summary>
    /// The lines of the moved type: its attached comment block (comments directly above it, up to a blank line or a
    /// directive), the declaration and its trailing trivia to the end of its line. Removal also drops one surplus blank line.
    /// </summary>
    private static Span Layout(SourceText text, MemberDeclarationSyntax decl)
    {
        var start = decl.SpanStart;
        var leading = decl.GetLeadingTrivia();
        for (var i = leading.Count - 1; i >= 0; i--)
        {
            var t = leading[i];
            if (t.IsKind(SyntaxKind.WhitespaceTrivia)) continue;
            if (t.IsKind(SyntaxKind.EndOfLineTrivia))
            {
                var line = text.Lines.GetLineFromPosition(t.SpanStart);
                if (string.IsNullOrWhiteSpace(text.ToString(TextSpan.FromBounds(line.Start, t.SpanStart)))) break; // blank line
                continue;
            }
            if (t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia)
                || t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            {
                start = t.FullSpan.Start; // a documentation comment's span starts after its "///"
                continue;
            }
            break; // a directive or anything else: the attached block ends here
        }
        var startLine = text.Lines.GetLineFromPosition(start);
        if (!string.IsNullOrWhiteSpace(text.ToString(TextSpan.FromBounds(startLine.Start, start))))
            return new Span(0, 0, 0, 0, "The type does not start on its own line; this version moves only types that are on their own lines.");
        var end = decl.FullSpan.End;
        if (end < text.Length && text.Lines.GetLineFromPosition(end).Start != end)
            return new Span(0, 0, 0, 0, "Other code follows the type on its last line; this version moves only types that are on their own lines.");
        if (decl.DescendantTrivia(descendIntoTrivia: true).Any(t => t.IsDirective && t.SpanStart >= start))
            return new Span(0, 0, 0, 0, "The type contains preprocessor directives (e.g. #region); this version does not move such types.");
        int removeStart = startLine.Start, removeEnd = end;
        bool Blank(int lineNumber) => lineNumber >= 0 && lineNumber < text.Lines.Count && string.IsNullOrWhiteSpace(text.Lines[lineNumber].ToString());
        var before = startLine.LineNumber - 1;
        var afterLine = end >= text.Length ? -1 : text.Lines.GetLineFromPosition(end).LineNumber;
        if (Blank(before))
        {
            if (afterLine >= 0 && Blank(afterLine)) removeEnd = text.Lines[afterLine].EndIncludingLineBreak;
            else if (afterLine < 0 || text.Lines[afterLine].ToString().Trim() == "}") removeStart = text.Lines[before].Start;
        }
        return new Span(startLine.Start, end, removeStart, removeEnd, null);
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, ISymbol symbol, string? documentPath, CancellationToken ct)
    {
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } c) symbol = c.ContainingType;
        documentPath ??= symbol.Locations.FirstOrDefault(x => x.IsInSource)?.SourceTree?.FilePath;
        var l = Locate(snapshot, symbol, documentPath, ct, out var hidden);
        if (l == null)
            return hidden is { ReasonCode: { } code } ? RenameOutcome.Unavailable(code, hidden.Message!)
                : RenameOutcome.Unavailable("NotApplicable", "Move Type to File works on the declaration of a top-level type in a file with several top-level types.");
        if (Refusal(snapshot, l, ct) is { } r) return RenameOutcome.Unavailable(r.code, r.message);
        var path = l.Document.FilePath!;
        if (RenamePlanner.IsReadOnly(path)) return RenameOutcome.Unavailable("ReadOnlyFile", Path.GetFileName(path) + " is read-only.");
        var sourceText = await l.Document.GetTextAsync(ct).ConfigureAwait(false);
        if (RenamePlanner.TargetGuard(snapshot.Session, path, sourceText) is { } targetGuard) return targetGuard;
        var span = Layout(sourceText, l.Declaration);
        var eol = LineBreakOf(sourceText, l.Declaration);
        var moved = sourceText.ToString(TextSpan.FromBounds(span.Start, span.End));
        if (!moved.EndsWith('\n')) moved += eol;

        // Candidate usings (never global usings: they stay where they are and apply to the new file anyway).
        var cuUsings = l.Root.Externs.Cast<SyntaxNode>().Concat(l.Root.Usings.Where(u => u.GlobalKeyword.IsKind(SyntaxKind.None))).ToList();
        var namespaces = l.Declaration.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Reverse().ToList();
        var nsUsings = namespaces.Select(n => n.Externs.Cast<SyntaxNode>().Concat(n.Usings).ToList()).ToList();
        var all = cuUsings.Concat(nsUsings.SelectMany(x => x)).ToList();
        var banner = Banner(sourceText, l.Root, span.Start);

        string Compose(IReadOnlyList<SyntaxNode> keep, out int typeOffset)
        {
            var sb = new StringBuilder();
            sb.Append(banner);
            var top = cuUsings.Where(keep.Contains).ToList();
            foreach (var u in top) sb.Append(u.WithoutTrivia().ToFullString()).Append(eol);
            if (top.Count > 0) sb.Append(eol);
            for (var i = 0; i < namespaces.Count; i++)
            {
                var ns = namespaces[i];
                var indent = IndentOf(sourceText, ns.SpanStart);
                var inner = nsUsings[i].Where(keep.Contains).ToList();
                if (ns is FileScopedNamespaceDeclarationSyntax)
                {
                    sb.Append(indent).Append("namespace ").Append(ns.Name.ToString()).Append(';').Append(eol).Append(eol);
                }
                else
                {
                    var open = ((NamespaceDeclarationSyntax)ns).OpenBraceToken;
                    sb.Append(indent).Append("namespace ").Append(ns.Name.ToString()).Append(eol);
                    sb.Append(IndentOf(sourceText, open.SpanStart)).Append('{').Append(eol);
                }
                foreach (var u in inner) sb.Append(IndentOf(sourceText, u.SpanStart)).Append(u.WithoutTrivia().ToFullString()).Append(eol);
                if (inner.Count > 0) sb.Append(eol);
            }
            typeOffset = sb.Length;
            sb.Append(moved);
            for (var i = namespaces.Count - 1; i >= 0; i--)
                if (namespaces[i] is NamespaceDeclarationSyntax block)
                    sb.Append(IndentOf(sourceText, block.CloseBraceToken.SpanStart)).Append('}').Append(eol);
            return sb.ToString();
        }

        var newPath = NewPath(l);
        var projects = FileRenamePlanner.ProjectsOf(snapshot, path);
        var owners = CreateFilePlanner.ProjectIds(snapshot.Solution, projects);
        if (owners.Count == 0) return RenameOutcome.Unavailable("UnprovenMembership", $"The project of {Path.GetFileName(path)} is unknown.");
        var removal = new TextChange(TextSpan.FromBounds(span.RemoveStart, span.RemoveEnd), "");
        var removed = sourceText.WithChanges(removal);
        var baseSolution = snapshot.Solution;
        foreach (var id in snapshot.Session.DocumentIdsForPath(path))
            if (baseSolution.GetDocument(id) != null) baseSolution = baseSolution.WithDocumentText(id, removed, PreservationMode.PreserveIdentity);

        // What every name of the moved code binds to now (the reference for the new file).
        var originalModel = await l.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (originalModel == null) return RenameOutcome.Unavailable("NotInWorkspace", "The document has no semantic model.");
        var reference = Bindings(originalModel, l.Declaration, ct);
        var declOffsetInMoved = l.Declaration.SpanStart - span.Start;

        async Task<(bool same, int errors)> TryAsync(IReadOnlyList<SyntaxNode> keep)
        {
            var text = Compose(keep, out var typeOffset);
            var sol = CreateFilePlanner.AddDocument(baseSolution, owners.Take(1), newPath, text);
            var doc = sol.Projects.SelectMany(p => p.Documents).First(d => d.FilePath == newPath);
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            if (model == null || root == null) return (false, int.MaxValue);
            var node = root.FindToken(typeOffset + declOffsetInMoved).Parent?.AncestorsAndSelf().OfType<MemberDeclarationSyntax>()
                .FirstOrDefault(m => m.SpanStart == typeOffset + declOffsetInMoved && m.RawKind == l.Declaration.RawKind);
            if (node == null) return (false, int.MaxValue);
            var errors = model.GetDiagnostics(cancellationToken: ct).Count(d => d.Severity == DiagnosticSeverity.Error);
            return (Bindings(model, node, ct).SequenceEqual(reference), errors);
        }

        var full = await TryAsync(all).ConfigureAwait(false);
        if (!full.same)
            return RenameOutcome.Unavailable("MeaningChanges", $"In a file of its own, {l.Type.Name} would not bind every name to the same symbol as now (e.g. a name that depends on the rest of {Path.GetFileName(path)}); not moved.");
        var keep = await CreateFilePlanner.MinimiseAsync<SyntaxNode>(all, async k =>
        {
            var t = await TryAsync(k).ConfigureAwait(false);
            return t.same && t.errors <= full.errors;
        }).ConfigureAwait(false);
        var newText = Compose(keep, out _);

        var edit = new PlannedFileChange(path, Hashing.Sha256Text(sourceText.ToString()), Hashing.Sha256Text(removed.ToString()),
            new[] { new PlannedEdit(sourceText.Lines.GetLinePositionSpan(removal.Span), "") });
        var create = new PlannedFileCreate(newPath, newText, Hashing.Sha256Text(newText), path, projects);
        var dropped = all.Count - keep.Count;
        var limitations = new List<string>
        {
            $"The usings of {Path.GetFileName(path)} are not changed (usings only the moved type needed stay there).",
            "Comments and blank lines above the type that are separated from it by a blank line stay in the original file.",
        };
        var evidence = new List<(string, Location?)>
        {
            ($"Every name in {l.Type.Name} binds to the same symbol in {Path.GetFileName(newPath)} as in {Path.GetFileName(path)}; {keep.Count} of {all.Count} using(s) kept ({dropped} not needed by the moved code)", SymbolFacts.PrimaryLocation(l.Type)),
        };
        return await CreateFilePlanner.BuildPlanAsync(snapshot, ActionId, $"Move {l.Type.Name} to {Path.GetFileName(newPath)}", create, edit, new[] { removal },
            limitations, evidence, null, ct).ConfigureAwait(false);
    }

    /// <summary>The comment banner at the very top of the file (up to the first blank line), copied to the new file.</summary>
    private static string Banner(SourceText text, CompilationUnitSyntax root, int movedStart)
    {
        var first = root.GetFirstToken(includeZeroWidth: true);
        var trivia = first.LeadingTrivia;
        if (trivia.Count == 0 || trivia.Any(t => t.IsDirective) || !trivia.Any(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia))) return "";
        // The banner ends at the first blank line; nothing of it may belong to the moved type itself.
        for (var line = 0; line < text.Lines.Count; line++)
        {
            var l = text.Lines[line];
            if (l.Start >= first.SpanStart || l.Start >= movedStart) return "";
            if (string.IsNullOrWhiteSpace(l.ToString()))
                return line == 0 ? "" : text.ToString(TextSpan.FromBounds(0, l.EndIncludingLineBreak)).TrimStart('﻿');
        }
        return "";
    }

    private static string IndentOf(SourceText text, int position)
    {
        var line = text.Lines.GetLineFromPosition(position);
        var prefix = text.ToString(TextSpan.FromBounds(line.Start, position));
        return string.IsNullOrWhiteSpace(prefix) ? prefix : "";
    }

    private static string LineBreakOf(SourceText text, SyntaxNode decl)
    {
        var line = text.Lines.GetLineFromPosition(decl.SpanStart);
        var len = line.EndIncludingLineBreak - line.End;
        return len == 2 ? "\r\n" : len == 1 ? text.ToString(new TextSpan(line.End, 1)) : CreateFilePlanner.LineBreak(text.ToString());
    }

    /// <summary>
    /// What the code of <paramref name="decl"/> binds to: the symbol, type and converted type of every expression and
    /// type, plus the implicit members (foreach, await, query clauses, collection initializers, deconstruction).
    /// Used to prove that the moved code means the same in the new file.
    /// </summary>
    private static List<string> Bindings(SemanticModel model, SyntaxNode decl, CancellationToken ct)
    {
        static string S(ISymbol? s) => s == null ? "-" : s.Kind + ":" + s.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) + "@" + (s.ContainingAssembly?.Identity.Name ?? "");
        var list = new List<string>();
        foreach (var node in decl.DescendantNodesAndSelf())
        {
            ct.ThrowIfCancellationRequested();
            if (node is ExpressionSyntax or TypeSyntax)
            {
                var info = model.GetSymbolInfo(node, ct);
                var type = model.GetTypeInfo(node, ct);
                list.Add(S(info.Symbol) + "|" + string.Join(",", info.CandidateSymbols.Select(S)) + "|" + S(type.Type) + "|" + S(type.ConvertedType));
            }
            if (node is AwaitExpressionSyntax aw) list.Add("await:" + S(model.GetAwaitExpressionInfo(aw).GetAwaiterMethod));
            if (node is InitializerExpressionSyntax init && init.IsKind(SyntaxKind.CollectionInitializerExpression))
                foreach (var e in init.Expressions) list.Add("add:" + S(model.GetCollectionInitializerSymbolInfo(e, ct).Symbol));
            if (node is CommonForEachStatementSyntax fe) list.Add("foreach:" + S(model.GetForEachStatementInfo(fe).GetEnumeratorMethod));
            if (node is QueryClauseSyntax qc)
            {
                var q = model.GetQueryClauseInfo(qc, ct);
                list.Add("query:" + S(q.OperationInfo.Symbol) + "|" + S(q.CastInfo.Symbol));
            }
            if (node is SelectOrGroupClauseSyntax sg) list.Add("select:" + S(model.GetSymbolInfo(sg, ct).Symbol));
            if (node is AssignmentExpressionSyntax asg && asg.Left is TupleExpressionSyntax or DeclarationExpressionSyntax)
                list.Add("deconstruct:" + S(model.GetDeconstructionInfo(asg).Method));
            if (node is AttributeSyntax attr) list.Add("attr:" + S(model.GetSymbolInfo(attr, ct).Symbol));
        }
        return list;
    }
}
