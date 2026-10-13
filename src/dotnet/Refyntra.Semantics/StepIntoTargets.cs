using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>
/// One call of the stopped statement for Smart Step Into (protocol 1.14, <c>code/stepIntoTargets</c>).
/// <see cref="BreakAt"/> is where the callee's body starts (its first statement, an expression body, a constructor
/// initializer or the closing brace of an empty body); null when Refyntra cannot step into it, with <see cref="Reason"/>:
/// <c>metadata</c> (no source in the solution), <c>noBody</c> (abstract, interface, extern, partial without an
/// implementation: the target is decided at run time), <c>delegate</c> (a delegate or lambda call), <c>implicit</c>
/// (a compiler-generated constructor).
/// </summary>
public sealed record StepIntoTarget(
    string Label,
    string Detail,
    string Kind,
    LinePositionSpan CallSpan,
    string? FilePath,
    LinePosition? BreakAt,
    string? Reason,
    bool IsVirtual);

/// <summary>
/// The calls of the stopped statement in the order they run (arguments before the call that receives them), the
/// statement itself and the next statement of the same block (the place where the stepped-over statement ends).
/// </summary>
public sealed record StepIntoTargetsModel(List<StepIntoTarget> Targets, LinePositionSpan Statement, LinePosition? NextStatement);

public static class StepIntoTargets
{
    public static class Reasons
    {
        public const string Metadata = "metadata", NoBody = "noBody", Delegate = "delegate", Implicit = "implicit";
    }

    private static readonly SymbolDisplayFormat LabelFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameOnly,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeParameters,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeParamsRefOut,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    /// <summary>
    /// The statement at the stopped position (0-based line and character, as the debugger reports the sequence point)
    /// and its calls; null when no statement is there.
    /// </summary>
    public static async Task<StepIntoTargetsModel?> ComputeAsync(Document doc, LinePosition at, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (root == null || model == null || at.Line < 0 || at.Line >= text.Lines.Count) return null;
        var line = text.Lines[at.Line];
        var pos = Math.Min(line.Start + Math.Max(0, at.Character), line.End);
        // The first non-blank character from the stopped column on (debuggers report the start of the sequence point).
        while (pos < line.End && char.IsWhiteSpace(text[pos])) pos++;
        var node = Stopped(root.FindToken(pos).Parent);
        if (node == null) return null;

        var calls = new List<ExpressionSyntax>();
        foreach (var n in node.DescendantNodesAndSelf(c => c == node || !(c is StatementSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)))
        {
            if (n != node && n is StatementSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax) continue;
            if (n is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax) calls.Add((ExpressionSyntax)n);
        }
        // Execution order: an argument (or receiver) ends before the call that uses it.
        calls.Sort((a, b) => a.Span.End != b.Span.End ? a.Span.End.CompareTo(b.Span.End) : b.Span.Start.CompareTo(a.Span.Start));

        var targets = new List<StepIntoTarget>();
        foreach (var call in calls)
        {
            ct.ThrowIfCancellationRequested();
            var info = model.GetSymbolInfo(call, ct);
            var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
            if (symbol is not IMethodSymbol method) continue; // nameof, dynamic, errors
            var span = text.Lines.GetLinePositionSpan(call.Span);
            var detail = Shorten(call.ToString());
            if (method.MethodKind is MethodKind.DelegateInvoke or MethodKind.AnonymousFunction)
            {
                targets.Add(new StepIntoTarget(method.ContainingType.ToDisplayString(LabelFormat) + ".Invoke", detail, "delegate", span, null, null, Reasons.Delegate, false));
                continue;
            }
            var target = (method.ReducedFrom ?? method).OriginalDefinition;
            target = target.PartialImplementationPart ?? target;
            var kind = target.MethodKind == MethodKind.Constructor ? "constructor" : "method";
            var label = target.ToDisplayString(LabelFormat);
            var isVirtual = (target.IsVirtual || target.IsOverride || target.IsAbstract) && !target.ContainingType.IsSealed && !target.IsSealed;
            var source = target.DeclaringSyntaxReferences.Select(r => r.GetSyntax(ct)).FirstOrDefault(s => s.SyntaxTree.FilePath is { Length: > 0 } && doc.Project.Solution.GetDocumentIdsWithFilePath(s.SyntaxTree.FilePath).Length > 0);
            if (source == null)
            {
                var reason = target.Locations.Any(l => l.IsInMetadata) ? Reasons.Metadata : target.IsImplicitlyDeclared ? Reasons.Implicit : Reasons.Metadata;
                targets.Add(new StepIntoTarget(label, detail, kind, span, null, null, reason, isVirtual));
                continue;
            }
            var bodyStart = BodyStart(source);
            if (bodyStart == null)
            {
                targets.Add(new StepIntoTarget(label, detail, kind, span, source.SyntaxTree.FilePath, null, Reasons.NoBody, isVirtual));
                continue;
            }
            var calleeText = source.SyntaxTree.GetText(ct);
            targets.Add(new StepIntoTarget(label, detail, kind, span, source.SyntaxTree.FilePath, calleeText.Lines.GetLinePosition(bodyStart.Value), null, isVirtual));
        }

        var statement = text.Lines.GetLinePositionSpan(node.Span);
        LinePosition? next = Next(node) is { } nx ? text.Lines.GetLinePosition(nx) : null;
        return new StepIntoTargetsModel(targets, statement, next);
    }

