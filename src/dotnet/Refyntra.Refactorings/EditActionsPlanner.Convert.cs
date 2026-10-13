using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using SF = Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace Refyntra.Refactorings;

/// <summary>
/// Convert actions: if chain ↔ switch statement / expression, foreach ↔ LINQ, interpolated string ↔ string.Format,
/// constructor ↔ primary constructor, class ↔ record, auto-property ↔ backing field, object initializer, using
/// statement ↔ declaration, make async / remove async. Each is offered only for the shapes it can rewrite without
/// changing what the code does, and refuses (with a reason) when a semantic check fails.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string IfToSwitchStatement = Prefix + "ifToSwitch";
    public const string IfToSwitchExpression = Prefix + "ifToSwitchExpression";
    public const string SwitchToExpression = Prefix + "switchToExpression";
    public const string SwitchToStatement = Prefix + "switchToStatement";
    public const string ForEachToLinq = Prefix + "foreachToLinq";
    public const string LinqToForEach = Prefix + "linqToForeach";
    public const string ToStringFormat = Prefix + "toStringFormat";
    public const string FormatToInterpolated = Prefix + "stringFormatToInterpolated";
    public const string ToPrimaryConstructor = Prefix + "toPrimaryConstructor";
    public const string FromPrimaryConstructor = Prefix + "fromPrimaryConstructor";
    public const string ClassToRecord = Prefix + "classToRecord";
    public const string RecordToClass = Prefix + "recordToClass";
    public const string ToFullProperty = Prefix + "toFullProperty";
    public const string ToAutoProperty = Prefix + "toAutoProperty";
    public const string ToObjectInitializer = Prefix + "toObjectInitializer";
    public const string SplitObjectInitializer = Prefix + "splitObjectInitializer";
    public const string UsingToDeclaration = Prefix + "usingToDeclaration";
    public const string UsingToStatement = Prefix + "usingToStatement";
    public const string MakeAsync = Prefix + "makeAsync";
    public const string RemoveAsync = Prefix + "removeAsync";

    private static void AddConvert(Ctx c, Action<string, string, string, Func<Task<Document>>?> add)
    {
        add(IfToSwitchStatement, "Convert 'if' to 'switch' statement", Rewrite + "ifToSwitch", IfSwitch(c, expression: false));
        add(IfToSwitchExpression, "Convert 'if' to 'switch' expression", Rewrite + "ifToSwitchExpression", IfSwitch(c, expression: true));
        add(SwitchToExpression, "Convert 'switch' statement to expression", Rewrite + "switchToExpression", SwitchStatementToExpression(c));
        add(SwitchToStatement, "Convert 'switch' expression to statement", Rewrite + "switchToStatement", SwitchExpressionToStatement(c));
        add(ForEachToLinq, "Convert 'foreach' to LINQ", Rewrite + "foreachToLinq", ForEachLinq(c));
        add(LinqToForEach, "Convert LINQ to 'foreach'", Rewrite + "linqToForeach", LinqForEach(c));
        add(ToStringFormat, "Convert to 'string.Format'", Rewrite + "stringFormat", InterpolatedToFormat(c));
        add(FormatToInterpolated, "Convert 'string.Format' to interpolated string", Rewrite + "formatToInterpolated", FormatToInterpolatedString(c));
        add(ToPrimaryConstructor, "Convert to primary constructor", Rewrite + "primaryConstructor", ToPrimary(c));
        add(FromPrimaryConstructor, "Convert primary constructor to constructor", Rewrite + "explicitConstructor", FromPrimary(c));
        add(ClassToRecord, "Convert class to record", Rewrite + "classToRecord", ClassRecord(c));
        add(RecordToClass, "Convert record to class", Rewrite + "recordToClass", RecordClass(c));
        add(ToFullProperty, "Convert to property with backing field", Rewrite + "fullProperty", AutoToFull(c));
        add(ToAutoProperty, "Convert to auto-property", Rewrite + "autoProperty", FullToAuto(c));
        add(ToObjectInitializer, "Use object initializer", Rewrite + "objectInitializer", ObjectInitializer(c));
        add(SplitObjectInitializer, "Split object initializer into assignments", Rewrite + "splitObjectInitializer", SplitInitializer(c));
        add(UsingToDeclaration, "Convert to 'using' declaration", Rewrite + "usingDeclaration", UsingDeclaration(c));
        add(UsingToStatement, "Convert to 'using' statement", Rewrite + "usingStatement", UsingStatement(c));
        add(MakeAsync, "Make method async", Rewrite + "makeAsync", MakeMethodAsync(c));
        add(RemoveAsync, "Remove 'async' and 'await'", Rewrite + "removeAsync", RemoveMethodAsync(c));
    }

    // ------------------------------------------------------------------ shared helpers

    private static ExpressionSyntax Bare(ExpressionSyntax e)
    {
        while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
        return e;
    }

    private static SyntaxTrivia Eol(Ctx c) => SF.EndOfLine(c.Text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");

    private static SyntaxList<StatementSyntax> SiblingsOf(StatementSyntax s) => s.Parent switch
    {
        BlockSyntax b => b.Statements,
        SwitchSectionSyntax ss => ss.Statements,
        _ => default,
    };

    private static StatementSyntax? NextStatement(StatementSyntax s)
    {
        if (s.Parent is not (BlockSyntax or SwitchSectionSyntax)) return null;
        var list = SiblingsOf(s);
        var i = list.IndexOf(s);
        return i >= 0 && i + 1 < list.Count ? list[i + 1] : null;
    }

    private static StatementSyntax? PreviousStatement(StatementSyntax s)
    {
        if (s.Parent is not (BlockSyntax or SwitchSectionSyntax)) return null;
        var list = SiblingsOf(s);
        var i = list.IndexOf(s);
        return i > 0 ? list[i - 1] : null;
    }

    private static T Fmt<T>(T n) where T : SyntaxNode => n.WithAdditionalAnnotations(Formatter.Annotation);

    /// <summary>True when the namespace's marker type is visible by simple name at the position (imported or enclosing).</summary>
    private static bool Imports(Ctx c, int position, string ns, string marker) =>
        c.Model.LookupNamespacesAndTypes(position, name: marker).OfType<INamedTypeSymbol>().Any(t => t.ContainingNamespace?.ToDisplayString() == ns);

    private static Document WithUsing(Document doc, SyntaxNode root, string ns)
    {
        if (root is not CompilationUnitSyntax cu) return doc.WithSyntaxRoot(root);
        var directive = Fmt(SF.UsingDirective(SF.ParseName(ns)));
        var usings = cu.Usings;
        var at = 0;
        while (at < usings.Count && usings[at].GlobalKeyword.IsKind(SyntaxKind.None) && usings[at].Alias == null && usings[at].StaticKeyword.IsKind(SyntaxKind.None)
               && string.CompareOrdinal(usings[at].Name?.ToString(), ns) < 0) at++;
        if (usings.Count == 0) directive = directive.WithTrailingTrivia(SF.ElasticCarriageReturnLineFeed, SF.ElasticCarriageReturnLineFeed);
        return doc.WithSyntaxRoot(cu.WithUsings(usings.Insert(at, directive)));
    }

    /// <summary>The function (method, local function, lambda, accessor) whose body contains <paramref name="n"/>.</summary>
    private static SyntaxNode? FunctionOf(SyntaxNode n) =>
        n.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax or AccessorDeclarationSyntax
            or PropertyDeclarationSyntax or IndexerDeclarationSyntax);

    /// <summary>The value-returning member whose arrow body is <paramref name="e"/> (method or local function), or null.</summary>
    private static SyntaxNode? ArrowOwner(Ctx c, ExpressionSyntax e)
    {
        if (e.Parent is not ArrowExpressionClauseSyntax arrow) return null;
        if (arrow.Parent is not (MethodDeclarationSyntax or LocalFunctionStatementSyntax)) return null;
        try { return ReturnsValue(c, arrow.Parent) ? arrow.Parent : null; }
        catch (Refusal) { return null; }
    }

    private static SyntaxNode WithBlockBody(SyntaxNode owner, BlockSyntax block) => owner switch
    {
        MethodDeclarationSyntax m => m.WithExpressionBody(null).WithSemicolonToken(default).WithBody(block).WithTriviaFrom(m),
        LocalFunctionStatementSyntax f => f.WithExpressionBody(null).WithSemicolonToken(default).WithBody(block).WithTriviaFrom(f),
        _ => throw new Refusal("NotApplicable", "Unsupported member."),
    };

    /// <summary>Replaces a statement of a block (or the arrow body of a method) with statements.</summary>
    private static SyntaxNode ReplaceWithStatements(SyntaxNode root, SyntaxNode at, IReadOnlyList<StatementSyntax> stmts)
    {
        var eol = SF.EndOfLine(root.ToFullString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");
        var list = stmts.Select(s => Fmt(s.WithoutTrivia().WithTrailingTrivia(eol))).ToList();
        if (at is StatementSyntax st)
        {
            list[0] = list[0].WithLeadingTrivia(st.GetLeadingTrivia());
            list[^1] = list[^1].WithTrailingTrivia(st.GetTrailingTrivia());
            return root.ReplaceNode(st, list);
        }
        return root.ReplaceNode(at, Fmt(WithBlockBody(at, SF.Block(list))));
    }

    private static bool Mentions(SyntaxNode n, ISymbol s, SemanticModel model, CancellationToken ct) =>
        n.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>().Any(i => i.Identifier.ValueText == s.Name && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(i, ct).Symbol, s));

    // ------------------------------------------------------------------ if ↔ switch

    private static bool IsPatternConstant(Ctx c, ExpressionSyntax e)
    {
        var v = c.Model.GetConstantValue(e, c.Ct);
        return v.HasValue && !(v.Value is double d && double.IsNaN(d)) && !(v.Value is float f && float.IsNaN(f));
    }

    /// <summary>The pattern a condition tests the subject against (==, is, ||), or null.</summary>
    private static PatternSyntax? PatternFor(Ctx c, ExpressionSyntax cond, ref ExpressionSyntax? subject)
    {
        var e = Bare(cond);
        switch (e)
        {
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.LogicalOrExpression):
            {
                var l = PatternFor(c, b.Left, ref subject);
                if (l == null) return null;
                var r = PatternFor(c, b.Right, ref subject);
                return r == null ? null : SF.BinaryPattern(SyntaxKind.OrPattern, l, r);
            }
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.EqualsExpression):
            {
                if (c.Model.GetSymbolInfo(b, c.Ct).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } op
                    && op.ContainingType.SpecialType is not (SpecialType.System_String or SpecialType.System_Decimal)) return null;
                ExpressionSyntax s, k;
                if (IsPatternConstant(c, b.Right) && !IsPatternConstant(c, b.Left)) (s, k) = (b.Left, b.Right);
                else if (IsPatternConstant(c, b.Left) && !IsPatternConstant(c, b.Right)) (s, k) = (b.Right, b.Left);
                else return null;
                return SameSubject(ref subject, s) ? SF.ConstantPattern(k.WithoutTrivia()) : null;
            }
            case IsPatternExpressionSyntax ip:
                return SameSubject(ref subject, ip.Expression) ? ip.Pattern.WithoutTrivia() : null;
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.IsExpression) && b.Right is TypeSyntax t:
                return SameSubject(ref subject, b.Left) ? SF.TypePattern(t.WithoutTrivia()) : null;
        }
        return null;
    }

    private static bool SameSubject(ref ExpressionSyntax? subject, ExpressionSyntax s)
    {
        s = Bare(s);
        if (subject == null)
        {
            subject = s;
            return true;
        }
        return SF.AreEquivalent(subject, s);
    }

    /// <summary>A subject read more than once by an if chain may be read once by a switch: names, fields and properties only.</summary>
    private static bool IsReadOnlySubject(Ctx c, ExpressionSyntax e) => e switch
    {
        ThisExpressionSyntax => true,
        IdentifierNameSyntax or MemberAccessExpressionSyntax => c.Model.GetSymbolInfo(e, c.Ct).Symbol is ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol { IsIndexer: false }
            && (e is not MemberAccessExpressionSyntax ma || IsReadOnlySubject(c, ma.Expression) || c.Model.GetSymbolInfo(ma.Expression, c.Ct).Symbol is INamedTypeSymbol),
        _ => false,
    };

    private static List<(ExpressionSyntax Cond, StatementSyntax Body)> ChainOf(IfStatementSyntax top, out StatementSyntax? els)
    {
        var list = new List<(ExpressionSyntax, StatementSyntax)>();
        els = null;
        for (var i = top; ;)
        {
            list.Add((i.Condition, i.Statement));
            if (i.Else == null) break;
            if (i.Else.Statement is IfStatementSyntax n) { i = n; continue; }
            els = i.Else.Statement;
            break;
        }
        return list;
    }

    private static bool BreaksOut(StatementSyntax body) =>
        body.DescendantNodesAndSelf().OfType<BreakStatementSyntax>().Any(br => !br.Ancestors().TakeWhile(a => a != body.Parent)
            .Any(a => a is WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax or CommonForEachStatementSyntax or SwitchStatementSyntax));

    private static IEnumerable<PatternSyntax> OrParts(PatternSyntax p) =>
        p is BinaryPatternSyntax { RawKind: (int)SyntaxKind.OrPattern } b ? OrParts(b.Left).Concat(OrParts(b.Right)) : new[] { p };

    private static SwitchLabelSyntax LabelFor(PatternSyntax p, WhenClauseSyntax? when = null) =>
        p is ConstantPatternSyntax cp && when == null ? SF.CaseSwitchLabel(cp.Expression) : SF.CasePatternSwitchLabel(p, when, SF.Token(SyntaxKind.ColonToken));

    /// <summary>The value one branch yields: the returned / assigned value (or a throw), and the assignment target.</summary>
    private sealed record BranchValue(bool Return, ExpressionSyntax Value, ExpressionSyntax? Target);

    private static BranchValue? ValueOf(StatementSyntax? s)
    {
        if (s is BlockSyntax b) s = b.Statements.Count == 1 ? b.Statements[0] : null;
        return s switch
        {
            ReturnStatementSyntax { Expression: { } r } => new BranchValue(true, r, null),
            ThrowStatementSyntax { Expression: { } t } => new BranchValue(false, SF.ThrowExpression(t.WithoutTrivia()), null),
            ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a } when IsSimpleTarget(a.Left) => new BranchValue(false, a.Right, a.Left),
            _ => null,
        };
    }

    /// <summary>All values return, or all assign the same target (throws fit both). Null: they do not agree.</summary>
    private static (bool Return, ExpressionSyntax? Target)? Agree(IEnumerable<BranchValue> values)
    {
        bool? ret = null;
        ExpressionSyntax? target = null;
        foreach (var v in values)
        {
            if (v.Value is ThrowExpressionSyntax && v.Target == null && !v.Return) continue;
            if (v.Return)
            {
                if (ret == false) return null;
                ret = true;
            }
            else
            {
                if (ret == true || target != null && !SF.AreEquivalent(target, v.Target!)) return null;
                ret = false;
                target = v.Target;
            }
        }
        return ret == null ? null : (ret.Value, target);
    }

    private static SwitchExpressionSyntax MakeSwitchExpression(Ctx c, ExpressionSyntax subject, IReadOnlyList<SwitchExpressionArmSyntax> arms)
    {
        var eol = Eol(c);
        var commas = arms.Select(_ => SF.Token(SyntaxKind.CommaToken).WithTrailingTrivia(eol));
        return SF.SwitchExpression(subject.WithoutTrivia(), SF.SeparatedList(arms, commas))
            .WithOpenBraceToken(SF.Token(SyntaxKind.OpenBraceToken).WithLeadingTrivia(eol).WithTrailingTrivia(eol));
    }

    private static Func<Task<Document>>? IfSwitch(Ctx c, bool expression)
    {
        if (IfAt(c) is not { } ifs || ifs.Parent is ElseClauseSyntax || HasInnerComments(ifs)) return null;
        var branches = ChainOf(ifs, out var els);
        if (branches.Count < 2) return null;
        ExpressionSyntax? subject = null;
        var patterns = new List<PatternSyntax>();
        foreach (var b in branches)
        {
            var p = PatternFor(c, b.Cond, ref subject);
            if (p == null) return null;
            patterns.Add(p);
        }
        if (subject == null || !IsReadOnlySubject(c, subject)) return null;
        if (!expression)
        {
            if (branches.Select(b => b.Body).Append(els).Any(b => b != null && BreaksOut(b))) return null;
            return () =>
            {
                var sections = new List<SwitchSectionSyntax>();
                for (var i = 0; i < branches.Count; i++)
                    sections.Add(SF.SwitchSection(SF.List(OrParts(patterns[i]).Select(p => LabelFor(p))), SectionBody(c, branches[i].Body)));
                if (els != null) sections.Add(SF.SwitchSection(SF.SingletonList<SwitchLabelSyntax>(SF.DefaultSwitchLabel()), SectionBody(c, els)));
                var sw = SF.SwitchStatement(subject.WithoutTrivia(), SF.List(sections));
                return Replace(c, ifs, sw.WithTriviaFrom(ifs))();
            };
        }
        var values = branches.Select(b => ValueOf(b.Body)).ToList();
        if (values.Any(v => v == null)) return null;
        var fallback = els != null ? ValueOf(els) : null;
        StatementSyntax? consumed = null;
        if (els != null && fallback == null) return null;
        if (els == null)
        {
            consumed = NextStatement(ifs);
            fallback = consumed is ReturnStatementSyntax or ThrowStatementSyntax ? ValueOf(consumed) : null;
            if (fallback == null) return null;
        }
        var agree = Agree(values.Append(fallback)!);
        if (agree == null) return null;
        var (isReturn, target) = agree.Value;
        if (!isReturn && consumed != null) return null;
        return () =>
        {
            var arms = new List<SwitchExpressionArmSyntax>();
            for (var i = 0; i < branches.Count; i++) arms.Add(SF.SwitchExpressionArm(patterns[i], values[i]!.Value.WithoutTrivia()));
            arms.Add(SF.SwitchExpressionArm(SF.DiscardPattern(), fallback!.Value.WithoutTrivia()));
            var se = MakeSwitchExpression(c, subject, arms);
            StatementSyntax stmt = isReturn
                ? SF.ReturnStatement(se)
                : SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, target!.WithoutTrivia(), se));
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            editor.ReplaceNode(ifs, Fmt(stmt.WithTriviaFrom(ifs)));
            if (consumed != null) editor.RemoveNode(consumed);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    /// <summary>The statements of a switch section from an if branch: wrapped in a block when it declares locals, plus 'break;' when its end is reachable.</summary>
    private static SyntaxList<StatementSyntax> SectionBody(Ctx c, StatementSyntax body)
    {
        var stmts = body is BlockSyntax b ? b.Statements.ToList() : new List<StatementSyntax> { body };
        var reachable = stmts.Count == 0 || c.Model.AnalyzeControlFlow(stmts[0], stmts[^1]) is not { Succeeded: true } flow || flow.EndPointIsReachable;
        var list = stmts.Select(s => s.WithoutTrivia().WithTrailingTrivia(Eol(c))).ToList();
        if (reachable) list.Add(SF.BreakStatement().WithTrailingTrivia(Eol(c)));
        if (stmts.Any(s => s is LocalDeclarationStatementSyntax or LocalFunctionStatementSyntax))
            return SF.SingletonList<StatementSyntax>(SF.Block(list));
        return SF.List(list);
    }

    private static Func<Task<Document>>? SwitchStatementToExpression(Ctx c)
    {
        var sw = c.Token.Parent?.AncestorsAndSelf().OfType<SwitchStatementSyntax>().FirstOrDefault();
        if (sw == null || c.Span.Start < sw.SwitchKeyword.SpanStart || c.Span.Start > sw.CloseParenToken.Span.End || HasInnerComments(sw)) return null;
        if (sw.Sections.Count == 0) return null;
        var arms = new List<(PatternSyntax? Pattern, WhenClauseSyntax? When, BranchValue Value)>();
        BranchValue? fallback = null;
        foreach (var section in sw.Sections)
        {
            var stmts = section.Statements;
            BranchValue? v = null;
            if (stmts.Count == 1) v = ValueOf(stmts[0]);
            if (v == null && stmts.Count == 1 && stmts[0] is BlockSyntax blk) v = ValueOf(blk);
            if (v == null && stmts.Count == 2 && stmts[1] is BreakStatementSyntax && ValueOf(stmts[0]) is { Target: not null } va) v = va;
            if (v == null || v.Target != null && stmts.Count != 2 && stmts[0] is not BlockSyntax) return null;
            if (v.Target != null && stmts.Count == 1) return null;
            if (section.Labels.Any(l => l is DefaultSwitchLabelSyntax))
            {
                fallback = v;
                continue;
            }
            if (section.Labels.Count > 1 && section.Labels.Any(l => l is CasePatternSwitchLabelSyntax { WhenClause: not null })) return null;
            PatternSyntax? pattern = null;
            WhenClauseSyntax? when = null;
            foreach (var label in section.Labels)
            {
                PatternSyntax p;
                switch (label)
                {
                    case CaseSwitchLabelSyntax cl: p = SF.ConstantPattern(cl.Value.WithoutTrivia()); break;
                    case CasePatternSwitchLabelSyntax pl: p = pl.Pattern.WithoutTrivia(); when = pl.WhenClause?.WithoutTrivia(); break;
                    default: return null;
                }
                pattern = pattern == null ? p : SF.BinaryPattern(SyntaxKind.OrPattern, pattern, p);
            }
            arms.Add((pattern, when, v));
        }
        StatementSyntax? consumed = null;
        if (fallback == null)
        {
            consumed = NextStatement(sw);
            fallback = consumed is ReturnStatementSyntax or ThrowStatementSyntax ? ValueOf(consumed) : null;
            if (fallback == null) return null;
        }
        var agree = Agree(arms.Select(a => a.Value).Append(fallback));
        if (agree == null) return null;
        var (isReturn, target) = agree.Value;
        if (!isReturn && consumed != null) return null;
        return () =>
        {
            var list = arms.Select(a => SF.SwitchExpressionArm(a.Pattern!, a.When, a.Value.Value.WithoutTrivia())).ToList();
            list.Add(SF.SwitchExpressionArm(SF.DiscardPattern(), fallback.Value.WithoutTrivia()));
            var se = MakeSwitchExpression(c, sw.Expression, list);
            StatementSyntax stmt = isReturn
                ? SF.ReturnStatement(se)
                : SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, target!.WithoutTrivia(), se));
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            editor.ReplaceNode(sw, Fmt(stmt.WithTriviaFrom(sw)));
            if (consumed != null) editor.RemoveNode(consumed);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    private static Func<Task<Document>>? SwitchExpressionToStatement(Ctx c)
    {
        var se = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not StatementSyntax).OfType<SwitchExpressionSyntax>().FirstOrDefault();
        if (se == null || c.Span.Start > se.OpenBraceToken.Span.End || HasInnerComments(se)) return null;
        SyntaxNode outer = se;
        while (outer.Parent is ParenthesizedExpressionSyntax) outer = outer.Parent;
        SyntaxNode? host = null;
        ExpressionSyntax? target = null;
        switch (outer.Parent)
        {
            case ReturnStatementSyntax r when r.Parent is BlockSyntax or SwitchSectionSyntax:
                host = r;
                break;
            case AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression, Parent: ExpressionStatementSyntax { Parent: BlockSyntax or SwitchSectionSyntax } es } a
                when a.Right == outer && IsSimpleTarget(a.Left):
                host = es;
                target = a.Left;
                break;
            case ArrowExpressionClauseSyntax when ArrowOwner(c, (ExpressionSyntax)outer) is { } owner:
                host = owner;
                break;
        }
        if (host == null) return null;
        return () =>
        {
            var last = se.Arms.Last();
            if (last.Pattern is not DiscardPatternSyntax || last.WhenClause != null)
                throw new Refusal("NoDefaultArm", "The switch expression has no '_' arm; a switch statement would silently do nothing where the expression throws.");
            StatementSyntax Body(ExpressionSyntax v) => v is ThrowExpressionSyntax t ? SF.ThrowStatement(t.Expression.WithoutTrivia())
                : target == null ? SF.ReturnStatement(v.WithoutTrivia())
                : SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, target.WithoutTrivia(), v.WithoutTrivia()));
            var sections = new List<SwitchSectionSyntax>();
            foreach (var arm in se.Arms)
            {
                SwitchLabelSyntax label = arm == last ? SF.DefaultSwitchLabel() : LabelFor(arm.Pattern.WithoutTrivia(), arm.WhenClause?.WithoutTrivia());
                var stmts = new List<StatementSyntax> { Body(arm.Expression) };
                if (target != null && arm.Expression is not ThrowExpressionSyntax) stmts.Add(SF.BreakStatement());
                sections.Add(SF.SwitchSection(SF.SingletonList(label), SF.List(stmts)));
            }
            var sw = SF.SwitchStatement(se.GoverningExpression.WithoutTrivia(), SF.List(sections));
            return Task.FromResult(c.Doc.WithSyntaxRoot(ReplaceWithStatements(c.Root, host, new[] { (StatementSyntax)sw })));
        };
    }

    // ------------------------------------------------------------------ foreach ↔ LINQ

    private static readonly SpecialType[] Summable = { SpecialType.System_Int32, SpecialType.System_Int64, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal };

    private static bool HasEffects(SyntaxNode n) =>
        n.DescendantNodesAndSelf().Any(x => x is AssignmentExpressionSyntax or AwaitExpressionSyntax or ThrowExpressionSyntax || x.IsKind(SyntaxKind.PreIncrementExpression)
            || x.IsKind(SyntaxKind.PreDecrementExpression) || x.IsKind(SyntaxKind.PostIncrementExpression) || x.IsKind(SyntaxKind.PostDecrementExpression)
            || x is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None } || x is RefExpressionSyntax || x is DeclarationExpressionSyntax
            || x is IsPatternExpressionSyntax ip && ip.Pattern.DescendantNodesAndSelf().Any(p => p is SingleVariableDesignationSyntax));

    private static ExpressionSyntax Receiver(ExpressionSyntax e) => IsPrimary(e) ? e.WithoutTrivia() : SF.ParenthesizedExpression(e.WithoutTrivia());

    private static InvocationExpressionSyntax Call(ExpressionSyntax receiver, string name, params ExpressionSyntax[] args) =>
        SF.InvocationExpression(SF.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, receiver, SF.IdentifierName(name)),
            SF.ArgumentList(SF.SeparatedList(args.Select(SF.Argument))));

    private static Func<Task<Document>>? ForEachLinq(Ctx c)
    {
        var fe = c.Token.Parent?.AncestorsAndSelf().OfType<ForEachStatementSyntax>().FirstOrDefault();
        if (fe == null || c.Span.Start < fe.SpanStart || c.Span.Start > fe.CloseParenToken.Span.End) return null;
        if (!fe.AwaitKeyword.IsKind(SyntaxKind.None) || fe.Type is RefTypeSyntax or ScopedTypeSyntax || HasInnerComments(fe) || fe.Parent is not BlockSyntax) return null;
        var info = c.Model.GetForEachStatementInfo(fe);
        if (info.ElementType == null || !info.ElementConversion.IsIdentity) return null;
        if (c.Model.GetDeclaredSymbol(fe, c.Ct) is not ILocalSymbol loopVar) return null;
        var body = Single(fe.Statement);
        ExpressionSyntax? cond = null;
        if (body is IfStatementSyntax { Else: null } iff)
        {
            cond = iff.Condition;
            body = Single(iff.Statement);
        }
        if (body == null || HasEffects(fe.Expression) || cond != null && HasEffects(cond)) return null;
        var source = Receiver(fe.Expression);
        var name = fe.Identifier.WithoutTrivia();
        LambdaExpressionSyntax Lambda(ExpressionSyntax e) => SF.SimpleLambdaExpression(SF.Parameter(name), e.WithoutTrivia());
        ExpressionSyntax Filtered() => cond == null ? source : Call(source, "Where", Lambda(cond));
        bool IsLoopVar(ExpressionSyntax e) => Bare(e) is IdentifierNameSyntax id && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(id, c.Ct).Symbol, loopVar);
        var next = NextStatement(fe);
        var prev = PreviousStatement(fe);
        ILocalSymbol? PrevLocal(out VariableDeclaratorSyntax? declarator)
        {
            declarator = null;
            if (prev is LocalDeclarationStatementSyntax { UsingKeyword.RawKind: (int)SyntaxKind.None, IsConst: false, Declaration.Variables.Count: 1 } ld && ld.Declaration.Variables[0].Initializer != null && !HasComments(ld))
            {
                declarator = ld.Declaration.Variables[0];
                return c.Model.GetDeclaredSymbol(declarator, c.Ct) as ILocalSymbol;
            }
            return null;
        }
        Func<Task<Document>> Finish(Func<SyntaxEditor, bool> edit) => () =>
        {
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            edit(editor);
            var root = editor.GetChangedRoot();
            return Task.FromResult(Imports(c, fe.SpanStart, "System.Linq", "Enumerable") ? c.Doc.WithSyntaxRoot(root) : WithUsing(c.Doc, root, "System.Linq"));
        };

        switch (body)
        {
            // early return true / false → Any / All; return the element → FirstOrDefault
            case ReturnStatementSyntax { Expression: { } rv } when cond != null && next is ReturnStatementSyntax { Expression: { } after } && !HasComments(next):
            {
                ExpressionSyntax? result = null;
                if (rv.IsKind(SyntaxKind.TrueLiteralExpression) && after.IsKind(SyntaxKind.FalseLiteralExpression)) result = Call(source, "Any", Lambda(cond));
                else if (rv.IsKind(SyntaxKind.FalseLiteralExpression) && after.IsKind(SyntaxKind.TrueLiteralExpression)) result = Call(source, "All", Lambda(Negate(cond, c.Model, c.Ct)));
                else if (IsLoopVar(rv) && (after.IsKind(SyntaxKind.NullLiteralExpression) || after.IsKind(SyntaxKind.DefaultLiteralExpression) || after is DefaultExpressionSyntax))
                    result = Call(source, "FirstOrDefault", Lambda(cond));
                if (result == null) return null;
                return Finish(e =>
                {
                    e.ReplaceNode(fe, Fmt(SF.ReturnStatement(result).WithTriviaFrom(fe)));
                    e.RemoveNode(next);
                    return true;
                });
            }
            // list.Add(x) → Where/Select/ToList (or AddRange)
            case ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax listName, Name.Identifier.ValueText: "Add" }, ArgumentList.Arguments: [{ RefKindKeyword.RawKind: (int)SyntaxKind.None, NameColon: null } arg] } inv }:
            {
                if (c.Model.GetSymbolInfo(inv, c.Ct).Symbol is not IMethodSymbol { ContainingType.OriginalDefinition: { } listType } add
                    || listType.ToDisplayString() != "System.Collections.Generic.List<T>") return null;
                var list = c.Model.GetSymbolInfo(listName, c.Ct).Symbol;
                if (list is not (ILocalSymbol or IFieldSymbol or IParameterSymbol) || Mentions(arg.Expression, list, c.Model, c.Ct) || cond != null && Mentions(cond, list, c.Model, c.Ct) || HasEffects(arg.Expression)) return null;
                var selected = IsLoopVar(arg.Expression) ? Filtered() : Call(Filtered(), "Select", Lambda(arg.Expression));
                var elementType = add.Parameters[0].Type;
                var sameType = SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(arg.Expression, c.Ct).Type, elementType);
                if (sameType && PrevLocal(out var d) is { } local && SymbolEqualityComparer.Default.Equals(local, list)
                    && d!.Initializer!.Value is BaseObjectCreationExpressionSyntax { Initializer: null } oc && (oc.ArgumentList == null || oc.ArgumentList.Arguments.Count == 0)
                    && SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(oc, c.Ct).Type, add.ContainingType))
                {
                    return Finish(e =>
                    {
                        e.ReplaceNode(d.Initializer.Value, Fmt(Call(selected, "ToList").WithTriviaFrom(d.Initializer.Value)));
                        e.RemoveNode(fe);
                        return true;
                    });
                }
                return Finish(e =>
                {
                    e.ReplaceNode(fe, Fmt(SF.ExpressionStatement(Call(listName.WithoutTrivia(), "AddRange", selected)).WithTriviaFrom(fe)));
                    return true;
                });
            }
            // counter++ → Count; total += x → Sum
            case ExpressionStatementSyntax { Expression: var ex }:
            {
                ExpressionSyntax? targetExpr = null;
                ExpressionSyntax? added = null;
                switch (ex)
                {
                    case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.PostIncrementExpression } pu: targetExpr = pu.Operand; break;
                    case PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.PreIncrementExpression } pr: targetExpr = pr.Operand; break;
                    case AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.AddAssignmentExpression } aa:
                        targetExpr = aa.Left;
                        if (c.Model.GetConstantValue(aa.Right, c.Ct) is not { HasValue: true, Value: 1 }) added = aa.Right;
                        break;
                }
                if (targetExpr is not IdentifierNameSyntax tid || c.Model.GetSymbolInfo(tid, c.Ct).Symbol is not (ILocalSymbol or IFieldSymbol) || c.Model.GetTypeInfo(tid, c.Ct).Type is not { } tt) return null;
                var target = c.Model.GetSymbolInfo(tid, c.Ct).Symbol!;
                if (c.Model.GetSymbolInfo(ex, c.Ct).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator }) return null;
                if (cond != null && Mentions(cond, target, c.Model, c.Ct)) return null;
                ExpressionSyntax value;
                if (added == null)
                {
                    if (tt.SpecialType is not (SpecialType.System_Int32 or SpecialType.System_Int64)) return null;
                    value = cond == null ? Call(source, "Count") : Call(source, "Count", Lambda(cond));
                }
                else
                {
                    if (HasEffects(added) || Mentions(added, target, c.Model, c.Ct) || !Summable.Contains(tt.SpecialType)
                        || !SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(added, c.Ct).Type, tt)) return null;
                    value = IsLoopVar(added) ? Call(Filtered(), "Sum") : Call(Filtered(), "Sum", Lambda(added));
                }
                if (PrevLocal(out var d) is { } local && SymbolEqualityComparer.Default.Equals(local, target)
                    && c.Model.GetConstantValue(d!.Initializer!.Value, c.Ct) is { HasValue: true } zero && Convert.ToDecimal(zero.Value, System.Globalization.CultureInfo.InvariantCulture) == 0m
                    && (added != null || tt.SpecialType == SpecialType.System_Int32 || ((LocalDeclarationStatementSyntax)prev!).Declaration.Type is not { IsVar: true }))
                {
                    return Finish(e =>
                    {
                        e.ReplaceNode(d.Initializer.Value, Fmt(value.WithTriviaFrom(d.Initializer.Value)));
                        e.RemoveNode(fe);
                        return true;
                    });
                }
                return Finish(e =>
                {
                    e.ReplaceNode(fe, Fmt(SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.AddAssignmentExpression, tid.WithoutTrivia(), value)).WithTriviaFrom(fe)));
                    return true;
                });
            }
        }
        return null;
    }

    private static readonly HashSet<string> LinqTerminals = new(StringComparer.Ordinal) { "Any", "All", "FirstOrDefault", "Count", "Sum", "ToList" };

    private static Func<Task<Document>>? LinqForEach(Ctx c)
    {
        var stmtOrArrow = c.Token.Parent?.AncestorsAndSelf().FirstOrDefault(a => a is StatementSyntax or ArrowExpressionClauseSyntax or MemberDeclarationSyntax);
        ExpressionSyntax? value = null;
        SyntaxNode? host = null;
        VariableDeclaratorSyntax? declarator = null;
        switch (stmtOrArrow)
        {
            case ReturnStatementSyntax { Expression: { } r } rs when rs.Parent is BlockSyntax:
                value = r; host = rs; break;
            case ArrowExpressionClauseSyntax arrow when ArrowOwner(c, arrow.Expression) is { } owner:
                value = arrow.Expression; host = owner; break;
            case LocalDeclarationStatementSyntax { IsConst: false, UsingKeyword.RawKind: (int)SyntaxKind.None, Declaration.Variables: [{ Initializer.Value: { } init } v] } ld when ld.Parent is BlockSyntax:
                value = init; host = ld; declarator = v; break;
        }
        if (value == null || host == null || !value.Span.Contains(c.Span.Start) || HasInnerComments(value)) return null;
        // source.[Where(p)].[Select(s)].Terminal(arg?)
        if (Bare(value) is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax tm } terminal || !LinqTerminals.Contains(tm.Name.Identifier.ValueText)) return null;
        IMethodSymbol? Linq(InvocationExpressionSyntax inv) =>
            c.Model.GetSymbolInfo(inv, c.Ct).Symbol is IMethodSymbol { ReducedFrom: { ContainingType: { } t } } m && t.ToDisplayString() == "System.Linq.Enumerable" ? m : null;
        if (Linq(terminal) is not { } terminalMethod) return null;
        var name = tm.Name.Identifier.ValueText;
        ExpressionSyntax receiver = tm.Expression;
        LambdaExpressionSyntax? select = null, where = null;
        if (receiver is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Select" } sm, ArgumentList.Arguments: [{ Expression: LambdaExpressionSyntax sl }] } si
            && Linq(si) != null && name is "ToList" or "Sum")
        {
            select = sl;
            receiver = sm.Expression;
        }
        if (receiver is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Where" } wm, ArgumentList.Arguments: [{ Expression: LambdaExpressionSyntax wl }] } wi
            && Linq(wi) != null)
        {
            where = wl;
            receiver = wm.Expression;
        }
        var terminalArg = terminal.ArgumentList.Arguments.Count == 1 ? terminal.ArgumentList.Arguments[0].Expression as LambdaExpressionSyntax : null;
        if (terminal.ArgumentList.Arguments.Count > (terminalArg != null ? 1 : 0)) return null;
        if (name is "Any" or "All" or "FirstOrDefault")
        {
            if (terminalArg == null || where != null || declarator != null) return null;
            where = terminalArg;
        }
        else if (declarator == null) return null;
        else if (name == "Count")
        {
            if (terminalArg != null && where != null) return null;
            where ??= terminalArg;
        }
        else if (name == "Sum")
        {
            if (terminalArg != null && select != null) return null;
            select ??= terminalArg;
        }
        else if (terminalArg != null) return null;
        var lambdas = new[] { where, select }.Where(l => l != null).Cast<LambdaExpressionSyntax>().ToList();
        if (lambdas.Count == 0) return null;
        static ParameterSyntax? Param(LambdaExpressionSyntax l) => l switch
        {
            SimpleLambdaExpressionSyntax s => s.Parameter,
            ParenthesizedLambdaExpressionSyntax { ParameterList.Parameters: [var p] } => p,
            _ => null,
        };
        if (lambdas.Any(l => l.ExpressionBody == null || Param(l) == null || !l.AsyncKeyword.IsKind(SyntaxKind.None) || HasEffects(l.ExpressionBody))) return null;
        var loopName = Param(lambdas[0])!.Identifier.ValueText;
        ExpressionSyntax BodyOf(LambdaExpressionSyntax l)
        {
            var p = c.Model.GetDeclaredSymbol(Param(l)!, c.Ct);
            var refs = l.ExpressionBody!.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
                .Where(i => SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(i, c.Ct).Symbol, p)).ToList();
            return l.ExpressionBody!.ReplaceNodes(refs, (o, _) => SF.IdentifierName(loopName).WithTriviaFrom(o)).WithoutTrivia();
        }
        var source = receiver.WithoutTrivia();
        return () =>
        {
            if (HasEffects(source)) throw new Refusal("SideEffects", "The source of the query has side effects.");
            var cond = where == null ? null : BodyOf(where);
            var sel = select == null ? null : BodyOf(select);
            StatementSyntax Guard(StatementSyntax s) => cond == null ? s : SF.IfStatement(cond, SF.Block(s));
            ForEachStatementSyntax Loop(StatementSyntax inner) =>
                SF.ForEachStatement(SF.IdentifierName("var"), SF.Identifier(loopName), source, SF.Block(inner));
            var stmts = new List<StatementSyntax>();
            switch (name)
            {
                case "Any":
                    stmts.Add(Loop(Guard(SF.ReturnStatement(SF.LiteralExpression(SyntaxKind.TrueLiteralExpression)))));
                    stmts.Add(SF.ReturnStatement(SF.LiteralExpression(SyntaxKind.FalseLiteralExpression)));
                    break;
                case "All":
                    stmts.Add(Loop(SF.IfStatement(Negate(where!.ExpressionBody!, c.Model, c.Ct), SF.Block(SF.ReturnStatement(SF.LiteralExpression(SyntaxKind.FalseLiteralExpression))))));
                    stmts.Add(SF.ReturnStatement(SF.LiteralExpression(SyntaxKind.TrueLiteralExpression)));
                    break;
                case "FirstOrDefault":
                    stmts.Add(Loop(Guard(SF.ReturnStatement(SF.IdentifierName(loopName)))));
                    stmts.Add(SF.ReturnStatement(SF.LiteralExpression(SyntaxKind.DefaultLiteralExpression, SF.Token(SyntaxKind.DefaultKeyword))));
                    break;
                default:
                {
                    var ld = (LocalDeclarationStatementSyntax)host;
                    var resultType = c.Model.GetTypeInfo(value, c.Ct).Type!;
                    var counter = SF.IdentifierName(declarator!.Identifier.WithoutTrivia());
                    ExpressionSyntax init;
                    StatementSyntax step;
                    var declType = ld.Declaration.Type;
                    if (name == "ToList")
                    {
                        var shown = DisplayLocalType(c, resultType, ld.SpanStart) ?? throw new Refusal("AnonymousType", "The list's element type cannot be written.");
                        init = SF.ObjectCreationExpression(SF.ParseTypeName(shown), SF.ArgumentList(), null);
                        step = SF.ExpressionStatement(Call(counter, "Add", sel ?? SF.IdentifierName(loopName)));
                    }
                    else
                    {
                        if (!Summable.Contains(resultType.SpecialType)) throw new Refusal("NotApplicable", "Only int, long, float, double and decimal results are converted.");
                        init = SF.LiteralExpression(SyntaxKind.NumericLiteralExpression, SF.Literal(0));
                        step = name == "Count"
                            ? SF.ExpressionStatement(SF.PostfixUnaryExpression(SyntaxKind.PostIncrementExpression, counter))
                            : SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.AddAssignmentExpression, counter, sel ?? SF.IdentifierName(loopName)));
                        if (declType.IsVar && resultType.SpecialType != SpecialType.System_Int32)
                            declType = SF.ParseTypeName(DisplayLocalType(c, resultType, ld.SpanStart)!).WithTriviaFrom(declType);
                    }
                    stmts.Add(ld.WithDeclaration(ld.Declaration.WithType(declType).WithVariables(SF.SingletonSeparatedList(declarator.WithInitializer(SF.EqualsValueClause(init))))).WithoutTrivia());
                    stmts.Add(Loop(Guard(step)));
                    break;
                }
            }
            return Task.FromResult(c.Doc.WithSyntaxRoot(ReplaceWithStatements(c.Root, host, stmts)));
        };
    }

    // ------------------------------------------------------------------ interpolated string ↔ string.Format

    private static Func<Task<Document>>? InterpolatedToFormat(Ctx c)
    {
        var ise = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not StatementSyntax).OfType<InterpolatedStringExpressionSyntax>().FirstOrDefault();
        if (ise == null || HasInnerComments(ise)) return null;
        var verbatim = ise.StringStartToken.IsKind(SyntaxKind.InterpolatedVerbatimStringStartToken);
        if (!verbatim && !ise.StringStartToken.IsKind(SyntaxKind.InterpolatedStringStartToken)) return null;
        if (!ise.Contents.OfType<InterpolationSyntax>().Any()) return null;
        if (c.Model.GetTypeInfo(ise, c.Ct).ConvertedType?.SpecialType != SpecialType.System_String || c.Model.GetConstantValue(ise, c.Ct).HasValue) return null;
        var sb = new System.Text.StringBuilder(verbatim ? "string.Format(@\"" : "string.Format(\"");
        var args = new List<string>();
        foreach (var part in ise.Contents)
        {
            if (part is InterpolatedStringTextSyntax t)
            {
                sb.Append(t.TextToken.Text);
                continue;
            }
            var i = (InterpolationSyntax)part;
            sb.Append('{').Append(args.Count);
            if (i.AlignmentClause != null)
            {
                if (c.Model.GetConstantValue(i.AlignmentClause.Value, c.Ct) is not { HasValue: true, Value: int align }) return null;
                sb.Append(',').Append(align.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            if (i.FormatClause != null) sb.Append(':').Append(i.FormatClause.FormatStringToken.Text);
            sb.Append('}');
            args.Add(i.Expression.WithoutTrivia().ToString());
        }
        sb.Append('"');
        foreach (var a in args) sb.Append(", ").Append(a);
        sb.Append(')');
        return Replace(c, ise, SF.ParseExpression(sb.ToString()).WithTriviaFrom(ise));
    }

    private static Func<Task<Document>>? FormatToInterpolatedString(Ctx c)
    {
        var inv = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not StatementSyntax).OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(i => c.Model.GetSymbolInfo(i, c.Ct).Symbol is IMethodSymbol { Name: "Format", IsStatic: true, ContainingType.SpecialType: SpecialType.System_String });
        if (inv == null || HasInnerComments(inv)) return null;
        var m = (IMethodSymbol)c.Model.GetSymbolInfo(inv, c.Ct).Symbol!;
        var args = inv.ArgumentList.Arguments;
        if (m.Parameters.Length == 0 || m.Parameters[0].Type.SpecialType != SpecialType.System_String || args.Count < 2) return null;
        if (args.Any(a => a.NameColon != null || !a.RefKindKeyword.IsKind(SyntaxKind.None))) return null;
        if (args[0].Expression is not LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } lit) return null;
        var tokenText = lit.Token.Text;
        var verbatim = tokenText.StartsWith("@\"", StringComparison.Ordinal);
        if (!verbatim && !tokenText.StartsWith('"')) return null;
        if (args.Count == 2 && c.Model.GetTypeInfo(args[1].Expression, c.Ct).Type is IArrayTypeSymbol) return null;
        var fmt = tokenText.Substring(verbatim ? 2 : 1, tokenText.Length - (verbatim ? 3 : 2));
        var values = args.Skip(1).Select(a => a.Expression).ToList();
        var sb = new System.Text.StringBuilder(verbatim ? "$@\"" : "$\"");
        var used = new List<int>();
        for (var i = 0; i < fmt.Length; i++)
        {
            var ch = fmt[i];
            if (ch == '{' && i + 1 < fmt.Length && fmt[i + 1] == '{') { sb.Append("{{"); i++; continue; }
            if (ch == '}' && i + 1 < fmt.Length && fmt[i + 1] == '}') { sb.Append("}}"); i++; continue; }
            if (ch == '}') return null;
            if (ch != '{') { sb.Append(ch); continue; }
            var end = fmt.IndexOf('}', i);
            if (end < 0) return null;
            var hole = fmt.Substring(i + 1, end - i - 1);
            i = end;
            string? spec = null, align = null;
            var colon = hole.IndexOf(':');
            if (colon >= 0) { spec = hole[(colon + 1)..]; hole = hole[..colon]; }
            var comma = hole.IndexOf(',');
            if (comma >= 0) { align = hole[(comma + 1)..].Trim(); hole = hole[..comma]; }
            if (!int.TryParse(hole.Trim(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var index) || index >= values.Count) return null;
            if (align != null && !int.TryParse(align, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out _)) return null;
            if (spec != null && spec.Contains('{')) return null;
            used.Add(index);
            var e = values[index].WithoutTrivia();
            var needs = e is ConditionalExpressionSyntax || e.DescendantTokens().Any(k => k.IsKind(SyntaxKind.ColonColonToken) || k.IsKind(SyntaxKind.ColonToken))
                || verbatim && e.DescendantTokens().Any(k => k.IsKind(SyntaxKind.StringLiteralToken));
            sb.Append('{').Append(needs ? "(" + e + ")" : e.ToString());
            if (align != null) sb.Append(',').Append(align);
            if (spec != null) sb.Append(':').Append(spec);
            sb.Append('}');
        }
        sb.Append('"');
        var inOrder = used.SequenceEqual(Enumerable.Range(0, values.Count));
        return () =>
        {
            if (!inOrder && values.Any(v => !CodeFacts.IsSideEffectFree(v, c.Model, c.Ct)))
                throw new Refusal("EvaluationOrder", "The arguments are not used exactly once in order and some may have side effects; an interpolated string would evaluate them differently.");
            return Replace(c, inv, SF.ParseExpression(sb.ToString()).WithTriviaFrom(inv))();
        };
    }

    // ------------------------------------------------------------------ constructor ↔ primary constructor

    private static bool SupportsPrimaryConstructors(Ctx c) =>
        c.Root.SyntaxTree.Options is CSharpParseOptions o && o.LanguageVersion >= LanguageVersion.CSharp12;

    /// <summary>The token right before the type's '{' header end where a parameter list goes (identifier or '&gt;').</summary>
    private static Func<Task<Document>>? ToPrimary(Ctx c)
    {
        if (c.Token.Parent is not ConstructorDeclarationSyntax ctor || c.Token != ctor.Identifier || ctor.Modifiers.Any(SyntaxKind.StaticKeyword)) return null;
        if (ctor.Parent is not (ClassDeclarationSyntax or StructDeclarationSyntax) || ctor.Parent is TypeDeclarationSyntax { ParameterList: not null } || !SupportsPrimaryConstructors(c)) return null;
        var type = (TypeDeclarationSyntax)ctor.Parent;
        return () =>
        {
            var typeSymbol = c.Model.GetDeclaredSymbol(type, c.Ct)!;
            if (typeSymbol.DeclaringSyntaxReferences.Length > 1) throw new Refusal("PartialType", "The type is declared in several parts.");
            if (HasComments(ctor) || ctor.AttributeLists.Count > 0) throw new Refusal("Comments", "The constructor has comments or attributes that would be lost.");
            var publicLike = ctor.Modifiers.Count == 1 && (ctor.Modifiers[0].IsKind(SyntaxKind.PublicKeyword) || ctor.Modifiers[0].IsKind(SyntaxKind.ProtectedKeyword) && type.Modifiers.Any(SyntaxKind.AbstractKeyword));
            if (!publicLike) throw new Refusal("Accessibility", "Only a public constructor (or a protected one of an abstract class) can become the primary constructor.");
            foreach (var other in type.Members.OfType<ConstructorDeclarationSyntax>().Where(o => o != ctor && !o.Modifiers.Any(SyntaxKind.StaticKeyword)))
                if (other.Initializer is not { RawKind: (int)SyntaxKind.ThisConstructorInitializer })
                    throw new Refusal("OtherConstructors", "Another constructor does not chain to 'this(...)'; with a primary constructor every other constructor must.");
            if (ctor.Initializer is { RawKind: (int)SyntaxKind.ThisConstructorInitializer })
                throw new Refusal("ConstructorChain", "The constructor calls 'this(...)'.");
            if (ctor.ParameterList.Parameters.Any(p => p.Modifiers.Any(m => !m.IsKind(SyntaxKind.ParamsKeyword))))
                throw new Refusal("ParameterModifiers", "ref, out, in and this parameters are not converted.");
            var paramSymbols = ctor.ParameterList.Parameters.Select(p => c.Model.GetDeclaredSymbol(p, c.Ct)!).ToList();
            var memberNames = typeSymbol.GetMembers().Select(s => s.Name).ToHashSet(StringComparer.Ordinal);
            if (paramSymbols.FirstOrDefault(p => memberNames.Contains(p.Name)) is { } clash)
                throw new Refusal("NameClash", $"The parameter '{clash.Name}' has the name of a member; in a primary constructor it would hide it.");
            var statements = ctor.Body?.Statements.ToList()
                ?? (ctor.ExpressionBody != null ? new List<StatementSyntax> { SF.ExpressionStatement(ctor.ExpressionBody.Expression) } : new List<StatementSyntax>());
            var inits = new List<(SyntaxNode Member, string Param)>();
            foreach (var s in statements)
            {
                if (s is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a }
                    || a.Left is not (IdentifierNameSyntax or MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax })
                    || a.Right is not IdentifierNameSyntax pr || c.Model.GetSymbolInfo(pr, c.Ct).Symbol is not IParameterSymbol ps || !paramSymbols.Contains(ps, SymbolEqualityComparer.Default))
                    throw new Refusal("ConstructorLogic", "The constructor does more than assign parameters to fields or properties.");
                var target = c.Model.GetSymbolInfo(a.Left, c.Ct).Symbol;
                if (target is not (IFieldSymbol or IPropertySymbol) || target.IsStatic || !SymbolEqualityComparer.Default.Equals(target.ContainingType, typeSymbol))
                    throw new Refusal("ConstructorLogic", "The constructor assigns something other than a field or property of this type.");
                var decl = target.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(c.Ct);
                switch (decl)
                {
                    case VariableDeclaratorSyntax { Initializer: null } vd when vd.SyntaxTree == type.SyntaxTree:
                        inits.Add((vd, pr.Identifier.ValueText)); break;
                    case PropertyDeclarationSyntax { Initializer: null, AccessorList: { } al } pd when pd.SyntaxTree == type.SyntaxTree && al.Accessors.All(x => x.Body == null && x.ExpressionBody == null):
                        inits.Add((pd, pr.Identifier.ValueText)); break;
                    default:
                        throw new Refusal("ConstructorLogic", $"'{target.Name}' already has an initializer or is not an auto-property.");
                }
                if (inits.Count(i => i.Member == inits[^1].Member) > 1) throw new Refusal("ConstructorLogic", $"'{target.Name}' is assigned twice.");
            }
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var (member, param) in inits)
            {
                var eq = SF.EqualsValueClause(SF.IdentifierName(param));
                if (member is VariableDeclaratorSyntax vd) editor.ReplaceNode(vd, Fmt(vd.WithInitializer(eq)));
                else
                {
                    var pd = (PropertyDeclarationSyntax)member;
                    editor.ReplaceNode(pd, Fmt(pd.WithInitializer(eq).WithSemicolonToken(SF.Token(SyntaxKind.SemicolonToken)).WithTrailingTrivia(pd.GetTrailingTrivia())));
                }
            }
            if (ctor.Initializer is { } baseInit)
            {
                if (type.BaseList?.Types.FirstOrDefault() is not SimpleBaseTypeSyntax first
                    || !SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(first.Type, c.Ct).Type, typeSymbol.BaseType))
                    throw new Refusal("BaseCall", "The base constructor call cannot be moved to the base list.");
                editor.ReplaceNode(first, Fmt(SF.PrimaryConstructorBaseType(first.Type.WithoutTrailingTrivia(), baseInit.ArgumentList.WithoutTrivia()).WithTriviaFrom(first)));
            }
            editor.RemoveNode(ctor);
            editor.ReplaceNode(type, (cur, _) =>
            {
                var t = (TypeDeclarationSyntax)cur;
                var pl = ctor.ParameterList.WithoutTrivia();
                if (t.TypeParameterList is { } tpl)
                    return Fmt(t.WithTypeParameterList(tpl.WithGreaterThanToken(tpl.GreaterThanToken.WithTrailingTrivia())).WithParameterList(pl.WithTrailingTrivia(tpl.GreaterThanToken.TrailingTrivia)));
                return t.WithIdentifier(t.Identifier.WithTrailingTrivia()).WithParameterList(Fmt(pl.WithTrailingTrivia(t.Identifier.TrailingTrivia)));
            });
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    private static Func<Task<Document>>? FromPrimary(Ctx c)
    {
        var type = c.Token.Parent?.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().FirstOrDefault();
        if (type is not (ClassDeclarationSyntax or StructDeclarationSyntax) || type.ParameterList is not { } plist) return null;
        if (c.Token != type.Identifier && !plist.Span.Contains(c.Span.Start)) return null;
        if (HasInnerComments(plist)) return null;
        return () =>
        {
            var typeSymbol = c.Model.GetDeclaredSymbol(type, c.Ct)!;
            if (typeSymbol.DeclaringSyntaxReferences.Length > 1) throw new Refusal("PartialType", "The type is declared in several parts.");
            var parameters = plist.Parameters.Select(p => c.Model.GetDeclaredSymbol(p, c.Ct)!).ToList();
            var refs = type.Members.SelectMany(m => m.DescendantNodes()).OfType<IdentifierNameSyntax>()
                .Select(i => (Id: i, P: c.Model.GetSymbolInfo(i, c.Ct).Symbol as IParameterSymbol))
                .Where(x => x.P != null && parameters.Contains(x.P, SymbolEqualityComparer.Default)).ToList();
            var initMembers = new List<SyntaxNode>();
            var captured = new List<(IdentifierNameSyntax Id, IParameterSymbol P)>();
            foreach (var (id, p) in refs)
            {
                var owner = id.Ancestors().FirstOrDefault(a => a is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } or PropertyDeclarationSyntax }
                    || a is MemberDeclarationSyntax);
                if (owner is EqualsValueClauseSyntax eq)
                {
                    if (!initMembers.Contains(eq.Parent!)) initMembers.Add(eq.Parent!);
                }
                else captured.Add((id, p!));
            }
            var fieldNames = new Dictionary<IParameterSymbol, string>(SymbolEqualityComparer.Default);
            foreach (var p in captured.Select(x => x.P).Distinct(SymbolEqualityComparer.Default).Cast<IParameterSymbol>())
            {
                var fname = "_" + p.Name;
                if (typeSymbol.GetMembers(fname).Any() || !c.Model.LookupSymbols(type.OpenBraceToken.Span.End, name: fname).IsEmpty)
                    throw new Refusal("NameClash", $"A field '{fname}' for the captured parameter '{p.Name}' would clash with an existing name.");
                fieldNames[p] = fname;
            }
            var paramNames = parameters.Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
            var body = new List<StatementSyntax>();
            ExpressionSyntax Target(string n) => paramNames.Contains(n)
                ? SF.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, SF.ThisExpression(), SF.IdentifierName(n)) : SF.IdentifierName(n);
            foreach (var (p, f) in fieldNames)
                body.Add(SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, SF.IdentifierName(f), SF.IdentifierName(p.Name))));
            foreach (var m in initMembers.OrderBy(n => n.SpanStart))
            {
                var (n, v) = m switch
                {
                    VariableDeclaratorSyntax vd => (vd.Identifier.ValueText, vd.Initializer!.Value),
                    PropertyDeclarationSyntax pd => (pd.Identifier.ValueText, pd.Initializer!.Value),
                    _ => throw new Refusal("NotApplicable", "Unsupported member."),
                };
                body.Add(SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, Target(n), v.WithoutTrivia())));
            }
            var writtenParams = captured.Where(x => IsWritten(x.Id)).Select(x => x.P).ToList();
            var replaced = type.ReplaceNodes(
                captured.Select(x => (SyntaxNode)x.Id).Concat(initMembers),
                (orig, cur) => cur switch
                {
                    IdentifierNameSyntax id => SF.IdentifierName(fieldNames[captured.First(x => x.Id == orig).P]).WithTriviaFrom(id),
                    VariableDeclaratorSyntax vd => vd.WithInitializer(null).WithIdentifier(vd.Identifier.WithTrailingTrivia()),
                    PropertyDeclarationSyntax pd => pd.WithInitializer(null).WithSemicolonToken(default).WithAccessorList(pd.AccessorList!.WithTrailingTrivia(pd.SemicolonToken.TrailingTrivia)),
                    _ => cur,
                });
            ConstructorInitializerSyntax? baseInit = null;
            if (replaced.BaseList?.Types.FirstOrDefault() is PrimaryConstructorBaseTypeSyntax pb)
            {
                baseInit = SF.ConstructorInitializer(SyntaxKind.BaseConstructorInitializer, pb.ArgumentList.WithoutTrivia());
                replaced = replaced.ReplaceNode(pb, SF.SimpleBaseType(pb.Type).WithTriviaFrom(pb));
            }
            var ctor = Fmt(SF.ConstructorDeclaration(type.Identifier.WithoutTrivia())
                .WithModifiers(SF.TokenList(SF.Token(type.Modifiers.Any(SyntaxKind.AbstractKeyword) ? SyntaxKind.ProtectedKeyword : SyntaxKind.PublicKeyword)))
                .WithParameterList(plist.WithoutTrivia())
                .WithInitializer(baseInit)
                .WithBody(SF.Block(body)));
            var newFields = fieldNames.Select(kv =>
            {
                var mods = new List<SyntaxToken> { SF.Token(SyntaxKind.PrivateKeyword) };
                if (!writtenParams.Contains(kv.Key, SymbolEqualityComparer.Default)) mods.Add(SF.Token(SyntaxKind.ReadOnlyKeyword));
                var shown = kv.Key.Type.ToMinimalDisplayString(c.Model, type.SpanStart, TypeFormat);
                return (MemberDeclarationSyntax)Fmt(SF.FieldDeclaration(SF.VariableDeclaration(SF.ParseTypeName(shown), SF.SingletonSeparatedList(SF.VariableDeclarator(kv.Value)))).WithModifiers(SF.TokenList(mods)));
            }).ToList();
            var members = replaced.Members.ToList();
            var lastField = members.FindLastIndex(m => m is FieldDeclarationSyntax);
            members.InsertRange(lastField + 1, newFields.Append(ctor));
            var closeTrivia = plist.CloseParenToken.TrailingTrivia;
            var result = replaced.WithParameterList(null).WithMembers(SF.List(members));
            result = result.TypeParameterList is { } tpl
                ? result.WithTypeParameterList(tpl.WithGreaterThanToken(tpl.GreaterThanToken.WithTrailingTrivia(closeTrivia)))
                : result.WithIdentifier(result.Identifier.WithTrailingTrivia(closeTrivia));
            return Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(type, result)));
        };
    }

    // ------------------------------------------------------------------ class ↔ record

    private static async Task RefuseDerivedAsync(Ctx c, INamedTypeSymbol t)
    {
        var derived = await SymbolFinder.FindDerivedClassesAsync(t, c.Doc.Project.Solution, transitive: false, cancellationToken: c.Ct).ConfigureAwait(false);
        if (derived.Any()) throw new Refusal("DerivedTypes", $"'{t.Name}' has derived types ({string.Join(", ", derived.Take(3).Select(d => d.Name))}) that would have to change too.");
    }

    private static Func<Task<Document>>? ClassRecord(Ctx c)
    {
        if (c.Token.Parent is not ClassDeclarationSyntax cls || c.Token != cls.Identifier || cls.ParameterList != null
            || cls.Modifiers.Any(SyntaxKind.StaticKeyword) || cls.Modifiers.Any(SyntaxKind.PartialKeyword)) return null;
        return async () =>
        {
            var t = c.Model.GetDeclaredSymbol(cls, c.Ct)!;
            if (t.BaseType is { SpecialType: not SpecialType.System_Object })
                throw new Refusal("BaseClass", $"'{t.Name}' derives from '{t.BaseType.Name}'; a record can only derive from another record.");
            if (t.GetMembers().Any(m => m is IMethodSymbol { Name: "Equals" or "GetHashCode" or "op_Equality" or "op_Inequality", IsImplicitlyDeclared: false }))
                throw new Refusal("CustomEquality", $"'{t.Name}' defines its own equality (Equals, GetHashCode or ==); a record generates these.");
            var mutable = t.GetMembers().FirstOrDefault(m => !m.IsStatic && !m.IsImplicitlyDeclared
                && (m is IFieldSymbol { IsReadOnly: false, IsConst: false, AssociatedSymbol: null } || m is IPropertySymbol { SetMethod: { IsInitOnly: false } }));
            if (mutable != null)
                throw new Refusal("MutableState", $"'{mutable.Name}' can change after construction; a record's value equality and hash code would change with it (a problem for dictionary keys and sets).");
            await RefuseDerivedAsync(c, t).ConfigureAwait(false);
            var rec = SF.RecordDeclaration(SyntaxKind.RecordDeclaration, cls.AttributeLists, cls.Modifiers, SF.Token(SyntaxKind.RecordKeyword).WithTriviaFrom(cls.Keyword), default,
                cls.Identifier, cls.TypeParameterList, null, cls.BaseList, cls.ConstraintClauses, cls.OpenBraceToken, cls.Members, cls.CloseBraceToken, cls.SemicolonToken);
            return c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(cls, rec));
        };
    }

    private static Func<Task<Document>>? RecordClass(Ctx c)
    {
        if (c.Token.Parent is not RecordDeclarationSyntax rec || c.Token != rec.Identifier || !rec.IsKind(SyntaxKind.RecordDeclaration)) return null;
        return async () =>
        {
            if (rec.ParameterList != null) throw new Refusal("PositionalRecord", "A positional record generates properties and Deconstruct; it is not converted.");
            var t = c.Model.GetDeclaredSymbol(rec, c.Ct)!;
            if (t.DeclaringSyntaxReferences.Length > 1) throw new Refusal("PartialType", "The record is declared in several parts.");
            if (t.BaseType is { SpecialType: not SpecialType.System_Object })
                throw new Refusal("BaseRecord", $"'{t.Name}' derives from the record '{t.BaseType.Name}'.");
            foreach (var n in c.Root.DescendantNodes())
            {
                switch (n)
                {
                    case WithExpressionSyntax w when SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(w.Expression, c.Ct).Type, t):
                        throw new Refusal("RecordFeatures", $"'{t.Name}' is used in a 'with' expression (line {w.GetLocation().GetLineSpan().StartLinePosition.Line + 1}); a class has no 'with'.");
                    case BinaryExpressionSyntax b when (b.IsKind(SyntaxKind.EqualsExpression) || b.IsKind(SyntaxKind.NotEqualsExpression))
                        && c.Model.GetSymbolInfo(b, c.Ct).Symbol is IMethodSymbol { ContainingType: { } ct2 } && SymbolEqualityComparer.Default.Equals(ct2, t):
                    case InvocationExpressionSyntax inv when c.Model.GetSymbolInfo(inv, c.Ct).Symbol is IMethodSymbol { Name: "Equals" or "GetHashCode" } em
                        && SymbolEqualityComparer.Default.Equals(em.ContainingType, t):
                        throw new Refusal("RecordFeatures", $"'{t.Name}' is compared by value (line {n.GetLocation().GetLineSpan().StartLinePosition.Line + 1}); a class compares references.");
                    case RecursivePatternSyntax { PositionalPatternClause: not null } rp when SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(rp, c.Ct).ConvertedType, t):
                        throw new Refusal("RecordFeatures", $"'{t.Name}' is deconstructed (line {rp.GetLocation().GetLineSpan().StartLinePosition.Line + 1}).");
                }
            }
            await RefuseDerivedAsync(c, t).ConfigureAwait(false);
            var keyword = SF.Token(SyntaxKind.ClassKeyword).WithLeadingTrivia(rec.Keyword.LeadingTrivia)
                .WithTrailingTrivia(rec.ClassOrStructKeyword.IsKind(SyntaxKind.None) ? rec.Keyword.TrailingTrivia : rec.ClassOrStructKeyword.TrailingTrivia);
            var open = rec.OpenBraceToken.IsKind(SyntaxKind.None) ? SF.Token(SyntaxKind.OpenBraceToken) : rec.OpenBraceToken;
            var close = rec.CloseBraceToken.IsKind(SyntaxKind.None) ? SF.Token(SyntaxKind.CloseBraceToken).WithTrailingTrivia(rec.SemicolonToken.TrailingTrivia) : rec.CloseBraceToken;
            var cls = SF.ClassDeclaration(rec.AttributeLists, rec.Modifiers, keyword, rec.Identifier, rec.TypeParameterList, null, rec.BaseList, rec.ConstraintClauses, open, rec.Members, close, default);
            return c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(rec, rec.OpenBraceToken.IsKind(SyntaxKind.None) ? Fmt(cls) : cls));
        };
    }

    // ------------------------------------------------------------------ auto-property ↔ backing field

    private static bool IsAuto(PropertyDeclarationSyntax p) =>
        p.AccessorList is { } al && al.Accessors.Count > 0 && al.Accessors.All(a => a.Body == null && a.ExpressionBody == null)
        && al.Accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration))
        && !p.Modifiers.Any(m => m.IsKind(SyntaxKind.AbstractKeyword) || m.IsKind(SyntaxKind.ExternKeyword) || m.IsKind(SyntaxKind.PartialKeyword))
        && p.Parent is ClassDeclarationSyntax or StructDeclarationSyntax or RecordDeclarationSyntax;

    private static string FieldNameFor(string property) => "_" + char.ToLowerInvariant(property[0]) + property[1..];

    private static Func<Task<Document>>? AutoToFull(Ctx c)
    {
        if (c.Token.Parent is not PropertyDeclarationSyntax prop || c.Token != prop.Identifier || !IsAuto(prop)) return null;
        if (prop.AttributeLists.Any(l => l.Target?.Identifier.IsKind(SyntaxKind.FieldKeyword) == true)) return null;
        return () =>
        {
            var symbol = c.Model.GetDeclaredSymbol(prop, c.Ct)!;
            var type = symbol.ContainingType;
            var fname = FieldNameFor(prop.Identifier.ValueText);
            if (type.GetMembers(fname).Any() || !c.Model.LookupSymbols(prop.SpanStart, name: fname).IsEmpty)
                throw new Refusal("NameClash", $"The name '{fname}' for the backing field is already used.");
            var accessors = prop.AccessorList!.Accessors;
            var hasSet = accessors.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));
            var mods = new List<SyntaxToken> { SF.Token(SyntaxKind.PrivateKeyword) };
            if (symbol.IsStatic) mods.Add(SF.Token(SyntaxKind.StaticKeyword));
            if (!hasSet) mods.Add(SF.Token(SyntaxKind.ReadOnlyKeyword));
            var declarator = SF.VariableDeclarator(fname);
            if (prop.Initializer != null) declarator = declarator.WithInitializer(prop.Initializer.WithoutTrivia());
            var field = Fmt(SF.FieldDeclaration(SF.VariableDeclaration(prop.Type.WithoutTrivia(), SF.SingletonSeparatedList(declarator))).WithModifiers(SF.TokenList(mods)));
            var semi = SF.Token(SyntaxKind.SemicolonToken);
            var newAccessors = accessors.Select(a =>
            {
                ExpressionSyntax body = a.IsKind(SyntaxKind.GetAccessorDeclaration)
                    ? SF.IdentifierName(fname)
                    : SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, SF.IdentifierName(fname), SF.IdentifierName("value"));
                return a.WithExpressionBody(SF.ArrowExpressionClause(body)).WithSemicolonToken(semi);
            });
            var newProp = Fmt(prop.WithAccessorList(SF.AccessorList(SF.List(newAccessors))).WithInitializer(null).WithSemicolonToken(default).WithTriviaFrom(prop));
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            if (!hasSet)
            {
                // A get-only auto-property assigned in a constructor: the constructor now assigns the field.
                var typeDecl = (TypeDeclarationSyntax)prop.Parent!;
                foreach (var id in typeDecl.Members.OfType<ConstructorDeclarationSyntax>().SelectMany(k => k.DescendantNodes()).OfType<IdentifierNameSyntax>())
                    if (id.Identifier.ValueText == symbol.Name && IsWritten(id) && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(id, c.Ct).Symbol, symbol))
                        editor.ReplaceNode(id, SF.IdentifierName(fname).WithTriviaFrom(id));
            }
            editor.InsertBefore(prop, field.WithTrailingTrivia(Eol(c)).WithLeadingTrivia(prop.GetLeadingTrivia().Where(t => !t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) && !t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))));
            editor.ReplaceNode(prop, newProp);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    private static Func<Task<Document>>? FullToAuto(Ctx c)
    {
        if (c.Token.Parent is not PropertyDeclarationSyntax prop || c.Token != prop.Identifier || prop.Initializer != null) return null;
        if (prop.Parent is not (ClassDeclarationSyntax or StructDeclarationSyntax or RecordDeclarationSyntax) || prop.Modifiers.Any(SyntaxKind.PartialKeyword) || HasInnerComments(prop)) return null;
        ExpressionSyntax? getExpr = null;
        var setters = new List<AccessorDeclarationSyntax>();
        if (prop.ExpressionBody != null) getExpr = prop.ExpressionBody.Expression;
        else if (prop.AccessorList is { } al)
        {
            foreach (var a in al.Accessors)
            {
                if (a.IsKind(SyntaxKind.GetAccessorDeclaration)) getExpr = a.ExpressionBody?.Expression ?? SingleReturn(a.Body);
                else if (a.IsKind(SyntaxKind.SetAccessorDeclaration) || a.IsKind(SyntaxKind.InitAccessorDeclaration)) setters.Add(a);
                else return null;
                if (a.AttributeLists.Count > 0) return null;
            }
        }
        if (getExpr == null) return null;
        var field = c.Model.GetSymbolInfo(getExpr, c.Ct).Symbol as IFieldSymbol;
        var propSymbol = c.Model.GetDeclaredSymbol(prop, c.Ct);
        if (field == null || propSymbol == null || getExpr is not (IdentifierNameSyntax or MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax })) return null;
        if (field.DeclaredAccessibility != Accessibility.Private || field.IsStatic != propSymbol.IsStatic || field.IsVolatile || field.IsConst
            || !SymbolEqualityComparer.Default.Equals(field.ContainingType, propSymbol.ContainingType) || !SymbolEqualityComparer.Default.Equals(field.Type, propSymbol.Type)) return null;
        foreach (var s in setters)
        {
            var e = s.ExpressionBody?.Expression ?? (s.Body is { Statements: [ExpressionStatementSyntax es] } ? es.Expression : null);
            if (e is not AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a || a.Right is not IdentifierNameSyntax { Identifier.ValueText: "value" }
                || !SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(a.Left, c.Ct).Symbol, field)) return null;
        }
        return () =>
        {
            if (field.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(c.Ct) is not VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Parent: FieldDeclarationSyntax fd } vdl } vd
                || vd.SyntaxTree != c.Root.SyntaxTree)
                throw new Refusal("NotApplicable", "The backing field is not declared in this file.");
            if (fd.AttributeLists.Count > 0 || HasComments(fd)) throw new Refusal("Comments", "The backing field has attributes or comments that would be lost.");
            if (propSymbol.ContainingType.DeclaringSyntaxReferences.Length > 1) throw new Refusal("PartialType", "The type is declared in several parts; the field may be used elsewhere.");
            var typeDecl = (TypeDeclarationSyntax)prop.Parent!;
            var refs = typeDecl.DescendantNodes().OfType<IdentifierNameSyntax>()
                .Where(i => i.Identifier.ValueText == field.Name && !prop.Span.Contains(i.Span) && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(i, c.Ct).Symbol, field)).ToList();
            foreach (var r in refs)
            {
                if (r.Parent is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None } || r.Parent is RefExpressionSyntax
                    || r.Parent is PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.AddressOfExpression })
                    throw new Refusal("FieldByReference", $"'{field.Name}' is passed by reference; a property cannot be.");
                var inCtor = r.Ancestors().OfType<ConstructorDeclarationSyntax>().Any(k => k.Modifiers.Any(SyntaxKind.StaticKeyword) == field.IsStatic)
                    && !r.Ancestors().Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax);
                if (IsWritten(r) && setters.Count == 0 && !inCtor)
                    throw new Refusal("FieldWritten", $"'{field.Name}' is written outside the constructor; a get-only auto-property cannot be.");
            }
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var r in refs) editor.ReplaceNode(r, SF.IdentifierName(prop.Identifier.ValueText).WithTriviaFrom(r));
            var accs = new List<AccessorDeclarationSyntax>
            {
                SF.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration).WithModifiers(prop.AccessorList?.Accessors.First(a => a.IsKind(SyntaxKind.GetAccessorDeclaration)).Modifiers ?? default)
                    .WithSemicolonToken(SF.Token(SyntaxKind.SemicolonToken)),
            };
            accs.AddRange(setters.Select(s => SF.AccessorDeclaration(s.Kind()).WithModifiers(s.Modifiers).WithSemicolonToken(SF.Token(SyntaxKind.SemicolonToken))));
            var auto = prop.WithExpressionBody(null).WithAccessorList(SF.AccessorList(SF.List(accs)));
            if (vd.Initializer != null) auto = auto.WithInitializer(vd.Initializer.WithoutTrivia()).WithSemicolonToken(SF.Token(SyntaxKind.SemicolonToken));
            else auto = auto.WithSemicolonToken(default);
            editor.ReplaceNode(prop, Fmt(auto.WithTriviaFrom(prop)));
            if (vdl.Variables.Count == 1) editor.RemoveNode(fd);
            else editor.RemoveNode(vd);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    // ------------------------------------------------------------------ object initializer

    private static Func<Task<Document>>? ObjectInitializer(Ctx c)
    {
        var stmt = c.Token.Parent?.AncestorsAndSelf().OfType<StatementSyntax>().FirstOrDefault();
        BaseObjectCreationExpressionSyntax? creation = null;
        ISymbol? variable = null;
        switch (stmt)
        {
            case LocalDeclarationStatementSyntax { UsingKeyword.RawKind: (int)SyntaxKind.None, Declaration.Variables: [{ Initializer.Value: BaseObjectCreationExpressionSyntax oc } v] }:
                creation = oc;
                variable = c.Model.GetDeclaredSymbol(v, c.Ct);
                break;
            case ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression, Left: IdentifierNameSyntax left, Right: BaseObjectCreationExpressionSyntax oc2 } }:
                creation = oc2;
                variable = c.Model.GetSymbolInfo(left, c.Ct).Symbol as ILocalSymbol;
                break;
        }
        if (creation == null || variable == null || stmt!.Parent is not BlockSyntax || creation.Initializer is { RawKind: not (int)SyntaxKind.ObjectInitializerExpression }) return null;
        var existing = creation.Initializer?.Expressions.OfType<AssignmentExpressionSyntax>().Select(a => (a.Left as IdentifierNameSyntax)?.Identifier.ValueText).ToHashSet() ?? new HashSet<string?>();
        var taken = new List<ExpressionStatementSyntax>();
        for (var s = NextStatement(stmt); s is ExpressionStatementSyntax es; s = NextStatement(s))
        {
            if (es.Expression is not AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression, Left: MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax target, Name: IdentifierNameSyntax member } } a) break;
            if (!SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(target, c.Ct).Symbol, variable) || Mentions(a.Right, variable, c.Model, c.Ct) || HasComments(es)) break;
            if (c.Model.GetSymbolInfo(member, c.Ct).Symbol is not (IFieldSymbol { IsStatic: false } or IPropertySymbol { IsStatic: false, IsIndexer: false })) break;
            if (!existing.Add(member.Identifier.ValueText)) break;
            taken.Add(es);
        }
        if (taken.Count == 0) return null;
        return () =>
        {
            var eol = Eol(c);
            var exprs = (creation.Initializer?.Expressions.Select(e => e.WithoutTrivia()) ?? Enumerable.Empty<ExpressionSyntax>())
                .Concat(taken.Select(t =>
                {
                    var a = (AssignmentExpressionSyntax)t.Expression;
                    return (ExpressionSyntax)SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, ((MemberAccessExpressionSyntax)a.Left).Name.WithoutTrivia(), a.Right.WithoutTrivia());
                })).ToList();
            var init = SF.InitializerExpression(SyntaxKind.ObjectInitializerExpression,
                    SF.SeparatedList(exprs, exprs.Select(_ => SF.Token(SyntaxKind.CommaToken).WithTrailingTrivia(eol))))
                .WithOpenBraceToken(SF.Token(SyntaxKind.OpenBraceToken).WithLeadingTrivia(eol).WithTrailingTrivia(eol));
            var newCreation = creation.WithInitializer(init);
            if (newCreation is ObjectCreationExpressionSyntax { ArgumentList: { Arguments.Count: 0 } } oce)
                newCreation = oce.WithType(oce.Type.WithoutTrailingTrivia()).WithArgumentList(null);
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            editor.ReplaceNode(creation, Fmt(newCreation.WithTriviaFrom(creation)));
            foreach (var t in taken) editor.RemoveNode(t);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    private static Func<Task<Document>>? SplitInitializer(Ctx c)
    {
        var stmt = c.Token.Parent?.AncestorsAndSelf().OfType<StatementSyntax>().FirstOrDefault();
        if (stmt is not LocalDeclarationStatementSyntax { UsingKeyword.RawKind: (int)SyntaxKind.None, Declaration.Variables: [{ Initializer.Value: BaseObjectCreationExpressionSyntax { Initializer: { RawKind: (int)SyntaxKind.ObjectInitializerExpression } init } oc } v] } ld
            || ld.Parent is not BlockSyntax || init.Expressions.Count == 0 || HasInnerComments(init)) return null;
        if (init.Expressions.Any(e => e is not AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression, Left: IdentifierNameSyntax, Right: not InitializerExpressionSyntax })) return null;
        return () =>
        {
            var name = SF.IdentifierName(v.Identifier.WithoutTrivia());
            BaseObjectCreationExpressionSyntax bare = oc.WithInitializer(null);
            if (bare is ObjectCreationExpressionSyntax { ArgumentList: null } o) bare = o.WithType(o.Type.WithoutTrailingTrivia()).WithArgumentList(SF.ArgumentList());
            var stmts = new List<StatementSyntax> { ld.ReplaceNode(oc, bare.WithoutTrailingTrivia()).WithoutTrivia() };
            foreach (AssignmentExpressionSyntax a in init.Expressions)
                stmts.Add(SF.ExpressionStatement(SF.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression,
                    SF.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, name, (IdentifierNameSyntax)a.Left.WithoutTrivia()), a.Right.WithoutTrivia())));
            return Task.FromResult(c.Doc.WithSyntaxRoot(ReplaceWithStatements(c.Root, ld, stmts)));
        };
    }

    // ------------------------------------------------------------------ using statement ↔ declaration

    private static Func<Task<Document>>? UsingDeclaration(Ctx c)
    {
        var us = c.Token.Parent?.AncestorsAndSelf().OfType<UsingStatementSyntax>().FirstOrDefault();
        if (us == null || c.Span.Start < us.SpanStart || c.Span.Start > us.CloseParenToken.Span.End || us.Parent is not BlockSyntax block) return null;
        var chain = new List<UsingStatementSyntax>();
        StatementSyntax inner = us;
        while (inner is UsingStatementSyntax u)
        {
            if (u.Declaration == null) return null;
            chain.Add(u);
            inner = u.Statement;
        }
        if (inner is BlockSyntax ib && (ib.OpenBraceToken.TrailingTrivia.Concat(ib.CloseBraceToken.LeadingTrivia).Any(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia) || t.IsDirective)))
            return null;
        if (block.Statements.Last() != us)
        {
            // Statements after the using would run before the disposal: allowed only when they are a single 'return' of a constant or local.
            return () => throw new Refusal("DisposalOrder", "Statements follow the 'using' statement; with a 'using' declaration the resource would be disposed only after them.");
        }
        return () =>
        {
            var stmts = chain.Select(u => (StatementSyntax)SF.LocalDeclarationStatement(u.AwaitKeyword, SF.Token(SyntaxKind.UsingKeyword), default, u.Declaration!.WithoutTrivia(), SF.Token(SyntaxKind.SemicolonToken))).ToList();
            stmts.AddRange(inner is BlockSyntax b ? b.Statements.Select(s => s.WithoutTrivia()) : new[] { inner.WithoutTrivia() });
            return Task.FromResult(c.Doc.WithSyntaxRoot(ReplaceWithStatements(c.Root, us, stmts)));
        };
    }

    private static Func<Task<Document>>? UsingStatement(Ctx c)
    {
        var ld = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not BlockSyntax).OfType<LocalDeclarationStatementSyntax>().FirstOrDefault();
        if (ld == null || ld.UsingKeyword.IsKind(SyntaxKind.None) || ld.Parent is not BlockSyntax block || HasInnerComments(ld)) return null;
        var rest = block.Statements.Skip(block.Statements.IndexOf(ld) + 1).ToList();
        return () =>
        {
            if (rest.Any(s => s is LabeledStatementSyntax || s.DescendantNodes().OfType<LabeledStatementSyntax>().Any()))
                throw new Refusal("Labels", "The statements after the declaration contain labels.");
            var body = SF.Block(rest.Select(s => s));
            var us = SF.UsingStatement(SF.List<AttributeListSyntax>(), ld.AwaitKeyword, SF.Token(SyntaxKind.UsingKeyword), SF.Token(SyntaxKind.OpenParenToken),
                ld.Declaration.WithoutTrivia(), null, SF.Token(SyntaxKind.CloseParenToken), body);
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var s in rest) editor.RemoveNode(s, SyntaxRemoveOptions.KeepNoTrivia);
            editor.ReplaceNode(ld, Fmt(us.WithTriviaFrom(ld)));
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    // ------------------------------------------------------------------ async

    private static bool IsTaskLike(ITypeSymbol t, out bool generic)
    {
        generic = false;
        if (t is not INamedTypeSymbol n || n.ContainingNamespace?.ToDisplayString() != "System.Threading.Tasks" || n.Name is not ("Task" or "ValueTask")) return false;
        generic = n.Arity == 1;
        return n.Arity <= 1;
    }

    /// <summary>The return statements of the method itself (not of lambdas or local functions inside it).</summary>
    private static IEnumerable<ReturnStatementSyntax> OwnReturns(SyntaxNode method) =>
        method.DescendantNodes(n => n == method || n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)).OfType<ReturnStatementSyntax>();

    private static IEnumerable<SyntaxNode> OwnNodes(SyntaxNode method) =>
        method.DescendantNodes(n => n == method || n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax));

    private static Func<Task<Document>>? MakeMethodAsync(Ctx c)
    {
        if (c.Token.Parent is not MethodDeclarationSyntax m || c.Token != m.Identifier || m.Modifiers.Any(SyntaxKind.AsyncKeyword)) return null;
        if (m.Body == null && m.ExpressionBody == null) return null;
        return () => Task.FromResult(MakeAsyncCore(c, m, signatureChanges: true));
    }

    /// <summary>
    /// Adds 'async' to <paramref name="m"/> (of <c>c.Root</c>) and awaits its returns; a method that does not return a
    /// task gets Task / Task&lt;T&gt;. With <paramref name="signatureChanges"/> false the method already returns a task, so
    /// overrides, interface implementations and Main keep their signature and are allowed.
    /// </summary>
    private static Document MakeAsyncCore(Ctx c, MethodDeclarationSyntax m, bool signatureChanges)
    {
        {
            var s = c.Model.GetDeclaredSymbol(m, c.Ct)!;
            if (signatureChanges && (s.IsOverride || s.ExplicitInterfaceImplementations.Length > 0
                || s.ContainingType.AllInterfaces.SelectMany(i => i.GetMembers()).Any(im => SymbolEqualityComparer.Default.Equals(s.ContainingType.FindImplementationForInterfaceMember(im), s))))
                throw new Refusal("SignatureFixed", "The method overrides or implements another member; its return type cannot change alone.");
            if (s.ReturnsByRef || s.ReturnsByRefReadonly) throw new Refusal("RefReturn", "Methods that return by reference cannot be async.");
            if (s.Parameters.Any(p => p.RefKind != RefKind.None)) throw new Refusal("RefParameters", "Async methods cannot have ref, out or in parameters.");
            if (OwnNodes(m).Any(n => n is YieldStatementSyntax)) throw new Refusal("Iterator", "Iterators are not made async.");
            if (signatureChanges && s.Name == "Main" && s.IsStatic) throw new Refusal("EntryPoint", "The entry point is not converted.");
            var taskLike = IsTaskLike(s.ReturnType, out var generic);
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            TypeSyntax returnType = m.ReturnType;
            if (!taskLike)
            {
                returnType = s.ReturnsVoid ? SF.IdentifierName("Task") : SF.GenericName(SF.Identifier("Task"), SF.TypeArgumentList(SF.SingletonSeparatedList(m.ReturnType.WithoutTrivia())));
            }
            else if (m.ExpressionBody != null)
            {
                editor.ReplaceNode(m.ExpressionBody.Expression, Fmt(SF.AwaitExpression(Receiver(m.ExpressionBody.Expression)).WithTriviaFrom(m.ExpressionBody.Expression)));
            }
            else
            {
                foreach (var r in OwnReturns(m))
                {
                    if (r.Expression == null) continue;
                    var awaited = SF.AwaitExpression(Receiver(r.Expression));
                    if (generic) editor.ReplaceNode(r.Expression, Fmt(awaited.WithTriviaFrom(r.Expression)));
                    else if (r.Parent == m.Body && m.Body!.Statements.Last() == r) editor.ReplaceNode(r, Fmt(SF.ExpressionStatement(awaited).WithTriviaFrom(r)));
                    else if (r.Parent is BlockSyntax) editor.ReplaceNode(r, (SyntaxNode)Fmt(SF.Block(SF.ExpressionStatement(awaited), SF.ReturnStatement())).WithTriviaFrom(r));
                    else throw new Refusal("NotApplicable", "A 'return' of the task is not in a block.");
                }
            }
            var asyncToken = SF.Token(SyntaxKind.AsyncKeyword).WithTrailingTrivia(SF.Space);
            MethodDeclarationSyntax Apply(MethodDeclarationSyntax cur)
            {
                var rt = (taskLike ? cur.ReturnType : returnType).WithTriviaFrom(cur.ReturnType);
                if (cur.Modifiers.Count == 0) return cur.WithReturnType(rt.WithoutLeadingTrivia()).WithModifiers(SF.TokenList(asyncToken.WithLeadingTrivia(cur.ReturnType.GetLeadingTrivia())));
                return cur.WithReturnType(rt).WithModifiers(cur.Modifiers.Add(asyncToken));
            }
            editor.ReplaceNode(m, (cur, _) => Apply((MethodDeclarationSyntax)cur));
            var root = editor.GetChangedRoot();
            return !taskLike && !Imports(c, m.SpanStart, "System.Threading.Tasks", "Task") ? WithUsing(c.Doc, root, "System.Threading.Tasks") : c.Doc.WithSyntaxRoot(root);
        }
    }

    private static Func<Task<Document>>? RemoveMethodAsync(Ctx c)
    {
        if (c.Token.Parent is not MethodDeclarationSyntax m || !(c.Token == m.Identifier || c.Token.IsKind(SyntaxKind.AsyncKeyword)) || !m.Modifiers.Any(SyntaxKind.AsyncKeyword)) return null;
        if (m.Body == null && m.ExpressionBody == null) return null;
        var awaits = OwnNodes(m).Where(n => n is AwaitExpressionSyntax || n is CommonForEachStatementSyntax { AwaitKeyword.RawKind: not (int)SyntaxKind.None }
            || n is UsingStatementSyntax { AwaitKeyword.RawKind: not (int)SyntaxKind.None } || n is LocalDeclarationStatementSyntax { AwaitKeyword.RawKind: not (int)SyntaxKind.None }).ToList();
        if (awaits.Count != 1 || awaits[0] is not AwaitExpressionSyntax aw) return null;
        return () =>
        {
            var s = c.Model.GetDeclaredSymbol(m, c.Ct)!;
            if (!IsTaskLike(s.ReturnType, out var generic)) throw new Refusal("NotApplicable", "Only methods returning Task or ValueTask are converted.");
            if (!SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(aw.Expression, c.Ct).Type, s.ReturnType))
                throw new Refusal("TypeMismatch", "The awaited value is not of the method's return type.");
            SyntaxNode oldNode;
            SyntaxNode newNode;
            if (m.ExpressionBody != null && Bare(m.ExpressionBody.Expression) == aw)
            {
                oldNode = m.ExpressionBody.Expression;
                newNode = aw.Expression.WithTriviaFrom(oldNode);
            }
            else if (m.Body is { } body && body.Statements.LastOrDefault() is { } last
                     && (last is ReturnStatementSyntax { Expression: { } re } && Bare(re) == aw && generic
                         || last is ExpressionStatementSyntax { Expression: var ee } && Bare(ee) == aw && !generic))
            {
                if (OwnReturns(m).Any(r => r != last))
                    throw new Refusal("OtherReturns", "The method returns in more than one place; without 'async' those returns would need Task.FromResult.");
                if (OwnNodes(m).Any(n => n is LocalDeclarationStatementSyntax { UsingKeyword.RawKind: not (int)SyntaxKind.None } or UsingStatementSyntax or TryStatementSyntax or LockStatementSyntax))
                    throw new Refusal("AwaitGuarded", "The await is inside try, using or lock; without it the guard would end before the task completes.");
                oldNode = last;
                newNode = Fmt(SF.ReturnStatement(aw.Expression.WithoutTrivia()).WithTriviaFrom(last));
            }
            else throw new Refusal("AwaitNotLast", "The single 'await' is not the method's final return (or is inside try, using or lock).");
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            editor.ReplaceNode(oldNode, newNode);
            editor.ReplaceNode(m, (cur, _) =>
            {
                var mm = (MethodDeclarationSyntax)cur;
                var i = mm.Modifiers.IndexOf(SyntaxKind.AsyncKeyword);
                var tok = mm.Modifiers[i];
                var mods = mm.Modifiers.RemoveAt(i);
                if (i < mods.Count) mods = mods.Replace(mods[i], mods[i].WithLeadingTrivia(tok.LeadingTrivia));
                else if (i == 0) return mm.WithModifiers(mods).WithReturnType(mm.ReturnType.WithLeadingTrivia(tok.LeadingTrivia));
                return mm.WithModifiers(mods);
            });
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }
}
