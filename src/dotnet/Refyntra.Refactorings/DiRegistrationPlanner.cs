using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Frameworks.DependencyInjection;
using Refyntra.Semantics;
using Refyntra.Semantics.Rules;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>What "Register in DI" can do for a service type: the implementations to pair it with and the composition roots.</summary>
public sealed record DiRegistrationInfo(string? Service, string? ServiceId, IReadOnlyList<CtorChoice> Implementations, IReadOnlyList<CtorChoice> Roots, string? ReasonCode, string? Message);

/// <summary>
/// Register in DI (protocol 1.11): adds <c>receiver.AddScoped&lt;IService, Implementation&gt;();</c> after the last
/// registration of a composition root found by the DI relations (Microsoft.Extensions.DependencyInjection facts: the
/// method that contains registrations, top-level statements included). An interface is paired with its single source
/// implementation (several: the user picks). The edit is a previewed plan (SolutionPlanBuilder: compile-checked,
/// revalidated before it is applied). Already registered services and types without implementation are refused.
/// </summary>
public static class DiRegistrationPlanner
{
    public const string ActionId = "csharp.registerDi";
    public static readonly string[] Lifetimes = { "Scoped", "Transient", "Singleton" };

    private static readonly SymbolDisplayFormat Full = SymbolDisplayFormat.FullyQualifiedFormat;
    private static readonly SyntaxAnnotation Imports = new("refyntra.di.imports");

    private sealed record Root(string Id, string Label, Document Document, StatementSyntax Anchor, string Receiver, bool Before);

    /// <summary>Is the type (or its open definition) registered as a service anywhere in the loaded solution?</summary>
    public static async Task<bool> IsRegisteredAsync(Snapshot snapshot, INamedTypeSymbol type, CancellationToken ct)
    {
        var facts = (DependencyInjectionModule.Facts)await SemanticService.GetFactsAsync(snapshot, SemanticService.DependencyInjection, ct).ConfigureAwait(false);
        var key = Or1001Rule.TypeKey(type);
        var open = Or1001Rule.TypeKey(type.OriginalDefinition);
        return facts.Registrations.Any(r => r.Key == null && (Or1001Rule.TypeKey(r.ServiceType) is var k && (k == key || k == open)
            || r.ServiceType is INamedTypeSymbol { IsUnboundGenericType: true } u && Or1001Rule.TypeKey(u.OriginalDefinition) == open));
    }

