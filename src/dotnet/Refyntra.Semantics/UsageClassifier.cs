using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>Usage kinds of <c>code/usages</c> (protocol 1.12).</summary>
public static class UsageKinds
{
    public const string Read = "read", Write = "write", ReadWrite = "readWrite", Invocation = "invocation", NameOf = "nameof",
        Attribute = "attribute", Inheritance = "inheritance", TypeArgument = "typeArgument", ObjectCreation = "objectCreation", Other = "other";

    public static readonly string[] All = { Read, Write, ReadWrite, Invocation, NameOf, Attribute, Inheritance, TypeArgument, ObjectCreation, Other };
}

/// <summary>One classified usage of a symbol.</summary>
public sealed record UsageHit(Location Location, Project Project, string Kind, string? ContainingMember, string? ContainingType, bool IsTest, string LineText, LinePositionSpan Span);

public sealed record UsagesModel(List<UsageHit> Items, int Total, bool Truncated, string Completeness);

/// <summary>
/// Find Usages grouped (protocol 1.12, <c>code/usages</c>): the source references of a symbol (Roslyn
/// <see cref="SymbolFinder.FindReferencesAsync(ISymbol, Solution, CancellationToken)"/>), each classified by syntax and
/// the semantic model: read, write, read-write (compound assignment, ++/--, ref argument), invocation, nameof, attribute,
/// inheritance / implementation (base list), type argument, object creation, other.
/// </summary>
public static class UsageClassifier
{
    public const int DefaultLimit = 1000;
    public const int MaxLimit = 50000;
    public const int MaxLineLength = 400;

    private static readonly string[] TestAssemblies = { "xunit.core", "xunit.v3.core", "nunit.framework", "Microsoft.VisualStudio.TestPlatform.TestFramework", "MSTest.TestFramework" };

    public static async Task<UsagesModel> FindAsync(Snapshot snapshot, ISymbol symbol, int limit, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        var model = await FindAsync(solution, symbol, limit, ct).ConfigureAwait(false);
        return model with { Completeness = SemanticService.Completeness(snapshot) };
    }

