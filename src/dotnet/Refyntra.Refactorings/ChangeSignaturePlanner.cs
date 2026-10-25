using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// One parameter of the new signature (Change Signature, protocol 1.6). <see cref="From"/> is the 0-based index of an
/// existing parameter (kept, possibly moved and renamed); null adds a parameter of <see cref="Type"/>. A new parameter
/// gets <see cref="CallSiteValue"/> at every call site; with <see cref="DefaultValue"/> it is optional in the declaration
/// (and call sites may omit it when no call-site value is given).
/// </summary>
public sealed record ParameterSpec(int? From, string Name, string? Type = null, string? DefaultValue = null, string? CallSiteValue = null);

/// <summary>Current parameters of a method (for the Change Signature dialog).</summary>
public sealed record SignatureParameter(string Name, string Type, string? DefaultValue, string Modifiers);

public sealed record SignatureInfo(string? Name, string? Display, IReadOnlyList<SignatureParameter> Parameters, string? ReasonCode, string? Message);

/// <summary>
/// Change Signature: add, remove, reorder and rename parameters of a method or constructor, together with every
/// override, interface implementation and implemented interface member, and every call site found by Roslyn (named
/// arguments, omitted optional arguments, expanded params arrays, reduced extension calls, constructor initializers,
/// object creation). Refuses what cannot be proven: method-group/delegate uses, attribute uses, generated code,
/// removing an argument that may have side effects, call sites that would bind to another overload afterwards, renames
/// that collide with a name used in a body. String/dynamic uses that the compiler cannot connect are reported as unknown
/// (the plan is limited). Never writes files.
/// </summary>
public static class ChangeSignaturePlanner
{
    public const string ActionId = "csharp.changeSignature";

    private static readonly HashSet<string> PatternNames = new(StringComparer.Ordinal)
    {
        "GetEnumerator", "GetAsyncEnumerator", "Deconstruct", "Dispose", "DisposeAsync", "GetAwaiter", "GetResult", "Add",
        "Select", "SelectMany", "Where", "Join", "GroupJoin", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "GroupBy", "Cast",
        "Slice", "GetPinnableReference", "MoveNext", "MoveNextAsync", "Main",
    };

    /// <summary>The method a signature change applies to (constructors included), or why there is none.</summary>
    public static (string reason, string message)? Guard(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (symbol is not IMethodSymbol m)
            return ("UnsupportedSymbolKind", "Change Signature applies to methods and constructors.");
        if (m.MethodKind is not (MethodKind.Ordinary or MethodKind.Constructor or MethodKind.LocalFunction))
            return ("UnsupportedSymbolKind", $"Changing the signature of {m.MethodKind} methods is not supported.");
        if (CodeFacts.SourceGuard(snapshot, m, ct) is { } g) return g;
        if (m.MethodKind == MethodKind.Constructor && m.IsStatic)
            return ("UnsupportedSymbolKind", "A static constructor has no parameters.");
        if (m.PartialDefinitionPart != null || m.PartialImplementationPart != null || m.IsPartialDefinition)
            return ("PartialMethod", "Partial methods are not supported.");
        if (m.IsExtern) return ("ExternMethod", "extern methods are not supported.");
        if (m.MethodKind == MethodKind.Constructor && m.ContainingType.IsRecord && m.DeclaringSyntaxReferences.Any(r => r.GetSyntax(ct) is RecordDeclarationSyntax))
            return ("PrimaryConstructor", "Primary constructors of records define properties; changing them is not supported.");
        if (m.DeclaringSyntaxReferences.Any(r => r.GetSyntax(ct) is TypeDeclarationSyntax))
            return ("PrimaryConstructor", "Primary constructors are not supported.");
        if (m.MethodKind == MethodKind.Ordinary && PatternNames.Contains(m.Name))
            return ("PatternMethod", $"{m.Name} can be called implicitly by the compiler (foreach, using, await, deconstruction, collection initializers, query expressions); its call sites cannot all be found.");
        if (m.ContainingType?.TypeKind == TypeKind.Delegate)
            return ("DelegateNotSupported", "Changing a delegate signature is not supported: lambdas and methods converted to it cannot all be updated safely.");
        return null;
    }