    private static async Task<INamedTypeSymbol?> ServiceAsync(Snapshot snapshot, string path, LinePosition position, string? typeId, CancellationToken ct)
    {
        var doc = ConstructorPlanner.DocumentOf(snapshot, path);
        if (doc == null) return null;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(typeId))
            return DocumentationCommentId.GetFirstSymbolForDeclarationId(typeId, model!.Compilation) as INamedTypeSymbol;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return null;
        var pos = Math.Min(text.Lines[position.Line].Start + position.Character, text.Lines[position.Line].End);
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var token = root!.FindToken(Math.Min(pos, Math.Max(0, root.FullSpan.End - 1)));
        if (token.Parent?.AncestorsAndSelf().OfType<ParameterSyntax>().FirstOrDefault() is { } p && model!.GetDeclaredSymbol(p, ct) is { Type: INamedTypeSymbol pt })
            return pt;
        if (token.Parent?.AncestorsAndSelf().OfType<TypeSyntax>().LastOrDefault() is { } ts && model!.GetTypeInfo(ts, ct).Type is INamedTypeSymbol t) return t;
        return null;
    }

    /// <summary>The implementations and composition roots for the service at the position (or <paramref name="typeId"/>), or why it cannot be registered.</summary>
    public static async Task<DiRegistrationInfo> DescribeAsync(Snapshot snapshot, string path, LinePosition position, string? typeId, CancellationToken ct)
    {
        static DiRegistrationInfo No(string reason, string message, INamedTypeSymbol? s = null) =>
            new(s?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), null, Array.Empty<CtorChoice>(), Array.Empty<CtorChoice>(), reason, message);
        var service = await ServiceAsync(snapshot, path, position, typeId, ct).ConfigureAwait(false);
        if (service == null || service.TypeKind == TypeKind.Error) return No("NoType", "Place the cursor on a constructor parameter or a type of the loaded solution.");
        if (!ConstructorPlanner.IsRegistrable(service)) return No("FrameworkType", $"'{service.Name}' is supplied by the framework or cannot be a service of your code.", service);
        if (await IsRegisteredAsync(snapshot, service, ct).ConfigureAwait(false))
            return No("AlreadyRegistered", $"'{service.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}' is already registered (see Refyntra Related → registrations).", service);
        var impls = await ImplementationsAsync(snapshot.Solution, service, ct).ConfigureAwait(false);
        if (impls.Count == 0)
            return No("NoImplementation", $"No class implements '{service.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}' in the solution, so there is nothing to register. Create the implementation first.", service);
        var roots = await RootsAsync(snapshot, ct).ConfigureAwait(false);
        if (roots.Count == 0)
            return No("NoCompositionRoot", "No composition root was found (no method or top-level code registers services with Microsoft.Extensions.DependencyInjection). Nothing was changed; add the registration where your services are configured.", service);
        return new DiRegistrationInfo(service.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), service.OriginalDefinition.GetDocumentationCommentId(),
            impls.Select((t, i) => new CtorChoice(t.GetDocumentationCommentId()!, t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), t.ContainingNamespace?.ToDisplayString(), i == 0)).ToList(),
            roots.Select((r, i) => new CtorChoice(r.Id, r.Label, Path.GetFileName(r.Document.FilePath), i == 0)).ToList(), null, null);
    }

    /// <summary>Concrete source classes for the service (the class itself when it is concrete).</summary>
    private static async Task<List<INamedTypeSymbol>> ImplementationsAsync(Solution solution, INamedTypeSymbol service, CancellationToken ct)
    {
        if (service.TypeKind == TypeKind.Class && !service.IsAbstract) return new List<INamedTypeSymbol> { service };
        IEnumerable<INamedTypeSymbol> found = service.TypeKind == TypeKind.Interface
            ? (await SymbolFinder.FindImplementationsAsync(service.OriginalDefinition, solution, transitive: true, cancellationToken: ct).ConfigureAwait(false)).OfType<INamedTypeSymbol>()
            : await SymbolFinder.FindDerivedClassesAsync(service.OriginalDefinition, solution, transitive: true, cancellationToken: ct).ConfigureAwait(false);
        return found.Where(t => t.TypeKind == TypeKind.Class && !t.IsAbstract && !t.IsStatic && t.Locations.Any(l => l.IsInSource)
                && t.Arity == service.Arity && (service.Arity == 0 || service.IsUnboundGenericType || SymbolEqualityComparer.Default.Equals(service, service.OriginalDefinition) || t.Arity == 0))
            .Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default).OrderBy(t => t.Name, StringComparer.Ordinal).ToList();
    }

    /// <summary>Composition roots from the DI facts: per root the last unconditional statement that registers services.</summary>
    private static async Task<List<Root>> RootsAsync(Snapshot snapshot, CancellationToken ct)
    {
        var facts = (DependencyInjectionModule.Facts)await SemanticService.GetFactsAsync(snapshot, SemanticService.DependencyInjection, ct).ConfigureAwait(false);
        var calls = facts.Registrations.Where(r => !r.Has(DiTraits.Conditional)).Select(r => (Root: r.CompositionRoot, r.Location))
            .Concat(facts.CollectionCalls.Where(x => !x.Conditional).Select(x => (Root: x.CallerRoot, x.Location)));
        var roots = new List<Root>();
        foreach (var g in calls.Where(x => x.Location.SourceTree != null).GroupBy(x => x.Root, StringComparer.Ordinal))
        {
            Root? best = null;
            foreach (var (_, loc) in g.OrderBy(x => x.Location.SourceTree!.FilePath, StringComparer.Ordinal).ThenBy(x => x.Location.SourceSpan.Start))
            {
                var doc = snapshot.Solution.GetDocument(loc.SourceTree);
                if (doc?.FilePath == null || RenamePlanner.IsReadOnly(doc.FilePath) || SymbolFacts.IsGeneratedTree(snapshot.Solution, loc.SourceTree!, ct)) continue;
                var node = (await loc.SourceTree!.GetRootAsync(ct).ConfigureAwait(false)).FindNode(loc.SourceSpan, getInnermostNodeForTie: true);
                var stmt = node.FirstAncestorOrSelf<StatementSyntax>();
                if (stmt == null || stmt.Parent is not (BlockSyntax { Parent: BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax } or GlobalStatementSyntax)) continue;
                var receiver = ReceiverOf(stmt);
                if (receiver == null) continue;
                best = new Root(g.Key, Label(g.Key, doc, stmt, receiver), doc, stmt, receiver, stmt is ReturnStatementSyntax);
            }
            if (best != null) roots.Add(best);
        }
        // Program / top-level roots first, then by name.
        return roots.OrderBy(r => r.Anchor.Parent is GlobalStatementSyntax ? 0 : 1).ThenBy(r => r.Label, StringComparer.Ordinal).ToList();
    }

    private static string Label(string root, Document doc, StatementSyntax anchor, string receiver)
    {
        var file = Path.GetFileName(doc.FilePath);
        if (anchor.Parent is GlobalStatementSyntax) return $"{receiver} in {file}";
        var method = anchor.Ancestors().OfType<BaseMethodDeclarationSyntax>().FirstOrDefault() is MethodDeclarationSyntax m ? m.Identifier.ValueText : root;
        return $"{method}({receiver}) in {file}";
    }

    /// <summary>The collection a statement calls on: the leftmost receiver of <c>a.B.AddX().AddY()</c> (e.g. "builder.Services").</summary>
    private static string? ReceiverOf(StatementSyntax stmt)
    {
        var e = stmt switch
        {
            ExpressionStatementSyntax es => es.Expression,
            ReturnStatementSyntax rs => rs.Expression,
            _ => null,
        };
        var sawCall = false;
        while (e is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma })
        {
            e = ma.Expression;
            sawCall = true;
        }
        return sawCall && e is IdentifierNameSyntax or MemberAccessExpressionSyntax ? e!.ToString() : null;
    }

    /// <summary>Prepares the previewed registration plan.</summary>
    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, string path, LinePosition position, string? typeId, string lifetime, string? implementationId, string? rootId, CancellationToken ct)
    {
        if (Array.IndexOf(Lifetimes, lifetime) < 0) return RenameOutcome.Unavailable("InvalidParams", "lifetime must be Scoped, Transient or Singleton.");
        var info = await DescribeAsync(snapshot, path, position, typeId, ct).ConfigureAwait(false);
        if (info.ReasonCode != null) return RenameOutcome.Unavailable(info.ReasonCode, info.Message!);
        var service = (await ServiceAsync(snapshot, path, position, typeId, ct).ConfigureAwait(false))!;
        var impls = await ImplementationsAsync(snapshot.Solution, service, ct).ConfigureAwait(false);
        var impl = implementationId == null ? (impls.Count == 1 ? impls[0] : null) : impls.FirstOrDefault(t => t.GetDocumentationCommentId() == implementationId);
        if (impl == null) return RenameOutcome.Unavailable("ChooseImplementation", $"Several classes implement '{info.Service}': choose one.");
        var roots = await RootsAsync(snapshot, ct).ConfigureAwait(false);
        var root = rootId == null ? (roots.Count == 1 ? roots[0] : null) : roots.FirstOrDefault(r => r.Id == rootId);
        if (root == null) return RenameOutcome.Unavailable("ChooseCompositionRoot", "Several composition roots were found: choose one.");

        var serviceText = service.ToDisplayString(Full);
        var implText = impl.ToDisplayString(Full);
        var generic = SymbolEqualityComparer.Default.Equals(service, impl) ? serviceText : $"{serviceText}, {implText}";
        var code = $"{root.Receiver}.Add{lifetime}<{generic}>();";
        var stmt = SyntaxFactory.ParseStatement(code);
        if (stmt.ContainsDiagnostics) return RenameOutcome.Unavailable("GenerationFailed", "The registration could not be written: " + code);
        var text = await root.Document.GetTextAsync(ct).ConfigureAwait(false);
        var eol = SyntaxFactory.EndOfLine(text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");
        stmt = stmt.WithTrailingTrivia(eol).WithAdditionalAnnotations(Formatter.Annotation, Simplifier.Annotation, Imports);
        var syntaxRoot = await root.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        SyntaxNode newRoot;
        if (root.Anchor.Parent is GlobalStatementSyntax global)
        {
            var g = SyntaxFactory.GlobalStatement(stmt).WithAdditionalAnnotations(Formatter.Annotation);
            newRoot = root.Before ? syntaxRoot!.InsertNodesBefore(global, new[] { g }) : syntaxRoot!.InsertNodesAfter(global, new[] { g });
        }
        else newRoot = root.Before ? syntaxRoot!.InsertNodesBefore(root.Anchor, new[] { stmt }) : syntaxRoot!.InsertNodesAfter(root.Anchor, new[] { stmt });
        var doc = root.Document.WithSyntaxRoot(newRoot);
        doc = await ImportAdder.AddImportsAsync(doc, Imports, null, ct).ConfigureAwait(false);
        doc = await Simplifier.ReduceAsync(doc, Simplifier.Annotation, null, ct).ConfigureAwait(false);
        doc = await Formatter.FormatAsync(doc, Formatter.Annotation, null, ct).ConfigureAwait(false);
        var shortService = service.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var shortImpl = impl.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var o = new SolutionPlanBuilder.Options(ActionId, $"Register {shortService}{(SymbolEqualityComparer.Default.Equals(service, impl) ? "" : " → " + shortImpl)} ({lifetime})",
            new List<string>(), new List<(string, Location?)> { ($"Composition root {root.Id}", root.Anchor.GetLocation()) }, new List<string>());
        return await SolutionPlanBuilder.BuildAsync(snapshot, doc.Project.Solution, o, ct).ConfigureAwait(false);
    }
}
