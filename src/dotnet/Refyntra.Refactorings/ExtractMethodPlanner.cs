using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Extract Method: moves a selection of whole statements (or one expression) of a method, constructor, accessor, local
/// function or lambda body into a new private method of the same type, and calls it from where the selection was.
/// Roslyn's data-flow analysis decides the parameters (values that flow in), the return value (one variable that flows
/// out, or the value of the expression), out/ref parameters (several variables that flow out) and the locals the new
/// method needs; control-flow analysis decides whether the selection returns. The method is static when the selection
/// does not use the instance, async when it awaits, and generic when it uses type parameters of the enclosing method.
/// Refused honestly: partial statements, jumps out of or into the selection (break, continue, goto), selections that
/// return on some paths and fall through on others, yield, unsafe code, local functions declared in the selection, ref
/// locals, anonymous types, out/ref values in async code, assignment targets, constant contexts, constructor
/// initializers, top-level statements and expression trees. The compilation delta must be clean. Never writes files.
/// </summary>
public static class ExtractMethodPlanner
{
    public const string ActionId = "csharp.extractMethod";

    private static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    /// <summary>True when the position is inside the body of a member of a type (where Extract Method can apply).</summary>
    public static async Task<bool> InsideBodyAsync(Snapshot snapshot, string path, int line, int character, CancellationToken ct)
    {
        var doc = DocumentOf(snapshot, path);
        if (doc == null) return false;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (line < 0 || line >= text.Lines.Count) return false;
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var token = root!.FindToken(Math.Min(text.Lines[line].Start + character, text.Length > 0 ? text.Length - 1 : 0));
        var body = token.Parent?.AncestorsAndSelf().FirstOrDefault(a => a is BlockSyntax or ArrowExpressionClauseSyntax);
        return body != null && Container(body) != null;
    }

