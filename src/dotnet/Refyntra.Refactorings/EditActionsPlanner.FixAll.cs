using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Fix in scope (protocol 1.11, refactor/prepare csharp.fixAll): applies one style-like edit action to every place it
/// applies in a document, its project or the solution, as one previewed plan. Each occurrence is computed exactly like
/// the single action (same rewrite, same formatting); an occurrence whose document would get a new compiler error is
/// skipped and reported. Generated code, read-only files and documents without a file are skipped.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string FixAllAction = "csharp.fixAll";
    public static readonly string[] FixAllScopes = { "document", "project", "solution" };
    private const int MaxFixAllOccurrences = 20000;

    /// <summary>The edit actions that can be applied in a whole scope (style-like rewrites with no choice to make).</summary>
    public static readonly IReadOnlyDictionary<string, string> FixAllTitles = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [VarToExplicit] = "Use explicit type",
        [ExplicitToVar] = "Use 'var'",
        [ToExpressionBody] = "Convert to expression body",
        [ToBlockBody] = "Convert to block body",
        [UsingToDeclaration] = "Convert to 'using' declaration",
        [ToObjectInitializer] = "Use object initializer",
        [ToInterpolated] = "Convert to interpolated string",
        [FormatToInterpolated] = "Convert 'string.Format' to interpolated string",
    };

    /// <summary>Positions where the action may apply (each is checked by the action itself).</summary>
    private static IEnumerable<int> Anchors(SyntaxNode root, string actionId) => actionId switch
    {
        VarToExplicit or ExplicitToVar => root.DescendantNodes().Select(n => n switch
        {
            VariableDeclarationSyntax { Parent: LocalDeclarationStatementSyntax or ForStatementSyntax or UsingStatementSyntax } v => v.Type.SpanStart,
            ForEachStatementSyntax f => f.Type.SpanStart,
            DeclarationExpressionSyntax d => d.Type.SpanStart,
            _ => -1,
        }),
        ToExpressionBody or ToBlockBody => root.DescendantNodes().Select(n => n switch
        {
            BaseMethodDeclarationSyntax m => m.ParameterList.SpanStart,
            LocalFunctionStatementSyntax f => f.ParameterList.SpanStart,
            PropertyDeclarationSyntax p => p.Identifier.SpanStart,
            IndexerDeclarationSyntax i => i.ThisKeyword.SpanStart,
            AccessorDeclarationSyntax a => a.Keyword.SpanStart,
            _ => -1,
        }),
        UsingToDeclaration => root.DescendantNodes().OfType<UsingStatementSyntax>().Select(u => u.UsingKeyword.SpanStart),
        ToObjectInitializer => root.DescendantNodes().Select(n => n switch
        {
            LocalDeclarationStatementSyntax { Declaration.Variables: [{ Initializer.Value: BaseObjectCreationExpressionSyntax }] } l => l.SpanStart,
            ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Right: BaseObjectCreationExpressionSyntax } } e => e.SpanStart,
            _ => -1,
        }),
        ToInterpolated => root.DescendantNodes().OfType<BinaryExpressionSyntax>()
            .Where(b => b.IsKind(SyntaxKind.AddExpression) && !(b.Parent is BinaryExpressionSyntax pb && pb.IsKind(SyntaxKind.AddExpression)) && !(b.Parent is ParenthesizedExpressionSyntax { Parent: BinaryExpressionSyntax pp } && pp.IsKind(SyntaxKind.AddExpression)))
            .Select(b => b.OperatorToken.SpanStart),
        FormatToInterpolated => root.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .Where(i => i.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Format" })
            .Select(i => ((MemberAccessExpressionSyntax)i.Expression).Name.SpanStart),
        _ => Enumerable.Empty<int>(),
    };

    private static Func<Task<Document>>? Detector(Ctx c, string actionId) => actionId switch
    {
        VarToExplicit => VarExplicit(c),
        ExplicitToVar => ExplicitVar(c),
        ToExpressionBody => ExpressionBody(c),
        ToBlockBody => BlockBody(c),
        UsingToDeclaration => UsingDeclaration(c),
        ToObjectInitializer => ObjectInitializer(c),
        ToInterpolated => Interpolate(c),
        FormatToInterpolated => FormatToInterpolatedString(c),
        _ => null,
    };

    /// <summary>Applies the action at every anchor of one document (last first, so earlier anchors keep their position).</summary>
    private static async Task<(Document Doc, int Applied, int Skipped)> FixDocumentAsync(Document doc, string actionId, bool checkEach, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var anchors = Anchors(root!, actionId).Where(p => p >= 0).Distinct().OrderByDescending(p => p).ToList();
        int applied = 0, skipped = 0;
        foreach (var pos in anchors)
        {
            ct.ThrowIfCancellationRequested();
            var r = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            if (pos >= r!.FullSpan.End) continue;
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            var c = new Ctx(doc, r, model!, text, new TextSpan(pos, 0), ct);
            Func<Task<Document>>? run;
            try
            {
                run = Detector(c, actionId);
            }
            catch (Refusal)
            {
                run = null;
            }
            if (run == null) continue;
            Document changed;
            try
            {
                changed = await run().ConfigureAwait(false);
                changed = await Formatter.FormatAsync(changed, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
                if (checkEach) await CompileCheckAsync(c, changed, ct).ConfigureAwait(false);
            }
            catch (Refusal)
            {
                skipped++;
                continue;
            }
            doc = changed;
            applied++;
        }
        return (doc, applied, skipped);
    }

    /// <summary>
    /// Prepares the plan: the action applied in the document at <paramref name="path"/>, its project(s) or the solution.
    /// A document is first fixed in one pass; when it then has a new compiler error, it is redone occurrence by
    /// occurrence, skipping the occurrences that add an error.
    /// </summary>
    public static async Task<RenameOutcome> PrepareFixAllAsync(Snapshot snapshot, string path, string actionId, string scope, CancellationToken ct)
    {
        if (!FixAllTitles.TryGetValue(actionId, out var title)) return RenameOutcome.Unavailable("NotApplicable", $"'{actionId}' cannot be applied in a scope.");
        if (Array.IndexOf(FixAllScopes, scope) < 0) return RenameOutcome.Unavailable("InvalidParams", "scope must be document, project or solution.");
        var start = DocumentOf(snapshot, path);
        if (start == null) return RenameOutcome.Unavailable("NoDocument", "The file is not a C# document of the loaded solution.");
        var solution = snapshot.Solution;
        IEnumerable<Document> docs = scope switch
        {
            "document" => new[] { start },
            "project" => snapshot.Session.DocumentIdsForPath(path).Select(id => solution.GetProject(id.ProjectId)!).Distinct().SelectMany(p => p.Documents),
            _ => solution.Projects.Where(p => p.Language == LanguageNames.CSharp).SelectMany(p => p.Documents),
        };
        var seenPaths = new HashSet<string>(UriPaths.PathComparer);
        var after = solution;
        int files = 0, applied = 0, skipped = 0, generated = 0, readOnly = 0;
        foreach (var doc in docs)
        {
            ct.ThrowIfCancellationRequested();
            if (doc.FilePath == null || !seenPaths.Add(doc.FilePath)) continue; // linked files: the first context decides
            var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
            if (tree == null) continue;
            if (SymbolFacts.IsGeneratedTree(solution, tree, ct)) { generated++; continue; }
            if (RenamePlanner.IsReadOnly(doc.FilePath)) { readOnly++; continue; }
            var (fixedDoc, n, s) = await FixDocumentAsync(doc, actionId, checkEach: false, ct).ConfigureAwait(false);
            if (n == 0) continue;
            var originalModel = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var originalText = await doc.GetTextAsync(ct).ConfigureAwait(false);
            try
            {
                await CompileCheckAsync(new Ctx(doc, (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!, originalModel!, originalText, default, ct), fixedDoc, ct).ConfigureAwait(false);
            }
            catch (Refusal)
            {
                (fixedDoc, n, s) = await FixDocumentAsync(doc, actionId, checkEach: true, ct).ConfigureAwait(false);
                if (n == 0) { skipped += s; continue; }
            }
            var newText = await fixedDoc.GetTextAsync(ct).ConfigureAwait(false);
            foreach (var id in snapshot.Session.DocumentIdsForPath(doc.FilePath)) after = after.WithDocumentText(id, newText);
            files++;
            applied += n;
            skipped += s;
            if (applied > MaxFixAllOccurrences)
                return RenameOutcome.Unavailable("TooManyOccurrences", $"More than {MaxFixAllOccurrences} occurrences; apply it to a project or a document first.");
        }
        if (applied == 0) return RenameOutcome.Unavailable("NoChanges", $"'{title}' does not apply anywhere in the {scope}{(skipped > 0 ? $" ({skipped} occurrence(s) skipped: they would introduce compiler errors)" : "")}.");
        var limitations = new List<string>();
        if (skipped > 0) limitations.Add($"{skipped} occurrence(s) skipped: applying them would introduce compiler errors in their file.");
        if (generated > 0) limitations.Add($"{generated} generated file(s) skipped.");
        if (readOnly > 0) limitations.Add($"{readOnly} read-only file(s) skipped.");
        var o = new SolutionPlanBuilder.Options(FixAllAction, $"{title} in {scope} ({applied} occurrence(s) in {files} file(s))", limitations,
            new List<(string, Location?)> { ($"{applied} occurrence(s) of '{title}' in {files} file(s)", null) }, new List<string>());
        return await SolutionPlanBuilder.BuildAsync(snapshot, after, o, ct).ConfigureAwait(false);
    }
}
