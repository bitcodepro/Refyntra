using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>A test that references something declared in the changed files, and the first such reference (the reason).</summary>
public sealed record AffectedTest(string FullyQualifiedName, string Reason);

/// <summary>
/// Tests affected by a change of some files (protocol 1.26, <c>code/affectedTests</c>): every test method that references
/// a type or member declared in those files (found by Roslyn's reference search). Static references, not runtime
/// coverage: a test reached only through reflection, DI or another layer is not listed.
/// </summary>
public static class AffectedTests
{
    private const int MaxSymbols = 400;
    private const int MaxTests = 2000;

    public static async Task<(List<AffectedTest> Tests, bool Truncated)> ForDocumentsAsync(Snapshot snapshot, IReadOnlyList<Document> documents, CancellationToken ct)
    {
        var (symbols, truncated) = await DeclaredSymbolsAsync(documents, ct).ConfigureAwait(false);
        var (tests, cut) = await ForSymbolsAsync(snapshot, symbols, ct).ConfigureAwait(false);
        return (tests, truncated || cut);
    }

    /// <summary>The types and members the documents declare (test classes and their members left out), members first.</summary>
    public static async Task<(List<ISymbol> Symbols, bool Truncated)> DeclaredSymbolsAsync(IReadOnlyList<Document> documents, CancellationToken ct)
    {
        var symbols = new List<ISymbol>();
        foreach (var doc in documents)
        {
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (root == null || model == null) continue;
            foreach (var node in root.DescendantNodes().Where(n => n is BaseTypeDeclarationSyntax or MethodDeclarationSyntax or PropertyDeclarationSyntax or ConstructorDeclarationSyntax or EventDeclarationSyntax or VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } or DelegateDeclarationSyntax or EnumMemberDeclarationSyntax))
            {
                var s = model.GetDeclaredSymbol(node, ct);
                if (s == null || s.IsImplicitlyDeclared || TestNavigation.IsTestSymbol(s)) continue;
                // Members of a test class (helpers, data sources): a changed test file runs its own tests anyway.
                if (s.ContainingType is { } owner && TestNavigation.IsTestClass(owner)) continue;
                symbols.Add(s);
                if (symbols.Count >= MaxSymbols) break;
            }
        }
        // Members first: the reason names the method or property a test uses rather than only its type.
        return (symbols.OrderBy(x => x is INamedTypeSymbol ? 1 : 0).ToList(), symbols.Count >= MaxSymbols);
    }

    /// <summary>The test methods that reference any of the symbols, each with the first reference found.</summary>
    public static async Task<(List<AffectedTest> Tests, bool Truncated)> ForSymbolsAsync(Snapshot snapshot, IReadOnlyList<ISymbol> symbols, CancellationToken ct)
    {
        var truncated = false;
        var found = new Dictionary<string, AffectedTest>(StringComparer.Ordinal);
        var testProjects = new Dictionary<ProjectId, bool>();
        foreach (var symbol in symbols)
        {
            ct.ThrowIfCancellationRequested();
            var refs = await SymbolFinder.FindReferencesAsync(symbol, snapshot.Solution, ct).ConfigureAwait(false);
            foreach (var loc in refs.SelectMany(r => r.Locations))
            {
                if (!testProjects.TryGetValue(loc.Document.Project.Id, out var isTest))
                    testProjects[loc.Document.Project.Id] = isTest = await UsageClassifier.IsTestProjectAsync(loc.Document.Project, ct).ConfigureAwait(false);
                if (!isTest) continue;
                var model = await loc.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
                var root = await loc.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                if (model == null || root == null) continue;
                var node = root.FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                var test = TestNavigation.EnclosingTestMethod(model, node, ct);
                if (test == null) continue;
                var fqn = FullyQualifiedName(test);
                if (found.ContainsKey(fqn)) continue;
                var line = loc.Location.GetLineSpan().StartLinePosition.Line + 1;
                var what = symbol is INamedTypeSymbol ? symbol.Name : $"{symbol.ContainingType?.Name}.{symbol.Name}";
                found[fqn] = new AffectedTest(fqn, $"references {what} ({Path.GetFileName(loc.Document.FilePath)}:{line})");
                if (found.Count >= MaxTests) return (found.Values.ToList(), true);
            }
        }
        return (found.Values.OrderBy(t => t.FullyQualifiedName, StringComparer.Ordinal).ToList(), truncated);
    }

    /// <summary>"Ns.Outer+Inner.Method", as test adapters report it.</summary>
    public static string FullyQualifiedName(IMethodSymbol method)
    {
        var types = new List<string>();
        for (var t = method.ContainingType; t != null; t = t.ContainingType) types.Insert(0, t.MetadataName);
        var ns = method.ContainingType?.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : "";
        return ns + string.Join("+", types) + "." + method.Name;
    }
}
