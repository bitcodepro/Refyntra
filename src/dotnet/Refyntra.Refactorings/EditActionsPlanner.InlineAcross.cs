using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Inline Method across files: the same rewrite as the edit actions <see cref="InlineMethod"/> / <see cref="InlineMethodAll"/>,
/// prepared as a previewed plan when the declaration or a call site is in another document (the edit action is then
/// refused with CrossFile and the client asks for this plan). Every call site is rewritten in its own document with its
/// own semantic model; the plan is compile-checked over the affected projects by <see cref="SolutionPlanBuilder"/>.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string InlineMethodPlanAction = "csharp.inlineMethod";
    public const string InlineMethodAllPlanAction = "csharp.inlineMethodAll";

    public static async Task<RenameOutcome> PrepareInlineMethodAsync(Snapshot snapshot, string path, LinePositionSpan range, bool all, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, range, ct).ConfigureAwait(false);
        if (c == null) return RenameOutcome.Unavailable("NoDocument", "The file is not an editable C# document of the loaded solution.");
        try
        {
            var tok = c.Token;
            IMethodSymbol? m = null;
            InvocationExpressionSyntax? site = null;
            if (tok.Parent is MethodDeclarationSyntax md && md.Identifier == tok && all) m = c.Model.GetDeclaredSymbol(md, ct) as IMethodSymbol;
            else if (tok.Parent is SimpleNameSyntax sn && sn.Identifier == tok && CallOf(sn) is { } call && c.Model.GetSymbolInfo(call, ct).Symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary } cm)
            {
                m = cm;
                if (!all) site = call;
            }
            if (m == null) throw new Refusal("NotApplicable", "Place the cursor on a method name or on a call of it.");
            m = m.ReducedFrom ?? m;
            if (m.DeclaringSyntaxReferences.Length != 1) throw new Refusal("NotSupported", $"'{m.Name}' has no single declaration in source.");
            var declTree = m.DeclaringSyntaxReferences[0].SyntaxTree;
            var declDoc = snapshot.Solution.GetDocument(declTree) ?? throw new Refusal("NotSupported", $"The declaration of '{m.Name}' is not in a document of the solution.");
            var declModel = (await declDoc.GetSemanticModelAsync(ct).ConfigureAwait(false))!;
            var declNode = (MethodDeclarationSyntax?)(await m.DeclaringSyntaxReferences[0].GetSyntaxAsync(ct).ConfigureAwait(false)) ?? throw new Refusal("NotSupported", "The declaration cannot be read.");
            // The method as its own compilation sees it (parameters of the body).
            m = declModel.GetDeclaredSymbol(declNode, ct) as IMethodSymbol ?? throw new Refusal("NotSupported", "The declaration cannot be analyzed.");
            var body = InlineableBody(c, m, declModel);

            // Call sites by document.
            var sites = new Dictionary<DocumentId, List<InvocationExpressionSyntax>>();
            if (site != null) sites[c.Doc.Id] = new List<InvocationExpressionSyntax> { site };
            else
            {
                var refs = await SymbolFinder.FindReferencesAsync(m, snapshot.Solution, ct).ConfigureAwait(false);
                foreach (var loc in refs.SelectMany(r => r.Locations))
                {
                    var root = (await loc.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
                    var node = root.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (node is not SimpleNameSyntax refName || CallOf(refName) is not { } refCall)
                        throw new Refusal("MethodGroup", $"'{m.Name}' is used as a method group or delegate ({loc.Document.Name}, line {loc.Location.GetLineSpan().StartLinePosition.Line + 1}); it cannot be inlined.");
                    if (!sites.TryGetValue(loc.Document.Id, out var list)) sites[loc.Document.Id] = list = new();
                    if (!list.Contains(refCall)) list.Add(refCall);
                }
                if (sites.Count == 0) throw new Refusal("NoCallers", $"'{m.Name}' is not called; use Safe Delete to remove it.");
            }
            foreach (var list in sites.Values)
            {
                if (list.Any(a => list.Any(b => a != b && a.Span.Contains(b.Span)))) throw new Refusal("NestedCalls", $"A call of '{m.Name}' is nested in another one; inline them one at a time.");
                if (list.Any(s => s.SyntaxTree == declTree && body.Decl.Span.Contains(s.Span))) throw new Refusal("Recursive", $"'{m.Name}' calls itself.");
            }

            var after = snapshot.Solution;
            var changedDocs = new List<DocumentId>();
            var docIds = sites.Keys.ToList();
            if (site == null && !docIds.Contains(declDoc.Id)) docIds.Add(declDoc.Id);
            var calls = 0;
            foreach (var id in docIds)
            {
                var doc = snapshot.Solution.GetDocument(id)!;
                var root = (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
                var model = (await doc.GetSemanticModelAsync(ct).ConfigureAwait(false))!;
                var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                var dc = new Ctx(doc, root, model, text, default, ct);
                var editor = new SyntaxEditor(root, snapshot.Solution.Services);
                var memberLocals = new Dictionary<SyntaxNode, HashSet<string>>();
                if (sites.TryGetValue(id, out var list))
                    foreach (var call in list.OrderBy(x => x.SpanStart))
                    {
                        try
                        {
                            InlineOneCall(dc, m, body, call, editor, memberLocals);
                        }
                        catch (Refusal r)
                        {
                            throw new Refusal(r.Reason, $"{doc.Name}, line {call.GetLocation().GetLineSpan().StartLinePosition.Line + 1}: {r.Message}");
                        }
                        calls++;
                    }
                if (site == null && id == declDoc.Id) editor.RemoveNode(body.Decl, SyntaxRemoveOptions.KeepUnbalancedDirectives);
                after = after.WithDocumentSyntaxRoot(id, editor.GetChangedRoot());
                changedDocs.Add(id);
            }
            foreach (var id in changedDocs)
            {
                var d = await Simplifier.ReduceAsync(after.GetDocument(id)!, Simplifier.Annotation, null, ct).ConfigureAwait(false);
                d = await Formatter.FormatAsync(d, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
                after = d.Project.Solution;
            }

            var name = m.ContainingType.Name + "." + m.Name;
            var title = site != null ? $"Inline {name} (this call site)" : $"Inline {name} ({calls} call site(s), remove declaration)";
            var limitations = new List<string> { "Only call sites the compiler binds to the method are rewritten; reflection, dynamic calls and string-based uses are not." };
            var evidence = new List<(string, Location?)> { ($"{calls} call(s) of {name} inlined in {sites.Count} file(s)", body.Decl.Identifier.GetLocation()) };
            return await SolutionPlanBuilder.BuildAsync(snapshot, after, new SolutionPlanBuilder.Options(all ? InlineMethodAllPlanAction : InlineMethodPlanAction, title, limitations, evidence, new List<string>(),
                OwnerProjects: new[] { declDoc.Project.Id }), ct).ConfigureAwait(false);
        }
        catch (Refusal r)
        {
            return RenameOutcome.Unavailable(r.Reason, r.Message);
        }
    }
}
