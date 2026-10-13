using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Workspaces;

namespace Refyntra.Semantics.Rules;

/// <summary>A quick fix of an inspection result: an edit action (csharp.edit.fix.*) computed at the result's position.</summary>
public sealed record InspectionFix(string ActionId, string Title);

/// <summary>One inspection result in a document.</summary>
public sealed record InspectionFinding(string Id, TextSpan Span, string Message, IReadOnlyList<InspectionFix> Fixes, IReadOnlyList<(TextSpan Span, string Message)> Related);

/// <summary>
/// Refyntra's own C# inspections OR1002–OR1010 (docs/rules/OR10xx.md). Each rule is a precise semantic check of one
/// syntax node (Roslyn public APIs, no analyzers), conservative by design: when ownership, control flow or the
/// actual type cannot be proven from the method itself, the rule stays silent. Results honour
/// <c>#pragma warning disable ORxxxx</c> and <c>[SuppressMessage("…", "ORxxxx…")]</c>.
///
/// Incrementality: results are per document, cached by the document's text version and its project's dependent
/// semantic version (signature-level changes of the project or its references); a keystroke re-analyses one document.
/// The client asks only for the documents it has open.
/// </summary>
public static class CodeInspections
{
    public const string SyncOverAsync = "OR1002";
    public const string AsyncVoid = "OR1003";
    public const string DiscardedTask = "OR1004";
    public const string UndisposedLocal = "OR1005";
    public const string MultipleEnumeration = "OR1006";
    public const string ConcatInLoop = "OR1007";
    public const string WhereThenOperator = "OR1008";
    public const string RedundantMaterialization = "OR1009";
    public const string FormatWithoutArguments = "OR1010";

    public static readonly IReadOnlyList<string> Ids = new[]
    {
        SyncOverAsync, AsyncVoid, DiscardedTask, UndisposedLocal, MultipleEnumeration, ConcatInLoop, WhereThenOperator, RedundantMaterialization, FormatWithoutArguments,
    };

    public const string FixPrefix = "csharp.edit.fix.";
    public const string FixAwaitSyncCall = FixPrefix + "awaitSyncCall";
    public const string FixAsyncTask = FixPrefix + "asyncVoidToTask";
    public const string FixAddAwait = FixPrefix + "addAwait";
    public const string FixDiscard = FixPrefix + "discardTask";
    public const string FixUsingVar = FixPrefix + "usingVar";
    public const string FixMaterialize = FixPrefix + "materialize";
    public const string FixStringBuilder = FixPrefix + "stringBuilder";
    public const string FixPredicateOverload = FixPrefix + "predicateOverload";
    public const string FixRemoveMaterialization = FixPrefix + "removeMaterialization";
    public const string FixRemoveFormat = FixPrefix + "removeFormat";