    /// <summary>Usages of <paramref name="symbol"/> in <paramref name="solution"/>, sorted by file and position, at most <paramref name="limit"/>.</summary>
    public static async Task<UsagesModel> FindAsync(Solution solution, ISymbol symbol, int limit, CancellationToken ct)
    {
        if (limit <= 0) limit = DefaultLimit;
        limit = Math.Min(limit, MaxLimit);
        var refs = await SymbolFinder.FindReferencesAsync(symbol, solution, ct).ConfigureAwait(false);
        var locations = new List<(Location loc, Document doc)>();
        var seen = new HashSet<(string?, int)>();
        foreach (var r in refs)
        foreach (var rl in r.Locations)
        {
            if (rl.IsImplicit || !rl.Location.IsInSource) continue;
            if (!seen.Add((rl.Location.SourceTree?.FilePath, rl.Location.SourceSpan.Start))) continue;
            locations.Add((rl.Location, rl.Document));
        }
        var ordered = locations.OrderBy(l => l.loc.SourceTree?.FilePath, StringComparer.Ordinal).ThenBy(l => l.loc.SourceSpan.Start).ToList();
        var testProjects = new Dictionary<ProjectId, bool>();
        var items = new List<UsageHit>();
        foreach (var group in ordered.Take(limit).GroupBy(l => l.doc.Id))
        {
            var doc = group.First().doc;
            var semantic = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            if (semantic == null || root == null) continue;
            if (!testProjects.TryGetValue(doc.Project.Id, out var testProject))
                testProjects[doc.Project.Id] = testProject = await IsTestProjectAsync(doc.Project, ct).ConfigureAwait(false);
            foreach (var (loc, _) in group)
            {
                ct.ThrowIfCancellationRequested();
                var node = root.FindNode(loc.SourceSpan, getInnermostNodeForTie: true);
                var kind = Classify(node, semantic, ct);
                var (member, type) = Containing(semantic, loc.SourceSpan.Start, ct);
                var isTest = testProject || (member is IMethodSymbol m && TestNavigation.TestFramework(m) != null) || (type != null && TestNavigation.IsTestClass(type));
                var lineSpan = loc.GetLineSpan().Span;
                var line = text.Lines[lineSpan.Start.Line].ToString();
                if (line.Length > MaxLineLength) line = line.Substring(0, MaxLineLength);
                items.Add(new UsageHit(loc, doc.Project, kind, MemberName(member), type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), isTest, line, lineSpan));
            }
        }
        return new UsagesModel(items, ordered.Count, ordered.Count > limit, "complete");
    }

    /// <summary>A project that references a known test framework assembly (xUnit, NUnit, MSTest).</summary>
    public static async Task<bool> IsTestProjectAsync(Project project, CancellationToken ct)
    {
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        return compilation != null && compilation.ReferencedAssemblyNames.Any(a => TestAssemblies.Contains(a.Name, StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>The kind of the reference whose innermost node is <paramref name="node"/>.</summary>
    public static string Classify(SyntaxNode node, SemanticModel model, CancellationToken ct)
    {
        if (node is ImplicitObjectCreationExpressionSyntax) return UsageKinds.ObjectCreation;
        if (node is ConstructorInitializerSyntax) return UsageKinds.Invocation;
        var name = node as SimpleNameSyntax ?? node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().FirstOrDefault() ?? node;
        // From the name up to the whole expression it names: A.B.C (name C), a?.C, global::C.
        SyntaxNode e = name;
        while (e.Parent is { } p && (p is QualifiedNameSyntax q && q.Right == e || p is MemberAccessExpressionSyntax ma && ma.Name == e
            || p is MemberBindingExpressionSyntax mb && mb.Name == e || p is AliasQualifiedNameSyntax aq && aq.Name == e))
            e = p;

        if (InNameOf(e, model, ct)) return UsageKinds.NameOf;
        if (e.Parent is AttributeSyntax a && a.Name == e) return UsageKinds.Attribute;
        // A type inside a type: List<Order>, Order[], Order? — the outer shape decides.
        var type = e;
        while (type.Parent is ArrayTypeSyntax or NullableTypeSyntax or PointerTypeSyntax or RefTypeSyntax) type = type.Parent;
        if (type.Parent is TypeArgumentListSyntax) return UsageKinds.TypeArgument;
        if (type.Parent is BaseTypeSyntax) return UsageKinds.Inheritance;
        if (e.Parent is ObjectCreationExpressionSyntax oc && oc.Type == e) return UsageKinds.ObjectCreation;
        if (e.Parent is InvocationExpressionSyntax inv && inv.Expression == e) return UsageKinds.Invocation;

        var symbol = model.GetSymbolInfo(name, ct).Symbol;
        // Raising an event or calling a delegate through Invoke: Changed?.Invoke(…), handler.Invoke(…).
        if (symbol is IEventSymbol or IFieldSymbol { Type.TypeKind: TypeKind.Delegate } or IPropertySymbol { Type.TypeKind: TypeKind.Delegate }
            && (e.Parent is ConditionalAccessExpressionSyntax { WhenNotNull: InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax { Name.Identifier.ValueText: "Invoke" } } } ca && ca.Expression == e
                || e.Parent is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Invoke", Parent: InvocationExpressionSyntax } im && im.Expression == e))
            return UsageKinds.Invocation;
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor }) return UsageKinds.ObjectCreation;
        if (symbol is not (IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IEventSymbol)) return UsageKinds.Other;

        switch (e.Parent)
        {
            case AssignmentExpressionSyntax asg when asg.Left == e:
                // Event subscription (+= / -=) changes the event; compound assignment reads and writes.
                return asg.IsKind(SyntaxKind.SimpleAssignmentExpression) || symbol is IEventSymbol ? UsageKinds.Write : UsageKinds.ReadWrite;
            case PrefixUnaryExpressionSyntax pre when pre.IsKind(SyntaxKind.PreIncrementExpression) || pre.IsKind(SyntaxKind.PreDecrementExpression):
                return UsageKinds.ReadWrite;
            case PostfixUnaryExpressionSyntax post when post.IsKind(SyntaxKind.PostIncrementExpression) || post.IsKind(SyntaxKind.PostDecrementExpression):
                return UsageKinds.ReadWrite;
            case ArgumentSyntax arg when arg.RefKindKeyword.IsKind(SyntaxKind.OutKeyword):
                return UsageKinds.Write;
            case ArgumentSyntax arg when arg.RefKindKeyword.IsKind(SyntaxKind.RefKeyword):
                return UsageKinds.ReadWrite;
            case ArgumentSyntax { Parent: TupleExpressionSyntax tuple } when tuple.Parent is AssignmentExpressionSyntax d && d.Left == tuple:
                return UsageKinds.Write; // (a, b) = …
        }
        return UsageKinds.Read;
    }

    private static bool InNameOf(SyntaxNode e, SemanticModel model, CancellationToken ct)
    {
        foreach (var inv in e.Ancestors().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" } && inv.ArgumentList.Span.Contains(e.Span)
                && model.GetOperation(inv, ct) is INameOfOperation)
                return true;
        }
        return false;
    }

    /// <summary>The member (lambdas and local functions belong to theirs) and the type that contain a position.</summary>
    public static (ISymbol? member, INamedTypeSymbol? type) Containing(SemanticModel model, int position, CancellationToken ct)
    {
        var s = model.GetEnclosingSymbol(position, ct);
        while (s is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction } && s.ContainingSymbol != null) s = s.ContainingSymbol;
        if (s is IMethodSymbol { AssociatedSymbol: { } assoc }) s = assoc; // accessors → the property or event
        if (s is INamedTypeSymbol t) return (null, t);
        if (s is INamespaceSymbol) return (null, null);
        return (s, s?.ContainingType);
    }

    private static string? MemberName(ISymbol? m) => m switch
    {
        null => null,
        IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } c => c.ContainingType.Name,
        IMethodSymbol { MethodKind: MethodKind.Destructor } d => "~" + d.ContainingType.Name,
        IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator or MethodKind.Conversion } o => o.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
        IPropertySymbol { IsIndexer: true } => "this[]",
        _ => m.Name,
    };
}