    public static async Task<SignatureInfo> DescribeAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (Guard(snapshot, symbol, ct) is { } g) return new SignatureInfo(null, null, Array.Empty<SignatureParameter>(), g.reason, g.message);
        var m = (IMethodSymbol)symbol;
        var decl = m.DeclaringSyntaxReferences[0].GetSyntax(ct);
        var list = ParameterListOf(decl);
        var ps = new List<SignatureParameter>();
        if (list != null)
            foreach (var p in list.Parameters)
                ps.Add(new SignatureParameter(p.Identifier.ValueText, p.Type?.ToString() ?? "", p.Default?.Value.ToString(), string.Join(" ", p.Modifiers.Select(t => t.Text))));
        await Task.CompletedTask.ConfigureAwait(false);
        return new SignatureInfo(m.MethodKind == MethodKind.Constructor ? m.ContainingType.Name : m.Name, m.ToDisplayString(SymbolDisplayFormat.CSharpShortErrorMessageFormat), ps, null, null);
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, ISymbol symbol, IReadOnlyList<ParameterSpec>? spec, CancellationToken ct)
    {
        if (Guard(snapshot, symbol, ct) is { } g) return RenameOutcome.Unavailable(g.reason, g.message);
        if (spec == null) return RenameOutcome.Unavailable("InvalidSignature", "The new parameter list is missing.");
        var m = (IMethodSymbol)symbol;
        var result = await ChangeAsync(snapshot, m, spec, ct).ConfigureAwait(false);
        if (result.Refusal is { } r) return RenameOutcome.Unavailable(r.reason, r.message);
        var limitations = result.Limitations;
        limitations.Insert(0, "Only call sites the compiler binds to the method are updated; reflection, dynamic calls, string-based uses and code outside the loaded solution are not.");
        var title = $"Change signature of {DisplayName(m)}: ({string.Join(", ", spec.Select(s => s.Name))})";
        return await SolutionPlanBuilder.BuildAsync(snapshot, result.After!, new SolutionPlanBuilder.Options(ActionId, title, limitations, result.Evidence, result.LimitedReasons,
            OwnerProjects: result.Projects), ct).ConfigureAwait(false);
    }

    internal static string DisplayName(IMethodSymbol m) => m.MethodKind == MethodKind.Constructor ? $"{m.ContainingType.Name} constructor" : m.Name;

    internal sealed class ChangeResult
    {
        public (string reason, string message)? Refusal;
        public Solution? After;
        public List<string> Limitations = new();
        public List<string> LimitedReasons = new();
        public List<(string, Location?)> Evidence = new();
        public HashSet<ProjectId> Projects = new();
        public static ChangeResult Refuse(string reason, string message) => new() { Refusal = (reason, message) };
    }

    internal static ParameterListSyntax? ParameterListOf(SyntaxNode decl) => decl switch
    {
        BaseMethodDeclarationSyntax b => b.ParameterList,
        LocalFunctionStatementSyntax l => l.ParameterList,
        _ => null,
    };

    /// <summary>
    /// The method, every member it overrides or implements (in source) and every override/implementation of those,
    /// to a fixed point. A member of the set declared in metadata refuses.
    /// </summary>
    internal static async Task<(List<IMethodSymbol> set, (string, string)? refusal)> HierarchyAsync(Solution solution, IMethodSymbol method, CancellationToken ct)
    {
        var set = new List<IMethodSymbol>();
        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var queue = new Queue<IMethodSymbol>();
        void Enqueue(IMethodSymbol s)
        {
            s = s.OriginalDefinition;
            if (seen.Add(s)) queue.Enqueue(s);
        }
        Enqueue(method);
        while (queue.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var s = queue.Dequeue();
            if (!s.Locations.Any(l => l.IsInSource))
                return (set, ("ImplementsMetadataMember", $"{s.ContainingType?.Name}.{s.Name} is declared in a referenced assembly; its signature cannot be changed."));
            set.Add(s);
            if (s.MethodKind != MethodKind.Ordinary) continue;
            if (s.OverriddenMethod is { } over) Enqueue(over);
            if (s.ContainingType != null)
                foreach (var iface in s.ContainingType.AllInterfaces)
                foreach (var member in iface.GetMembers().OfType<IMethodSymbol>())
                    if (SymbolEqualityComparer.Default.Equals(s.ContainingType.FindImplementationForInterfaceMember(member)?.OriginalDefinition, s)) Enqueue(member);
            foreach (var o in await SymbolFinder.FindOverridesAsync(s, solution, cancellationToken: ct).ConfigureAwait(false))
                if (o is IMethodSymbol om) Enqueue(om);
            if (s.ContainingType?.TypeKind == TypeKind.Interface || s.IsAbstract || s.IsVirtual)
                foreach (var impl in await SymbolFinder.FindImplementationsAsync(s, solution, cancellationToken: ct).ConfigureAwait(false))
                    if (impl is IMethodSymbol im) Enqueue(im);
        }
        return (set, null);
    }

    private sealed record CallSite(Document Document, SyntaxNode Node, ArgumentListSyntax? Args, Dictionary<int, List<int>> ArgsByOrdinal, int ParamsOrdinal, bool Expanded, IReadOnlyList<string> BoundNames);

    /// <summary>Computes the solution after the signature change (no plan): shared with Safe Delete of a parameter.</summary>
    internal static async Task<ChangeResult> ChangeAsync(Snapshot snapshot, IMethodSymbol method, IReadOnlyList<ParameterSpec> spec, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        method = method.OriginalDefinition;
        var oldParams = method.Parameters;
        // ---------------- the new parameter list
        var used = new HashSet<int>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < spec.Count; i++)
        {
            var s = spec[i];
            if (!CodeFacts.IsValidIdentifier(s.Name)) return ChangeResult.Refuse("InvalidIdentifier", $"'{s.Name}' is not a valid parameter name.");
            if (!names.Add(s.Name)) return ChangeResult.Refuse("DuplicateParameter", $"Two parameters are named {s.Name}.");
            if (s.From is { } from)
            {
                if (from < 0 || from >= oldParams.Length || !used.Add(from)) return ChangeResult.Refuse("InvalidSignature", "A parameter index is out of range or used twice.");
                if (s.Type != null && s.Type != oldParams[from].Type.ToDisplayString() && Normalize(s.Type) != Normalize(TypeText(method, from, ct)))
                    return ChangeResult.Refuse("TypeChangeNotSupported", $"Changing the type of {oldParams[from].Name} is not supported.");
                if (oldParams[from].IsParams && i != spec.Count - 1) return ChangeResult.Refuse("ParamsArray", $"The params parameter {oldParams[from].Name} must stay last.");
                if (oldParams[from].IsThis && i != 0) return ChangeResult.Refuse("ExtensionThis", "The 'this' parameter of an extension method must stay first.");
            }
            else
            {
                if (string.IsNullOrWhiteSpace(s.Type) || SyntaxFactory.ParseTypeName(s.Type).ContainsDiagnostics || SyntaxFactory.ParseTypeName(s.Type).ToString() != s.Type.Trim())
                    return ChangeResult.Refuse("InvalidType", $"'{s.Type}' is not a valid type for the new parameter {s.Name}.");
                if (s.DefaultValue != null && !IsExpression(s.DefaultValue)) return ChangeResult.Refuse("InvalidValue", $"'{s.DefaultValue}' is not a valid default value.");
                if (s.CallSiteValue != null && !IsExpression(s.CallSiteValue)) return ChangeResult.Refuse("InvalidValue", $"'{s.CallSiteValue}' is not a valid call-site value.");
                if (s.CallSiteValue == null && s.DefaultValue == null) return ChangeResult.Refuse("MissingValue", $"The new parameter {s.Name} needs a call-site value or a default value.");
            }
        }
        var removed = Enumerable.Range(0, oldParams.Length).Where(i => !used.Contains(i)).ToList();
        if (oldParams.Length > 0 && oldParams[0].IsThis && removed.Contains(0)) return ChangeResult.Refuse("ExtensionThis", "The 'this' parameter of an extension method cannot be removed.");
        foreach (var r in removed)
            if (oldParams[r].RefKind is RefKind.Out or RefKind.Ref) return ChangeResult.Refuse("RefOutParameter", $"Removing the {oldParams[r].RefKind.ToString().ToLowerInvariant()} parameter {oldParams[r].Name} would change what the call sites assign.");
        var identity = removed.Count == 0 && spec.Count == oldParams.Length && spec.Select((s, i) => s.From == i && s.Name == oldParams[i].Name).All(x => x);
        if (identity) return ChangeResult.Refuse("NoChanges", "The new signature equals the current one.");

        var (set, refusal) = await HierarchyAsync(solution, method, ct).ConfigureAwait(false);
        if (refusal is { } hr) return ChangeResult.Refuse(hr.Item1, hr.Item2);
        var result = new ChangeResult();
        foreach (var s in set)
        {
            if (CodeFacts.SourceGuard(snapshot, s, ct) is { } sg) return ChangeResult.Refuse(sg.reason, $"{s.ContainingType?.Name}.{s.Name}: {sg.message}");
            if (s.Parameters.Length != oldParams.Length) return ChangeResult.Refuse("InvalidSignature", "A member of the hierarchy has a different number of parameters.");
        }
        if (set.Count > 1)
            result.Evidence.Add(($"Hierarchy: {string.Join(", ", set.Select(s => $"{s.ContainingType?.Name}.{s.Name}"))} change together", null));

        // ---------------- renames: no collision with a name used in any body of the set
        var renamed = new Dictionary<int, string>();
        foreach (var s in spec)
            if (s.From is { } f && s.Name != oldParams[f].Name) renamed[f] = s.Name;
        foreach (var s in set)
        {
            var decl = s.DeclaringSyntaxReferences[0].GetSyntax(ct);
            foreach (var (ordinal, newName) in renamed)
            {
                if (s.Parameters[ordinal].Name == newName) continue;
                if (decl.DescendantTokens().Any(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == newName))
                    return ChangeResult.Refuse("NameInUse", $"{newName} is already used in {s.ContainingType?.Name}.{s.Name}; renaming {s.Parameters[ordinal].Name} could change what that name refers to.");
            }
        }

        // ---------------- removed parameters must be unused in every body
        var nameColonRefs = new HashSet<(string, int)>();
        var bodyRenames = new List<(DocumentId doc, IdentifierNameSyntax node, string newName)>();
        foreach (var s in set)
        {
            for (var ordinal = 0; ordinal < s.Parameters.Length; ordinal++)
            {
                var p = s.Parameters[ordinal];
                var isRemoved = removed.Contains(ordinal);
                var newName = renamed.TryGetValue(ordinal, out var rn) ? rn : null;
                if (!isRemoved && newName == null) continue;
                foreach (var rs in await SymbolFinder.FindReferencesAsync(p, solution, ct).ConfigureAwait(false))
                foreach (var loc in rs.Locations)
                {
                    var doc = loc.Document;
                    var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                    var node = root!.FindNode(loc.Location.SourceSpan, findInsideTrivia: true, getInnermostNodeForTie: true);
                    if (node.AncestorsAndSelf().Any(n => n is DocumentationCommentTriviaSyntax)) continue; // <param>/<paramref>: rewritten with the declaration
                    if (node.Parent is NameColonSyntax) continue; // a named argument: rewritten with its call site
                    if (isRemoved)
                        return ChangeResult.Refuse("ParameterUsed", $"{p.Name} is used in {s.ContainingType?.Name}.{s.Name} ({CodeFacts.Label(loc.Location)}); remove that use first.");
                    if (node is IdentifierNameSyntax id) bodyRenames.Add((doc.Id, id, newName!));
                    else return ChangeResult.Refuse("UnsupportedReference", $"A use of {p.Name} at {CodeFacts.Label(loc.Location)} cannot be renamed.");
                }
            }
        }

        // ---------------- call sites
        var calls = new List<CallSite>();
        var setDecls = new HashSet<SyntaxNode>(set.Select(s => s.DeclaringSyntaxReferences[0].GetSyntax(ct)));
        foreach (var s in set)
        {
            foreach (var rs in await SymbolFinder.FindReferencesAsync(s, solution, ct).ConfigureAwait(false))
            {
                if (!set.Any(x => SymbolEqualityComparer.Default.Equals(x, rs.Definition.OriginalDefinition))) continue;
                foreach (var loc in rs.Locations)
                {
                    if (loc.IsImplicit) return ChangeResult.Refuse("ImplicitCall", $"{DisplayName(method)} is called implicitly at {CodeFacts.Label(loc.Location)}; that call cannot be rewritten.");
                    var doc = loc.Document;
                    var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
                    if (SymbolFacts.IsGeneratedTree(solution, tree!, ct))
                        return ChangeResult.Refuse("GeneratedCode", $"{DisplayName(method)} is used in generated code ({CodeFacts.Label(loc.Location)}).");
                    var root = await tree!.GetRootAsync(ct).ConfigureAwait(false);
                    var node = root.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (node.AncestorsAndSelf().Any(a => a is CrefSyntax)) { result.Limitations.Add($"XML documentation references (cref) are not updated ({CodeFacts.Label(loc.Location)})."); continue; }
                    if (node.Ancestors().OfType<InvocationExpressionSyntax>().FirstOrDefault() is { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } }) continue;
                    var call = CallNode(node);
                    if (call == null)
                        return ChangeResult.Refuse(node.Ancestors().Any(a => a is AttributeSyntax) ? "AttributeUse" : "MethodGroupUse",
                            $"{DisplayName(method)} is used without a call at {CodeFacts.Label(loc.Location)} (a method group, delegate or attribute); that use cannot be updated safely.");
                    if (calls.Any(c => c.Node == call)) continue;
                    var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                    var site = await MapArgumentsAsync(doc, model!, call, oldParams.Length, ct).ConfigureAwait(false);
                    if (site == null) return ChangeResult.Refuse("UnsupportedCall", $"The arguments of the call at {CodeFacts.Label(loc.Location)} cannot be mapped to parameters.");
                    calls.Add(site);
                }
            }
        }
        result.Evidence.Add(($"{calls.Count} call site(s) found by Roslyn and rewritten", SymbolFacts.PrimaryLocation(method)));

        // ---------------- argument lists of every call site (computed from the original nodes)
        var newArgs = new Dictionary<SyntaxNode, Func<ArgumentListSyntax, ArgumentListSyntax>>();
        foreach (var c in calls)
        {
            var model = await c.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var plan = PlanArguments(c, spec, oldParams, removed, renamed, model!, ct, out var error);
            if (plan == null) return ChangeResult.Refuse(error!.Value.reason, error.Value.message);
            newArgs[c.Node] = plan;
        }

        // ---------------- overload safety: calls of same-named members must keep binding to the same declaration
        var overloads = new List<(DocumentId doc, SyntaxNode node, string display)>();
        if (method.MethodKind == MethodKind.Ordinary || method.MethodKind == MethodKind.Constructor)
        {
            var others = new List<IMethodSymbol>();
            foreach (var s in set)
                for (var t = s.ContainingType; t != null; t = t.BaseType)
                    foreach (var o in t.GetMembers(s.MethodKind == MethodKind.Constructor ? WellKnownMemberNames.InstanceConstructorName : s.Name).OfType<IMethodSymbol>())
                        if (!set.Contains(o.OriginalDefinition, SymbolEqualityComparer.Default) && o.Locations.Any(l => l.IsInSource) && !others.Contains(o, SymbolEqualityComparer.Default))
                            others.Add(o);
            foreach (var o in others)
            foreach (var rs in await SymbolFinder.FindReferencesAsync(o, solution, ct).ConfigureAwait(false))
            foreach (var loc in rs.Locations)
            {
                var root = await loc.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                var call = CallNode(root!.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true));
                if (call != null) overloads.Add((loc.Document.Id, call, o.OriginalDefinition.ToDisplayString()));
            }
        }

        // ---------------- apply with one SyntaxEditor per document
        var declAnnotation = new SyntaxAnnotation("refyntra.signature.decl");
        var callAnnotation = new SyntaxAnnotation("refyntra.signature.call");
        var overloadAnnotations = new Dictionary<SyntaxNode, SyntaxAnnotation>();
        var docs = new HashSet<DocumentId>();
        foreach (var s in set) docs.Add(solution.GetDocument(s.DeclaringSyntaxReferences[0].SyntaxTree)!.Id);
        foreach (var c in calls) docs.Add(c.Document.Id);
        foreach (var r in bodyRenames) docs.Add(r.doc);
        foreach (var o in overloads) docs.Add(o.doc);
        var after = solution;
        foreach (var docId in docs)
        {
            var doc = solution.GetDocument(docId)!;
            var root = (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
            var editor = new SyntaxEditor(root, solution.Services);
            foreach (var r in bodyRenames.Where(r => r.doc == docId))
                editor.ReplaceNode(r.node, (current, _) =>
                {
                    var id = (IdentifierNameSyntax)current;
                    return id.WithIdentifier(SyntaxFactory.Identifier(r.newName).WithTriviaFrom(id.Identifier));
                });
            foreach (var c in calls.Where(c => c.Document.Id == docId))
            {
                var rewrite = newArgs[c.Node];
                editor.ReplaceNode(c.Node, (current, _) => WithArgs(current, rewrite).WithAdditionalAnnotations(callAnnotation));
            }
            foreach (var o in overloads.Where(o => o.doc == docId))
            {
                if (calls.Any(c => c.Node == o.node)) continue;
                var ann = new SyntaxAnnotation("refyntra.signature.overload", o.display);
                overloadAnnotations[o.node] = ann;
                editor.ReplaceNode(o.node, (current, _) => current.WithAdditionalAnnotations(ann));
            }
            foreach (var s in set)
            {
                var decl = s.DeclaringSyntaxReferences[0].GetSyntax(ct);
                if (decl.SyntaxTree != root.SyntaxTree) continue;
                var names0 = s.Parameters.Select(p => p.Name).ToList();
                editor.ReplaceNode(decl, (current, _) => RewriteDeclaration(current, spec, removed, renamed, names0).WithAdditionalAnnotations(declAnnotation));
            }
            after = after.WithDocumentSyntaxRoot(docId, editor.GetChangedRoot());
        }

        // ---------------- verify binding after the change
        foreach (var docId in docs)
        {
            var doc = after.GetDocument(docId)!;
            var root = (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
            SemanticModel? model = null;
            foreach (var node in root.GetAnnotatedNodes(callAnnotation))
            {
                model ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                var bound = BoundMethod(model!, node, ct);
                var target = bound?.ReducedFrom ?? bound;
                if (target == null || !target.OriginalDefinition.DeclaringSyntaxReferences.Any(r => r.GetSyntax(ct).HasAnnotation(declAnnotation)))
                    return ChangeResult.Refuse("OverloadResolutionChange", $"After the change, the call at {Path.GetFileName(doc.FilePath)}:{node.GetLocation().GetLineSpan().StartLinePosition.Line + 1} would not call {DisplayName(method)} any more.");
            }
            foreach (var ann in overloadAnnotations.Values)
            foreach (var node in root.GetAnnotatedNodes(ann))
            {
                model ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                var bound = BoundMethod(model!, node, ct);
                var display = (bound?.ReducedFrom ?? bound)?.OriginalDefinition.ToDisplayString();
                if (display != ann.Data)
                    return ChangeResult.Refuse("OverloadResolutionChange", $"After the change, the call at {Path.GetFileName(doc.FilePath)}:{node.GetLocation().GetLineSpan().StartLinePosition.Line + 1} would call {DisplayName(method)} instead of {ann.Data}.");
            }
        }

        // ---------------- unknown uses (dynamic, strings) and the visible surface
        var unknown = await CodeFacts.UnknownUsesAsync(solution, null, method.MethodKind == MethodKind.Constructor ? method.ContainingType.Name : method.Name, ct).ConfigureAwait(false);
        if (method.MethodKind != MethodKind.Constructor && unknown.Count > 0)
            result.LimitedReasons.Add($"Uses the compiler cannot connect to {DisplayName(method)} were found and are not updated (unknown callers): {string.Join("; ", unknown)}.");
        if (set.Any(s => s.DeclaredAccessibility is Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal) && set.All(s => s.MethodKind != MethodKind.LocalFunction))
            result.Limitations.Add("The method is publicly visible; callers outside the loaded solution are not updated.");
        if (removed.Count > 0) result.Limitations.Add("XML documentation <param> tags of removed parameters are removed; other documentation is not changed.");
        result.After = after;
        foreach (var d in docs) result.Projects.Add(d.ProjectId);
        return result;
    }

    private static string Normalize(string type) => type.Replace(" ", "");

    private static string TypeText(IMethodSymbol m, int ordinal, CancellationToken ct) =>
        ParameterListOf(m.DeclaringSyntaxReferences[0].GetSyntax(ct))?.Parameters[ordinal].Type?.ToString() ?? "";

    private static bool IsExpression(string text)
    {
        var e = SyntaxFactory.ParseExpression(text);
        return !e.ContainsDiagnostics && e.FullSpan.Length == text.Length && e is not IdentifierNameSyntax { IsMissing: true };
    }

    /// <summary>The call node of a reference: invocation, object creation (also target-typed) or constructor initializer.</summary>
    internal static SyntaxNode? CallNode(SyntaxNode node)
    {
        if (node is ConstructorInitializerSyntax ci) return ci;
        if (node.FirstAncestorOrSelf<ConstructorInitializerSyntax>() is { } init && (node == init || node.Span.Start < init.ArgumentList.SpanStart)) return init;
        if (node is ImplicitObjectCreationExpressionSyntax io) return io;
        if (node.Parent is ImplicitObjectCreationExpressionSyntax io2) return io2;
        var n = node;
        while (n.Parent is QualifiedNameSyntax q && q.Right == n || n.Parent is AliasQualifiedNameSyntax a && a.Name == n) n = n.Parent;
        if (n.Parent is ObjectCreationExpressionSyntax oc && oc.Type == n) return oc;
        if (n.Parent is MemberAccessExpressionSyntax ma && ma.Name == n) n = ma;
        else if (n.Parent is MemberBindingExpressionSyntax mb && mb.Name == n) n = mb;
        if (n.Parent is InvocationExpressionSyntax inv && inv.Expression == n) return inv;
        return null;
    }

    private static ArgumentListSyntax? ArgsOf(SyntaxNode call) => call switch
    {
        InvocationExpressionSyntax i => i.ArgumentList,
        BaseObjectCreationExpressionSyntax o => o.ArgumentList,
        ConstructorInitializerSyntax c => c.ArgumentList,
        _ => null,
    };

    private static SyntaxNode WithArgs(SyntaxNode call, Func<ArgumentListSyntax, ArgumentListSyntax> rewrite) => call switch
    {
        InvocationExpressionSyntax i => i.WithArgumentList(rewrite(i.ArgumentList)),
        ObjectCreationExpressionSyntax o => o.WithArgumentList(rewrite(o.ArgumentList ?? SyntaxFactory.ArgumentList())),
        ImplicitObjectCreationExpressionSyntax o => o.WithArgumentList(rewrite(o.ArgumentList)),
        ConstructorInitializerSyntax c => c.WithArgumentList(rewrite(c.ArgumentList)),
        _ => call,
    };

    internal static IMethodSymbol? BoundMethod(SemanticModel model, SyntaxNode call, CancellationToken ct) =>
        model.GetSymbolInfo(call, ct).Symbol as IMethodSymbol;

    /// <summary>Maps each argument of a call to the ordinal of its parameter (expanded params arguments to the params ordinal).</summary>
    private static async Task<CallSite?> MapArgumentsAsync(Document doc, SemanticModel model, SyntaxNode call, int paramCount, CancellationToken ct)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        var bound = BoundMethod(model, call, ct);
        if (bound == null) return null;
        var target = bound.ReducedFrom ?? bound;
        var offset = bound.ReducedFrom != null ? 1 : 0;
        var args = ArgsOf(call);
        var map = new Dictionary<int, List<int>>();
        var paramsOrdinal = target.Parameters.Length > 0 && target.Parameters[^1].IsParams ? target.Parameters.Length - 1 : -1;
        var expanded = false;
        // Expanded form of a params array: the compiler builds the array from the trailing arguments (ArgumentKind.ParamArray).
        if (model.GetOperation(call, ct) is { } op)
        {
            var arguments = op.DescendantsAndSelf().Select(o => o switch
            {
                IInvocationOperation inv => inv.Arguments,
                IObjectCreationOperation oc => oc.Arguments,
                _ => default,
            }).FirstOrDefault(a => !a.IsDefault);
            if (!arguments.IsDefault) expanded = arguments.Any(a => a.ArgumentKind == ArgumentKind.ParamArray);
        }
        if (args != null)
        {
            for (var i = 0; i < args.Arguments.Count; i++)
            {
                var a = args.Arguments[i];
                int ordinal;
                if (a.NameColon != null)
                {
                    var p = target.Parameters.FirstOrDefault(p => p.Name == a.NameColon.Name.Identifier.ValueText);
                    if (p == null) return null;
                    ordinal = p.Ordinal;
                }
                else
                {
                    ordinal = i + offset;
                    if (expanded && paramsOrdinal >= 0 && ordinal >= paramsOrdinal) ordinal = paramsOrdinal;
                }
                if (ordinal >= paramCount) return null;
                if (!map.TryGetValue(ordinal, out var l)) map[ordinal] = l = new List<int>();
                l.Add(i);
            }
        }
        return new CallSite(doc, call, args, map, paramsOrdinal, expanded, target.Parameters.Select(p => p.Name).ToList());
    }

    /// <summary>
    /// The arguments of a call (indexes into <paramref name="original"/>) whose evaluation runs a user-defined conversion:
    /// into the parameter type or anywhere inside the argument. Such an argument has effects even when its syntax is a
    /// literal or a plain read (M(1, 2) with an implicit operator V(int) that counts), and when the conversion is one
    /// element of a tuple conversion (a local (int, int) passed as (V, int)). Null when the call cannot be analyzed: then
    /// every argument counts as converted.
    /// </summary>
    private static HashSet<int>? ConvertingArguments(SyntaxNode call, IReadOnlyList<ArgumentSyntax> original, SemanticModel model, CancellationToken ct)
    {
        if (original.Count == 0) return new HashSet<int>();
        if (model.GetOperation(call, ct) is not { } op) return null;
        var found = new HashSet<int>();
        foreach (var o in op.DescendantsAndSelf())
        {
            var userDefined = o switch
            {
                IConversionOperation conversion => conversion.Conversion.IsUserDefined || RunsUserCode(model.Compilation, conversion.Operand.Type, conversion.Type),
                IArgumentOperation argument => argument.InConversion.IsUserDefined || argument.OutConversion.IsUserDefined,
                _ => false,
            };
            if (!userDefined || o.Syntax == null) continue;
            for (var i = 0; i < original.Count; i++)
                if (original[i].Span.Contains(o.Syntax.Span)) found.Add(i);
        }
        return found;
    }

    /// <summary>
    /// Whether converting a value of <paramref name="source"/> to <paramref name="destination"/> runs a user-defined
    /// conversion inside a tuple or nullable conversion. The operation tree shows only the outer conversion (its element
    /// conversions are not operations), so the element types are classified one by one; a top-level user-defined
    /// conversion is the caller's check.
    /// </summary>
    private static bool RunsUserCode(Compilation compilation, ITypeSymbol? source, ITypeSymbol? destination, int depth = 0)
    {
        if (source == null || destination == null || depth > 16 || SymbolEqualityComparer.Default.Equals(source, destination)) return false;
        bool Element(ITypeSymbol from, ITypeSymbol to) => compilation.ClassifyCommonConversion(from, to).IsUserDefined || RunsUserCode(compilation, from, to, depth + 1);
        var s = Unwrap(source);
        var d = Unwrap(destination);
        if (s is INamedTypeSymbol { IsTupleType: true } st && d is INamedTypeSymbol { IsTupleType: true } dt)
            return st.TupleElements.Length != dt.TupleElements.Length || st.TupleElements.Zip(dt.TupleElements, (a, b) => Element(a.Type, b.Type)).Any(x => x);
        // A lifted conversion (int? → V?) runs the conversion of the underlying types.
        return (!SymbolEqualityComparer.Default.Equals(s, source) || !SymbolEqualityComparer.Default.Equals(d, destination)) && Element(s, d);

        static ITypeSymbol Unwrap(ITypeSymbol t) => t is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n ? n.TypeArguments[0] : t;
    }

    /// <summary>
    /// The new argument list of one call site as a function of its current list (same arguments as the original, possibly
    /// with nested call sites already rewritten). Arguments of removed parameters must be free of side effects; when the
    /// new order swaps an argument that may have side effects with a non-constant one, the arguments keep their original
    /// evaluation order as named arguments (a read may depend on a neighboring argument that changes its value).
    /// </summary>
    private static Func<ArgumentListSyntax, ArgumentListSyntax>? PlanArguments(CallSite c, IReadOnlyList<ParameterSpec> spec, IReadOnlyList<IParameterSymbol> oldParams,
        List<int> removed, Dictionary<int, string> renamed, SemanticModel model, CancellationToken ct, out (string reason, string message)? error)
    {
        error = null;
        var original = c.Args?.Arguments.ToList() ?? new List<ArgumentSyntax>();
        var where = CodeFacts.Label(c.Node.GetLocation());
        var converting = ConvertingArguments(c.Node, original, model, ct);
        // An argument converted by user code runs that code when it is evaluated, whatever its syntax (a literal, a read).
        bool Converts(int i) => converting == null || converting.Contains(i);
        foreach (var r in removed)
        {
            if (!c.ArgsByOrdinal.TryGetValue(r, out var idxs)) continue;
            foreach (var i in idxs)
            {
                var a = original[i];
                if (!a.RefKindKeyword.IsKind(SyntaxKind.None) && !a.RefKindKeyword.IsKind(SyntaxKind.InKeyword))
                {
                    error = ("RefOutParameter", $"The argument of {oldParams[r].Name} at {where} is passed by reference.");
                    return null;
                }
                if (!CodeFacts.IsSideEffectFree(a.Expression, model, ct) || Converts(i))
                {
                    error = ("ArgumentHasSideEffects", $"The argument '{a.Expression}' for {oldParams[r].Name} at {where} may have side effects; removing it could change behavior. Make it a local variable first.");
                    return null;
                }
            }
        }
        // Reads of locals and fields can depend on a neighboring call (M(value, Mutate())), so an argument that may have side
        // effects (a call, an assignment, ref / out, a user-defined conversion) keeps its place relative to every argument
        // whose value can differ. Two plain reads, or a read and a constant, may swap: nothing between them runs code. Such
        // a swap is kept by naming the arguments.
        var keptOrder = new List<int>();
        foreach (var s in spec)
            if (s.From is { } f && c.ArgsByOrdinal.TryGetValue(f, out var idxs)) keptOrder.AddRange(idxs);
        bool Effects(int i) => !original[i].RefKindKeyword.IsKind(SyntaxKind.None) && !original[i].RefKindKeyword.IsKind(SyntaxKind.InKeyword)
            || !CodeFacts.IsSideEffectFree(original[i].Expression, model, ct) || Converts(i);
        // A converted constant varies too: the conversion's result depends on when it runs (implicit operator V(int) => ++n).
        bool Varies(int i) => Converts(i) || !model.GetConstantValue(original[i].Expression, ct).HasValue;
        var orderMatters = false;
        for (var p = 0; p < keptOrder.Count && !orderMatters; p++)
            for (var q = p + 1; q < keptOrder.Count && !orderMatters; q++)
            {
                int first = keptOrder[q], second = keptOrder[p]; // the original order of a swapped pair
                orderMatters = first < second && (Effects(first) && Varies(second) || Effects(second) && Varies(first));
            }
        // Positional emission: a gap (an omitted optional argument or a new parameter without a call-site value) makes the rest named.
        var useNamedAll = orderMatters;
        if (useNamedAll && c.Expanded && c.ArgsByOrdinal.TryGetValue(c.ParamsOrdinal, out var pa) && pa.Count != 1)
        {
            error = ("EvaluationOrder", $"The call at {where} passes a params array in expanded form; its arguments cannot be reordered without changing evaluation order.");
            return null;
        }
        var receiverOffset = 0;
        if (c.Node is InvocationExpressionSyntax && BoundMethod(model, c.Node, ct)?.ReducedFrom != null) receiverOffset = 1;

        // Positional emission: a gap (an omitted optional argument or a new parameter without a call-site value) makes the
        // rest named; an expanded params array cannot be named.
        if (!useNamedAll)
        {
            var gap = false;
            for (var k = receiverOffset; k < spec.Count; k++)
            {
                var s = spec[k];
                if (s.From is { } f)
                {
                    if (!c.ArgsByOrdinal.TryGetValue(f, out var idxs)) gap = true;
                    else if (gap && idxs.Count != 1 && f == c.ParamsOrdinal && c.Expanded)
                    {
                        error = ("EvaluationOrder", $"The call at {where} passes a params array in expanded form after an omitted argument; it cannot be named.");
                        return null;
                    }
                }
                else if (s.CallSiteValue == null) gap = true;
            }
        }
        var specCopy = spec.ToList();
        var boundNames = c.BoundNames;
        string NameOf(int f) => renamed.TryGetValue(f, out var rn) ? rn : boundNames[f];
        return current =>
        {
            var cur = current.Arguments.ToList();
            var outArgs = new List<ArgumentSyntax>();
            static ArgumentSyntax Named(ArgumentSyntax a, string name) =>
                a.WithNameColon(SyntaxFactory.NameColon(SyntaxFactory.IdentifierName(name)).WithTrailingTrivia(SyntaxFactory.Space));
            static ArgumentSyntax NewArg(string value) => SyntaxFactory.Argument(SyntaxFactory.ParseExpression(value).WithoutTrivia());
            if (useNamedAll)
            {
                // Original textual order, every argument named; new parameters with a call-site value last.
                var byIndex = new SortedDictionary<int, ArgumentSyntax>();
                foreach (var s in specCopy)
                    if (s.From is { } f && c.ArgsByOrdinal.TryGetValue(f, out var idxs))
                        foreach (var i in idxs) byIndex[i] = Named(cur[i].WithNameColon(null), NameOf(f));
                outArgs.AddRange(byIndex.Values);
                foreach (var s in specCopy)
                    if (s.From == null && s.CallSiteValue != null) outArgs.Add(Named(NewArg(s.CallSiteValue), s.Name));
            }
            else
            {
                var named = false;
                for (var k = receiverOffset; k < specCopy.Count; k++)
                {
                    var s = specCopy[k];
                    if (s.From is { } f)
                    {
                        if (!c.ArgsByOrdinal.TryGetValue(f, out var idxs)) { named = true; continue; }
                        foreach (var i in idxs)
                        {
                            var a = cur[i];
                            // Once an argument is named, every later one is named too (a positional argument may not follow a
                            // named argument that is out of position).
                            if (a.NameColon != null || named) { a = Named(a.WithNameColon(null), NameOf(f)); named = true; }
                            outArgs.Add(a);
                        }
                    }
                    else if (s.CallSiteValue != null) outArgs.Add(named ? Named(NewArg(s.CallSiteValue), s.Name) : NewArg(s.CallSiteValue));
                    else named = true;
                }
            }
            return current.WithArguments(Layout(outArgs, current.Arguments));
        };
    }

    /// <summary>
    /// A separated list with the layout of <paramref name="original"/> by position: the n-th item gets the leading trivia
    /// of the n-th original item (indentation of multi-line lists) and the n-th separator is the n-th original separator.
    /// Comments in front of an item move with it.
    /// </summary>
    internal static SeparatedSyntaxList<T> Layout<T>(List<T> items, SeparatedSyntaxList<T> original) where T : SyntaxNode
    {
        var origItems = original.ToList();
        var origSeps = original.GetSeparators().ToList();
        var outItems = new List<T>();
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            var comments = item.GetLeadingTrivia().Where(t => !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia)).ToList();
            var position = i < origItems.Count ? origItems[i].GetLeadingTrivia() : origItems.Count > 1 ? origItems[^1].GetLeadingTrivia() : default;
            var lead = position.Where(t => t.IsKind(SyntaxKind.WhitespaceTrivia) || t.IsKind(SyntaxKind.EndOfLineTrivia)).ToList();
            if (comments.Count > 0) lead.AddRange(comments.Concat(new[] { SyntaxFactory.Space }));
            var trail = item.GetTrailingTrivia().Where(t => !t.IsKind(SyntaxKind.EndOfLineTrivia)).ToList();
            if (i == items.Count - 1 && origItems.Count > 0) trail = origItems[^1].GetTrailingTrivia().ToList();
            else if (i < items.Count - 1) trail = trail.Where(t => !t.IsKind(SyntaxKind.WhitespaceTrivia)).ToList();
            outItems.Add(item.WithLeadingTrivia(lead).WithTrailingTrivia(trail));
        }
        var seps = new List<SyntaxToken>();
        for (var i = 0; i < Math.Max(0, items.Count - 1); i++)
            seps.Add(i < origSeps.Count ? origSeps[i] : origSeps.Count > 0 ? origSeps[^1] : SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space));
        return SyntaxFactory.SeparatedList(outItems, seps);
    }

    /// <summary>The declaration with the new parameter list (from the current one, by index) and its XML documentation updated.</summary>
    private static SyntaxNode RewriteDeclaration(SyntaxNode current, IReadOnlyList<ParameterSpec> spec, List<int> removed, Dictionary<int, string> renamed, List<string> ownNames)
    {
        var list = ParameterListOf(current)!;
        var ps = list.Parameters.ToList();
        var outPs = new List<ParameterSyntax>();
        foreach (var s in spec)
        {
            if (s.From is { } f)
            {
                var p = ps[f];
                if (renamed.TryGetValue(f, out var rn)) p = p.WithIdentifier(SyntaxFactory.Identifier(rn).WithTriviaFrom(p.Identifier));
                outPs.Add(p);
            }
            else
            {
                var p = SyntaxFactory.Parameter(SyntaxFactory.Identifier(s.Name)).WithType(SyntaxFactory.ParseTypeName(s.Type!).WithoutTrivia().WithTrailingTrivia(SyntaxFactory.Space));
                if (s.DefaultValue != null)
                    p = p.WithDefault(SyntaxFactory.EqualsValueClause(SyntaxFactory.Token(SyntaxKind.EqualsToken).WithLeadingTrivia(SyntaxFactory.Space).WithTrailingTrivia(SyntaxFactory.Space),
                        SyntaxFactory.ParseExpression(s.DefaultValue).WithoutTrivia()));
                outPs.Add(p);
            }
        }
        var newList = list.WithParameters(Layout(outPs, list.Parameters));
        var result = current.ReplaceNode(list, newList);
        // XML documentation: <param name>/<paramref name> renamed, <param> of removed parameters removed.
        var renames = renamed.ToDictionary(kv => ownNames[kv.Key], kv => kv.Value, StringComparer.Ordinal);
        var removedNames = new HashSet<string>(removed.Select(i => ownNames[i]), StringComparer.Ordinal);
        if (renames.Count == 0 && removedNames.Count == 0) return result;
        var trivia = result.GetLeadingTrivia();
        var changed = false;
        var newTrivia = new List<SyntaxTrivia>();
        foreach (var t in trivia)
        {
            if (t.GetStructure() is DocumentationCommentTriviaSyntax docComment)
            {
                var rewritten = (DocumentationCommentTriviaSyntax)new DocRewriter(renames, removedNames).Visit(docComment)!;
                rewritten = RemoveParamElements(rewritten, removedNames);
                if (!rewritten.IsEquivalentTo(docComment)) { changed = true; newTrivia.Add(SyntaxFactory.Trivia(rewritten)); continue; }
            }
            newTrivia.Add(t);
        }
        return changed ? result.WithLeadingTrivia(newTrivia) : result;
    }

    private static DocumentationCommentTriviaSyntax RemoveParamElements(DocumentationCommentTriviaSyntax doc, HashSet<string> removedNames)
    {
        if (removedNames.Count == 0) return doc;
        var content = doc.Content.ToList();
        for (var i = 0; i < content.Count; i++)
        {
            if (content[i] is not XmlElementSyntax el || el.StartTag.Name.LocalName.ValueText != "param") continue;
            var name = el.StartTag.Attributes.OfType<XmlNameAttributeSyntax>().FirstOrDefault()?.Identifier.Identifier.ValueText;
            if (name == null || !removedNames.Contains(name)) continue;
            content.RemoveAt(i);
            // The line break and "///" before the next element go with it (or, for the last element, the ones before it).
            if (i < content.Count - 1 && content[i] is XmlTextSyntax next && next.TextTokens.Any(t => t.IsKind(SyntaxKind.XmlTextLiteralNewLineToken))) content.RemoveAt(i);
            else if (i > 0 && content[i - 1] is XmlTextSyntax prev && prev.TextTokens.Any(t => t.IsKind(SyntaxKind.XmlTextLiteralNewLineToken))) { content.RemoveAt(i - 1); i--; }
            i--;
        }
        return doc.WithContent(SyntaxFactory.List(content));
    }

    private sealed class DocRewriter : CSharpSyntaxRewriter
    {
        private readonly Dictionary<string, string> _renames;
        public DocRewriter(Dictionary<string, string> renames, HashSet<string> _) : base(visitIntoStructuredTrivia: true) => _renames = renames;
        public override SyntaxNode? VisitXmlNameAttribute(XmlNameAttributeSyntax node) =>
            _renames.TryGetValue(node.Identifier.Identifier.ValueText, out var n)
                ? node.WithIdentifier(node.Identifier.WithIdentifier(SyntaxFactory.Identifier(n).WithTriviaFrom(node.Identifier.Identifier)))
                : node;
    }
}
