using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics.Rules;
using SF = Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace Refyntra.Refactorings;

/// <summary>
/// Quick fixes of Refyntra's inspections OR1002–OR1010 (CodeInspections). Each fix is an edit action
/// (csharp.edit.fix.*, kind quickfix.refyntra.ORxxxx) computed at the position of an inspection result, compile-checked
/// and applied as one undo step like every other edit action; Fix in scope applies it at every result of a document,
/// project or solution. "Add 'await'" and "Discard" also apply where the compiler reports CS4014.
/// </summary>
public static partial class EditActionsPlanner
{
    private const string QuickFix = "quickfix.refyntra.";

    /// <summary>The fix actions of Refyntra's inspections (all of them can be applied in a scope).</summary>
    public static bool IsInspectionFix(string actionId) => CodeInspections.FixTitles.ContainsKey(actionId);

    private static void AddInspectionFixes(Ctx c, Action<string, string, string, Func<Task<Document>>?> add)
    {
        var pos = c.Span.Start;
        var findings = CodeInspections.Analyze(c.Model, c.Root, new TextSpan(pos, 0), c.Ct).Where(f => f.Span.Start <= pos && pos <= f.Span.End).ToList();
        var added = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in findings)
            foreach (var x in f.Fixes)
                if (added.Add(x.ActionId)) add(x.ActionId, x.Title, QuickFix + f.Id, InspectionFix(c, x.ActionId));
        // Also at the compiler's CS4014 (an unawaited call in an async function): no Refyntra result there.
        if (added.Add(CodeInspections.FixAddAwait)) add(CodeInspections.FixAddAwait, CodeInspections.FixTitles[CodeInspections.FixAddAwait], QuickFix + CodeInspections.DiscardedTask, AddAwait(c));
        if (added.Add(CodeInspections.FixDiscard)) add(CodeInspections.FixDiscard, CodeInspections.FixTitles[CodeInspections.FixDiscard], QuickFix + CodeInspections.DiscardedTask, Discard(c));
    }

    private static Func<Task<Document>>? InspectionFix(Ctx c, string actionId) => actionId switch
    {
        CodeInspections.FixAwaitSyncCall => AwaitSyncCall(c),
        CodeInspections.FixAsyncTask => AsyncVoidToTask(c),
        CodeInspections.FixAddAwait => AddAwait(c),
        CodeInspections.FixDiscard => Discard(c),
        CodeInspections.FixUsingVar => UsingVar(c),
        CodeInspections.FixMaterialize => Materialize(c),
        CodeInspections.FixStringBuilder => StringBuilderFix(c),
        CodeInspections.FixPredicateOverload => PredicateOverload(c),
        CodeInspections.FixRemoveMaterialization => RemoveMaterialization(c),
        CodeInspections.FixRemoveFormat => RemoveFormat(c),
        CodeInspections.FixAddInclude => AddInclude(c),
        _ => null,
    };

    /// <summary>The inspection result with this fix at the context position.</summary>
    private static InspectionFinding? FindingFor(Ctx c, string actionId) => CodeInspections.At(c.Model, c.Root, c.Span.Start, actionId, c.Ct);

    private static T? NodeAt<T>(Ctx c, TextSpan span) where T : SyntaxNode =>
        c.Root.FindNode(span, getInnermostNodeForTie: true).AncestorsAndSelf().OfType<T>().FirstOrDefault();

    /// <summary>Anchors of Fix in scope for an inspection fix: the results that offer it (CS4014-like statements for Add 'await').</summary>
    private static IEnumerable<int> InspectionAnchors(SemanticModel model, SyntaxNode root, string actionId, CancellationToken ct) =>
        actionId == CodeInspections.FixAddAwait
            ? root.DescendantNodes().OfType<ExpressionStatementSyntax>().Where(s => s.Expression is InvocationExpressionSyntax).Select(s => s.Expression.SpanStart)
            : CodeInspections.Analyze(model, root, null, ct).Where(f => f.Fixes.Any(x => x.ActionId == actionId)).Select(f => f.Span.Start);

    // ------------------------------------------------------------------ OR1002: use 'await'

    private static readonly SyntaxAnnotation AwaitMarker = new("refyntra.await");

    private static Func<Task<Document>>? AwaitSyncCall(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixAwaitSyncCall);
        if (f == null) return null;
        var node = c.Root.FindNode(f.Span, getInnermostNodeForTie: true);
        node = node.AncestorsAndSelf().First(n => n is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Result" } || n is InvocationExpressionSyntax);
        ExpressionSyntax receiver = node switch
        {
            MemberAccessExpressionSyntax ma => ma.Expression,
            InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Wait" } wm } => wm.Expression,
            InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax gm } } } => gm.Expression,
            _ => throw new Refusal("NotApplicable", "No blocking call here."),
        };
        var fn = CodeInspections.FunctionOf(node)!;
        return async () =>
        {
            ExpressionSyntax awaited = SF.AwaitExpression(receiver.WithoutTrivia());
            if (node.Parent is MemberAccessExpressionSyntax or ConditionalAccessExpressionSyntax or ElementAccessExpressionSyntax or InvocationExpressionSyntax or PostfixUnaryExpressionSyntax)
                awaited = SF.ParenthesizedExpression(awaited);
            awaited = awaited.WithTriviaFrom(node).WithAdditionalAnnotations(Formatter.Annotation, AwaitMarker);
            if (CodeInspections.IsAsyncFunction(fn)) return c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(node, awaited));
            if (fn is not MethodDeclarationSyntax) throw new Refusal("NotAsync", "Only a method can be made async here.");
            // The method already returns a task: 'async' keeps its signature (the returns are awaited).
            var methodMarker = new SyntaxAnnotation("refyntra.method");
            var root1 = c.Root.ReplaceNodes(new[] { fn, node }, (orig, cur) => orig == node ? awaited : cur.WithAdditionalAnnotations(methodMarker));
            var doc1 = c.Doc.WithSyntaxRoot(root1);
            root1 = (await doc1.GetSyntaxRootAsync(c.Ct).ConfigureAwait(false))!;
            var model1 = await doc1.GetSemanticModelAsync(c.Ct).ConfigureAwait(false);
            var m1 = (MethodDeclarationSyntax)root1.GetAnnotatedNodes(methodMarker).Single();
            var c1 = c with { Doc = doc1, Root = root1, Model = model1!, Text = await doc1.GetTextAsync(c.Ct).ConfigureAwait(false) };
            // MakeAsyncCore awaits every return of the method; the new 'await' is never inside a return of a task.
            return MakeAsyncCore(c1, m1, signatureChanges: false);
        };
    }

    // ------------------------------------------------------------------ OR1003: async void → async Task

    private static Func<Task<Document>>? AsyncVoidToTask(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixAsyncTask);
        if (f == null) return null;
        var decl = c.Root.FindToken(f.Span.Start).Parent?.AncestorsAndSelf().FirstOrDefault(n => n is MethodDeclarationSyntax or LocalFunctionStatementSyntax);
        if (decl == null) return null;
        return async () =>
        {
            var symbol = (IMethodSymbol)c.Model.GetDeclaredSymbol(decl, c.Ct)!;
            if (decl is MethodDeclarationSyntax)
            {
                var refs = await SymbolFinder.FindReferencesAsync(symbol, c.Doc.Project.Solution, c.Ct).ConfigureAwait(false);
                foreach (var loc in refs.SelectMany(r => r.Locations))
                {
                    var root = await loc.Document.GetSyntaxRootAsync(c.Ct).ConfigureAwait(false);
                    var n = root!.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (!IsCallTarget(n)) throw new Refusal("UsedAsDelegate", $"'{symbol.Name}' is used as a delegate ({loc.Document.Name}); a void-returning delegate type requires 'void'.");
                }
            }
            else
            {
                var fn = CodeInspections.FunctionOf(decl);
                var scope = fn == null ? c.Root : CodeInspections.BodyOf(fn) ?? fn;
                foreach (var r in CodeInspections.References(c.Model, scope, symbol, c.Ct))
                    if (!IsCallTarget(r)) throw new Refusal("UsedAsDelegate", $"'{symbol.Name}' is used as a delegate; a void-returning delegate type requires 'void'.");
            }
            var ret = decl is MethodDeclarationSyntax md ? md.ReturnType : ((LocalFunctionStatementSyntax)decl).ReturnType;
            var task = SF.IdentifierName("Task").WithTriviaFrom(ret);
            var newRoot = c.Root.ReplaceNode(ret, task);
            return Imports(c, decl.SpanStart, "System.Threading.Tasks", "Task") ? c.Doc.WithSyntaxRoot(newRoot) : WithUsing(c.Doc, newRoot, "System.Threading.Tasks");
        };
    }

    private static bool IsCallTarget(SyntaxNode n)
    {
        var e = n.AncestorsAndSelf().OfType<ExpressionSyntax>().FirstOrDefault();
        if (e is GenericNameSyntax or IdentifierNameSyntax && e.Parent is MemberAccessExpressionSyntax ma && ma.Name == e) e = ma;
        else if (e?.Parent is MemberBindingExpressionSyntax mb) e = mb;
        return e?.Parent is InvocationExpressionSyntax inv && inv.Expression == e;
    }

    // ------------------------------------------------------------------ OR1004 / CS4014: await or discard

    /// <summary>The expression statement at the position whose value is a discarded task.</summary>
    private static ExpressionStatementSyntax? DiscardedTaskAt(Ctx c)
    {
        var s = c.Token.Parent?.AncestorsAndSelf().OfType<ExpressionStatementSyntax>().FirstOrDefault();
        if (s == null || !s.Expression.Span.Contains(c.Span.Start) && s.Expression.SpanStart != c.Span.Start) return null;
        if (s.Expression is not (InvocationExpressionSyntax or ConditionalAccessExpressionSyntax { WhenNotNull: InvocationExpressionSyntax })) return null;
        return CodeInspections.IsTaskLike(c.Model.GetTypeInfo(s.Expression, c.Ct).Type) ? s : null;
    }

    private static Func<Task<Document>>? AddAwait(Ctx c)
    {
        var s = DiscardedTaskAt(c);
        if (s == null || s.Expression is not InvocationExpressionSyntax) return null;
        var fn = CodeInspections.FunctionOf(s);
        if (fn == null || !CodeInspections.IsAsyncFunction(fn) || !CodeInspections.AwaitAllowedAt(s, fn)) return null;
        return Replace(c, s.Expression, SF.AwaitExpression(s.Expression.WithoutTrivia()).WithTriviaFrom(s.Expression));
    }

    private static Func<Task<Document>>? Discard(Ctx c)
    {
        var s = DiscardedTaskAt(c);
        if (s == null) return null;
        return Replace(c, s.Expression, SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, SF.IdentifierName(SF.Identifier(SF.TriviaList(), SyntaxKind.UnderscoreToken, "_", "_", SF.TriviaList())), s.Expression.WithoutTrivia()).WithTriviaFrom(s.Expression));
    }

    // ------------------------------------------------------------------ OR1005: using var

    private static Func<Task<Document>>? UsingVar(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixUsingVar);
        if (f == null) return null;
        var ld = NodeAt<LocalDeclarationStatementSyntax>(c, f.Span);
        if (ld == null) return null;
        var first = ld.GetFirstToken();
        var stripped = ld.ReplaceToken(first, first.WithLeadingTrivia());
        var withUsing = stripped.WithUsingKeyword(SF.Token(first.LeadingTrivia, SyntaxKind.UsingKeyword, SF.TriviaList(SF.Space)));
        return () => Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(ld, withUsing)));
    }

    // ------------------------------------------------------------------ OR1006: materialize once

    private static Func<Task<Document>>? Materialize(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixMaterialize);
        if (f == null) return null;
        var id = NodeAt<IdentifierNameSyntax>(c, f.Span);
        var symbol = id == null ? null : c.Model.GetSymbolInfo(id, c.Ct).Symbol;
        if (symbol is ILocalSymbol local)
        {
            var v = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(c.Ct) as VariableDeclaratorSyntax;
            if (v?.Initializer?.Value is not { } init) return null;
            return () =>
            {
                var call = Call(Receiver(init), "ToList").WithTriviaFrom(init);
                var root = c.Root.ReplaceNode(init, call);
                return Task.FromResult(Imports(c, init.SpanStart, "System.Linq", "Enumerable") ? c.Doc.WithSyntaxRoot(root) : WithUsing(c.Doc, root, "System.Linq"));
            };
        }
        if (symbol is not IParameterSymbol p) return null;
        var decl = p.ContainingSymbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(c.Ct);
        var body = decl switch { BaseMethodDeclarationSyntax m => m.Body, LocalFunctionStatementSyntax lf => lf.Body, _ => null };
        if (body == null || body.Statements.Count == 0) return null;
        return () =>
        {
            var name = UniqueLocalName(c, body, p.Name + "List");
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var r in CodeInspections.References(c.Model, body, p, c.Ct))
            {
                if (r.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" })) continue;
                editor.ReplaceNode(r, SF.IdentifierName(name).WithTriviaFrom(r));
            }
            var stmt = Fmt(SF.LocalDeclarationStatement(SF.VariableDeclaration(SF.IdentifierName("var"),
                SF.SingletonSeparatedList(SF.VariableDeclarator(SF.Identifier(name)).WithInitializer(SF.EqualsValueClause(Call(SF.IdentifierName(p.Name), "ToList"))))))).WithTrailingTrivia(Eol(c));
            editor.InsertBefore(body.Statements[0], stmt);
            var root = editor.GetChangedRoot();
            return Task.FromResult(Imports(c, body.SpanStart, "System.Linq", "Enumerable") ? c.Doc.WithSyntaxRoot(root) : WithUsing(c.Doc, root, "System.Linq"));
        };
    }

    private static string UniqueLocalName(Ctx c, SyntaxNode scope, string baseName)
    {
        var taken = new HashSet<string>(c.Model.LookupSymbols(scope.SpanStart).Select(s => s.Name), StringComparer.Ordinal);
        foreach (var t in scope.DescendantTokens().Where(t => t.IsKind(SyntaxKind.IdentifierToken))) taken.Add(t.ValueText);
        var name = baseName;
        for (var i = 2; taken.Contains(name); i++) name = baseName + i;
        return name;
    }

    // ------------------------------------------------------------------ OR1007: StringBuilder

    private static Func<Task<Document>>? StringBuilderFix(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixStringBuilder);
        if (f == null) return null;
        var assignment = NodeAt<AssignmentExpressionSyntax>(c, f.Span);
        if (assignment?.Left is not IdentifierNameSyntax id || c.Model.GetSymbolInfo(id, c.Ct).Symbol is not ILocalSymbol local) return null;
        return () =>
        {
            if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(c.Ct) is not VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Variables.Count: 1, Parent: LocalDeclarationStatementSyntax { Parent: BlockSyntax block } ld } } v
                || v.Initializer == null || !ld.UsingKeyword.IsKind(SyntaxKind.None))
                throw new Refusal("UnsupportedDeclaration", $"'{local.Name}' must be declared alone with an initializer in the block of the loop.");
            var loop = assignment.Ancestors().OfType<StatementSyntax>().LastOrDefault(s => s.Parent == block);
            if (loop is not (ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax) || block.Statements.IndexOf(loop) <= block.Statements.IndexOf(ld))
                throw new Refusal("UnsupportedLoop", "The loop must follow the declaration in the same block.");
            var fn = CodeInspections.FunctionOf(ld)!;
            var refs = CodeInspections.References(c.Model, block, local, c.Ct);
            var appends = new List<ExpressionStatementSyntax>();
            var after = false;
            foreach (var r in refs)
            {
                if (r.Ancestors().TakeWhile(a => a != fn).Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                    throw new Refusal("Captured", $"'{local.Name}' is used in a lambda or local function.");
                if (r.SpanStart >= loop.Span.End) { after = true; continue; }
                if (r.SpanStart < loop.SpanStart) throw new Refusal("UsedBeforeLoop", $"'{local.Name}' is used between its declaration and the loop.");
                if (r.Parent is AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.AddAssignmentExpression, Parent: ExpressionStatementSyntax es } a && a.Left == r) appends.Add(es);
                else throw new Refusal("ReadInLoop", $"The loop reads '{local.Name}'; a StringBuilder would need ToString() there.");
            }
            var builder = UniqueLocalName(c, block, local.Name + "Builder");
            var hasSb = Imports(c, ld.SpanStart, "System.Text", "StringBuilder");
            var init = v.Initializer.Value;
            var empty = init is LiteralExpressionSyntax { Token.ValueText: "" } && init.IsKind(SyntaxKind.StringLiteralExpression)
                || init is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Empty" } em && c.Model.GetSymbolInfo(em, c.Ct).Symbol?.ContainingType?.SpecialType == SpecialType.System_String;
            var create = SF.ObjectCreationExpression(SF.IdentifierName("StringBuilder"), SF.ArgumentList(empty ? default : SF.SingletonSeparatedList(SF.Argument(init.WithoutTrivia()))), null);
            var newDecl = Fmt(SF.LocalDeclarationStatement(SF.VariableDeclaration(SF.IdentifierName("var"),
                SF.SingletonSeparatedList(SF.VariableDeclarator(SF.Identifier(builder)).WithInitializer(SF.EqualsValueClause(create))))).WithTriviaFrom(ld));
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            editor.ReplaceNode(ld, newDecl);
            foreach (var es in appends)
            {
                var value = ((AssignmentExpressionSyntax)es.Expression).Right;
                editor.ReplaceNode(es, Fmt(SF.ExpressionStatement(Call(SF.IdentifierName(builder), "Append", value.WithoutTrivia())).WithTriviaFrom(es)));
            }
            if (after)
            {
                var back = Fmt(SF.LocalDeclarationStatement(SF.VariableDeclaration(ld.Declaration.Type.WithoutTrivia(),
                    SF.SingletonSeparatedList(SF.VariableDeclarator(SF.Identifier(local.Name)).WithInitializer(SF.EqualsValueClause(Call(SF.IdentifierName(builder), "ToString"))))))).WithTrailingTrivia(Eol(c));
                editor.InsertAfter(loop, back);
            }
            var root = editor.GetChangedRoot();
            return Task.FromResult(hasSb ? c.Doc.WithSyntaxRoot(root) : WithUsing(c.Doc, root, "System.Text"));
        };
    }

    // ------------------------------------------------------------------ OR1008: predicate overload

    private static Func<Task<Document>>? PredicateOverload(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixPredicateOverload);
        if (f == null) return null;
        var inv = c.Root.FindNode(f.Span, getInnermostNodeForTie: true).AncestorsAndSelf().OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(i => i.Span.End == f.Span.End && i.Expression is MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax });
        if (inv?.Expression is not MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax wma } where } ma) return null;
        var call = SF.InvocationExpression(ma.WithExpression(wma.Expression), where.ArgumentList).WithTriviaFrom(inv);
        return () => Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(inv, call)));
    }

    // ------------------------------------------------------------------ OR1009: remove ToList/ToArray

    private static Func<Task<Document>>? RemoveMaterialization(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixRemoveMaterialization);
        if (f == null) return null;
        var inv = c.Root.FindNode(f.Span, getInnermostNodeForTie: true).AncestorsAndSelf().OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(i => i.Span.End == f.Span.End && i.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ToList" or "ToArray" });
        if (inv?.Expression is not MemberAccessExpressionSyntax ma) return null;
        var source = ma.Expression.WithTrailingTrivia(inv.GetTrailingTrivia());
        return () => Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(inv, source)));
    }

    // ------------------------------------------------------------------ OR1010: the string itself

    private static Func<Task<Document>>? RemoveFormat(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixRemoveFormat);
        if (f == null) return null;
        var inv = c.Root.FindNode(f.Span, getInnermostNodeForTie: true).AncestorsAndSelf().OfType<InvocationExpressionSyntax>().FirstOrDefault(i => i.Span == f.Span);
        if (inv == null || inv.ArgumentList.Arguments.Count != 1) return null;
        var arg = inv.ArgumentList.Arguments[0].Expression;
        if (c.Model.GetConstantValue(arg, c.Ct).Value is not string value) return null;
        ExpressionSyntax replacement = value.IndexOfAny(new[] { '{', '}' }) < 0
            ? arg.WithoutTrivia()
            : SF.LiteralExpression(SyntaxKind.StringLiteralExpression, SF.Literal(value.Replace("{{", "{", StringComparison.Ordinal).Replace("}}", "}", StringComparison.Ordinal)));
        return () => Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(inv, replacement.WithTriviaFrom(inv))));
    }

    // ------------------------------------------------------------------ Fix in scope

    /// <summary>
    /// Applies an inspection fix at every result of the document. The results are recomputed after each fix (a fix
    /// may edit text before its position, e.g. 'async' on the method), from the end of the document to its start;
    /// results whose fix was refused are remembered by their distance from the end of the text.
    /// </summary>
    private static async Task<(Document Doc, int Applied, int Skipped)> FixInspectionDocumentAsync(Document doc, string actionId, bool checkEach, CancellationToken ct)
    {
        int applied = 0, skipped = 0;
        var refused = new HashSet<int>();
        var root0 = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model0 = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var budget = InspectionAnchors(model0!, root0!, actionId, ct).Count() * 2 + 4;
        while (budget-- > 0)
        {
            ct.ThrowIfCancellationRequested();
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            var anchors = InspectionAnchors(model!, root!, actionId, ct).Distinct().OrderByDescending(p => p).ToList();
            Func<Task<Document>>? run = null;
            Ctx? at = null;
            foreach (var pos in anchors)
            {
                if (refused.Contains(text.Length - pos)) continue;
                var c = new Ctx(doc, root!, model!, text, new TextSpan(pos, 0), ct);
                try { run = InspectionFix(c, actionId); }
                catch (Refusal) { run = null; }
                if (run != null) { at = c; break; }
                refused.Add(text.Length - pos); // not applicable here (e.g. CS4014-like statement that is not one)
            }
            if (run == null || at == null) break;
            try
            {
                var changed = await run().ConfigureAwait(false);
                changed = await Formatter.FormatAsync(changed, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
                if (checkEach) await CompileCheckAsync(at, changed, ct).ConfigureAwait(false);
                doc = changed;
                applied++;
            }
            catch (Refusal)
            {
                refused.Add(text.Length - at.Span.Start);
                skipped++;
            }
        }
        return (doc, applied, skipped);
    }
}
