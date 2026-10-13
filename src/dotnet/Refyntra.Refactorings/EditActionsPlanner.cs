using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>One single-document edit action that applies at a position (protocol 1.9, code/editActions).</summary>
public sealed record EditActionInfo(string ActionId, string Title, string Kind);

/// <summary>The computed edits of an edit action, or why it is refused.</summary>
public sealed record EditActionOutcome(IReadOnlyList<(LinePositionSpan Range, string NewText)>? Edits, string? DocumentHash, string? ReasonCode, string? Message)
{
    public static EditActionOutcome Refused(string reason, string message) => new(null, null, reason, message);
}

/// <summary>
/// Rider-style single-document edit actions computed by Roslyn: convert expression body ↔ block body, var ↔ explicit
/// type, invert if, ternary ↔ if/else, merge / split nested if, string concatenation → interpolated string, inline a
/// local variable and introduce a local variable from a selected expression. Listing is a syntax pass plus a few
/// semantic queries (no compilation); computing an action rewrites the syntax tree, formats only the rewritten nodes
/// (the document's .editorconfig options), and refuses when the document gets a compiler error it did not have.
/// Never writes files: the client applies the returned edits as one undo step while the document is unchanged.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string Prefix = "csharp.edit.";
    public const string ToBlockBody = Prefix + "toBlockBody";
    public const string ToExpressionBody = Prefix + "toExpressionBody";
    public const string VarToExplicit = Prefix + "varToExplicit";
    public const string ExplicitToVar = Prefix + "explicitToVar";
    public const string InvertIf = Prefix + "invertIf";
    public const string TernaryToIf = Prefix + "ternaryToIf";
    public const string IfToTernary = Prefix + "ifToTernary";
    public const string MergeIf = Prefix + "mergeNestedIf";
    public const string SplitIf = Prefix + "splitIf";
    public const string ToInterpolated = Prefix + "toInterpolatedString";
    public const string InlineLocal = Prefix + "inlineVariable";
    public const string IntroduceLocal = Prefix + "introduceVariable";
    public const string IntroduceLocalAll = Prefix + "introduceVariableAll";

    private const string Rewrite = "refactor.rewrite.refyntra.";

    private static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private sealed class Refusal : Exception
    {
        public string Reason { get; }
        public Refusal(string reason, string message) : base(message) => Reason = reason;
    }

    private sealed record Ctx(Document Doc, SyntaxNode Root, SemanticModel Model, SourceText Text, TextSpan Span, CancellationToken Ct)
    {
        public SyntaxToken Token => Root.FindToken(Math.Min(Span.Start, Math.Max(0, Root.FullSpan.End - 1)));
    }

    /// <summary>A candidate: its info, and the rewrite (runs only when the action is computed).</summary>
    private sealed record Candidate(EditActionInfo Info, Func<Task<Document>> Run);

    private static Document? DocumentOf(Snapshot snapshot, string path) =>
        snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);

    private static async Task<Ctx?> ContextAsync(Snapshot snapshot, string path, LinePositionSpan range, CancellationToken ct)
    {
        var doc = DocumentOf(snapshot, path);
        if (doc == null) return null;
        var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return null;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        int Pos(LinePosition p) => p.Line < 0 || p.Line >= text.Lines.Count ? -1 : Math.Min(text.Lines[p.Line].Start + p.Character, text.Lines[p.Line].End);
        int s = Pos(range.Start), e = Pos(range.End);
        if (s < 0 || e < 0) return null;
        if (e < s) (s, e) = (e, s);
        while (s < e && char.IsWhiteSpace(text[s])) s++;
        while (e > s && char.IsWhiteSpace(text[e - 1])) e--;
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return new Ctx(doc, root!, model!, text, TextSpan.FromBounds(s, e), ct);
    }

    /// <summary>The actions that apply at the range (no compilation; an action may still be refused when computed).</summary>
    public static async Task<IReadOnlyList<EditActionInfo>> ListAsync(Snapshot snapshot, string path, LinePositionSpan range, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, range, ct).ConfigureAwait(false);
        return c == null ? Array.Empty<EditActionInfo>() : Candidates(c).Select(x => x.Info).ToList();
    }

    /// <summary>Computes one action: the minimal text edits of the document, compile-checked; or a refusal.</summary>
    public static async Task<EditActionOutcome> ComputeAsync(Snapshot snapshot, string path, LinePositionSpan range, string actionId, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, range, ct).ConfigureAwait(false);
        if (c == null) return EditActionOutcome.Refused("NoDocument", "The file is not an editable C# document of the loaded solution.");
        if (RenamePlanner.IsReadOnly(path)) return EditActionOutcome.Refused("ReadOnlyFile", "The file is read-only.");
        try
        {
            var candidate = Candidates(c).FirstOrDefault(x => x.Info.ActionId == actionId)
                ?? throw new Refusal("NotApplicable", "The action does not apply at this position.");
            var changed = await candidate.Run().ConfigureAwait(false);
            changed = await Formatter.FormatAsync(changed, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
            var newText = await changed.GetTextAsync(ct).ConfigureAwait(false);
            if (newText.ContentEquals(c.Text)) throw new Refusal("NoChanges", "The action produces no edits.");
            await CompileCheckAsync(c, changed, ct).ConfigureAwait(false);
            var changes = newText.GetTextChanges(c.Text).OrderBy(x => x.Span.Start).ToList();
            var edits = changes.Select(x => (c.Text.Lines.GetLinePositionSpan(x.Span), x.NewText ?? "")).ToList();
            return new EditActionOutcome(edits, Hashing.Sha256Text(c.Text.ToString()), null, null);
        }
        catch (Refusal r)
        {
            return EditActionOutcome.Refused(r.Reason, r.Message);
        }
    }

    /// <summary>Refuses when the changed document has a compiler error (by id and message) that the original did not have.</summary>
    private static async Task CompileCheckAsync(Ctx c, Document changed, CancellationToken ct)
    {
        static Dictionary<string, int> Keys(IEnumerable<Diagnostic> ds)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var x in ds.Where(x => x.Severity == DiagnosticSeverity.Error))
            {
                var k = x.Id + ": " + x.GetMessage();
                d[k] = d.TryGetValue(k, out var n) ? n + 1 : 1;
            }
            return d;
        }
        var before = Keys(c.Model.GetDiagnostics(cancellationToken: ct));
        var model = await changed.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var after = Keys(model!.GetDiagnostics(cancellationToken: ct));
        var added = after.Where(kv => kv.Value > (before.TryGetValue(kv.Key, out var n) ? n : 0)).Select(kv => kv.Key).ToList();
        if (added.Count > 0) throw new Refusal("CompilationErrors", "The change would introduce compiler errors: " + string.Join("; ", added.Take(3)));
    }

    // ------------------------------------------------------------------ catalogue

    private static IEnumerable<Candidate> Candidates(Ctx c)
    {
        var list = new List<Candidate>();
        void Add(string id, string title, string kind, Func<Task<Document>>? run)
        {
            if (run != null) list.Add(new Candidate(new EditActionInfo(id, title, kind), run));
        }
        if (c.Span.IsEmpty)
        {
            Add(ToBlockBody, "Convert to block body", Rewrite + "blockBody", BlockBody(c));
            Add(ToExpressionBody, "Convert to expression body", Rewrite + "expressionBody", ExpressionBody(c));
            Add(VarToExplicit, "Use explicit type", Rewrite + "explicitType", VarExplicit(c));
            Add(ExplicitToVar, "Use 'var'", Rewrite + "var", ExplicitVar(c));
            Add(InvertIf, "Invert 'if'", Rewrite + "invertIf", Invert(c));
            Add(IfToTernary, "Convert 'if' to conditional expression", Rewrite + "ifToConditional", IfTernary(c));
            Add(TernaryToIf, "Convert conditional expression to 'if'", Rewrite + "conditionalToIf", TernaryIf(c));
            Add(MergeIf, "Merge nested 'if' statements", Rewrite + "mergeIf", Merge(c));
            Add(SplitIf, "Split 'if' at '&&'", Rewrite + "splitIf", Split(c));
            Add(ToInterpolated, "Convert to interpolated string", Rewrite + "interpolatedString", Interpolate(c));
            Add(InlineLocal, "Inline variable", "refactor.inline.refyntra.variable", Inline(c));
            AddInlineMembers(c, Add);
            AddConvert(c, Add);
        }
        else
        {
            AddIntroduceMembers(c, Add);
            Add(IntroduceLocal, "Introduce variable", "refactor.extract.refyntra.variable", Introduce(c, all: false));
            Add(IntroduceLocalAll, "Introduce variable (replace all occurrences)", "refactor.extract.refyntra.variableAll", Introduce(c, all: true));
        }
        AddInspectionFixes(c, Add);
        return list;
    }

    private static Func<Task<Document>> Replace(Ctx c, SyntaxNode old, SyntaxNode @new) =>
        () => Task.FromResult(c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(old, @new.WithAdditionalAnnotations(Formatter.Annotation))));

    private static bool HasComments(SyntaxNode n) =>
        n.DescendantTrivia(descendIntoTrivia: true).Any(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia)
            || t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) || t.IsDirective);

    private static bool HasInnerComments(SyntaxNode n) =>
        n.DescendantTrivia(descendIntoTrivia: true).Any(t => t.SpanStart >= n.SpanStart && t.Span.End <= n.Span.End
            && (t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia) || t.IsDirective));

    // ------------------------------------------------------------------ expression body ↔ block body

    /// <summary>The member whose header or arrow the cursor is on (not inside a nested body).</summary>
    private static SyntaxNode? BodyOwner(Ctx c)
    {
        foreach (var a in c.Token.Parent!.AncestorsAndSelf())
        {
            if (a is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax or AccessorDeclarationSyntax)
                return a;
            if (a is BlockSyntax or AnonymousFunctionExpressionSyntax or TypeDeclarationSyntax) return null;
        }
        return null;
    }

    private static ArrowExpressionClauseSyntax? ArrowOf(SyntaxNode n) => n switch
    {
        BaseMethodDeclarationSyntax m => m.ExpressionBody,
        LocalFunctionStatementSyntax f => f.ExpressionBody,
        BasePropertyDeclarationSyntax p => p switch { PropertyDeclarationSyntax pp => pp.ExpressionBody, IndexerDeclarationSyntax ii => ii.ExpressionBody, _ => null },
        AccessorDeclarationSyntax a => a.ExpressionBody,
        _ => null,
    };

    private static BlockSyntax? BlockOf(SyntaxNode n) => n switch
    {
        BaseMethodDeclarationSyntax m => m.Body,
        LocalFunctionStatementSyntax f => f.Body,
        AccessorDeclarationSyntax a => a.Body,
        _ => null,
    };

    /// <summary>True when the body's value is returned (false: the expression is a statement).</summary>
    private static bool ReturnsValue(Ctx c, SyntaxNode owner)
    {
        switch (owner)
        {
            case ConstructorDeclarationSyntax or DestructorDeclarationSyntax:
                return false;
            case AccessorDeclarationSyntax a:
                return a.IsKind(SyntaxKind.GetAccessorDeclaration);
            case PropertyDeclarationSyntax or IndexerDeclarationSyntax:
                return true;
        }
        if (c.Model.GetDeclaredSymbol(owner, c.Ct) is not IMethodSymbol m) return true;
        if (m.ReturnsByRef || m.ReturnsByRefReadonly) throw new Refusal("RefReturn", "Methods that return by reference are not converted.");
        if (m.ReturnsVoid) return false;
        if (m.IsAsync && m.ReturnType is INamedTypeSymbol { Arity: 0 } t && t.Name is "Task" or "ValueTask") return false;
        return true;
    }

    private static Func<Task<Document>>? BlockBody(Ctx c)
    {
        var owner = BodyOwner(c);
        if (owner == null || ArrowOf(owner) is not { } arrow) return null;
        if (owner is PropertyDeclarationSyntax { AccessorList: not null } or IndexerDeclarationSyntax { AccessorList: not null }) return null;
        return () =>
        {
            var expr = arrow.Expression.WithoutTrivia();
            StatementSyntax stmt = expr is ThrowExpressionSyntax th
                ? SyntaxFactory.ThrowStatement(th.Expression.WithoutTrivia())
                : ReturnsValue(c, owner) ? SyntaxFactory.ReturnStatement(expr) : SyntaxFactory.ExpressionStatement(expr);
            var block = SyntaxFactory.Block(stmt);
            SyntaxNode result = owner switch
            {
                BaseMethodDeclarationSyntax m => m.WithExpressionBody(null).WithSemicolonToken(default).WithBody(block),
                LocalFunctionStatementSyntax f => f.WithExpressionBody(null).WithSemicolonToken(default).WithBody(block),
                AccessorDeclarationSyntax a => a.WithExpressionBody(null).WithSemicolonToken(default).WithBody(block),
                PropertyDeclarationSyntax p => p.WithExpressionBody(null).WithSemicolonToken(default)
                    .WithAccessorList(SyntaxFactory.AccessorList(SyntaxFactory.SingletonList(SyntaxFactory.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration, block)))),
                IndexerDeclarationSyntax i => i.WithExpressionBody(null).WithSemicolonToken(default)
                    .WithAccessorList(SyntaxFactory.AccessorList(SyntaxFactory.SingletonList(SyntaxFactory.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration, block)))),
                _ => throw new Refusal("NotApplicable", "Unsupported member."),
            };
            return Replace(c, owner, result.WithTriviaFrom(owner))();
        };
    }

    private static Func<Task<Document>>? ExpressionBody(Ctx c)
    {
        var owner = BodyOwner(c);
        if (owner == null) return null;
        // A get-only property / indexer: { get { return e; } } or { get => e; } becomes => e;
        if (owner is PropertyDeclarationSyntax or IndexerDeclarationSyntax)
        {
            var bp = (BasePropertyDeclarationSyntax)owner;
            if (bp.AccessorList is not { Accessors.Count: 1 } al) return null;
            var get = al.Accessors[0];
            if (!get.IsKind(SyntaxKind.GetAccessorDeclaration) || get.AttributeLists.Count > 0 || get.Modifiers.Count > 0) return null;
            if (owner is PropertyDeclarationSyntax { Initializer: not null }) return null;
            var e = get.ExpressionBody?.Expression ?? SingleReturn(get.Body);
            if (e == null || HasInnerComments(al)) return null;
            var arrow = SyntaxFactory.ArrowExpressionClause(e.WithoutTrivia());
            SyntaxNode result = owner switch
            {
                PropertyDeclarationSyntax p => p.WithAccessorList(null).WithExpressionBody(arrow).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)),
                IndexerDeclarationSyntax i => i.WithAccessorList(null).WithExpressionBody(arrow).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)),
                _ => owner,
            };
            return Replace(c, owner, result.WithTriviaFrom(owner));
        }
        var block = BlockOf(owner);
        if (block is not { Statements.Count: 1 } || HasInnerComments(block)) return null;
        var s = block.Statements[0];
        ExpressionSyntax? body = s switch
        {
            ReturnStatementSyntax { Expression: { } r } => r,
            ThrowStatementSyntax { Expression: { } t } => SyntaxFactory.ThrowExpression(t.WithoutTrivia()),
            ExpressionStatementSyntax es => es.Expression,
            _ => null,
        };
        if (body == null) return null;
        if (s is ExpressionStatementSyntax)
        {
            // A statement body only fits a member that returns nothing.
            try { if (ReturnsValue(c, owner)) return null; }
            catch (Refusal) { return null; }
        }
        var arrowClause = SyntaxFactory.ArrowExpressionClause(body.WithoutTrivia());
        var semi = SyntaxFactory.Token(SyntaxKind.SemicolonToken);
        SyntaxNode? res = owner switch
        {
            BaseMethodDeclarationSyntax m => m.WithBody(null).WithExpressionBody(arrowClause).WithSemicolonToken(semi),
            LocalFunctionStatementSyntax f => f.WithBody(null).WithExpressionBody(arrowClause).WithSemicolonToken(semi),
            AccessorDeclarationSyntax a => a.WithBody(null).WithExpressionBody(arrowClause).WithSemicolonToken(semi),
            _ => null,
        };
        return res == null ? null : Replace(c, owner, res.WithTriviaFrom(owner));
    }

    private static ExpressionSyntax? SingleReturn(BlockSyntax? b) =>
        b is { Statements.Count: 1 } && b.Statements[0] is ReturnStatementSyntax { Expression: { } e } ? e : null;

    // ------------------------------------------------------------------ var ↔ explicit type

    private static VariableDeclarationSyntax? DeclarationAt(Ctx c)
    {
        var decl = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not StatementSyntax || a is LocalDeclarationStatementSyntax).OfType<VariableDeclarationSyntax>().FirstOrDefault();
        if (decl?.Parent is not LocalDeclarationStatementSyntax { IsConst: false } || decl.Variables.Count != 1) return null;
        if (decl.Type is RefTypeSyntax || decl.Type is ScopedTypeSyntax) return null;
        return decl;
    }

    private static string? DisplayLocalType(Ctx c, ITypeSymbol t, int position)
    {
        if (t is IErrorTypeSymbol || t.IsAnonymousType || ContainsAnonymous(t) || t.TypeKind == TypeKind.Error) return null;
        return t.ToMinimalDisplayString(c.Model, position, TypeFormat);
    }

    private static bool ContainsAnonymous(ITypeSymbol t) => t switch
    {
        { IsAnonymousType: true } => true,
        INamedTypeSymbol n => n.TypeArguments.Any(ContainsAnonymous) || (n.IsTupleType && n.TupleElements.Any(e => ContainsAnonymous(e.Type))),
        IArrayTypeSymbol a => ContainsAnonymous(a.ElementType),
        IPointerTypeSymbol => true,
        _ => false,
    };

    private static Func<Task<Document>>? VarExplicit(Ctx c)
    {
        TypeSyntax? typeNode = null;
        ITypeSymbol? type = null;
        var fe = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not BlockSyntax).OfType<ForEachStatementSyntax>().FirstOrDefault();
        if (fe != null && fe.Type.IsVar && c.Span.Start <= fe.CloseParenToken.SpanStart)
        {
            typeNode = fe.Type;
            type = c.Model.GetForEachStatementInfo(fe).ElementType;
        }
        else if (DeclarationAt(c) is { Type.IsVar: true } decl && decl.Variables[0].Initializer != null)
        {
            typeNode = decl.Type;
            type = c.Model.GetDeclaredSymbol(decl.Variables[0], c.Ct) is ILocalSymbol l ? l.Type : null;
            if (type != null && type.IsReferenceType && c.Model.GetTypeInfo(decl.Variables[0].Initializer!.Value, c.Ct).Nullability.FlowState == NullableFlowState.NotNull)
                type = type.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
        }
        if (typeNode == null || type == null || c.Model.GetSymbolInfo(typeNode, c.Ct).Symbol is not ITypeSymbol) return null;
        var shown = DisplayLocalType(c, type, typeNode.SpanStart);
        if (shown == null) return null;
        return Replace(c, typeNode, SyntaxFactory.ParseTypeName(shown).WithTriviaFrom(typeNode));
    }

    private static Func<Task<Document>>? ExplicitVar(Ctx c)
    {
        if (DeclarationAt(c) is not { } decl || decl.Type.IsVar || decl.Variables[0].Initializer?.Value is not { } init) return null;
        if (init is InitializerExpressionSyntax or ImplicitObjectCreationExpressionSyntax or CollectionExpressionSyntax or AnonymousFunctionExpressionSyntax
            or StackAllocArrayCreationExpressionSyntax or ImplicitStackAllocArrayCreationExpressionSyntax) return null;
        if (init is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression or (int)SyntaxKind.DefaultLiteralExpression }) return null;
        var declared = c.Model.GetTypeInfo(decl.Type, c.Ct).Type;
        var natural = c.Model.GetTypeInfo(init, c.Ct).Type;
        if (declared == null || natural == null || !SymbolEqualityComparer.Default.Equals(declared, natural)) return null;
        return Replace(c, decl.Type, SyntaxFactory.IdentifierName("var").WithTriviaFrom(decl.Type));
    }

    // ------------------------------------------------------------------ if

    /// <summary>The if statement whose keyword or condition the cursor is on.</summary>
    private static IfStatementSyntax? IfAt(Ctx c)
    {
        var ifs = c.Token.Parent?.AncestorsAndSelf().OfType<IfStatementSyntax>().FirstOrDefault();
        if (ifs == null) return null;
        return c.Span.Start >= ifs.IfKeyword.SpanStart && c.Span.Start <= ifs.CloseParenToken.Span.End ? ifs : null;
    }

    private static ExpressionSyntax Negate(ExpressionSyntax e, SemanticModel model, CancellationToken ct)
    {
        var x = e.WithoutTrivia();
        switch (e)
        {
            case PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.LogicalNotExpression } n:
                return n.Operand is ParenthesizedExpressionSyntax p ? p.Expression.WithoutTrivia() : n.Operand.WithoutTrivia();
            case LiteralExpressionSyntax { RawKind: (int)SyntaxKind.TrueLiteralExpression }:
                return SyntaxFactory.LiteralExpression(SyntaxKind.FalseLiteralExpression);
            case LiteralExpressionSyntax { RawKind: (int)SyntaxKind.FalseLiteralExpression }:
                return SyntaxFactory.LiteralExpression(SyntaxKind.TrueLiteralExpression);
            case BinaryExpressionSyntax b when model.GetSymbolInfo(b, ct).Symbol is not IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator }:
            {
                SyntaxKind? flipped = b.Kind() switch
                {
                    SyntaxKind.EqualsExpression => SyntaxKind.NotEqualsExpression,
                    SyntaxKind.NotEqualsExpression => SyntaxKind.EqualsExpression,
                    _ => null,
                };
                // Relational operators flip only for integral operands (NaN makes !(a < b) differ from a >= b).
                if (flipped == null && !IsFloating(model.GetTypeInfo(b.Left, ct).Type) && !IsFloating(model.GetTypeInfo(b.Right, ct).Type))
                    flipped = b.Kind() switch
                    {
                        SyntaxKind.LessThanExpression => SyntaxKind.GreaterThanOrEqualExpression,
                        SyntaxKind.LessThanOrEqualExpression => SyntaxKind.GreaterThanExpression,
                        SyntaxKind.GreaterThanExpression => SyntaxKind.LessThanOrEqualExpression,
                        SyntaxKind.GreaterThanOrEqualExpression => SyntaxKind.LessThanExpression,
                        _ => null,
                    };
                if (flipped is { } kk) return SyntaxFactory.BinaryExpression(kk, b.Left.WithoutTrivia(), b.Right.WithoutTrivia());
                break;
            }
            case IsPatternExpressionSyntax { Pattern: ConstantPatternSyntax cp } ip:
                return ip.WithPattern(SyntaxFactory.UnaryPattern(cp.WithoutTrivia()));
            case IsPatternExpressionSyntax { Pattern: UnaryPatternSyntax { RawKind: (int)SyntaxKind.NotPattern } np } ip2:
                return ip2.WithPattern(np.Pattern.WithoutTrivia());
        }
        var operand = x is IdentifierNameSyntax or InvocationExpressionSyntax or MemberAccessExpressionSyntax or ElementAccessExpressionSyntax or ParenthesizedExpressionSyntax or ThisExpressionSyntax
            ? x : SyntaxFactory.ParenthesizedExpression(x);
        return SyntaxFactory.PrefixUnaryExpression(SyntaxKind.LogicalNotExpression, operand);
    }

    private static bool IsFloating(ITypeSymbol? t)
    {
        // Nullable operands are lifted: !(null < 1) is true but null >= 1 is false. Only plain integral types flip.
        return t?.SpecialType is SpecialType.System_Single or SpecialType.System_Double or null or SpecialType.None;
    }

    private static StatementSyntax AsBlock(StatementSyntax s) => s is BlockSyntax ? s.WithoutTrivia() : SyntaxFactory.Block(s.WithoutTrivia());

    private static Func<Task<Document>>? Invert(Ctx c)
    {
        if (IfAt(c) is not { Else: { } els } ifs || els.Statement is IfStatementSyntax) return null;
        if (HasInnerComments(ifs.Condition)) return null;
        return () =>
        {
            var neg = Negate(ifs.Condition, c.Model, c.Ct);
            var result = ifs.WithCondition(neg).WithStatement(AsBlock(els.Statement)).WithElse(els.WithStatement(AsBlock(ifs.Statement)));
            return Replace(c, ifs, result.WithTriviaFrom(ifs))();
        };
    }

    private static StatementSyntax? Single(StatementSyntax s) => s is BlockSyntax b ? (b.Statements.Count == 1 ? b.Statements[0] : null) : s;

    private static Func<Task<Document>>? IfTernary(Ctx c)
    {
        if (IfAt(c) is not { Else: { } els } ifs || els.Statement is IfStatementSyntax || HasInnerComments(ifs)) return null;
        var a = Single(ifs.Statement);
        var b = Single(els.Statement);
        ExpressionSyntax? whenTrue, whenFalse;
        Func<ExpressionSyntax, StatementSyntax> make;
        if (a is ReturnStatementSyntax { Expression: { } ra } && b is ReturnStatementSyntax { Expression: { } rb })
        {
            (whenTrue, whenFalse) = (ra, rb);
            make = e => SyntaxFactory.ReturnStatement(e);
        }
        else if (a is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax aa } && b is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax ab }
                 && aa.Kind() == ab.Kind() && SyntaxFactory.AreEquivalent(aa.Left, ab.Left) && IsSimpleTarget(aa.Left))
        {
            (whenTrue, whenFalse) = (aa.Right, ab.Right);
            make = e => SyntaxFactory.ExpressionStatement(SyntaxFactory.AssignmentExpression(aa.Kind(), aa.Left.WithoutTrivia(), e));
        }
        else return null;
        // Both branches must have the same type (or one is null/default and takes the other's); otherwise the
        // conditional's natural type could silently convert a branch.
        var ta = c.Model.GetTypeInfo(whenTrue, c.Ct).Type;
        var tb = c.Model.GetTypeInfo(whenFalse, c.Ct).Type;
        if (ta != null && tb != null && !SymbolEqualityComparer.Default.Equals(ta, tb)) return null;
        if (ta == null && tb == null) return null;
        return () =>
        {
            var cond = SyntaxFactory.ConditionalExpression(Paren(ifs.Condition.WithoutTrivia(), conditional: true), whenTrue.WithoutTrivia(), whenFalse.WithoutTrivia());
            return Replace(c, ifs, make(cond).WithTriviaFrom(ifs))();
        };
    }

    private static bool IsSimpleTarget(ExpressionSyntax e) => e switch
    {
        IdentifierNameSyntax => true,
        MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax or IdentifierNameSyntax } => true,
        _ => false,
    };

    private static ExpressionSyntax Paren(ExpressionSyntax e, bool conditional = false) =>
        e is AssignmentExpressionSyntax or ConditionalExpressionSyntax or LambdaExpressionSyntax or AnonymousMethodExpressionSyntax
            || (!conditional && e is BinaryExpressionSyntax { RawKind: (int)SyntaxKind.LogicalOrExpression or (int)SyntaxKind.CoalesceExpression })
            ? SyntaxFactory.ParenthesizedExpression(e) : e;

    private static Func<Task<Document>>? TernaryIf(Ctx c)
    {
        var cond = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not StatementSyntax).OfType<ConditionalExpressionSyntax>().LastOrDefault();
        if (cond == null || HasInnerComments(cond)) return null;
        SyntaxNode outer = cond;
        while (outer.Parent is ParenthesizedExpressionSyntax pe) outer = pe;
        var stmt = outer.Parent switch
        {
            ReturnStatementSyntax r when r.Parent is BlockSyntax or SwitchSectionSyntax => (StatementSyntax)r,
            AssignmentExpressionSyntax { Parent: ExpressionStatementSyntax es } asg when asg.Right == outer && IsSimpleTarget(asg.Left) && es.Parent is BlockSyntax or SwitchSectionSyntax => es,
            _ => null,
        };
        if (stmt == null) return null;
        return () =>
        {
            StatementSyntax Branch(ExpressionSyntax value) => stmt switch
            {
                ReturnStatementSyntax => SyntaxFactory.ReturnStatement(value.WithoutTrivia()),
                ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a } => SyntaxFactory.ExpressionStatement(SyntaxFactory.AssignmentExpression(a.Kind(), a.Left.WithoutTrivia(), value.WithoutTrivia())),
                _ => throw new Refusal("NotApplicable", "Unsupported statement."),
            };
            var ifs = SyntaxFactory.IfStatement(cond.Condition.WithoutTrivia(), SyntaxFactory.Block(Branch(cond.WhenTrue)), SyntaxFactory.ElseClause(SyntaxFactory.Block(Branch(cond.WhenFalse))));
            return Replace(c, stmt, ifs.WithTriviaFrom(stmt))();
        };
    }

    private static Func<Task<Document>>? Merge(Ctx c)
    {
        if (IfAt(c) is not { Else: null } outer) return null;
        if (Single(outer.Statement) is not IfStatementSyntax { Else: null } inner || HasInnerComments(outer.Statement) && outer.Statement is BlockSyntax b0 && b0.Statements.Count == 1 && HasCommentsOutside(b0, inner)) return null;
        if (outer.Statement is BlockSyntax blk && HasCommentsOutside(blk, inner)) return null;
        return () =>
        {
            var condition = SyntaxFactory.BinaryExpression(SyntaxKind.LogicalAndExpression, Paren(outer.Condition.WithoutTrivia()), Paren(inner.Condition.WithoutTrivia()));
            return Replace(c, outer, outer.WithCondition(condition).WithStatement(inner.Statement).WithTriviaFrom(outer))();
        };
    }

    private static bool HasCommentsOutside(BlockSyntax b, SyntaxNode inner) =>
        b.OpenBraceToken.TrailingTrivia.Concat(b.CloseBraceToken.LeadingTrivia).Concat(inner.GetLeadingTrivia()).Concat(inner.GetTrailingTrivia())
            .Any(t => t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia) || t.IsDirective);

    private static Func<Task<Document>>? Split(Ctx c)
    {
        if (IfAt(c) is not { Else: null, Condition: BinaryExpressionSyntax { RawKind: (int)SyntaxKind.LogicalAndExpression } and } ifs) return null;
        return () =>
        {
            var inner = SyntaxFactory.IfStatement(Unparen(and.Right).WithoutTrivia(), ifs.Statement.WithoutTrivia());
            var outer = ifs.WithCondition(Unparen(and.Left).WithoutTrivia()).WithStatement(SyntaxFactory.Block(inner));
            return Replace(c, ifs, outer.WithTriviaFrom(ifs))();
        };
    }

    private static ExpressionSyntax Unparen(ExpressionSyntax e) =>
        e is ParenthesizedExpressionSyntax p && p.Expression is not (AssignmentExpressionSyntax or LambdaExpressionSyntax) ? p.Expression : e;

    // ------------------------------------------------------------------ interpolated string

    private static Func<Task<Document>>? Interpolate(Ctx c)
    {
        BinaryExpressionSyntax? top = null;
        foreach (var a in c.Token.Parent!.AncestorsAndSelf())
        {
            if (a is BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AddExpression } b && c.Model.GetTypeInfo(b, c.Ct).Type?.SpecialType == SpecialType.System_String) top = b;
            else if (a is ParenthesizedExpressionSyntax && top == null) continue;
            else if (top != null || a is StatementSyntax or MemberDeclarationSyntax) break;
        }
        if (top == null || HasInnerComments(top)) return null;
        if (c.Model.GetConstantValue(top, c.Ct).HasValue && top.Ancestors().Any(a => a is AttributeArgumentSyntax or CaseSwitchLabelSyntax or ParameterSyntax || a is FieldDeclarationSyntax f && f.Modifiers.Any(SyntaxKind.ConstKeyword) || a is LocalDeclarationStatementSyntax { IsConst: true }))
            return null;
        var parts = new List<ExpressionSyntax>();
        void Flatten(ExpressionSyntax e)
        {
            if (e is BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AddExpression } b && c.Model.GetTypeInfo(b, c.Ct).Type?.SpecialType == SpecialType.System_String
                && c.Model.GetSymbolInfo(b, c.Ct).Symbol is IMethodSymbol { MethodKind: MethodKind.BuiltinOperator } or null
                && (c.Model.GetTypeInfo(b.Left, c.Ct).Type?.SpecialType == SpecialType.System_String))
            {
                Flatten(b.Left);
                parts.Add(b.Right);
            }
            else parts.Add(e);
        }
        Flatten(top);
        if (!parts.Any(IsPlainString)) return null;
        if (parts.Any(p => p is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } l && !IsPlainString(l))) return null;
        return () =>
        {
            var expr = SyntaxFactory.ParseExpression(EscapeBraces(parts, c)).WithTriviaFrom(top);
            return Replace(c, top, expr)();
        };
    }

    private static string EscapeBraces(List<ExpressionSyntax> parts, Ctx c)
    {
        var sb = new System.Text.StringBuilder("$\"");
        foreach (var p in parts)
        {
            if (IsPlainString(p))
            {
                var t = ((LiteralExpressionSyntax)p).Token.Text;
                sb.Append(t.Substring(1, t.Length - 2).Replace("{", "{{").Replace("}", "}}"));
            }
            else
            {
                var e = p.WithoutTrivia();
                var needs = e is ConditionalExpressionSyntax || e.DescendantTokens().Any(k => k.IsKind(SyntaxKind.ColonColonToken) || k.IsKind(SyntaxKind.ColonToken));
                sb.Append('{').Append(needs ? "(" + e + ")" : e.ToString()).Append('}');
            }
        }
        return sb.Append('"').ToString();
    }

    private static bool IsPlainString(ExpressionSyntax e) =>
        e is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } l && l.Token.IsKind(SyntaxKind.StringLiteralToken) && l.Token.Text.StartsWith('"');

    // ------------------------------------------------------------------ inline local variable

    private static bool IsWritten(IdentifierNameSyntax id)
    {
        var e = (ExpressionSyntax)id;
        while (e.Parent is ParenthesizedExpressionSyntax p) e = p;
        return e.Parent switch
        {
            AssignmentExpressionSyntax a => a.Left == e,
            PrefixUnaryExpressionSyntax u => u.IsKind(SyntaxKind.PreIncrementExpression) || u.IsKind(SyntaxKind.PreDecrementExpression) || u.IsKind(SyntaxKind.AddressOfExpression),
            PostfixUnaryExpressionSyntax u => u.IsKind(SyntaxKind.PostIncrementExpression) || u.IsKind(SyntaxKind.PostDecrementExpression),
            ArgumentSyntax arg => !arg.RefKindKeyword.IsKind(SyntaxKind.None) && !arg.RefKindKeyword.IsKind(SyntaxKind.InKeyword),
            RefExpressionSyntax => true,
            _ => false,
        };
    }

    /// <summary>The value cannot change between the declaration and any use: constants and unwritten locals/parameters/readonly fields.</summary>
    private static bool IsStable(ExpressionSyntax init, SyntaxNode scope, SemanticModel model, CancellationToken ct)
    {
        if (!CodeFacts.IsSideEffectFree(init, model, ct) && !IsPureOperators(init, model, ct)) return false;
        foreach (var id in init.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
        {
            var s = model.GetSymbolInfo(id, ct).Symbol;
            switch (s)
            {
                case null: return false;
                case IFieldSymbol f when f.IsConst || f.IsReadOnly: break;
                case ILocalSymbol or IParameterSymbol:
                    if (scope.DescendantNodes().OfType<IdentifierNameSyntax>().Any(r => r.Identifier.ValueText == id.Identifier.ValueText && IsWritten(r)
                        && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(r, ct).Symbol, s))) return false;
                    if (s is IParameterSymbol { RefKind: not RefKind.None }) return false;
                    break;
                case INamedTypeSymbol or INamespaceSymbol: break;
                default: return false;
            }
        }
        return true;
    }

    /// <summary>Built-in arithmetic / comparison / logic over side-effect-free operands (no user operators, no conversions).</summary>
    private static bool IsPureOperators(ExpressionSyntax e, SemanticModel model, CancellationToken ct) => e switch
    {
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AsExpression) || b.IsKind(SyntaxKind.IsExpression) => false,
        BinaryExpressionSyntax b => model.GetSymbolInfo(b, ct).Symbol is not IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator }
            && !(b.IsKind(SyntaxKind.AddExpression) && model.GetTypeInfo(b, ct).Type?.SpecialType == SpecialType.System_String)
            && Pure(b.Left) && Pure(b.Right),
        PrefixUnaryExpressionSyntax u when u.IsKind(SyntaxKind.LogicalNotExpression) || u.IsKind(SyntaxKind.UnaryMinusExpression) || u.IsKind(SyntaxKind.BitwiseNotExpression) =>
            model.GetSymbolInfo(u, ct).Symbol is not IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } && Pure(u.Operand),
        ParenthesizedExpressionSyntax p => Pure(p.Expression),
        _ => false,
    };

    private static bool Pure(ExpressionSyntax e) => true && e is not null && e.DescendantNodesAndSelf().All(n => n is not (InvocationExpressionSyntax or ObjectCreationExpressionSyntax or AssignmentExpressionSyntax
        or AwaitExpressionSyntax or ElementAccessExpressionSyntax or CastExpressionSyntax or PostfixUnaryExpressionSyntax)
        && !n.IsKind(SyntaxKind.PreIncrementExpression) && !n.IsKind(SyntaxKind.PreDecrementExpression) && !(n is MemberAccessExpressionSyntax));

    private static bool IsImpure(SyntaxNode n) =>
        n is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax or AssignmentExpressionSyntax or AwaitExpressionSyntax or ElementAccessExpressionSyntax
            or MemberAccessExpressionSyntax or ConditionalAccessExpressionSyntax
        || n.IsKind(SyntaxKind.PreIncrementExpression) || n.IsKind(SyntaxKind.PreDecrementExpression) || n.IsKind(SyntaxKind.PostIncrementExpression) || n.IsKind(SyntaxKind.PostDecrementExpression);

    /// <summary>True when <paramref name="n"/> is only conditionally evaluated within <paramref name="stop"/> (or in a lambda / loop body).</summary>
    private static bool ConditionallyEvaluated(SyntaxNode n, SyntaxNode stop)
    {
        var child = n;
        for (var a = n.Parent; a != null && a != stop; child = a, a = a.Parent)
        {
            switch (a)
            {
                case BinaryExpressionSyntax b when (b.IsKind(SyntaxKind.LogicalAndExpression) || b.IsKind(SyntaxKind.LogicalOrExpression) || b.IsKind(SyntaxKind.CoalesceExpression)) && b.Right == child:
                case ConditionalExpressionSyntax ce when ce.Condition != child:
                case ConditionalAccessExpressionSyntax ca when ca.WhenNotNull == child:
                case AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or QueryExpressionSyntax:
                case AssignmentExpressionSyntax asg when asg.IsKind(SyntaxKind.CoalesceAssignmentExpression) && asg.Right == child:
                case SwitchExpressionArmSyntax:
                    return true;
                case StatementSyntax s when s is not ExpressionStatementSyntax and not ReturnStatementSyntax and not LocalDeclarationStatementSyntax and not ThrowStatementSyntax
                    and not IfStatementSyntax and not SwitchStatementSyntax and not BlockSyntax:
                    return true;
                case IfStatementSyntax i when i.Condition != child:
                    return true;
                case SwitchStatementSyntax sw when sw.Expression != child:
                    return true;
            }
        }
        return false;
    }

    private static Func<Task<Document>>? Inline(Ctx c)
    {
        if (c.Token.Parent is not { } p) return null;
        ILocalSymbol? local = null;
        if (p is VariableDeclaratorSyntax vd && vd.Identifier == c.Token) local = c.Model.GetDeclaredSymbol(vd, c.Ct) as ILocalSymbol;
        else if (p is IdentifierNameSyntax idn) local = c.Model.GetSymbolInfo(idn, c.Ct).Symbol as ILocalSymbol;
        if (local == null || local.IsRef || local.DeclaringSyntaxReferences.Length != 1) return null;
        if (local.DeclaringSyntaxReferences[0].GetSyntax(c.Ct) is not VariableDeclaratorSyntax { Initializer.Value: { } init } declarator
            || declarator.Parent is not VariableDeclarationSyntax { Variables.Count: 1 } decl
            || decl.Parent is not LocalDeclarationStatementSyntax { UsingKeyword.RawKind: (int)SyntaxKind.None, AwaitKeyword.RawKind: (int)SyntaxKind.None } declStmt
            || declStmt.Parent is not (BlockSyntax or SwitchSectionSyntax)
            || declarator.SyntaxTree != c.Root.SyntaxTree)
            return null;
        if (init is InitializerExpressionSyntax) return null;
        return () =>
        {
            var scope = declStmt.Parent!;
            var refs = scope.DescendantNodes().OfType<IdentifierNameSyntax>()
                .Where(r => r.Identifier.ValueText == local.Name && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(r, c.Ct).Symbol, local)).ToList();
            if (refs.Any(IsWritten)) throw new Refusal("VariableWritten", $"'{local.Name}' is assigned after its declaration; only a variable that is never written can be inlined.");
            if (HasComments(declStmt)) throw new Refusal("Comments", "The declaration has comments that would be lost.");
            var stable = IsStable(init, scope.Parent ?? scope, c.Model, c.Ct);
            if (!stable)
            {
                if (refs.Count != 1)
                    throw new Refusal("SideEffects", refs.Count == 0
                        ? $"'{local.Name}' is unused, but its initializer may have side effects."
                        : $"The initializer of '{local.Name}' may have side effects or change value; it can only be inlined into a single use in the next statement.");
                var use = refs[0];
                var useStmt = use.Ancestors().OfType<StatementSyntax>().First(s => s.Parent == scope);
                var siblings = scope is BlockSyntax b ? b.Statements : ((SwitchSectionSyntax)scope).Statements;
                if (siblings.IndexOf(useStmt) != siblings.IndexOf(declStmt) + 1)
                    throw new Refusal("SideEffects", $"The initializer of '{local.Name}' may have side effects; it can only be inlined into the statement right after the declaration.");
                var stopAt = use.Ancestors().OfType<StatementSyntax>().First();
                if (ConditionallyEvaluated(use, useStmt) || stopAt != useStmt && stopAt.Ancestors().Contains(useStmt) && ConditionallyEvaluated(stopAt, useStmt))
                    throw new Refusal("EvaluationOrder", "The use is evaluated conditionally or repeatedly; inlining would change how often the initializer runs.");
                if (useStmt.DescendantNodes().Any(n => n.SpanStart < use.SpanStart && !n.Span.Contains(use.Span) && IsImpure(n)))
                    throw new Refusal("EvaluationOrder", "Something with possible side effects runs before the use in its statement; inlining would change the evaluation order.");
            }
            var declaredType = local.Type;
            var natural = c.Model.GetTypeInfo(init, c.Ct).Type;
            ExpressionSyntax value = init.WithoutTrivia();
            if (natural == null || !SymbolEqualityComparer.Default.Equals(natural, declaredType))
            {
                var shown = DisplayLocalType(c, declaredType, declStmt.SpanStart) ?? throw new Refusal("AnonymousType", "The variable's type cannot be written.");
                value = SyntaxFactory.CastExpression(SyntaxFactory.ParseTypeName(shown), IsPrimary(value) ? value : SyntaxFactory.ParenthesizedExpression(value));
            }
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var r in refs)
            {
                var postfix = r.Parent is MemberAccessExpressionSyntax or ElementAccessExpressionSyntax or ConditionalAccessExpressionSyntax or InvocationExpressionSyntax or PostfixUnaryExpressionSyntax;
                var needsParens = !IsPrimary(value) && !(value is CastExpressionSyntax && !postfix)
                    && r.Parent is not (ArgumentSyntax or EqualsValueClauseSyntax or ReturnStatementSyntax or ArrowExpressionClauseSyntax or ExpressionStatementSyntax)
                    && !(r.Parent is AssignmentExpressionSyntax a && a.Right == r);
                editor.ReplaceNode(r, (needsParens ? SyntaxFactory.ParenthesizedExpression(value) : value).WithTriviaFrom(r));
            }
            editor.RemoveNode(declStmt, SyntaxRemoveOptions.KeepUnbalancedDirectives);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    private static bool IsPrimary(ExpressionSyntax e) => e is IdentifierNameSyntax or LiteralExpressionSyntax or MemberAccessExpressionSyntax or InvocationExpressionSyntax
        or ElementAccessExpressionSyntax or ParenthesizedExpressionSyntax or ThisExpressionSyntax or ObjectCreationExpressionSyntax or TypeOfExpressionSyntax
        or DefaultExpressionSyntax or InterpolatedStringExpressionSyntax or GenericNameSyntax;

    // ------------------------------------------------------------------ introduce local variable

    private static Func<Task<Document>>? Introduce(Ctx c, bool all)
    {
        var node = c.Root.FindNode(c.Span, getInnermostNodeForTie: true);
        while (node.Parent != null && node.Parent.Span == node.Span && node is not ExpressionSyntax) node = node.Parent;
        while (node is ExpressionSyntax && node.Parent is ExpressionSyntax pp && pp.Span == node.Span) node = pp;
        if (node is not ExpressionSyntax expr || expr.Span != c.Span) return null;
        if (expr is IdentifierNameSyntax or LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression or (int)SyntaxKind.DefaultLiteralExpression }
            or AssignmentExpressionSyntax or DeclarationExpressionSyntax or ThrowExpressionSyntax || expr.Parent is NameColonSyntax || expr.Parent is MemberAccessExpressionSyntax { Name: var nm } && nm == expr)
            return null;
        var stmt = expr.Ancestors().OfType<StatementSyntax>().FirstOrDefault();
        if (stmt == null || stmt.Parent is not (BlockSyntax or SwitchSectionSyntax) || stmt is LocalFunctionStatementSyntax) return null;
        var type = c.Model.GetTypeInfo(expr, c.Ct).Type;
        if (type == null || type.SpecialType == SpecialType.System_Void || type is IErrorTypeSymbol
            || c.Model.GetSymbolInfo(expr, c.Ct).Symbol is INamespaceOrTypeSymbol)
            return null;
        if (all && !(IsStable(expr, stmt.Parent!.Parent ?? stmt.Parent!, c.Model, c.Ct))) return null;
        return () =>
        {
            CheckIntroducibleBefore(c, expr, stmt);
            var name = SuggestName(c, expr, type, stmt);
            var occurrences = new List<ExpressionSyntax> { expr };
            if (all)
            {
                var block = stmt.Parent!;
                var siblings = block is BlockSyntax bb ? bb.Statements : ((SwitchSectionSyntax)block).Statements;
                foreach (var s in siblings.Skip(siblings.IndexOf(stmt)))
                    foreach (var e in s.DescendantNodesAndSelf().OfType<ExpressionSyntax>())
                        if (e != expr && SyntaxFactory.AreEquivalent(e, expr) && !occurrences.Any(o => o.Span.Contains(e.Span) || e.Span.Contains(o.Span))
                            && !e.Ancestors().Any(a => a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax) && !(e.Parent is AssignmentExpressionSyntax asg && asg.Left == e))
                            occurrences.Add(e);
            }
            var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
            foreach (var o in occurrences) editor.ReplaceNode(o, SyntaxFactory.IdentifierName(name).WithTriviaFrom(o));
            var decl = SyntaxFactory.LocalDeclarationStatement(SyntaxFactory.VariableDeclaration(SyntaxFactory.IdentifierName("var"),
                    SyntaxFactory.SingletonSeparatedList(SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(name)).WithInitializer(SyntaxFactory.EqualsValueClause(expr.WithoutTrivia())))))
                .WithAdditionalAnnotations(Formatter.Annotation);
            editor.InsertBefore(stmt, decl);
            return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
        };
    }

    /// <summary>Refuses when evaluating <paramref name="expr"/> before <paramref name="stmt"/> could change what the code does.</summary>
    private static void CheckIntroducibleBefore(Ctx c, ExpressionSyntax expr, StatementSyntax stmt)
    {
        if (ConditionallyEvaluated(expr, stmt) || expr.Ancestors().TakeWhile(a => a != stmt).Any(a => a is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None }))
            throw new Refusal("EvaluationOrder", "The expression is evaluated conditionally, repeatedly or by reference; introducing a variable would change that.");
        var inLoopHead = stmt is WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax
            || stmt is ForEachStatementSyntax fe && !fe.Expression.Span.Contains(expr.Span)
            || stmt is UsingStatementSyntax or FixedStatementSyntax or LockStatementSyntax;
        if (inLoopHead)
            throw new Refusal("EvaluationOrder", "The expression is part of a loop or resource statement whose evaluation would change.");
        if (expr.Ancestors().Any(a => a is AttributeArgumentSyntax or CaseSwitchLabelSyntax or ConstantPatternSyntax) || c.Model.GetConstantValue(expr, c.Ct).HasValue && stmt is LocalDeclarationStatementSyntax { IsConst: true })
            throw new Refusal("ConstantContext", "The expression must stay constant here.");
        if (stmt.DescendantNodes().Any(n => n.SpanStart < expr.SpanStart && !n.Span.Contains(expr.Span) && IsImpure(n) && n.Span.End <= expr.SpanStart)
            && !CodeFacts.IsSideEffectFree(expr, c.Model, c.Ct) && !IsPureOperators(expr, c.Model, c.Ct))
            throw new Refusal("EvaluationOrder", "Something with possible side effects runs before the expression in its statement; moving it first would change the evaluation order.");
    }

    private static string SuggestName(Ctx c, ExpressionSyntax expr, ITypeSymbol type, StatementSyntax stmt)
    {
        var name = SuggestBaseName(expr, type);
        var member = stmt.Ancestors().FirstOrDefault(a => a is MemberDeclarationSyntax or LocalFunctionStatementSyntax) ?? stmt.Parent!;
        var taken = new HashSet<string>(member.DescendantNodes().Select(n => n switch
        {
            VariableDeclaratorSyntax v => v.Identifier.ValueText,
            SingleVariableDesignationSyntax s => s.Identifier.ValueText,
            ParameterSyntax p => p.Identifier.ValueText,
            ForEachStatementSyntax f => f.Identifier.ValueText,
            CatchDeclarationSyntax cd => cd.Identifier.ValueText,
            LocalFunctionStatementSyntax lf => lf.Identifier.ValueText,
            _ => "",
        }), StringComparer.Ordinal);
        bool Free(string n) => !taken.Contains(n) && c.Model.LookupSymbols(stmt.SpanStart, name: n).IsEmpty;
        var candidate = name;
        for (var i = 2; !Free(candidate); i++) candidate = name + i;
        return candidate;
    }

    /// <summary>A camelCase name for the value of <paramref name="expr"/> (from the called member, the type or the kind of value); not a keyword.</summary>
    private static string SuggestBaseName(ExpressionSyntax expr, ITypeSymbol type)
    {
        string? baseName = expr switch
        {
            InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } => ma.Name.Identifier.ValueText,
            InvocationExpressionSyntax { Expression: IdentifierNameSyntax id } => id.Identifier.ValueText,
            MemberAccessExpressionSyntax ma2 => ma2.Name.Identifier.ValueText,
            ObjectCreationExpressionSyntax oc => type.Name,
            _ => null,
        };
        if (baseName != null && baseName.StartsWith("Get", StringComparison.Ordinal) && baseName.Length > 3 && char.IsUpper(baseName[3])) baseName = baseName[3..];
        if (string.IsNullOrEmpty(baseName) || !char.IsLetter(baseName[0]))
            baseName = type.SpecialType switch
            {
                SpecialType.System_String => "text",
                SpecialType.System_Boolean => "flag",
                SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_Double or SpecialType.System_Decimal or SpecialType.System_Single => "value",
                _ => type is IArrayTypeSymbol ? "items" : type.Name is { Length: > 0 } n && char.IsLetter(n[0]) && !type.IsTupleType ? (type.TypeKind == TypeKind.Interface && n.Length > 1 && n[0] == 'I' && char.IsUpper(n[1]) ? n[1..] : n) : "value",
            };
        var name = char.ToLowerInvariant(baseName[0]) + baseName[1..];
        if (SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None || SyntaxFacts.GetContextualKeywordKind(name) is SyntaxKind.VarKeyword) name += "Value";
        return name;
    }
}
