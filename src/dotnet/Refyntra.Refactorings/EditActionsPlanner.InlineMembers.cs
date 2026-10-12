using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Simplification;
using Refyntra.Semantics;

namespace Refyntra.Refactorings;

/// <summary>
/// Inline Method (this call site / all call sites + remove the declaration), Inline Field / Constant and Inline Parameter.
/// These stay single-document edit actions: every reference must be in the document of the action (otherwise refused
/// with CrossFile), so the result is one compile-checked undo step like the other edit actions.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string InlineMethod = Prefix + "inlineMethod";
    public const string InlineMethodAll = Prefix + "inlineMethodAll";
    public const string InlineField = Prefix + "inlineField";
    public const string InlineParameter = Prefix + "inlineParameter";

    private const string InlineKind = "refactor.inline.refyntra.";

    private static void AddInlineMembers(Ctx c, Action<string, string, string, Func<Task<Document>>?> add)
    {
        var tok = c.Token;
        var p = tok.Parent;
        if (p == null) return;
        if (p is MethodDeclarationSyntax md && md.Identifier == tok && c.Model.GetDeclaredSymbol(md, c.Ct) is { } dm)
            add(InlineMethodAll, "Inline method (all call sites, remove declaration)", InlineKind + "method", () => InlineMethodAsync(c, dm, null));
        else if (p is SimpleNameSyntax sn && sn.Identifier == tok && CallOf(sn) is { } call && c.Model.GetSymbolInfo(call, c.Ct).Symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary } cm)
        {
            add(InlineMethod, "Inline method (this call site)", InlineKind + "methodCall", () => InlineMethodAsync(c, cm, call));
            add(InlineMethodAll, "Inline method (all call sites, remove declaration)", InlineKind + "method", () => InlineMethodAsync(c, cm, null));
        }

        if (p is VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } vd && vd.Identifier == tok && c.Model.GetDeclaredSymbol(vd, c.Ct) is IFieldSymbol df)
            add(InlineField, df.IsConst ? "Inline constant" : "Inline field", InlineKind + "field", () => InlineFieldAsync(c, df));
        else if (p is IdentifierNameSyntax idn && c.Model.GetSymbolInfo(idn, c.Ct).Symbol is IFieldSymbol { ContainingType.TypeKind: not TypeKind.Enum } rf
            && rf.DeclaringSyntaxReferences.Length == 1 && (rf.IsConst || rf.IsReadOnly))
            add(InlineField, rf.IsConst ? "Inline constant" : "Inline field", InlineKind + "field", () => InlineFieldAsync(c, rf));

        if (p is ParameterSyntax { Parent: ParameterListSyntax { Parent: MethodDeclarationSyntax } } ps && ps.Identifier == tok
            && c.Model.GetDeclaredSymbol(ps, c.Ct) is { } prm)
            add(InlineParameter, "Inline parameter", InlineKind + "parameter", () => InlineParameterAsync(c, prm, ps));
    }

    /// <summary>The invocation whose target name is <paramref name="name"/> (M(..), x.M(..)), or null (method group, nameof, ...).</summary>
    private static InvocationExpressionSyntax? CallOf(SimpleNameSyntax name) => name.Parent switch
    {
        InvocationExpressionSyntax inv when inv.Expression == name => inv,
        MemberAccessExpressionSyntax ma when ma.Name == name && ma.Parent is InvocationExpressionSyntax inv2 && inv2.Expression == ma => inv2,
        _ => null,
    };

    // ------------------------------------------------------------------ shared checks

    /// <summary>A method whose body can be inlined or whose signature can change: no virtual dispatch, no partial / extern / generic forms.</summary>
    private static MethodDeclarationSyntax CheckPlainMethod(Ctx c, IMethodSymbol m, string what)
    {
        if (m.MethodKind != MethodKind.Ordinary) throw new Refusal("NotSupported", $"Only ordinary methods can {what}.");
        if (m.ContainingType.TypeKind == TypeKind.Interface || m.IsVirtual || m.IsAbstract || m.IsOverride)
            throw new Refusal("Virtual", $"'{m.Name}' is virtual, abstract or an override; callers may run another implementation.");
        if (m.ContainingType.AllInterfaces.SelectMany(i => i.GetMembers()).Any(im => SymbolEqualityComparer.Default.Equals(m.ContainingType.FindImplementationForInterfaceMember(im), m)))
            throw new Refusal("InterfaceMember", $"'{m.Name}' implements an interface member; it can be called through the interface.");
        if (m.IsExtern || m.PartialDefinitionPart != null || m.PartialImplementationPart != null) throw new Refusal("NotSupported", $"Partial and extern methods cannot {what}.");
        if (m.IsExtensionMethod) throw new Refusal("ExtensionMethod", "Extension methods are not inlined.");
        if (m.DeclaringSyntaxReferences.Length != 1 || m.DeclaringSyntaxReferences[0].SyntaxTree != c.Root.SyntaxTree
            || m.DeclaringSyntaxReferences[0].GetSyntax(c.Ct) is not MethodDeclarationSyntax decl)
            throw new Refusal("CrossFile", $"'{m.Name}' is declared in another file; this action changes one document only.");
        return decl;
    }

    /// <summary>Every call of <paramref name="m"/> in the solution: all must be invocations in this document.</summary>
    private static async Task<List<InvocationExpressionSyntax>> CallSitesAsync(Ctx c, IMethodSymbol m)
    {
        var refs = await SymbolFinder.FindReferencesAsync(m, c.Doc.Project.Solution, c.Ct).ConfigureAwait(false);
        var calls = new List<InvocationExpressionSyntax>();
        foreach (var loc in refs.SelectMany(r => r.Locations))
        {
            if (loc.Document.Id != c.Doc.Id) throw new Refusal("CrossFile", $"'{m.Name}' is used in another file ({loc.Document.Name}); this action changes one document only.");
            var node = c.Root.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
            if (node is not SimpleNameSyntax sn || CallOf(sn) is not { } call)
                throw new Refusal("MethodGroup", $"'{m.Name}' is used as a method group or delegate (line {loc.Location.GetLineSpan().StartLinePosition.Line + 1}); it cannot be inlined.");
            calls.Add(call);
        }
        return calls.Distinct().OrderBy(x => x.SpanStart).ToList();
    }

    /// <summary>Names used inside <paramref name="expr"/> (outside its own lambdas) that mean the same at <paramref name="position"/>.</summary>
    private static void CheckResolvesSame(Ctx c, ExpressionSyntax expr, int position, Func<ISymbol, bool> skip)
    {
        foreach (var id in expr.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
        {
            if (id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id || id.Parent is MemberBindingExpressionSyntax || id.Parent is QualifiedNameSyntax q && q.Right == id
                || id.Parent is NameColonSyntax || id.Parent is NameEqualsSyntax || id.Identifier.ValueText == "nameof" || id.IsVar) continue;
            var sym = c.Model.GetSymbolInfo(id, c.Ct).Symbol ?? c.Model.GetSymbolInfo(id, c.Ct).CandidateSymbols.FirstOrDefault();
            if (sym == null || skip(sym)) continue;
            if (sym.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == expr.SyntaxTree && expr.Span.Contains(r.Span))) continue;
            var visible = c.Model.LookupSymbols(position, name: id.Identifier.ValueText);
            if (!visible.Any(v => SymbolEqualityComparer.Default.Equals(v.OriginalDefinition, sym.OriginalDefinition))
                || visible.Any(v => v is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol && !SymbolEqualityComparer.Default.Equals(v, sym)))
                throw new Refusal("NameConflict", $"'{id.Identifier.ValueText}' would mean something else at the target position.");
        }
    }

    private static ExpressionSyntax Parens(ExpressionSyntax e) =>
        IsPrimary(e) ? e : SyntaxFactory.ParenthesizedExpression(e).WithAdditionalAnnotations(Simplifier.Annotation);

    private static ExpressionSyntax WithConversion(Ctx c, ExpressionSyntax value, ExpressionSyntax original, ITypeSymbol target, int position)
    {
        var natural = c.Model.GetTypeInfo(original, c.Ct).Type;
        if (natural != null && SymbolEqualityComparer.Default.Equals(natural, target)) return value;
        if (natural == null && original is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression or (int)SyntaxKind.DefaultLiteralExpression } && !target.IsValueType) { }
        var shown = DisplayLocalType(c, target, position) ?? throw new Refusal("AnonymousType", "The type cannot be written.");
        return SyntaxFactory.CastExpression(SyntaxFactory.ParseTypeName(shown), IsPrimary(value) ? value : SyntaxFactory.ParenthesizedExpression(value));
    }

    private static bool InNameOf(SyntaxNode n) =>
        n.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" });

    private static Task<Document> Reduce(Ctx c, SyntaxNode root) =>
        Simplifier.ReduceAsync(c.Doc.WithSyntaxRoot(root), Simplifier.Annotation, null, c.Ct);

    // ------------------------------------------------------------------ inline method

    private sealed record InlineBody(MethodDeclarationSyntax Decl, ExpressionSyntax Expr, bool IsStatement);

    private static InlineBody InlineableBody(Ctx c, IMethodSymbol m)
    {
        var decl = CheckPlainMethod(c, m, "be inlined");
        if (m.IsGenericMethod) throw new Refusal("Generic", "Generic methods are not inlined.");
        if (m.IsAsync) throw new Refusal("Async", "Async methods are not inlined.");
        if (m.ReturnsByRef || m.ReturnsByRefReadonly) throw new Refusal("RefReturn", "Methods that return by reference are not inlined.");
        if (m.Parameters.Any(x => x.RefKind != RefKind.None)) throw new Refusal("RefParameter", $"'{m.Name}' has ref, out or in parameters.");
        if (m.Parameters.Any(x => x.IsParams)) throw new Refusal("ParamsParameter", $"'{m.Name}' has a params parameter.");
        ExpressionSyntax? expr;
        bool isStatement = m.ReturnsVoid;
        if (decl.ExpressionBody != null) expr = decl.ExpressionBody.Expression;
        else if (decl.Body is { } body)
        {
            var returns = body.DescendantNodes().OfType<ReturnStatementSyntax>().Count(r => !r.Ancestors().TakeWhile(a => a != body).Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax));
            if (returns > 1) throw new Refusal("MultipleReturns", $"'{m.Name}' has several return statements; only a single-return body can be inlined.");
            if (body.Statements.Count != 1) throw new Refusal("MultipleStatements", $"'{m.Name}' has several statements; only an expression body or a single return can be inlined.");
            expr = body.Statements[0] switch
            {
                ReturnStatementSyntax { Expression: { } r } when !m.ReturnsVoid => r,
                ExpressionStatementSyntax es when m.ReturnsVoid => es.Expression,
                _ => throw new Refusal("MultipleStatements", $"The body of '{m.Name}' is not a single return or expression."),
            };
        }
        else throw new Refusal("NoBody", $"'{m.Name}' has no body.");
        if (expr is ThrowExpressionSyntax) throw new Refusal("NotSupported", "A body that only throws is not inlined.");
        if (decl.Body != null && HasInnerComments(decl.Body) || decl.ExpressionBody != null && HasInnerComments(decl.ExpressionBody))
            throw new Refusal("Comments", "The method body has comments that would be lost.");
        if (expr.DescendantNodesAndSelf().Any(n => n is BaseExpressionSyntax || n is StackAllocArrayCreationExpressionSyntax))
            throw new Refusal("NotSupported", "Bodies using 'base' or stackalloc are not inlined.");
        if (expr.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().Any(n => c.Model.GetSymbolInfo(n, c.Ct).Symbol is IMethodSymbol s && SymbolEqualityComparer.Default.Equals(s.OriginalDefinition, m.OriginalDefinition)))
            throw new Refusal("Recursive", $"'{m.Name}' calls itself.");
        return new InlineBody(decl, expr, isStatement);
    }

    private static async Task<Document> InlineMethodAsync(Ctx c, IMethodSymbol m, InvocationExpressionSyntax? site)
    {
        m = m.ReducedFrom ?? m;
        var body = InlineableBody(c, m);
        var sites = site != null ? new List<InvocationExpressionSyntax> { site } : await CallSitesAsync(c, m).ConfigureAwait(false);
        if (sites.Count == 0 && site == null) throw new Refusal("NoCallers", $"'{m.Name}' is not called; use Safe Delete to remove it.");
        if (sites.Any(s => body.Decl.Span.Contains(s.Span))) throw new Refusal("Recursive", $"'{m.Name}' calls itself.");
        if (sites.Any(a => sites.Any(b => a != b && a.Span.Contains(b.Span)))) throw new Refusal("NestedCalls", $"A call of '{m.Name}' is nested in another one; inline them one at a time.");

        var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
        var memberLocals = new Dictionary<SyntaxNode, HashSet<string>>();
        foreach (var call in sites) InlineOneCall(c, m, body, call, editor, memberLocals);
        if (site == null) editor.RemoveNode(body.Decl, SyntaxRemoveOptions.KeepUnbalancedDirectives);
        return await Reduce(c, editor.GetChangedRoot()).ConfigureAwait(false);
    }

    private static void InlineOneCall(Ctx c, IMethodSymbol m, InlineBody body, InvocationExpressionSyntax call, SyntaxEditor editor, Dictionary<SyntaxNode, HashSet<string>> memberLocals)
    {
        if (c.Model.GetOperation(call, c.Ct) is not IInvocationOperation op) throw new Refusal("NotSupported", "The call cannot be analyzed.");
        // Receiver: M(..), this.M(..) or Type.M(..) only (another instance would need its own temp and null semantics).
        if (call.Expression is MemberAccessExpressionSyntax ma && ma.Expression is not ThisExpressionSyntax
            && c.Model.GetSymbolInfo(ma.Expression, c.Ct).Symbol is not INamedTypeSymbol)
            throw new Refusal("Receiver", $"The call is made on another object ('{ma.Expression}'); only calls on 'this' or the type are inlined.");
        var callerType = c.Model.GetEnclosingSymbol(call.SpanStart, c.Ct)?.ContainingType;
        if (!m.IsStatic && !SymbolEqualityComparer.Default.Equals(callerType?.OriginalDefinition, m.ContainingType.OriginalDefinition))
            throw new Refusal("Receiver", "The call is made from another type.");
        if (op.Arguments.Any(a => a.ArgumentKind != ArgumentKind.Explicit)) throw new Refusal("OptionalArguments", "The call relies on default parameter values.");
        if (body.IsStatement && call.Parent is not (ExpressionStatementSyntax or ArrowExpressionClauseSyntax)) throw new Refusal("NotSupported", "A call of a void method can only be inlined where it is a statement.");

        var args = op.Arguments.ToDictionary(a => a.Parameter!.Ordinal, a => ((ArgumentSyntax)a.Syntax).Expression);
        var uses = m.Parameters.ToDictionary(p => p.Ordinal, p => body.Expr.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
            .Where(id => id.Identifier.ValueText == p.Name && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(id, c.Ct).Symbol, p)).ToList());
        if (uses.Values.SelectMany(x => x).Any(InNameOf)) throw new Refusal("NameOf", "A parameter is used in nameof.");

        bool Trivial(ExpressionSyntax a) => c.Model.GetConstantValue(a, c.Ct).HasValue
            || a is IdentifierNameSyntax && c.Model.GetSymbolInfo(a, c.Ct).Symbol is ILocalSymbol { IsRef: false } or IParameterSymbol { RefKind: RefKind.None }
            || a is ThisExpressionSyntax;
        bool DirectSingle(int ordinal) =>
            uses[ordinal].Count == 1 && !IsWritten(uses[ordinal][0]) && !ConditionallyEvaluated(uses[ordinal][0], body.Expr)
            && !body.Expr.DescendantNodesAndSelf().Any(n => n.SpanStart < uses[ordinal][0].SpanStart && !n.Span.Contains(uses[ordinal][0].Span) && IsImpure(n)
                && !(n is MemberAccessExpressionSyntax mn && (mn.Parent is InvocationExpressionSyntax pi && pi.Expression == mn || c.Model.GetSymbolInfo(mn, c.Ct).Symbol is IMethodSymbol or INamedTypeSymbol or INamespaceSymbol)));

        var temp = new HashSet<int>();
        foreach (var p in m.Parameters)
        {
            var a = args[p.Ordinal];
            if (uses[p.Ordinal].Any(IsWritten)) temp.Add(p.Ordinal);
            else if (Trivial(a)) continue;
            else if (uses[p.Ordinal].Count == 0) { if (!CodeFacts.IsSideEffectFree(a, c.Model, c.Ct)) temp.Add(p.Ordinal); }
            else if (!DirectSingle(p.Ordinal)) temp.Add(p.Ordinal);
        }
        // Direct single uses must keep the argument order.
        var direct = m.Parameters.Where(p => !temp.Contains(p.Ordinal) && !Trivial(args[p.Ordinal]) && uses[p.Ordinal].Count > 0).Select(p => uses[p.Ordinal][0].SpanStart).ToList();
        if (direct.Zip(direct.Skip(1)).Any(x => x.First > x.Second))
            foreach (var p in m.Parameters.Where(p => !Trivial(args[p.Ordinal]))) temp.Add(p.Ordinal);
        // Temps are evaluated before the statement, so every non-trivial argument goes into a temp to keep the order.
        if (temp.Count > 0)
            foreach (var p in m.Parameters.Where(p => !Trivial(args[p.Ordinal]))) temp.Add(p.Ordinal);

        CheckResolvesSame(c, body.Expr, call.SpanStart, s => s is IParameterSymbol ps && SymbolEqualityComparer.Default.Equals(ps.ContainingSymbol, m));

        var replacement = new Dictionary<SyntaxNode, SyntaxNode>();
        StatementSyntax? stmt = null;
        var temps = new List<StatementSyntax>();
        if (temp.Count > 0)
        {
            stmt = call.Ancestors().OfType<StatementSyntax>().FirstOrDefault() ?? throw new Refusal("NeedsStatement", "An argument must be evaluated once into a temporary variable, but the call is not inside a statement block.");
            if (stmt.Parent is not (BlockSyntax or SwitchSectionSyntax))
                throw new Refusal("NeedsStatement", "An argument must be evaluated once into a temporary variable, but the call is not inside a statement block.");
            if (ConditionallyEvaluated(call, stmt))
                throw new Refusal("EvaluationOrder", "The call is evaluated conditionally; moving its arguments into variables would change how often they run.");
            if (stmt.DescendantNodes().Any(n => n.SpanStart < call.SpanStart && !n.Span.Contains(call.Span) && IsImpure(n)))
                throw new Refusal("EvaluationOrder", "Something with possible side effects runs before the call in its statement; inlining would change the evaluation order.");
            var member = (SyntaxNode?)call.Ancestors().FirstOrDefault(a => a is MemberDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax) ?? c.Root;
            if (!memberLocals.TryGetValue(member, out var taken))
            {
                taken = new HashSet<string>(member.DescendantNodes().Select(n => n switch
                {
                    VariableDeclaratorSyntax v => v.Identifier.ValueText,
                    SingleVariableDesignationSyntax d => d.Identifier.ValueText,
                    ParameterSyntax ps => ps.Identifier.ValueText,
                    ForEachStatementSyntax f => f.Identifier.ValueText,
                    _ => null,
                }).OfType<string>(), StringComparer.Ordinal);
                memberLocals[member] = taken;
            }
            foreach (var id in body.Expr.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
                if (c.Model.GetSymbolInfo(id, c.Ct).Symbol is not IParameterSymbol { ContainingSymbol: var owner } || !SymbolEqualityComparer.Default.Equals(owner, m))
                    taken.Add(id.Identifier.ValueText);
            foreach (var p in m.Parameters.Where(p => temp.Contains(p.Ordinal)))
            {
                var name = p.Name;
                for (var i = 2; taken.Contains(name) || c.Model.LookupSymbols(stmt.SpanStart, name: name).Any(); i++) name = p.Name + i;
                taken.Add(name);
                var type = DisplayLocalType(c, p.Type, stmt.SpanStart) ?? throw new Refusal("AnonymousType", "A parameter type cannot be written.");
                temps.Add(SyntaxFactory.LocalDeclarationStatement(SyntaxFactory.VariableDeclaration(SyntaxFactory.ParseTypeName(type),
                    SyntaxFactory.SingletonSeparatedList(SyntaxFactory.VariableDeclarator(name).WithInitializer(SyntaxFactory.EqualsValueClause(args[p.Ordinal].WithoutTrivia())))))
                    .WithAdditionalAnnotations(Formatter.Annotation));
                foreach (var u in uses[p.Ordinal]) replacement[u] = SyntaxFactory.IdentifierName(name).WithTriviaFrom(u);
            }
        }
        foreach (var p in m.Parameters.Where(p => !temp.Contains(p.Ordinal)))
            foreach (var u in uses[p.Ordinal]) replacement[u] = Parens(args[p.Ordinal].WithoutTrivia()).WithTriviaFrom(u);

        var expr = body.Expr.ReplaceNodes(replacement.Keys, (o, _) => replacement[o]).WithoutTrivia();
        // A call through 'this.' or the type keeps the same instance; implicit member references stay valid.
        if (!body.IsStatement) expr = WithConversion(c, expr, body.Expr, m.ReturnType, call.SpanStart);
        var result = (body.IsStatement ? expr : Parens(expr)).WithTriviaFrom(call).WithAdditionalAnnotations(Formatter.Annotation);
        if (stmt != null) editor.InsertBefore(stmt, temps);
        editor.ReplaceNode(call, result);
    }

    // ------------------------------------------------------------------ inline field / constant

    private static async Task<Document> InlineFieldAsync(Ctx c, IFieldSymbol f)
    {
        if (!f.IsConst && !f.IsReadOnly) throw new Refusal("NotReadOnly", $"'{f.Name}' is not const or readonly; its value can change.");
        if (f.DeclaringSyntaxReferences.Length != 1 || f.DeclaringSyntaxReferences[0].SyntaxTree != c.Root.SyntaxTree
            || f.DeclaringSyntaxReferences[0].GetSyntax(c.Ct) is not VariableDeclaratorSyntax declarator
            || declarator.Parent is not VariableDeclarationSyntax { Parent: FieldDeclarationSyntax fieldDecl } decl)
            throw new Refusal("CrossFile", $"'{f.Name}' is declared in another file; this action changes one document only.");
        if (declarator.Initializer?.Value is not { } init)
            throw new Refusal("NotSingleAssignment", $"'{f.Name}' has no initializer; only a field assigned once by its initializer can be inlined.");
        if (!f.IsConst)
        {
            var ok = (CodeFacts.IsSideEffectFree(init, c.Model, c.Ct) || IsPureOperators(init, c.Model, c.Ct) || c.Model.GetConstantValue(init, c.Ct).HasValue)
                && init.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().All(id => id.Parent is MemberAccessExpressionSyntax mx && mx.Name == id
                    || c.Model.GetSymbolInfo(id, c.Ct).Symbol is IFieldSymbol { IsConst: true } or INamedTypeSymbol or INamespaceSymbol);
            if (!ok) throw new Refusal("SideEffects", $"The initializer of '{f.Name}' may have side effects or depend on other state; only a side-effect-free initializer of constants is inlined.");
        }
        if (HasInnerComments(init)) throw new Refusal("Comments", "The initializer has comments that would be lost.");

        var refs = await SymbolFinder.FindReferencesAsync(f, c.Doc.Project.Solution, c.Ct).ConfigureAwait(false);
        var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
        foreach (var loc in refs.SelectMany(r => r.Locations))
        {
            if (loc.Document.Id != c.Doc.Id) throw new Refusal("CrossFile", $"'{f.Name}' is used in another file ({loc.Document.Name}); this action changes one document only.");
            if (c.Root.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true) is not IdentifierNameSyntax id) throw new Refusal("NotSupported", "A reference cannot be analyzed.");
            if (IsWritten(id) || id.Parent is MemberAccessExpressionSyntax wm && wm.Name == id && IsWrittenExpr(wm))
                throw new Refusal("FieldWritten", $"'{f.Name}' is assigned outside its initializer.");
            if (InNameOf(id)) throw new Refusal("NameOf", $"'{f.Name}' is used in nameof.");
            ExpressionSyntax target = id;
            if (id.Parent is MemberAccessExpressionSyntax mm && mm.Name == id)
            {
                if (!f.IsStatic && mm.Expression is not ThisExpressionSyntax)
                    throw new Refusal("Receiver", $"'{f.Name}' is read from another object ('{mm.Expression}'); inlining would drop that object's evaluation.");
                target = mm;
            }
            else if (id.Parent is MemberBindingExpressionSyntax)
                throw new Refusal("Receiver", $"'{f.Name}' is read with '?.'.");
            CheckResolvesSame(c, init, target.SpanStart, _ => false);
            var value = WithConversion(c, init.WithoutTrivia(), init, f.Type, target.SpanStart);
            editor.ReplaceNode(target, Parens(value).WithTriviaFrom(target).WithAdditionalAnnotations(Formatter.Annotation));
        }
        if (decl.Variables.Count == 1) editor.RemoveNode(fieldDecl, SyntaxRemoveOptions.KeepUnbalancedDirectives);
        else editor.RemoveNode(declarator);
        return await Reduce(c, editor.GetChangedRoot()).ConfigureAwait(false);
    }

    private static bool IsWrittenExpr(ExpressionSyntax e)
    {
        while (e.Parent is ParenthesizedExpressionSyntax p) e = p;
        return e.Parent switch
        {
            AssignmentExpressionSyntax a => a.Left == e,
            PrefixUnaryExpressionSyntax u => !u.IsKind(SyntaxKind.LogicalNotExpression) && !u.IsKind(SyntaxKind.UnaryMinusExpression) && !u.IsKind(SyntaxKind.UnaryPlusExpression) && !u.IsKind(SyntaxKind.BitwiseNotExpression),
            PostfixUnaryExpressionSyntax u => !u.IsKind(SyntaxKind.SuppressNullableWarningExpression),
            ArgumentSyntax arg => !arg.RefKindKeyword.IsKind(SyntaxKind.None) && !arg.RefKindKeyword.IsKind(SyntaxKind.InKeyword),
            RefExpressionSyntax => true,
            _ => false,
        };
    }

    // ------------------------------------------------------------------ inline parameter

    private static async Task<Document> InlineParameterAsync(Ctx c, IParameterSymbol prm, ParameterSyntax ps)
    {
        if (prm.ContainingSymbol is not IMethodSymbol m) throw new Refusal("NotSupported", "Only method parameters are inlined.");
        var decl = CheckPlainMethod(c, m, "change their parameters");
        if (prm.RefKind != RefKind.None || prm.IsParams || prm.IsThis) throw new Refusal("RefParameter", $"'{prm.Name}' is a ref, out, in, params or 'this' parameter.");
        var calls = await CallSitesAsync(c, m).ConfigureAwait(false);
        if (calls.Count == 0) throw new Refusal("NoCallers", $"'{m.Name}' is not called; there is no value to inline.");

        ExpressionSyntax? value = null;
        var removeArgs = new List<ArgumentSyntax>();
        foreach (var call in calls)
        {
            if (c.Model.GetOperation(call, c.Ct) is not IInvocationOperation op) throw new Refusal("NotSupported", "A call cannot be analyzed.");
            var arg = op.Arguments.FirstOrDefault(a => SymbolEqualityComparer.Default.Equals(a.Parameter, prm)) ?? throw new Refusal("NotSupported", "A call cannot be analyzed.");
            ExpressionSyntax v;
            if (arg.ArgumentKind == ArgumentKind.Explicit && arg.Syntax is ArgumentSyntax a) { v = a.Expression; removeArgs.Add(a); }
            else if (arg.ArgumentKind == ArgumentKind.DefaultValue && ps.Default?.Value is { } dv) v = dv;
            else throw new Refusal("NotSupported", "A call passes the parameter in a way that cannot be inlined.");
            if (value == null) value = v;
            else if (!SyntaxFactory.AreEquivalent(value, v, topLevel: false))
                throw new Refusal("DifferentArguments", $"Callers pass different values for '{prm.Name}' ('{value}' and '{v}').");
            if (!(CodeFacts.IsSideEffectFree(v, c.Model, c.Ct) || IsPureOperators(v, c.Model, c.Ct)))
                throw new Refusal("SideEffects", $"The value passed for '{prm.Name}' may have side effects.");
            foreach (var id in v.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
            {
                if (id.Parent is MemberAccessExpressionSyntax mx && mx.Name == id) continue;
                var s = c.Model.GetSymbolInfo(id, c.Ct).Symbol;
                if (s is not (IFieldSymbol { IsConst: true } or IFieldSymbol { IsStatic: true, IsReadOnly: true } or INamedTypeSymbol or INamespaceSymbol))
                    throw new Refusal("CallerLocals", $"The value passed for '{prm.Name}' uses '{id.Identifier.ValueText}', which is not a constant or static readonly member.");
            }
        }
        var bodyNode = (SyntaxNode?)decl.Body ?? decl.ExpressionBody ?? throw new Refusal("NoBody", $"'{m.Name}' has no body.");
        var uses = bodyNode.DescendantNodes().OfType<IdentifierNameSyntax>()
            .Where(id => id.Identifier.ValueText == prm.Name && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(id, c.Ct).Symbol, prm)).ToList();
        if (uses.Any(InNameOf)) throw new Refusal("NameOf", $"'{prm.Name}' is used in nameof.");
        var anyBodyPos = decl.Body?.OpenBraceToken.Span.End ?? decl.ExpressionBody!.Expression.SpanStart;
        CheckResolvesSame(c, value!, anyBodyPos, _ => false);

        var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
        if (uses.Any(IsWritten))
        {
            if (decl.Body == null) throw new Refusal("NotSupported", $"'{prm.Name}' is assigned in an expression body.");
            var type = DisplayLocalType(c, prm.Type, decl.Body.SpanStart) ?? throw new Refusal("AnonymousType", "The parameter type cannot be written.");
            var local = SyntaxFactory.LocalDeclarationStatement(SyntaxFactory.VariableDeclaration(SyntaxFactory.ParseTypeName(type),
                SyntaxFactory.SingletonSeparatedList(SyntaxFactory.VariableDeclarator(prm.Name).WithInitializer(SyntaxFactory.EqualsValueClause(value!.WithoutTrivia())))))
                .WithAdditionalAnnotations(Formatter.Annotation);
            if (decl.Body.Statements.Count > 0) editor.InsertBefore(decl.Body.Statements[0], local);
            else editor.ReplaceNode(decl.Body, decl.Body.AddStatements(local).WithAdditionalAnnotations(Formatter.Annotation));
        }
        else
        {
            foreach (var u in uses)
                editor.ReplaceNode(u, Parens(WithConversion(c, value!.WithoutTrivia(), value!, prm.Type, u.SpanStart)).WithTriviaFrom(u).WithAdditionalAnnotations(Formatter.Annotation));
        }
        editor.RemoveNode(ps);
        foreach (var a in removeArgs) editor.RemoveNode(a);
        return await Reduce(c, editor.GetChangedRoot()).ConfigureAwait(false);
    }
}
