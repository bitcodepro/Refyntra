using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Frameworks.EfCore;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>What a rename does with the EF Core migration files that reference the symbol.</summary>
public static class GeneratedEditModes
{
    /// <summary>Rename the references in EF Core migrations and model snapshots too (default).</summary>
    public const string EfMigrations = "efMigrations";
    /// <summary>Leave EF Core migrations untouched (the project does not build until they are updated).</summary>
    public const string None = "none";
}

/// <summary>EF Core migrations a rename touches: the mode used for the plan and the migration files with edits.</summary>
public sealed record EfMigrationOffer(string Mode, IReadOnlyList<string> Files);

/// <summary>
/// EF Core migrations and model snapshots in a rename: identity proof of the file (verified EF attributes and base
/// types, <see cref="EfCoreModule.MigrationFileContext"/>) and proof that Roslyn's edits in it only rename references
/// to the renamed symbol (no string, no other token).
/// </summary>
internal static class EfMigrationEdits
{
    /// <summary>The DbContext the document is a migration/snapshot of, or null when it is not proven to be one.</summary>
    public static async Task<INamedTypeSymbol?> MigrationContextAsync(Document doc, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root == null || !MentionsDbContextAttribute(root)) return null;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return model == null ? null : EfCoreModule.MigrationFileContext(model, root, ct);
    }

    /// <summary>Cheap syntactic prefilter: an attribute named DbContext / DbContextAttribute.</summary>
    private static bool MentionsDbContextAttribute(SyntaxNode root) =>
        root.DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.AttributeSyntax>().Any(a =>
        {
            var name = a.Name.ToString();
            var last = name.Substring(name.LastIndexOf('.') + 1);
            return last is "DbContext" or "DbContextAttribute";
        });

    /// <summary>
    /// True when the edits from <paramref name="oldDoc"/> to <paramref name="newDoc"/> replace only identifier tokens
    /// spelled like the symbol that bind to the renamed symbol, each by the new name, and nothing else.
    /// </summary>
    public static async Task<bool> OnlyRenamesReferencesAsync(Document oldDoc, Document newDoc, ISymbol symbol, string newName, string bareNew, CancellationToken ct)
    {
        var root = await oldDoc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await oldDoc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null || model == null) return false;
        var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
        var newText = (await newDoc.GetTextAsync(ct).ConfigureAwait(false)).ToString();
        var changes = await newDoc.GetTextChangesAsync(oldDoc, ct).ConfigureAwait(false);
        var tokens = new SortedDictionary<int, SyntaxToken>();
        foreach (var c in changes)
        {
            var touched = c.Span.Length == 0 ? new[] { root.FindToken(c.Span.Start) } : root.DescendantTokens(c.Span).Where(t => t.Span.IntersectsWith(c.Span)).ToArray();
            if (touched.Length != 1) return false;
            var token = touched[0];
            if (!token.IsKind(SyntaxKind.IdentifierToken) || token.ValueText != symbol.Name) return false;
            if (c.Span.Start < token.SpanStart || c.Span.End > token.Span.End) return false;
            if (!BindsTo(model, token, symbol, ct)) return false;
            tokens[token.SpanStart] = token;
        }
        if (tokens.Count == 0) return false;
        foreach (var replacement in new[] { newName, bareNew }.Distinct())
        {
            var expected = oldText.WithChanges(tokens.Values.Select(t => new TextChange(t.Span, replacement))).ToString();
            if (expected == newText) return true;
        }
        return false;
    }

    private static bool BindsTo(SemanticModel model, SyntaxToken token, ISymbol symbol, CancellationToken ct)
    {
        var node = token.Parent;
        if (node == null) return false;
        var info = model.GetSymbolInfo(node, ct);
        var bound = info.Symbol ?? model.GetDeclaredSymbol(node, ct) ?? (info.CandidateSymbols.Length == 1 ? info.CandidateSymbols[0] : null);
        if (bound is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) bound = ctor.ContainingType;
        if (bound is IAliasSymbol alias) bound = alias.Target;
        return bound != null && SymbolIdentity.SameDefinition(bound.OriginalDefinition, symbol.OriginalDefinition);
    }

    /// <summary>
    /// The proven EF Core migration/snapshot documents of the given projects that keep the old name as text: string
    /// literals equal to the CLR name of the renamed type (model snapshots name entities by it), and migration or
    /// snapshot class names that contain the old name.
    /// </summary>
    public static async Task<(List<string> stringFiles, List<string> classNames)> OldNameTextAsync(Solution solution, IEnumerable<ProjectId> projects, ISymbol symbol, CancellationToken ct)
    {
        var stringFiles = new List<string>();
        var classNames = new SortedSet<string>(StringComparer.Ordinal);
        var clrName = symbol is INamedTypeSymbol t ? SymbolIdentity.FullMetadataName(t.OriginalDefinition) : null;
        var seen = new HashSet<string>(UriPaths.PathComparer);
        foreach (var pid in projects)
        {
            var project = solution.GetProject(pid);
            if (project == null) continue;
            foreach (var doc in project.Documents)
            {
                ct.ThrowIfCancellationRequested();
                if (doc.FilePath == null || !seen.Add(doc.FilePath)) continue;
                if (await MigrationContextAsync(doc, ct).ConfigureAwait(false) == null) continue;
                var root = (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
                if (clrName != null && root.DescendantTokens().Any(tok => tok.IsKind(SyntaxKind.StringLiteralToken) && tok.ValueText == clrName))
                    stringFiles.Add(doc.FilePath);
                if (symbol.Kind == SymbolKind.NamedType)
                    foreach (var decl in root.DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseTypeDeclarationSyntax>())
                        if (decl.Identifier.ValueText != symbol.Name && decl.Identifier.ValueText.Contains(symbol.Name, StringComparison.Ordinal))
                            classNames.Add(decl.Identifier.ValueText);
            }
        }
        return (stringFiles, classNames.ToList());
    }
}