    /// <summary>Titles of the fixes (also used by Fix in scope).</summary>
    public static readonly IReadOnlyDictionary<string, string> FixTitles = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [FixAwaitSyncCall] = "Use 'await'",
        [FixAsyncTask] = "Change 'async void' to 'async Task'",
        [FixAddAwait] = "Add 'await'",
        [FixDiscard] = "Discard the task explicitly ('_ =')",
        [FixUsingVar] = "Dispose with a 'using' declaration",
        [FixMaterialize] = "Materialize once with 'ToList()'",
        [FixStringBuilder] = "Use a StringBuilder",
        [FixPredicateOverload] = "Pass the predicate to the operator",
        [FixRemoveMaterialization] = "Remove the redundant copy",
        [FixRemoveFormat] = "Use the string directly",
    };

    public static string HelpUri(string id) => $"https://github.com/refyntra/refyntra/blob/main/docs/rules/{id}.md";

    // ------------------------------------------------------------------ cache

    private sealed record Entry(VersionStamp Text, VersionStamp Semantic, IReadOnlyList<InspectionFinding> Findings);

    private sealed class SessionCache
    {
        public readonly ConcurrentDictionary<DocumentId, Entry> Documents = new();
        public long Computed;
        public long Reused;
    }

    private static readonly ConditionalWeakTable<WorkspaceSession, SessionCache> Sessions = new();

    /// <summary>For tests and logs: documents analysed and results reused in this session.</summary>
    public static (long computed, long reused) Stats(WorkspaceSession session)
    {
        var c = Sessions.GetValue(session, _ => new SessionCache());
        return (Interlocked.Read(ref c.Computed), Interlocked.Read(ref c.Reused));
    }

    /// <summary>The inspection results of one document of the snapshot (cached; generated code has none).</summary>
    public static async Task<IReadOnlyList<InspectionFinding>> AnalyzeDocumentAsync(Snapshot snapshot, Document doc, CancellationToken ct)
    {
        if (doc.Project.Language != LanguageNames.CSharp) return Array.Empty<InspectionFinding>();
        var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return Array.Empty<InspectionFinding>();
        var cache = Sessions.GetValue(snapshot.Session, _ => new SessionCache());
        var textVersion = await doc.GetTextVersionAsync(ct).ConfigureAwait(false);
        var semantic = await doc.Project.GetDependentSemanticVersionAsync(ct).ConfigureAwait(false);
        if (cache.Documents.TryGetValue(doc.Id, out var e) && e.Text == textVersion && e.Semantic == semantic)
        {
            Interlocked.Increment(ref cache.Reused);
            return e.Findings;
        }
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var findings = Analyze(model!, root!, null, ct);
        cache.Documents[doc.Id] = new Entry(textVersion, semantic, findings);
        Interlocked.Increment(ref cache.Computed);
        return findings;
    }

    // ------------------------------------------------------------------ analysis

    /// <summary>
    /// The results of the document (or only of the nodes that intersect <paramref name="within"/>), suppressions applied.
    /// </summary>
    public static IReadOnlyList<InspectionFinding> Analyze(SemanticModel model, SyntaxNode root, TextSpan? within, CancellationToken ct)
    {
        var a = new Analyzer(model, root, ct);
        // DescendantNodes(span) skips everything for an empty span: walk the one-character span at its position instead.
        var walk = within is { IsEmpty: true } e ? new TextSpan(e.Start, e.Start < root.FullSpan.End ? 1 : 0) : within;
        var nodes = walk is { } w ? root.DescendantNodesAndSelf(w) : root.DescendantNodes();
        foreach (var n in nodes)
        {
            ct.ThrowIfCancellationRequested();
            a.Visit(n);
            // At a position, a use of a local or parameter also checks its declaration (OR1006 reports at a use).
            if (walk != null && n is IdentifierNameSyntax id && model.GetSymbolInfo(id, ct).Symbol is ILocalSymbol or IParameterSymbol
                && model.GetSymbolInfo(id, ct).Symbol!.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) is { } decl && decl.SyntaxTree == root.SyntaxTree)
                a.VisitDeclaration(decl);
        }
        var list = a.Findings.Where(f => within is not { } w2 || f.Span.IntersectsWith(w2) || f.Span.Start == w2.Start || f.Span.End == w2.Start)
            .GroupBy(f => (f.Id, f.Span)).Select(g => g.First())
            .Where(f => !a.Suppressed(f.Id, f.Span))
            .OrderBy(f => f.Span.Start).ThenBy(f => f.Id, StringComparer.Ordinal).ToList();
        return list;
    }

    /// <summary>The result of rule <paramref name="id"/> whose span contains <paramref name="position"/>, or null.</summary>
    public static InspectionFinding? At(SemanticModel model, SyntaxNode root, int position, string fixActionId, CancellationToken ct) =>
        Analyze(model, root, new TextSpan(position, 0), ct)
            .Where(f => f.Fixes.Any(x => x.ActionId == fixActionId) && f.Span.Start <= position && position <= f.Span.End)
            .OrderByDescending(f => f.Span.Start).FirstOrDefault();

    // ------------------------------------------------------------------ shared facts (also used by the fixes)

    /// <summary>Task, Task&lt;T&gt;, ValueTask, ValueTask&lt;T&gt; of System.Threading.Tasks.</summary>
    public static bool IsTaskLike(ITypeSymbol? t, out bool generic)
    {
        generic = false;
        if (t is not INamedTypeSymbol n || n.Name is not ("Task" or "ValueTask") || n.Arity > 1) return false;
        if (n.ContainingNamespace?.ToDisplayString() != "System.Threading.Tasks") return false;
        generic = n.Arity == 1;
        return true;
    }

    public static bool IsTaskLike(ITypeSymbol? t) => IsTaskLike(t, out _);

    /// <summary>The function whose body contains <paramref name="n"/> (a GlobalStatement for top-level code), or null.</summary>
    public static SyntaxNode? FunctionOf(SyntaxNode n) =>
        n.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax or AccessorDeclarationSyntax
            or PropertyDeclarationSyntax or IndexerDeclarationSyntax or GlobalStatementSyntax or FieldDeclarationSyntax or EnumMemberDeclarationSyntax or ParameterSyntax or AttributeSyntax);

    public static bool IsAsyncFunction(SyntaxNode? fn) => fn switch
    {
        MethodDeclarationSyntax m => m.Modifiers.Any(SyntaxKind.AsyncKeyword),
        LocalFunctionStatementSyntax f => f.Modifiers.Any(SyntaxKind.AsyncKeyword),
        AnonymousFunctionExpressionSyntax a => !a.AsyncKeyword.IsKind(SyntaxKind.None),
        GlobalStatementSyntax => true,
        _ => false,
    };

    /// <summary>True when an 'await' at <paramref name="n"/> would be legal syntax-wise (not in lock, query, unsafe code or a catch filter).</summary>
    public static bool AwaitAllowedAt(SyntaxNode n, SyntaxNode fn)
    {
        foreach (var a in n.Ancestors())
        {
            if (a == fn) break;
            if (a is LockStatementSyntax or QueryExpressionSyntax or UnsafeStatementSyntax or CatchFilterClauseSyntax) return false;
        }
        if (fn is MemberDeclarationSyntax md && md.Modifiers.Any(SyntaxKind.UnsafeKeyword)) return false;
        if (fn.Ancestors().OfType<TypeDeclarationSyntax>().Any(t => t.Modifiers.Any(SyntaxKind.UnsafeKeyword))) return false;
        return true;
    }

    /// <summary>Statements and expressions of the function itself (not of nested lambdas or local functions).</summary>
    public static IEnumerable<SyntaxNode> OwnNodes(SyntaxNode fn) =>
        fn.DescendantNodes(n => n == fn || n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax));

    public static bool IsEnumerable(IMethodSymbol? m) =>
        m != null && (m.ReducedFrom ?? m).ContainingType is { Name: "Enumerable" } t && t.ContainingNamespace?.ToDisplayString() == "System.Linq";

    /// <summary>LINQ operators that enumerate their source immediately.</summary>
    public static readonly HashSet<string> ImmediateOperators = new(StringComparer.Ordinal)
    {
        "Any", "All", "Count", "LongCount", "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "ElementAt", "ElementAtOrDefault",
        "Contains", "Sum", "Min", "Max", "MinBy", "MaxBy", "Average", "Aggregate", "ToList", "ToArray", "ToDictionary", "ToHashSet", "ToLookup", "SequenceEqual",
    };

    private static readonly HashSet<string> PredicateOperators = new(StringComparer.Ordinal)
    {
        "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "Any", "Count", "LongCount",
    };

    private static readonly HashSet<string> DeferredOperators = new(StringComparer.Ordinal)
    {
        "Where", "Select", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "Skip", "Take", "Distinct", "Reverse", "Cast", "OfType",
    };

    private static readonly HashSet<string> MutatingMethods = new(StringComparer.Ordinal)
    {
        "Add", "AddRange", "Remove", "RemoveAt", "RemoveAll", "RemoveRange", "Clear", "Insert", "InsertRange", "Push", "Pop", "Enqueue", "Dequeue",
        "TryAdd", "TryRemove", "TryDequeue", "TryPop", "Sort", "Reverse", "AddOrUpdate", "GetOrAdd", "Set", "ExceptWith", "IntersectWith", "UnionWith", "SymmetricExceptWith",
    };

    private static bool InNamespace(ISymbol? s, string ns) => s?.ContainingNamespace?.ToDisplayString() == ns;

    private static bool InheritsFrom(ITypeSymbol? t, string fullName)
    {
        for (var x = t; x != null; x = x.BaseType)
            if (x.ToDisplayString() == fullName) return true;
        return false;
    }

    private static bool Implements(ITypeSymbol t, string fullName) =>
        t.ToDisplayString() == fullName || t.AllInterfaces.Any(i => i.ToDisplayString() == fullName);

    private static bool IsCollection(ITypeSymbol? t) =>
        t is IArrayTypeSymbol || (t != null && (t.SpecialType == SpecialType.System_String
            || t.AllInterfaces.Concat(t is INamedTypeSymbol { TypeKind: TypeKind.Interface } nt ? new[] { nt } : Array.Empty<INamedTypeSymbol>())
                .Any(i => i.OriginalDefinition.ToDisplayString() is "System.Collections.Generic.ICollection<T>" or "System.Collections.Generic.IReadOnlyCollection<T>" or "System.Collections.ICollection")));

    /// <summary>The identifiers in <paramref name="scope"/> bound to <paramref name="symbol"/>.</summary>
    public static List<IdentifierNameSyntax> References(SemanticModel model, SyntaxNode scope, ISymbol symbol, CancellationToken ct) =>
        scope.DescendantNodes().OfType<IdentifierNameSyntax>()
            .Where(id => id.Identifier.ValueText == symbol.Name && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id, ct).Symbol, symbol)).ToList();

    private static bool IsWrite(IdentifierNameSyntax id) => id.Parent switch
    {
        AssignmentExpressionSyntax a => a.Left == id,
        PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax => true,
        ArgumentSyntax arg => !arg.RefKindKeyword.IsKind(SyntaxKind.None),
        _ => false,
    };

    private static bool InsideNestedFunction(SyntaxNode n, SyntaxNode fn)
    {
        foreach (var a in n.Ancestors())
        {
            if (a == fn) return false;
            if (a is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax) return true;
        }
        return false;
    }

    /// <summary>The body of a function (block or arrow expression), or the global statement.</summary>
    public static SyntaxNode? BodyOf(SyntaxNode fn) => fn switch
    {
        BaseMethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody,
        LocalFunctionStatementSyntax f => (SyntaxNode?)f.Body ?? f.ExpressionBody,
        AnonymousFunctionExpressionSyntax a => a.Body,
        AccessorDeclarationSyntax a => (SyntaxNode?)a.Body ?? a.ExpressionBody,
        GlobalStatementSyntax g => g.Parent,
        _ => fn,
    };

    /// <summary>
    /// True when <paramref name="a"/> and <paramref name="b"/> can never both run in one call: different arms of an
    /// if/else, conditional expression or switch, or <paramref name="a"/> sits in a branch that ends with return/throw.
    /// </summary>
    public static bool Exclusive(SyntaxNode a, SyntaxNode b)
    {
        var ancestorsOfA = new HashSet<SyntaxNode>(a.AncestorsAndSelf());
        SyntaxNode? cb = b;
        SyntaxNode? lca = null;
        foreach (var x in b.AncestorsAndSelf())
        {
            if (ancestorsOfA.Contains(x)) { lca = x; break; }
            cb = x;
        }
        if (lca == null) return false;
        var ca = a.AncestorsAndSelf().TakeWhile(x => x != lca).LastOrDefault();
        if (ca == null || cb == null || ca == cb) return false;
        switch (lca)
        {
            case IfStatementSyntax ifs when (ca == ifs.Statement && cb == ifs.Else) || (cb == ifs.Statement && ca == ifs.Else):
                return true;
            case ConditionalExpressionSyntax ce when (ca == ce.WhenTrue && cb == ce.WhenFalse) || (cb == ce.WhenTrue && ca == ce.WhenFalse):
                return true;
            case SwitchStatementSyntax when ca is SwitchSectionSyntax && cb is SwitchSectionSyntax:
                return true;
            case SwitchExpressionSyntax when ca is SwitchExpressionArmSyntax && cb is SwitchExpressionArmSyntax:
                return true;
        }
        // The earlier one is in a branch that always leaves the function.
        var (first, _) = a.SpanStart <= b.SpanStart ? (a, b) : (b, a);
        foreach (var x in first.Ancestors())
        {
            if (x == lca) break;
            if (x is BlockSyntax { Parent: IfStatementSyntax or ElseClauseSyntax } blk && blk.Statements.LastOrDefault() is ReturnStatementSyntax or ThrowStatementSyntax) return true;
            if (x is ReturnStatementSyntax or ThrowStatementSyntax && x.Parent is IfStatementSyntax or ElseClauseSyntax) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ the rules

    private sealed class Analyzer
    {
        private readonly SemanticModel _model;
        private readonly SyntaxNode _root;
        private readonly CancellationToken _ct;
        public readonly List<InspectionFinding> Findings = new();
        private List<(int Position, bool Disable, HashSet<string>? Ids)>? _pragmas;

        public Analyzer(SemanticModel model, SyntaxNode root, CancellationToken ct)
        {
            _model = model;
            _root = root;
            _ct = ct;
        }

        private void Report(string id, TextSpan span, string message, params string[] fixes) =>
            Findings.Add(new InspectionFinding(id, span, message, fixes.Select(f => new InspectionFix(f, FixTitles[f])).ToList(), Array.Empty<(TextSpan, string)>()));

        private void Report(string id, TextSpan span, string message, IReadOnlyList<(TextSpan, string)> related, params string[] fixes) =>
            Findings.Add(new InspectionFinding(id, span, message, fixes.Select(f => new InspectionFix(f, FixTitles[f])).ToList(), related));

        public void VisitDeclaration(SyntaxNode declaration) => CheckMultipleEnumeration(declaration);

        public void Visit(SyntaxNode n)
        {
            switch (n)
            {
                case MemberAccessExpressionSyntax ma:
                    CheckSyncOverAsync(ma);
                    break;
                case MethodDeclarationSyntax or LocalFunctionStatementSyntax:
                    CheckAsyncVoid(n);
                    break;
                case ExpressionStatementSyntax es:
                    CheckDiscardedTask(es);
                    CheckConcatInLoop(es);
                    break;
                case LocalDeclarationStatementSyntax ld:
                    CheckUndisposed(ld);
                    foreach (var v in ld.Declaration.Variables) CheckMultipleEnumeration(v);
                    break;
                case ParameterSyntax p:
                    CheckMultipleEnumeration(p);
                    break;
                case InvocationExpressionSyntax inv:
                    CheckWhereThen(inv);
                    CheckRedundantMaterialization(inv);
                    CheckFormat(inv);
                    break;
            }
        }

        // ---------------------------------------------------------------- OR1002 sync over async

        private void CheckSyncOverAsync(MemberAccessExpressionSyntax ma)
        {
            var name = ma.Name.Identifier.ValueText;
            if (name is not ("Result" or "Wait" or "GetResult")) return;
            ExpressionSyntax receiver;
            SyntaxNode node;
            int start;
            string shown;
            if (name == "Result")
            {
                if (ma.Parent is InvocationExpressionSyntax pi && pi.Expression == ma) return;
                if (_model.GetSymbolInfo(ma, _ct).Symbol is not IPropertySymbol prop || !IsTaskLike(prop.ContainingType, out var g) || !g) return;
                if (ma.Parent is AssignmentExpressionSyntax asg && asg.Left == ma) return;
                receiver = ma.Expression;
                node = ma;
                start = ma.OperatorToken.SpanStart;
                shown = ".Result";
            }
            else
            {
                if (ma.Parent is not InvocationExpressionSyntax inv || inv.Expression != ma || inv.ArgumentList.Arguments.Count != 0) return;
                if (_model.GetSymbolInfo(inv, _ct).Symbol is not IMethodSymbol m) return;
                if (name == "Wait")
                {
                    if (m.ContainingType?.Name != "Task" || !InNamespace(m.ContainingType, "System.Threading.Tasks")) return;
                    receiver = ma.Expression;
                    start = ma.OperatorToken.SpanStart;
                    shown = ".Wait()";
                }
                else
                {
                    if (ma.Expression is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "GetAwaiter" } gma, ArgumentList.Arguments.Count: 0 }) return;
                    if (!InNamespace(m.ContainingType, "System.Runtime.CompilerServices") || m.ContainingType.Name is not ("TaskAwaiter" or "ValueTaskAwaiter" or "ConfiguredTaskAwaiter" or "ConfiguredValueTaskAwaiter")) return;
                    receiver = gma.Expression;
                    start = gma.OperatorToken.SpanStart;
                    shown = ".GetAwaiter().GetResult()";
                }
                node = inv;
            }
            var fn = FunctionOf(node);
            if (fn == null) return; // field and attribute initializers: nothing to suggest
            if (CompletedTask(receiver, node, fn)) return;
            var fixes = new List<string>();
            if (AwaitAllowedAt(node, fn))
            {
                if (IsAsyncFunction(fn)) fixes.Add(FixAwaitSyncCall);
                else if (fn is MethodDeclarationSyntax m && CanBecomeAsync(m)) fixes.Add(FixAwaitSyncCall);
            }
            var where = IsAsyncFunction(fn) ? "inside an async function" : "here";
            Report(SyncOverAsync, TextSpan.FromBounds(start, node.Span.End),
                $"'{shown}' blocks the thread until the task completes (sync over async; risks deadlocks and thread-pool starvation); 'await' it {where}.", fixes.ToArray());
        }

        /// <summary>A method whose return type stays the same when it becomes async (it already returns a task).</summary>
        private bool CanBecomeAsync(MethodDeclarationSyntax m)
        {
            if (m.Body == null && m.ExpressionBody == null) return false;
            if (_model.GetDeclaredSymbol(m, _ct) is not IMethodSymbol s || !IsTaskLike(s.ReturnType)) return false;
            if (s.Parameters.Any(p => p.RefKind != RefKind.None) || s.ReturnsByRef) return false;
            return !OwnNodes(m).Any(x => x is YieldStatementSyntax);
        }

        /// <summary>The receiver is a task already known to be complete (awaited, checked or created completed before).</summary>
        private bool CompletedTask(ExpressionSyntax receiver, SyntaxNode node, SyntaxNode fn)
        {
            var r = receiver;
            while (r is ParenthesizedExpressionSyntax p) r = p.Expression;
            if (r is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } cfg }) r = cfg.Expression;
            if (r is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "FromResult" or "FromException" or "FromCanceled" } fr }
                && _model.GetSymbolInfo(r, _ct).Symbol is IMethodSymbol frm && IsTaskLike(frm.ContainingType)) return true;
            if (r is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "CompletedTask" }) return true;
            if (r is not IdentifierNameSyntax id) return false;
            var sym = _model.GetSymbolInfo(id, _ct).Symbol;
            if (sym is not (ILocalSymbol or IParameterSymbol)) return false;
            // A continuation's antecedent (ContinueWith(t => t.Result)) and any lambda parameter: completion is not provable either way.
            if (sym is IParameterSymbol ps && ps.ContainingSymbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LambdaMethod }) return true;
            var scope = BodyOf(fn) ?? fn;
            foreach (var other in References(_model, scope, sym, _ct))
            {
                if (other == id) continue;
                if (other.Parent is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "IsCompleted" or "IsCompletedSuccessfully" or "IsFaulted" or "IsCanceled" or "Status" } om && om.Expression == other) return true;
                if (other.SpanStart < node.SpanStart && other.Ancestors().Any(a => a is AwaitExpressionSyntax)) return true;
                if (other.SpanStart < node.SpanStart && other.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "WaitAll" or "WaitAny" or "WhenAll" or "WhenAny" })) return true;
            }
            return false;
        }

        // ---------------------------------------------------------------- OR1003 async void

        private void CheckAsyncVoid(SyntaxNode n)
        {
            SyntaxTokenList mods;
            TypeSyntax ret;
            SyntaxToken identifier;
            switch (n)
            {
                case MethodDeclarationSyntax m: mods = m.Modifiers; ret = m.ReturnType; identifier = m.Identifier; break;
                case LocalFunctionStatementSyntax f: mods = f.Modifiers; ret = f.ReturnType; identifier = f.Identifier; break;
                default: return;
            }
            if (!mods.Any(SyntaxKind.AsyncKeyword) || ret is not PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.VoidKeyword }) return;
            if (mods.Any(SyntaxKind.PartialKeyword)) return;
            if (_model.GetDeclaredSymbol(n, _ct) is not IMethodSymbol s) return;
            if (s.IsOverride || s.ExplicitInterfaceImplementations.Length > 0) return;
            if (s.ContainingType != null && s.ContainingType.AllInterfaces.SelectMany(i => i.GetMembers()).Any(im => SymbolEqualityComparer.Default.Equals(s.ContainingType.FindImplementationForInterfaceMember(im), s))) return;
            // Event handlers (object sender, XxxEventArgs e) must return void.
            if (s.Parameters.Length == 2 && s.Parameters[0].Type.SpecialType == SpecialType.System_Object
                && (InheritsFrom(s.Parameters[1].Type, "System.EventArgs") || s.Parameters[1].Type.Name.EndsWith("EventArgs", StringComparison.Ordinal))) return;
            Report(AsyncVoid, identifier.Span,
                $"'async void' method '{identifier.ValueText}': callers cannot await it and its exceptions crash the process; return 'Task' (only event handlers need 'async void').", FixAsyncTask);
        }

        // ---------------------------------------------------------------- OR1004 discarded task

        private void CheckDiscardedTask(ExpressionStatementSyntax es)
        {
            var e = es.Expression;
            if (e is not (InvocationExpressionSyntax or ConditionalAccessExpressionSyntax { WhenNotNull: InvocationExpressionSyntax })) return;
            var type = _model.GetTypeInfo(e, _ct).Type;
            if (!IsTaskLike(type)) return;
            var invocation = e is ConditionalAccessExpressionSyntax ca ? (InvocationExpressionSyntax)ca.WhenNotNull : (InvocationExpressionSyntax)e;
            var method = _model.GetSymbolInfo(invocation, _ct).Symbol as IMethodSymbol;
            if (method == null) return;
            // Deliberate starts of background work (documented exclusions).
            if (method.Name is "Run" or "StartNew" or "ContinueWith" && (IsTaskLike(method.ContainingType) || method.ContainingType?.Name == "TaskFactory")) return;
            var fn = FunctionOf(es);
            if (fn == null) return;
            if (IsAsyncFunction(fn))
            {
                // The compiler reports CS4014 for a plain call here; Refyntra adds only what it misses ('?.' calls).
                if (e is InvocationExpressionSyntax) return;
                Report(DiscardedTask, e.Span,
                    $"The task returned by '{method.Name}' is neither awaited nor stored: its exceptions are lost and the work may outlive the caller.",
                    FixDiscard);
                return;
            }
            Report(DiscardedTask, e.Span,
                $"The task returned by '{method.Name}' is discarded in a method that is not async (fire-and-forget): its exceptions are lost and the work may still run after the method returns. Await it, return it, or discard it explicitly.",
                FixDiscard);
        }

        // ---------------------------------------------------------------- OR1005 undisposed local

        private static readonly HashSet<string> HarmlessDisposables = new(StringComparer.Ordinal)
        {
            "System.Threading.Tasks.Task", "System.IO.MemoryStream", "System.IO.StringReader", "System.IO.StringWriter",
            "System.Threading.Timer", "System.Timers.Timer", "System.Data.DataTable", "System.Data.DataSet",
        };

        private static readonly HashSet<string> OwningFactories = new(StringComparer.Ordinal)
        {
            "Open", "OpenRead", "OpenWrite", "OpenText", "Create", "CreateText", "AppendText", "OpenHandle",
        };

        private void CheckUndisposed(LocalDeclarationStatementSyntax ld)
        {
            if (!ld.UsingKeyword.IsKind(SyntaxKind.None) || ld.IsConst || ld.Declaration.Variables.Count != 1) return;
            if (ld.Parent is not (BlockSyntax or GlobalStatementSyntax)) return;
            var v = ld.Declaration.Variables[0];
            var init = v.Initializer?.Value;
            if (init == null) return;
            var created = init is BaseObjectCreationExpressionSyntax;
            if (!created && init is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax fma } fi && OwningFactories.Contains(fma.Name.Identifier.ValueText)
                && _model.GetSymbolInfo(fi, _ct).Symbol is IMethodSymbol fm && fm.ContainingType?.ToDisplayString() == "System.IO.File") created = true;
            if (!created) return;
            if (_model.GetDeclaredSymbol(v, _ct) is not ILocalSymbol local) return;
            var type = _model.GetTypeInfo(init, _ct).Type;
            if (type == null || type.IsRefLikeType || type.TypeKind == TypeKind.Error) return;
            if (!Implements(type, "System.IDisposable")) return;
            for (var t = type; t != null; t = t.BaseType)
                if (HarmlessDisposables.Contains(t.OriginalDefinition.ToDisplayString().Split('<')[0])) return;
            var fn = FunctionOf(ld);
            if (fn == null) return;
            var scope = BodyOf(fn) ?? fn;
            var refs = References(_model, scope, local, _ct);
            if (refs.Count == 0) return;
            foreach (var r in refs)
                if (!IsBorrowingUse(r, fn, type)) return;
            var lang = ((CSharpParseOptions)ld.SyntaxTree.Options).LanguageVersion;
            Report(UndisposedLocal, v.Identifier.Span,
                $"'{local.Name}' ({type.Name}) is created here, never disposed and never handed over; dispose it with 'using'.",
                lang >= LanguageVersion.CSharp8 ? new[] { FixUsingVar } : Array.Empty<string>());
        }

        /// <summary>A use that cannot transfer ownership: a member call or read whose result is void or a plain value.</summary>
        private bool IsBorrowingUse(IdentifierNameSyntax r, SyntaxNode fn, ITypeSymbol ownerType)
        {
            if (InsideNestedFunction(r, fn)) return false;
            if (r.Parent is ConditionalAccessExpressionSyntax cae && cae.Expression == r)
                return cae.WhenNotNull is InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax mb } ci && mb.Name.Identifier.ValueText is not ("Dispose" or "DisposeAsync" or "Close") && PlainResult(ci);
            if (r.Parent is not MemberAccessExpressionSyntax ma || ma.Expression != r) return false;
            if (ma.Name.Identifier.ValueText is "Dispose" or "DisposeAsync" or "Close") return false;
            SyntaxNode use = ma.Parent is InvocationExpressionSyntax inv && inv.Expression == ma ? inv : ma;
            if (use == ma && ma.Parent is AssignmentExpressionSyntax asg && asg.Left == ma) return asg.Parent is ExpressionStatementSyntax;
            return PlainResult(use);
        }

        private bool PlainResult(SyntaxNode use)
        {
            var t = _model.GetTypeInfo(use, _ct).Type;
            if (t == null) return false;
            if (t.SpecialType == SpecialType.System_Void) return true;
            if (t.TypeKind == TypeKind.Enum) return true;
            if (t.SpecialType is SpecialType.System_Boolean or SpecialType.System_Char or SpecialType.System_String or SpecialType.System_Int16 or SpecialType.System_Int32
                or SpecialType.System_Int64 or SpecialType.System_UInt16 or SpecialType.System_UInt32 or SpecialType.System_UInt64 or SpecialType.System_Byte
                or SpecialType.System_SByte or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal or SpecialType.System_DateTime) return true;
            // An awaited plain result (await reader.ReadToEndAsync()) is plain too.
            if (IsTaskLike(t, out var g) && use.Parent is AwaitExpressionSyntax)
            {
                if (!g) return true;
                var inner = ((INamedTypeSymbol)t).TypeArguments[0];
                return inner.SpecialType != SpecialType.None && inner.SpecialType != SpecialType.System_Object || inner.TypeKind == TypeKind.Enum;
            }
            return false;
        }

        // ---------------------------------------------------------------- OR1006 multiple enumeration

        private void CheckMultipleEnumeration(SyntaxNode decl)
        {
            ISymbol? symbol;
            SyntaxNode? fn;
            if (decl is ParameterSyntax p)
            {
                if (p.Parent is not ParameterListSyntax { Parent: BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax } pl) return;
                fn = pl.Parent;
                if (!p.Modifiers.All(m => m.IsKind(SyntaxKind.ParamsKeyword) || m.IsKind(SyntaxKind.ThisKeyword))) return;
                symbol = _model.GetDeclaredSymbol(p, _ct);
            }
            else if (decl is VariableDeclaratorSyntax { Initializer.Value: { } init, Parent.Parent: LocalDeclarationStatementSyntax ld } v)
            {
                if (!ld.UsingKeyword.IsKind(SyntaxKind.None)) return;
                var it = _model.GetTypeInfo(init, _ct).Type;
                if (it == null || IsCollection(it)) return; // declared IEnumerable but holds a materialized collection
                fn = FunctionOf(ld);
                symbol = _model.GetDeclaredSymbol(v, _ct);
            }
            else return;
            if (fn == null || symbol == null) return;
            var type = symbol switch { IParameterSymbol ps => ps.Type, ILocalSymbol ls => ls.Type, _ => null };
            if (type is not INamedTypeSymbol nt || nt.OriginalDefinition.ToDisplayString() != "System.Collections.Generic.IEnumerable<T>") return;
            var scope = BodyOf(fn);
            if (scope == null) return;
            var refs = References(_model, scope, symbol, _ct);
            var sites = new List<IdentifierNameSyntax>();
            foreach (var r in refs)
            {
                if (IsWrite(r)) return;
                var enumerates = r.Parent is ForEachStatementSyntax fe && fe.Expression == r
                    || r.Parent is MemberAccessExpressionSyntax ma && ma.Expression == r && ma.Parent is InvocationExpressionSyntax inv && inv.Expression == ma
                        && ImmediateOperators.Contains(ma.Name.Identifier.ValueText) && IsEnumerable(_model.GetSymbolInfo(inv, _ct).Symbol as IMethodSymbol);
                if (!enumerates) continue;
                if (InsideNestedFunction(r, fn)) return; // a lambda may run any number of times
                sites.Add(r);
            }
            if (sites.Count < 2) return;
            sites.Sort((a, b) => a.SpanStart.CompareTo(b.SpanStart));
            for (var i = 1; i < sites.Count; i++)
            {
                var first = sites.Take(i).FirstOrDefault(s => !Exclusive(s, sites[i]));
                if (first == null) continue;
                var fixes = fn is BaseMethodDeclarationSyntax { Body: not null } or LocalFunctionStatementSyntax { Body: not null } || symbol is ILocalSymbol ? new[] { FixMaterialize } : Array.Empty<string>();
                Report(MultipleEnumeration, sites[i].Span,
                    $"Possible multiple enumeration of '{symbol.Name}': it is enumerated again here (each enumeration re-runs the query or re-reads the source); materialize it once.",
                    new[] { (first.Span, "first enumeration") }, fixes);
                return;
            }
        }

        // ---------------------------------------------------------------- OR1007 string concatenation in a loop

        private void CheckConcatInLoop(ExpressionStatementSyntax es)
        {
            if (es.Expression is not AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.AddAssignmentExpression, Left: IdentifierNameSyntax id } a) return;
            if (_model.GetSymbolInfo(id, _ct).Symbol is not ILocalSymbol local || local.Type.SpecialType != SpecialType.System_String) return;
            var declaration = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(_ct);
            if (declaration == null) return;
            var fn = FunctionOf(es);
            StatementSyntax? loop = null;
            foreach (var x in es.Ancestors())
            {
                if (x == fn || x is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax) break;
                if (x is ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax && !x.Span.Contains(declaration.Span)) loop = (StatementSyntax)x;
            }
            if (loop == null) return;
            // One result per local and loop: at its first '+=' in the loop.
            var firstInLoop = loop.DescendantNodes().OfType<AssignmentExpressionSyntax>()
                .First(x => x.IsKind(SyntaxKind.AddAssignmentExpression) && x.Left is IdentifierNameSyntax l && l.Identifier.ValueText == local.Name
                    && SymbolEqualityComparer.Default.Equals(_model.GetSymbolInfo(l, _ct).Symbol, local));
            if (firstInLoop != a) return;
            // Only a string the loop builds and never reads: a loop that also reads it (while (!names.Add(s)) s += "1")
            // needs the string on every iteration, and a StringBuilder would not help.
            foreach (var r in References(_model, loop, local, _ct))
                if (!(r.Parent is AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.AddAssignmentExpression, Parent: ExpressionStatementSyntax } ra && ra.Left == r)) return;
            Report(ConcatInLoop, a.Span,
                $"'{local.Name} +=' in a loop copies the whole string on every iteration (quadratic time and garbage); build it with a StringBuilder.", FixStringBuilder);
        }

        // ---------------------------------------------------------------- OR1008 Where(p).Operator()

        private void CheckWhereThen(InvocationExpressionSyntax inv)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma || inv.ArgumentList.Arguments.Count != 0 || !PredicateOperators.Contains(ma.Name.Identifier.ValueText)) return;
            if (ma.Expression is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Where" } wma, ArgumentList.Arguments.Count: 1 } w) return;
            if (_model.GetSymbolInfo(inv, _ct).Symbol is not IMethodSymbol op || !IsEnumerable(op)) return;
            if (_model.GetSymbolInfo(w, _ct).Symbol is not IMethodSymbol where || !IsEnumerable(where)) return;
            var predicate = (where.ReducedFrom != null ? where.Parameters[0] : where.Parameters[1]).Type as INamedTypeSymbol;
            if (predicate is not { Name: "Func", Arity: 2 }) return; // not the (item, index) overload
            Report(WhereThenOperator, TextSpan.FromBounds(wma.Name.SpanStart, inv.Span.End),
                $"'Where(…).{ma.Name.Identifier.ValueText}()' can be '{ma.Name.Identifier.ValueText}(…)': one call instead of two and no intermediate iterator.", FixPredicateOverload);
        }

        // ---------------------------------------------------------------- OR1009 redundant ToList/ToArray

        private void CheckRedundantMaterialization(InvocationExpressionSyntax inv)
        {
            if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ToList" or "ToArray" } ma || inv.ArgumentList.Arguments.Count != 0) return;
            if (_model.GetSymbolInfo(inv, _ct).Symbol is not IMethodSymbol m || !IsEnumerable(m)) return;
            var sourceType = _model.GetTypeInfo(ma.Expression, _ct).Type;
            if (sourceType == null || Implements(sourceType, "System.Linq.IQueryable")) return;
            var name = ma.Name.Identifier.ValueText;
            // Case A: x.ToList().Any() — the next operator enumerates once anyway.
            if (inv.Parent is MemberAccessExpressionSyntax next && next.Expression == inv && next.Parent is InvocationExpressionSyntax nextInv && nextInv.Expression == next
                && ImmediateOperators.Contains(next.Name.Identifier.ValueText) && IsEnumerable(_model.GetSymbolInfo(nextInv, _ct).Symbol as IMethodSymbol))
            {
                Report(RedundantMaterialization, TextSpan.FromBounds(ma.OperatorToken.SpanStart, inv.Span.End),
                    $"'{name}()' copies the sequence only to enumerate the copy once with '{next.Name.Identifier.ValueText}'; call it on the source.", FixRemoveMaterialization);
                return;
            }
            // Case B: foreach (var x in list.ToList()) over an in-memory collection the loop does not touch.
            if (inv.Parent is not ForEachStatementSyntax fe || fe.Expression != inv) return;
            var root = ma.Expression;
            while (root is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax dm } di && DeferredOperators.Contains(dm.Name.Identifier.ValueText)
                   && IsEnumerable(_model.GetSymbolInfo(di, _ct).Symbol as IMethodSymbol)
                   && di.ArgumentList.Arguments.All(arg => arg.Expression is not AnonymousFunctionExpressionSyntax lam
                       || !lam.DescendantNodes().Any(x => x is InvocationExpressionSyntax or AssignmentExpressionSyntax or ObjectCreationExpressionSyntax or AwaitExpressionSyntax)))
                root = dm.Expression;
            if (root is not IdentifierNameSyntax rid) return;
            var rs = _model.GetSymbolInfo(rid, _ct).Symbol;
            if (rs is not (ILocalSymbol or IParameterSymbol)) return;
            var rootType = _model.GetTypeInfo(rid, _ct).Type;
            if (!IsCollection(rootType)) return;
            if (fe.Statement.DescendantNodes().OfType<IdentifierNameSyntax>().Any(x => x.Identifier.ValueText == rs.Name)) return;
            if (fe.Statement.DescendantNodes().Any(x => x is AwaitExpressionSyntax or YieldStatementSyntax
                    || x is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax mm } && MutatingMethods.Contains(mm.Name.Identifier.ValueText)
                    || x is InvocationExpressionSyntax { Expression: IdentifierNameSyntax im } && MutatingMethods.Contains(im.Identifier.ValueText)
                    || x is AssignmentExpressionSyntax { Left: ElementAccessExpressionSyntax })) return;
            Report(RedundantMaterialization, TextSpan.FromBounds(ma.OperatorToken.SpanStart, inv.Span.End),
                $"'{name}()' copies '{rs.Name}' before the loop, but the loop does not change it; iterate the source directly.", FixRemoveMaterialization);
        }

        // ---------------------------------------------------------------- OR1010 string.Format without arguments

        private void CheckFormat(InvocationExpressionSyntax inv)
        {
            if (inv.ArgumentList.Arguments.Count != 1 || inv.Expression is not (MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Format" } or IdentifierNameSyntax { Identifier.ValueText: "Format" })) return;
            if (_model.GetSymbolInfo(inv, _ct).Symbol is not IMethodSymbol m || m.Name != "Format" || m.ContainingType?.SpecialType != SpecialType.System_String) return;
            if (m.Parameters.Length == 0 || m.Parameters[0].Type.SpecialType != SpecialType.System_String) return;
            var arg = inv.ArgumentList.Arguments[0];
            if (arg.NameColon != null) return;
            var c = _model.GetConstantValue(arg.Expression, _ct);
            if (!c.HasValue || c.Value is not string format) return;
            var valid = ValidWithoutArguments(format);
            if (valid)
                Report(FormatWithoutArguments, inv.Span, "'string.Format' without arguments only un-doubles braces; use the string itself.", FixRemoveFormat);
            else
                Report(FormatWithoutArguments, inv.Span, "'string.Format' without arguments: the format has a placeholder or a single brace and throws FormatException at run time.");
        }

        public static bool ValidWithoutArguments(string format)
        {
            for (var i = 0; i < format.Length; i++)
            {
                var ch = format[i];
                if (ch is not ('{' or '}')) continue;
                if (i + 1 < format.Length && format[i + 1] == ch) { i++; continue; }
                return false;
            }
            return true;
        }

        // ---------------------------------------------------------------- suppression

        public bool Suppressed(string id, TextSpan span)
        {
            _pragmas ??= Pragmas();
            var disabled = false;
            foreach (var (pos, disable, ids) in _pragmas)
            {
                if (pos > span.Start) break;
                if (ids == null || ids.Contains(id)) disabled = disable;
            }
            if (disabled) return true;
            var node = _root.FindNode(span, getInnermostNodeForTie: true);
            foreach (var a in node.AncestorsAndSelf())
            {
                if (a is not (MemberDeclarationSyntax or LocalFunctionStatementSyntax)) continue;
                if (a is BaseFieldDeclarationSyntax f)
                {
                    foreach (var v in f.Declaration.Variables)
                        if (_model.GetDeclaredSymbol(v, _ct) is { } fs && HasSuppression(fs.GetAttributes(), id)) return true;
                    continue;
                }
                var s = _model.GetDeclaredSymbol(a, _ct);
                if (s == null) continue;
                if (HasSuppression(s.GetAttributes(), id)) return true;
                if (GlobalSuppression(s, id)) return true;
            }
            return HasModuleSuppression(id);
        }

        private List<(int, bool, HashSet<string>?)> Pragmas()
        {
            var list = new List<(int, bool, HashSet<string>?)>();
            if (!_root.ContainsDirectives) return list;
            foreach (var t in _root.DescendantTrivia(descendIntoTrivia: true))
            {
                if (t.GetStructure() is not PragmaWarningDirectiveTriviaSyntax p) continue;
                HashSet<string>? ids = p.ErrorCodes.Count == 0 ? null : new HashSet<string>(p.ErrorCodes.Select(e => e.ToString().Trim()), StringComparer.OrdinalIgnoreCase);
                list.Add((p.SpanStart, p.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword), ids));
            }
            list.Sort((a, b) => a.Item1.CompareTo(b.Item1));
            return list;
        }

        private static bool IsSuppressAttribute(AttributeData a) =>
            a.AttributeClass is { Name: "SuppressMessageAttribute" or "UnconditionalSuppressMessageAttribute" } c && InNamespace(c, "System.Diagnostics.CodeAnalysis");

        private static bool Matches(AttributeData a, string id) =>
            a.ConstructorArguments.Length >= 2 && a.ConstructorArguments[1].Value is string check
            && (check == id || check.StartsWith(id + ":", StringComparison.OrdinalIgnoreCase) || check.StartsWith(id + " ", StringComparison.OrdinalIgnoreCase) || string.Equals(check, id, StringComparison.OrdinalIgnoreCase));

        private static bool HasSuppression(IEnumerable<AttributeData> attributes, string id) =>
            attributes.Any(a => IsSuppressAttribute(a) && Matches(a, id));

        private bool GlobalSuppression(ISymbol s, string id)
        {
            var docId = s.GetDocumentationCommentId();
            if (docId == null) return false;
            foreach (var a in _model.Compilation.Assembly.GetAttributes().Concat(_model.Compilation.SourceModule.GetAttributes()))
            {
                if (!IsSuppressAttribute(a) || !Matches(a, id)) continue;
                var target = a.NamedArguments.FirstOrDefault(n => n.Key == "Target").Value.Value as string;
                if (target == null) continue;
                if (target.StartsWith("~", StringComparison.Ordinal)) target = target[1..];
                if (string.Equals(target, docId, StringComparison.Ordinal)) return true;
                var scope = a.NamedArguments.FirstOrDefault(n => n.Key == "Scope").Value.Value as string;
                if (string.Equals(scope, "namespaceanddescendants", StringComparison.OrdinalIgnoreCase) && s.ContainingNamespace is { } ns
                    && ("N:" + ns.ToDisplayString()).StartsWith(target, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private readonly Dictionary<string, bool> _moduleById = new(StringComparer.Ordinal);

        private bool HasModuleSuppression(string id)
        {
            if (_moduleById.TryGetValue(id, out var v)) return v;
            v = _model.Compilation.Assembly.GetAttributes().Concat(_model.Compilation.SourceModule.GetAttributes())
                .Any(a => IsSuppressAttribute(a) && Matches(a, id) && !a.NamedArguments.Any(n => n.Key == "Target"));
            _moduleById[id] = v;
            return v;
        }
    }
}