    private static Document? DocumentOf(Snapshot snapshot, string path) =>
        snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);

    /// <summary>The member of a type whose body contains <paramref name="node"/> (null at top level or outside a body).</summary>
    private static MemberDeclarationSyntax? Container(SyntaxNode node)
    {
        var member = node.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().FirstOrDefault(m => m.Parent is TypeDeclarationSyntax);
        if (member is not (BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax)) return null;
        if (member.Parent is InterfaceDeclarationSyntax) return null;
        var inBody = node.AncestorsAndSelf().Any(a => a is BlockSyntax or ArrowExpressionClauseSyntax && a.Ancestors().Contains(member));
        return inBody ? member : null;
    }

    private sealed class Refusal : Exception
    {
        public string Reason { get; }
        public Refusal(string reason, string message) : base(message) => Reason = reason;
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, string path, int startLine, int startChar, int endLine, int endChar, string name, CancellationToken ct)
    {
        try
        {
            return await PrepareCoreAsync(snapshot, path, startLine, startChar, endLine, endChar, name, ct).ConfigureAwait(false);
        }
        catch (Refusal r)
        {
            return RenameOutcome.Unavailable(r.Reason, r.Message);
        }
    }

    private static async Task<RenameOutcome> PrepareCoreAsync(Snapshot snapshot, string path, int startLine, int startChar, int endLine, int endChar, string name, CancellationToken ct)
    {
        if (!CodeFacts.IsValidIdentifier(name)) throw new Refusal("InvalidIdentifier", $"'{name}' is not a valid method name.");
        var doc = DocumentOf(snapshot, path) ?? throw new Refusal("NoDocument", "The file is not a C# document of the loaded solution.");
        if (SymbolFacts.IsGeneratedTree(snapshot.Solution, (await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false))!, ct))
            throw new Refusal("GeneratedCode", "The selection is in generated code.");
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        var root = (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var model = (await doc.GetSemanticModelAsync(ct).ConfigureAwait(false))!;
        int Pos(int l, int c) => l < 0 || l >= text.Lines.Count ? throw new Refusal("InvalidSelection", "The selection is outside the file.") : Math.Min(text.Lines[l].Start + c, text.Lines[l].End);
        int start = Pos(startLine, startChar), end = Pos(endLine, endChar);
        if (end < start) (start, end) = (end, start);
        while (start < end && char.IsWhiteSpace(text[start])) start++;
        while (end > start && char.IsWhiteSpace(text[end - 1])) end--;
        if (start == end) throw new Refusal("EmptySelection", "Select the statements or the expression to extract.");
        var span = TextSpan.FromBounds(start, end);
        var probe = root.FindNode(span, getInnermostNodeForTie: true);
        if (Container(probe) == null)
            throw probe.AncestorsAndSelf().Any(a => a is GlobalStatementSyntax)
                ? new Refusal("TopLevelStatements", "Extracting from top-level statements is not supported.")
                : new Refusal("NotInMethodBody", "The selection is not inside the body of a method, constructor, accessor or local function of a type.");

        // ---------------- statements or one expression
        var statements = SelectedStatements(root, span);
        ExpressionSyntax? expression = null;
        if (statements == null)
        {
            var node = root.FindNode(span, getInnermostNodeForTie: true);
            while (node.Parent != null && node.Parent.Span == node.Span && node is not ExpressionSyntax) node = node.Parent;
            if (node is ExpressionSyntax e && e.Span == span) expression = e;
            else throw new Refusal("InvalidSelection", "Select whole statements of one block, or exactly one expression.");
        }
        SyntaxNode first = (SyntaxNode?)statements?[0] ?? expression!;
        var member = Container(first) ?? throw new Refusal(first.Ancestors().Any(a => a is GlobalStatementSyntax) ? "TopLevelStatements" : "NotInMethodBody",
            first.Ancestors().Any(a => a is GlobalStatementSyntax) ? "Extracting from top-level statements is not supported." : "The selection is not inside the body of a method, constructor, accessor or local function of a type.");
        var typeDecl = (TypeDeclarationSyntax)member.Parent!;
        var regionNodes = statements != null ? statements.SelectMany(s => s.DescendantNodesAndSelf()).ToList() : expression!.DescendantNodesAndSelf().ToList();
        CheckUnsupported(first, regionNodes, expression, model, ct);

        // ---------------- data flow and control flow
        DataFlowAnalysis flow = statements != null ? model.AnalyzeDataFlow(statements[0], statements[^1])! : model.AnalyzeDataFlow(expression!)!;
        if (flow == null || !flow.Succeeded) throw new Refusal("AnalysisFailed", "Roslyn could not analyse the data flow of the selection.");
        if (!flow.UnsafeAddressTaken.IsEmpty) throw new Refusal("UnsafeCode", "The selection takes the address of a variable.");
        var returnsMode = false;
        if (statements != null)
        {
            var control = model.AnalyzeControlFlow(statements[0], statements[^1]);
            if (control == null || !control.Succeeded) throw new Refusal("AnalysisFailed", "Roslyn could not analyse the control flow of the selection.");
            if (!control.EntryPoints.IsEmpty) throw new Refusal("GotoIntoSelection", "A goto outside the selection jumps to a label inside it.");
            var jumps = control.ExitPoints.Where(x => x is not ReturnStatementSyntax).ToList();
            if (jumps.Count > 0)
                throw new Refusal("JumpOutOfSelection", $"The selection contains {Describe(jumps[0])}, which leaves the selection; a method cannot do that.");
            if (!control.ReturnStatements.IsEmpty)
            {
                if (control.EndPointIsReachable)
                    throw new Refusal("MultipleExits", "The selection returns on some paths and continues on others; extract a part that always returns or never returns.");
                returnsMode = true;
            }
        }

        var enclosing = model.GetEnclosingSymbol(first.SpanStart, ct) as IMethodSymbol;
        var isAsync = regionNodes.Any(n => IsAwait(n) && !InNestedFunction(n, first, statements, expression));
        var declared = flow.VariablesDeclared.ToHashSet(SymbolEqualityComparer.Default);
        bool IsThis(ISymbol s) => s is IParameterSymbol { IsThis: true };
        var ins = flow.DataFlowsIn.Where(s => !IsThis(s)).ToList();
        var outs = flow.DataFlowsOut.Where(s => !IsThis(s))
            .Concat(flow.WrittenInside.Intersect(flow.CapturedOutside, SymbolEqualityComparer.Default).Where(s => !declared.Contains(s)))
            .Concat(flow.VariablesDeclared.Where(s => flow.ReadOutside.Contains(s, SymbolEqualityComparer.Default) || flow.WrittenOutside.Contains(s, SymbolEqualityComparer.Default)))
            .Distinct(SymbolEqualityComparer.Default).OrderBy(s => s.Locations.FirstOrDefault()?.SourceSpan.Start ?? 0).ToList();
        if (expression != null && outs.Count > 0) throw new Refusal("ExpressionWritesVariables", $"The expression assigns {outs[0].Name}, which is used after it; select whole statements instead.");
        if (returnsMode && outs.Count > 0) throw new Refusal("MultipleExits", $"The selection returns, but {outs[0].Name} is also used after it.");
        foreach (var v in ins.Concat(outs))
        {
            if (v is ILocalSymbol { IsRef: true } || v is IParameterSymbol { RefKind: RefKind.Ref or RefKind.Out } && v.ContainingSymbol is IMethodSymbol m && m.IsAsync)
                throw new Refusal("RefLocal", $"{v.Name} is a ref variable; extracting code that uses it is not supported.");
            var t = TypeOf(v);
            if (t == null || t.TypeKind == TypeKind.Error) throw new Refusal("UnknownType", $"The type of {v.Name} is not known.");
            if (ContainsAnonymous(t)) throw new Refusal("AnonymousType", $"{v.Name} has an anonymous type, which cannot be written as a parameter type.");
        }
        // Variables declared outside, written inside, whose value matters only inside: the new method declares them.
        var locals = flow.WrittenInside.Concat(flow.ReadInside).Where(s => !IsThis(s) && !declared.Contains(s) && s is ILocalSymbol or IParameterSymbol)
            .Where(s => !ins.Contains(s, SymbolEqualityComparer.Default) && !outs.Contains(s, SymbolEqualityComparer.Default))
            .Distinct(SymbolEqualityComparer.Default).ToList();
        foreach (var v in locals)
            if (TypeOf(v) is not { } lt || lt.TypeKind == TypeKind.Error || ContainsAnonymous(lt)) throw new Refusal("UnknownType", $"The type of {v.Name} cannot be written.");

        // ---------------- shape: return value, out/ref parameters
        ISymbol? returnVar = null;
        var outParams = new List<(ISymbol v, bool isRef)>();
        if (statements != null && !returnsMode)
        {
            if (outs.Count == 1) returnVar = outs[0];
            else if (outs.Count > 1)
            {
                if (isAsync) throw new Refusal("AsyncOutParameters", $"The selection awaits and sets {outs.Count} variables used after it ({string.Join(", ", outs.Select(o => o.Name))}); an async method cannot have out or ref parameters.");
                foreach (var o in outs) outParams.Add((o, ins.Contains(o, SymbolEqualityComparer.Default)));
            }
        }
        var valueParams = ins.Where(v => !outParams.Any(o => SymbolEqualityComparer.Default.Equals(o.v, v)))
            .OrderBy(v => v.Locations.FirstOrDefault()?.SourceSpan.Start ?? 0).ToList();

        // ---------------- return type
        string returnType;
        ITypeSymbol? exprType = null;
        if (expression != null)
        {
            var info = model.GetTypeInfo(expression, ct);
            exprType = info.Type ?? info.ConvertedType;
            if (exprType == null || exprType.TypeKind == TypeKind.Error) throw new Refusal("UnknownType", "The type of the expression is not known (a lambda, method group or typeless literal).");
            if (ContainsAnonymous(exprType)) throw new Refusal("AnonymousType", "The expression has an anonymous type.");
            if (exprType.IsRefLikeType && isAsync) throw new Refusal("RefLikeType", "A ref struct value cannot be returned from an async method.");
            returnType = exprType.SpecialType == SpecialType.System_Void ? "void" : Display(exprType, model, first.SpanStart);
        }
        else if (returnsMode)
        {
            var rt = enclosing?.ReturnType;
            if (enclosing == null || rt == null) throw new Refusal("UnknownType", "The return type of the enclosing method is not known.");
            if (enclosing.IsAsync)
                rt = rt is INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } g && g.Name is "Task" or "ValueTask" ? g.TypeArguments[0] : null;
            if (enclosing.IsAsync && rt == null) returnType = "void";
            else returnType = rt!.SpecialType == SpecialType.System_Void ? "void" : Display(rt, model, first.SpanStart);
            if (enclosing.ReturnsByRef || enclosing.ReturnsByRefReadonly) throw new Refusal("RefReturn", "The enclosing method returns by reference.");
        }
        else returnType = returnVar != null ? Display(VariableType(returnVar, regionNodes, model, ct), model, first.SpanStart) : "void";
        var task = TaskName(model, first.SpanStart);
        var declaredReturn = isAsync ? (returnType == "void" ? task : $"{task}<{returnType}>") : returnType;

        // ---------------- static, generic
        var containingStatic = member.Modifiers.Any(SyntaxKind.StaticKeyword);
        var isStatic = containingStatic || !UsesInstance(regionNodes, model, ct) && !flow.ReadInside.Concat(flow.WrittenInside).Any(IsThis);
        var typeParams = MethodTypeParameters(regionNodes, ins.Concat(outs).Concat(locals), exprType, model, ct);
        var typeParamText = typeParams.Count == 0 ? "" : "<" + string.Join(", ", typeParams.Select(t => t.Name)) + ">";
        if (typeParams.Select(t => t.Name).Distinct().Count() != typeParams.Count) throw new Refusal("TypeParameterConflict", "Type parameters of different enclosing methods have the same name.");
        var constraints = Constraints(typeParams, ct);

        // ---------------- name collisions
        var containingType = model.GetDeclaredSymbol(typeDecl, ct) as INamedTypeSymbol;
        for (var t = containingType; t != null; t = t.BaseType)
            if (t.GetMembers(name).Any())
                throw new Refusal("NameInUse", $"{t.Name} already has a member named {name}; choose another name (an overload could change which method existing calls use).");
        if (member.DescendantTokens().Any(tk => tk.IsKind(SyntaxKind.IdentifierToken) && tk.ValueText == name))
            throw new Refusal("NameInUse", $"{name} is already used in {Describe(member)}; choose another name.");

        // ---------------- texts
        var eol = CreateFilePlanner.LineBreak(text.ToString());
        var memberIndent = IndentOf(text, member.SpanStart);
        var unit = IndentUnit(text, member, memberIndent);
        var bodyIndent = memberIndent + unit;
        var pos = first.SpanStart;
        string P(ISymbol v) => Display(VariableType(v, regionNodes, model, ct), model, pos);
        var parameters = new List<string>();
        foreach (var v in valueParams) parameters.Add($"{P(v)} {v.Name}");
        foreach (var (v, isRef) in outParams) parameters.Add($"{(isRef ? "ref" : "out")} {P(v)} {v.Name}");
        var args = new List<string>();
        foreach (var v in valueParams) args.Add(v.Name);
        foreach (var (v, isRef) in outParams) args.Add(isRef ? $"ref {v.Name}" : declared.Contains(v) ? $"out var {v.Name}" : $"out {v.Name}");
        var call = $"{name}{typeParamText}({string.Join(", ", args)})";
        if (isAsync) call = "await " + call;

        var body = new StringBuilder();
        foreach (var v in locals) body.Append(bodyIndent).Append($"{P(v)} {v.Name};").Append(eol);
        if (returnVar != null && !declared.Contains(returnVar) && !ins.Contains(returnVar, SymbolEqualityComparer.Default))
            body.Append(bodyIndent).Append($"{P(returnVar)} {returnVar.Name};").Append(eol);
        string callSite;
        if (statements != null)
        {
            var outDeclared = outParams.Where(o => declared.Contains(o.v)).Select(o => o.v).ToList();
            body.Append(Reindent(text, root, statements[0].SpanStart, statements[^1].Span.End, bodyIndent, eol, DeclarationEdits(statements, outDeclared)));
            body.Append(eol);
            if (returnVar != null) body.Append(bodyIndent).Append($"return {returnVar.Name};").Append(eol);
            var stmtIndent = IndentOf(text, statements[0].SpanStart);
            if (returnsMode) callSite = returnType == "void" ? $"{call};{eol}{stmtIndent}return;" : $"return {call};";
            else if (returnVar != null) callSite = declared.Contains(returnVar) ? $"var {returnVar.Name} = {call};" : $"{returnVar.Name} = {call};";
            else callSite = $"{call};";
            if (statements.Count > 1 && statements[0].Parent is not (BlockSyntax or SwitchSectionSyntax))
                throw new Refusal("InvalidSelection", "Select whole statements of one block.");
            if (callSite.Contains(eol) && statements[0].Parent is not (BlockSyntax or SwitchSectionSyntax))
                throw new Refusal("EmbeddedStatement", "The statement is the body of an if/loop without braces; add braces first.");
        }
        else
        {
            var exprText = text.ToString(expression!.Span);
            body.Append(bodyIndent).Append(returnType == "void" ? $"{exprText};" : $"return {exprText};").Append(eol);
            callSite = isAsync && NeedsParentheses(expression) ? $"({call})" : call;
        }
        var modifiers = "private " + (isStatic ? "static " : "") + (isAsync ? "async " : "");
        var method = new StringBuilder();
        method.Append(eol).Append(memberIndent).Append(modifiers).Append(declaredReturn).Append(' ').Append(name).Append(typeParamText)
            .Append('(').Append(string.Join(", ", parameters)).Append(')');
        foreach (var c in constraints) method.Append(eol).Append(bodyIndent).Append(c);
        method.Append(eol).Append(memberIndent).Append('{').Append(eol).Append(body).Append(memberIndent).Append('}').Append(eol);

        var replaceSpan = statements != null ? TextSpan.FromBounds(statements[0].SpanStart, statements[^1].Span.End) : expression!.Span;
        var insertAt = member.FullSpan.End;
        if (insertAt > 0 && text[insertAt - 1] != '\n') throw new Refusal("Layout", "The member ends on a line with other code; extracting next to it is not supported.");
        var newText = text.WithChanges(new TextChange(replaceSpan, callSite), new TextChange(new TextSpan(insertAt, 0), method.ToString()));
        var after = snapshot.Solution;
        foreach (var id in snapshot.Session.DocumentIdsForPath(path))
            if (after.GetDocument(id) != null) after = after.WithDocumentText(id, newText, PreservationMode.PreserveIdentity);

        // ---------------- the call must bind to the new method
        var newDoc = after.GetDocument(doc.Id)!;
        var newRoot = (await newDoc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var newModel = (await newDoc.GetSemanticModelAsync(ct).ConfigureAwait(false))!;
        var callNode = newRoot.DescendantNodes(new TextSpan(replaceSpan.Start, callSite.Length)).OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(i => i.Expression is SimpleNameSyntax sn && sn.Identifier.ValueText == name);
        var bound = callNode != null ? newModel.GetSymbolInfo(callNode, ct).Symbol as IMethodSymbol : null;
        var delta = callSite.Length - replaceSpan.Length;
        if (bound == null || bound.Name != name || !bound.Locations.Any(l => l.IsInSource && l.SourceSpan.Start > insertAt + delta))
            throw new Refusal("CompilationErrors", "The call to the new method does not compile or does not bind to it.");

        var limitations = new List<string>
        {
            $"The new method {name} is private and placed after {Describe(member)}; its body keeps the selected code (indentation adjusted).",
        };
        if (isAsync) limitations.Add($"{name} is async and returns {declaredReturn}; the call is awaited without ConfigureAwait.");
        var evidence = new List<(string, Location?)>
        {
            ($"Data flow (Roslyn): parameters {(valueParams.Count == 0 ? "none" : string.Join(", ", valueParams.Select(v => v.Name)))}; " +
             (returnsMode ? "the selection always returns" : returnVar != null ? $"returns {returnVar.Name}" : expression != null ? "returns the expression value" : "no value flows out") +
             (outParams.Count > 0 ? $"; {string.Join(", ", outParams.Select(o => (o.isRef ? "ref " : "out ") + o.v.Name))}" : "") +
             (isStatic ? "; static (no instance use)" : "; instance (uses this)"), Location.Create(root.SyntaxTree, replaceSpan)),
        };
        return await SolutionPlanBuilder.BuildAsync(snapshot, after, new SolutionPlanBuilder.Options(ActionId, $"Extract method {name}", limitations, evidence, new List<string>(),
            new[] { doc.Project.Id }), ct).ConfigureAwait(false);
    }

    /// <summary>Whole statements of one block (or switch section) covering the selection exactly (trivia aside), or null.</summary>
    private static List<StatementSyntax>? SelectedStatements(SyntaxNode root, TextSpan span)
    {
        var inside = root.DescendantNodes(span).OfType<StatementSyntax>().Where(s => span.Contains(s.Span)).ToList();
        var top = inside.Where(s => !inside.Any(o => o != s && o.Span.Contains(s.Span))).OrderBy(s => s.SpanStart).ToList();
        if (top.Count == 0) return null;
        var parent = top[0].Parent;
        if (top.Any(s => s.Parent != parent)) return null;
        if (top[0].SpanStart != span.Start || top[^1].Span.End != span.End) return null;
        if (parent is BlockSyntax block)
        {
            var i = block.Statements.IndexOf(top[0]);
            if (block.Statements.Skip(i).Take(top.Count).Zip(top).Any(p => p.First != p.Second)) return null;
        }
        else if (parent is SwitchSectionSyntax section)
        {
            var i = section.Statements.IndexOf(top[0]);
            if (section.Statements.Skip(i).Take(top.Count).Zip(top).Any(p => p.First != p.Second)) return null;
        }
        else if (top.Count > 1) return null;
        if (top.Count == 1 && top[0] is BlockSyntax && parent is not BlockSyntax) return null;
        return top;
    }

    private static void CheckUnsupported(SyntaxNode first, List<SyntaxNode> region, ExpressionSyntax? expression, SemanticModel model, CancellationToken ct)
    {
        foreach (var n in region)
        {
            switch (n)
            {
                case YieldStatementSyntax: throw new Refusal("Yield", "The selection contains yield; an iterator cannot be split.");
                case LocalFunctionStatementSyntax:
                    throw new Refusal("LocalFunctionInSelection", "The selection declares a local function.");
                case UnsafeStatementSyntax or FixedStatementSyntax or PointerTypeSyntax or StackAllocArrayCreationExpressionSyntax or ImplicitStackAllocArrayCreationExpressionSyntax:
                    throw new Refusal("UnsafeCode", "The selection contains unsafe code or stackalloc.");
                case LabeledStatementSyntax: throw new Refusal("Label", "The selection contains a label.");
            }
        }
        var ancestors = first.Ancestors().ToList();
        if (ancestors.Any(a => a is ConstructorInitializerSyntax)) throw new Refusal("ConstructorInitializer", "Extracting from a constructor initializer is not supported.");
        if (ancestors.Any(a => a is QueryExpressionSyntax)) throw new Refusal("QueryExpression", "Extracting from a query expression is not supported (range variables).");
        if (ancestors.Any(a => a is AttributeSyntax or ParameterSyntax or CaseSwitchLabelSyntax or ConstantPatternSyntax or EqualsValueClauseSyntax { Parent: ParameterSyntax }))
            throw new Refusal("ConstantContext", "The selection is in a constant context.");
        if (first.Ancestors().OfType<LambdaExpressionSyntax>().Any(l => model.GetTypeInfo(l, ct).ConvertedType is INamedTypeSymbol { Name: "Expression" }))
            throw new Refusal("ExpressionTree", "The selection is inside an expression tree lambda.");
        if (first.Ancestors().Any(a => a is MemberDeclarationSyntax m && m.Modifiers.Any(SyntaxKind.UnsafeKeyword)))
            throw new Refusal("UnsafeCode", "The selection is in unsafe code.");
        if (expression == null) return;
        var parent = expression.Parent;
        if (parent is AssignmentExpressionSyntax a && a.Left == expression) throw new Refusal("AssignmentTarget", "The expression is assigned to; it cannot be replaced by a call.");
        if (parent is PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax && (parent.IsKind(SyntaxKind.PreIncrementExpression) || parent.IsKind(SyntaxKind.PreDecrementExpression)
            || parent.IsKind(SyntaxKind.PostIncrementExpression) || parent.IsKind(SyntaxKind.PostDecrementExpression) || parent.IsKind(SyntaxKind.AddressOfExpression)))
            throw new Refusal("AssignmentTarget", "The expression is modified in place; it cannot be replaced by a call.");
        if (parent is ArgumentSyntax arg && !arg.RefKindKeyword.IsKind(SyntaxKind.None)) throw new Refusal("AssignmentTarget", "The expression is passed by reference.");
        if (parent is RefExpressionSyntax) throw new Refusal("AssignmentTarget", "The expression is a ref expression.");
        if (expression is DeclarationExpressionSyntax || expression.DescendantNodes().Any(d => d is DeclarationExpressionSyntax or DeclarationPatternSyntax or RecursivePatternSyntax { Designation: not null } or VarPatternSyntax))
            throw new Refusal("ExpressionDeclaresVariables", "The expression declares variables; select whole statements instead.");
        if (parent is InvocationExpressionSyntax inv && inv.Expression == expression) throw new Refusal("NotAValue", "The selection is a method name, not a value.");
        if (parent is MemberAccessExpressionSyntax ma && ma.Name == expression) throw new Refusal("NotAValue", "Select the whole member access.");
        if (parent is ArgumentSyntax { Parent.Parent: InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } } })
            throw new Refusal("NotAValue", "The argument of nameof is a name, not a value.");
        if (parent is InitializerExpressionSyntax { RawKind: (int)SyntaxKind.ObjectInitializerExpression }) throw new Refusal("NotAValue", "Select a value, not an initializer member.");
        var symbol = model.GetSymbolInfo(expression, ct).Symbol;
        if (symbol is INamespaceOrTypeSymbol || expression is TypeSyntax && symbol is null && model.GetTypeInfo(expression, ct).Type == null)
            throw new Refusal("NotAValue", "The selection is a type or namespace name, not a value.");
        if (symbol is IMethodSymbol && expression is SimpleNameSyntax or MemberAccessExpressionSyntax or MemberBindingExpressionSyntax)
            throw new Refusal("NotAValue", "The selection is a method group.");
        if (expression is ThrowExpressionSyntax) throw new Refusal("NotAValue", "A throw expression has no value.");
    }

    private static bool IsAwait(SyntaxNode n) =>
        n is AwaitExpressionSyntax || n is ForEachStatementSyntax { AwaitKeyword.RawKind: not 0 } || n is UsingStatementSyntax { AwaitKeyword.RawKind: not 0 }
        || n is LocalDeclarationStatementSyntax { AwaitKeyword.RawKind: not 0 } || n is ForEachVariableStatementSyntax { AwaitKeyword.RawKind: not 0 };

    /// <summary>True when <paramref name="n"/> is inside a lambda or local function that is itself inside the selection.</summary>
    private static bool InNestedFunction(SyntaxNode n, SyntaxNode first, List<StatementSyntax>? statements, ExpressionSyntax? expression)
    {
        foreach (var a in n.Ancestors())
        {
            if (statements != null && statements.Contains(a)) return false;
            if (expression != null && a == expression) return false;
            if (a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)
                return statements != null ? statements.Any(s => s.Span.Contains(a.Span)) : expression!.Span.Contains(a.Span);
        }
        return false;
    }

    /// <summary>
    /// The type of a variable for the new signature: a nullable-annotated reference type (every <c>var</c> local is one)
    /// that the selection only sees as not-null (flow state) is written without '?', so the new method gets no new
    /// nullable warnings.
    /// </summary>
    private static ITypeSymbol VariableType(ISymbol v, List<SyntaxNode> region, SemanticModel model, CancellationToken ct)
    {
        var t = TypeOf(v)!;
        if (t.NullableAnnotation != NullableAnnotation.Annotated || t.IsValueType) return t;
        var uses = region.OfType<IdentifierNameSyntax>().Where(id => id.Identifier.ValueText == v.Name && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id, ct).Symbol, v)).ToList();
        NullableFlowState? state = null;
        if (uses.Count > 0) state = uses.All(u => model.GetTypeInfo(u, ct).Nullability.FlowState == NullableFlowState.NotNull) ? NullableFlowState.NotNull : NullableFlowState.MaybeNull;
        else if (v.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) is VariableDeclaratorSyntax { Initializer: { } init } && region.Contains(init.Value))
            state = model.GetTypeInfo(init.Value, ct).Nullability.FlowState;
        return state == NullableFlowState.NotNull ? t.WithNullableAnnotation(NullableAnnotation.NotAnnotated) : t;
    }

    private static ITypeSymbol? TypeOf(ISymbol s) => s switch { ILocalSymbol l => l.Type, IParameterSymbol p => p.Type, _ => null };

    private static bool ContainsAnonymous(ITypeSymbol t) => t.IsAnonymousType
        || t is INamedTypeSymbol n && n.TypeArguments.Any(ContainsAnonymous)
        || t is IArrayTypeSymbol a && ContainsAnonymous(a.ElementType);

    private static string Display(ITypeSymbol t, SemanticModel model, int position) => t.ToMinimalDisplayString(model, position, TypeFormat);

    /// <summary>"Task" when that name means System.Threading.Tasks.Task here, else the qualified name.</summary>
    private static string TaskName(SemanticModel model, int position) =>
        model.LookupNamespacesAndTypes(position, name: "Task").OfType<INamedTypeSymbol>().Any(s => s.Arity == 0 && s.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
            ? "Task" : "System.Threading.Tasks.Task";

    /// <summary>True when the selection uses the instance: this/base, or an instance member reached without a receiver.</summary>
    private static bool UsesInstance(List<SyntaxNode> region, SemanticModel model, CancellationToken ct)
    {
        foreach (var n in region)
        {
            if (n is ThisExpressionSyntax or BaseExpressionSyntax) return true;
            if (n is not SimpleNameSyntax name) continue;
            if (name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name) continue;
            if (name.Parent is MemberBindingExpressionSyntax) continue;
            if (name.Parent is NameColonSyntax or NameEqualsSyntax) continue;
            if (name.Parent is AssignmentExpressionSyntax { Parent: InitializerExpressionSyntax } asg && asg.Left == name) continue;
            if (name.Parent is QualifiedNameSyntax q && q.Right == name) continue;
            var info = model.GetSymbolInfo(name, ct);
            var symbols = info.Symbol != null ? new[] { info.Symbol } : info.CandidateSymbols.ToArray();
            foreach (var s in symbols)
                if (s is IFieldSymbol or IPropertySymbol or IMethodSymbol { MethodKind: MethodKind.Ordinary } or IEventSymbol && !s.IsStatic && s.ContainingType != null) return true;
            if (info.Symbol == null && info.CandidateSymbols.IsEmpty && model.GetTypeInfo(name, ct).Type == null) return true; // unresolved: assume instance
        }
        return false;
    }

    /// <summary>Type parameters of enclosing methods (or local functions) that the selection or its variables use.</summary>
    private static List<ITypeParameterSymbol> MethodTypeParameters(List<SyntaxNode> region, IEnumerable<ISymbol> variables, ITypeSymbol? exprType, SemanticModel model, CancellationToken ct)
    {
        var found = new List<ITypeParameterSymbol>();
        void Walk(ITypeSymbol? t)
        {
            switch (t)
            {
                case ITypeParameterSymbol tp when tp.TypeParameterKind == TypeParameterKind.Method:
                    if (!found.Contains(tp, SymbolEqualityComparer.Default)) found.Add(tp);
                    break;
                case INamedTypeSymbol n:
                    foreach (var a in n.TypeArguments) Walk(a);
                    break;
                case IArrayTypeSymbol a:
                    Walk(a.ElementType);
                    break;
                case IPointerTypeSymbol p:
                    Walk(p.PointedAtType);
                    break;
            }
        }
        foreach (var v in variables) Walk(TypeOf(v));
        Walk(exprType);
        foreach (var n in region)
        {
            if (n is TypeSyntax ts) Walk(model.GetTypeInfo(ts, ct).Type);
            if (n is ExpressionSyntax es) Walk(model.GetTypeInfo(es, ct).Type);
            if (n is SimpleNameSyntax sn && model.GetSymbolInfo(sn, ct).Symbol is IMethodSymbol { IsGenericMethod: true } gm)
                foreach (var a in gm.TypeArguments) Walk(a);
        }
        // Declared inside the selection (a generic lambda/local function inside it): not a parameter of the new method.
        return found.Where(tp => !tp.Locations.Any(l => region.Any(r => r.Span.Contains(l.SourceSpan) && r.SyntaxTree == l.SourceTree))).ToList();
    }

    private static List<string> Constraints(List<ITypeParameterSymbol> typeParams, CancellationToken ct)
    {
        var result = new List<string>();
        foreach (var tp in typeParams)
        {
            var decl = tp.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct);
            var owner = decl?.Parent?.Parent;
            var clauses = owner switch
            {
                MethodDeclarationSyntax m => m.ConstraintClauses,
                LocalFunctionStatementSyntax l => l.ConstraintClauses,
                _ => default,
            };
            foreach (var c in clauses)
                if (c.Name.Identifier.ValueText == tp.Name) result.Add(c.WithoutTrivia().ToString());
        }
        return result;
    }

    /// <summary>Edits inside the selected statements: declarations of variables that become out parameters turn into assignments.</summary>
    private static List<TextChange> DeclarationEdits(List<StatementSyntax> statements, List<ISymbol> outDeclared)
    {
        var edits = new List<TextChange>();
        foreach (var v in outDeclared)
        {
            var declarator = v.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as VariableDeclaratorSyntax;
            if (declarator?.Parent is not VariableDeclarationSyntax { Parent: LocalDeclarationStatementSyntax stmt } decl || !statements.Any(s => s.Span.Contains(stmt.Span)))
                throw new Refusal("UnsupportedDeclaration", $"{v.Name} is declared in a way that cannot become an out parameter (pattern, out variable, deconstruction or loop variable).");
            if (decl.Variables.Count != 1 || stmt.UsingKeyword.RawKind != 0 || stmt.Modifiers.Count > 0)
                throw new Refusal("UnsupportedDeclaration", $"{v.Name} is declared together with other variables or as using/const; split the declaration first.");
            if (declarator.Initializer == null) edits.Add(new TextChange(stmt.Span, ""));
            else edits.Add(new TextChange(TextSpan.FromBounds(decl.Type.SpanStart, declarator.Identifier.SpanStart), ""));
        }
        return edits;
    }

    /// <summary>
    /// The text of [start, end) with <paramref name="edits"/> applied, every line moved from its indentation to
    /// <paramref name="indent"/> (relative indentation kept); lines inside multi-line string literals are left alone.
    /// </summary>
    private static string Reindent(SourceText text, SyntaxNode root, int start, int end, string indent, string eol, List<TextChange> edits)
    {
        var firstLine = text.Lines.GetLineFromPosition(start);
        var original = IndentOf(text, start);
        var protectedLines = new HashSet<int>();
        foreach (var token in root.DescendantTokens(TextSpan.FromBounds(start, end)))
        {
            if (!(token.IsKind(SyntaxKind.StringLiteralToken) || token.IsKind(SyntaxKind.InterpolatedStringTextToken) || token.IsKind(SyntaxKind.MultiLineRawStringLiteralToken)
                || token.IsKind(SyntaxKind.InterpolatedMultiLineRawStringStartToken) || token.IsKind(SyntaxKind.InterpolatedRawStringEndToken))) continue;
            var l1 = text.Lines.GetLineFromPosition(token.SpanStart).LineNumber;
            var l2 = text.Lines.GetLineFromPosition(token.Span.End).LineNumber;
            for (var l = l1 + 1; l <= l2; l++) protectedLines.Add(l);
        }
        foreach (var node in root.DescendantNodes(TextSpan.FromBounds(start, end)).Where(n => n is InterpolatedStringExpressionSyntax))
        {
            var l1 = text.Lines.GetLineFromPosition(node.SpanStart).LineNumber;
            var l2 = text.Lines.GetLineFromPosition(node.Span.End).LineNumber;
            for (var l = l1 + 1; l <= l2; l++) protectedLines.Add(l);
        }
        var sb = new StringBuilder();
        var lastLine = text.Lines.GetLineFromPosition(end).LineNumber;
        for (var ln = firstLine.LineNumber; ln <= lastLine; ln++)
        {
            var line = text.Lines[ln];
            var lineStart = ln == firstLine.LineNumber ? start : line.Start;
            var lineEnd = ln == lastLine ? end : line.End;
            var content = ApplyEdits(text, lineStart, lineEnd, edits);
            if (ln > firstLine.LineNumber) sb.Append(eol);
            if (ln == firstLine.LineNumber) { sb.Append(indent).Append(content); continue; }
            if (protectedLines.Contains(ln)) { sb.Append(content); continue; }
            if (content.Trim().Length == 0) continue;
            if (content.StartsWith(original, StringComparison.Ordinal)) sb.Append(indent).Append(content.Substring(original.Length));
            else sb.Append(indent).Append(content.TrimStart());
        }
        return sb.ToString();
    }

    private static string ApplyEdits(SourceText text, int start, int end, List<TextChange> edits)
    {
        var sb = new StringBuilder();
        var pos = start;
        foreach (var e in edits.Where(e => e.Span.Start >= start && e.Span.End <= end).OrderBy(e => e.Span.Start))
        {
            sb.Append(text.ToString(TextSpan.FromBounds(pos, e.Span.Start))).Append(e.NewText);
            pos = e.Span.End;
        }
        foreach (var e in edits.Where(e => e.Span.Start < end && e.Span.End > start && !(e.Span.Start >= start && e.Span.End <= end)))
            throw new Refusal("UnsupportedDeclaration", "A declaration that becomes an out parameter spans several lines; split it first.");
        sb.Append(text.ToString(TextSpan.FromBounds(pos, end)));
        return sb.ToString();
    }

    private static string IndentOf(SourceText text, int position)
    {
        var line = text.Lines.GetLineFromPosition(position);
        var i = line.Start;
        while (i < line.End && (text[i] == ' ' || text[i] == '\t')) i++;
        return text.ToString(TextSpan.FromBounds(line.Start, i));
    }

    private static string IndentUnit(SourceText text, MemberDeclarationSyntax member, string memberIndent)
    {
        var inner = member.DescendantTokens().Skip(1).FirstOrDefault(t => text.Lines.GetLineFromPosition(t.SpanStart).LineNumber != text.Lines.GetLineFromPosition(member.SpanStart).LineNumber
            && IndentOf(text, t.SpanStart).Length > memberIndent.Length && IndentOf(text, t.SpanStart).StartsWith(memberIndent, StringComparison.Ordinal));
        if (inner.RawKind != 0)
        {
            var indent = IndentOf(text, inner.SpanStart);
            if (indent.StartsWith(memberIndent, StringComparison.Ordinal) && indent.Length > memberIndent.Length) return indent.Substring(memberIndent.Length, Math.Min(indent.Length - memberIndent.Length, indent.Contains('\t') ? 1 : 4));
        }
        return memberIndent.Contains('\t') ? "\t" : "    ";
    }

    private static bool NeedsParentheses(ExpressionSyntax e) =>
        e.Parent is not (ExpressionStatementSyntax or EqualsValueClauseSyntax or ArgumentSyntax or ReturnStatementSyntax or ArrowExpressionClauseSyntax
            or ParenthesizedExpressionSyntax or InitializerExpressionSyntax) && !(e.Parent is AssignmentExpressionSyntax a && a.Right == e);

    private static string Describe(SyntaxNode n) => n switch
    {
        BreakStatementSyntax => "break",
        ContinueStatementSyntax => "continue",
        GotoStatementSyntax => "goto",
        YieldStatementSyntax => "yield",
        MethodDeclarationSyntax m => m.Identifier.ValueText,
        ConstructorDeclarationSyntax c => c.Identifier.ValueText + " constructor",
        PropertyDeclarationSyntax p => p.Identifier.ValueText,
        IndexerDeclarationSyntax => "the indexer",
        EventDeclarationSyntax ev => ev.Identifier.ValueText,
        OperatorDeclarationSyntax o => "operator " + o.OperatorToken.Text,
        _ => n.Kind().ToString(),
    };
}