    /// <summary>The innermost statement (not a block) or expression body that contains the token.</summary>
    private static SyntaxNode? Stopped(SyntaxNode? n)
    {
        for (; n != null; n = n.Parent)
        {
            if (n is BlockSyntax) return null;
            if (n is StatementSyntax or ArrowExpressionClauseSyntax) return n;
            if (n is ConstructorInitializerSyntax) return n;
        }
        return null;
    }

    /// <summary>Where the debugger first stops in a member body (the position of its first sequence point).</summary>
    private static int? BodyStart(SyntaxNode decl)
    {
        switch (decl)
        {
            case ConstructorDeclarationSyntax { Initializer: { } init }:
                return init.SpanStart;
            case BaseMethodDeclarationSyntax m:
                return Block(m.Body) ?? m.ExpressionBody?.Expression.SpanStart;
            case LocalFunctionStatementSyntax lf:
                return Block(lf.Body) ?? lf.ExpressionBody?.Expression.SpanStart;
            case AccessorDeclarationSyntax a:
                return Block(a.Body) ?? a.ExpressionBody?.Expression.SpanStart;
            default:
                return null; // a positional record's primary constructor, a type: no body to stop in
        }
        static int? Block(BlockSyntax? b) => b == null ? null : b.Statements.Count > 0 ? b.Statements[0].SpanStart : b.CloseBraceToken.SpanStart;
    }

    /// <summary>The statement that runs after this one in the same block (or top-level statements), if any.</summary>
    private static int? Next(SyntaxNode node)
    {
        if (node is StatementSyntax s && s.Parent is GlobalStatementSyntax g && g.Parent is CompilationUnitSyntax cu)
        {
            var globals = cu.Members.OfType<GlobalStatementSyntax>().ToList();
            var i = globals.IndexOf(g);
            return i >= 0 && i + 1 < globals.Count ? globals[i + 1].SpanStart : null;
        }
        if (node is StatementSyntax st && st.Parent is BlockSyntax block)
        {
            var i = block.Statements.IndexOf(st);
            if (i >= 0 && i + 1 < block.Statements.Count) return block.Statements[i + 1].SpanStart;
            // The last statement of a member body: the closing brace is where the method returns.
            return block.Parent is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax ? block.CloseBraceToken.SpanStart : null;
        }
        return null;
    }

    private static string Shorten(string s)
    {
        var one = string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return one.Length <= 80 ? one : one.Substring(0, 79) + "…";
    }
}
