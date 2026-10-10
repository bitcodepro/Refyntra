using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>
/// Sorts the using directives of each block (the file and each namespace): global usings first, then namespaces, then
/// "using static", then aliases; inside each kind by name, "System" first unless .editorconfig sets
/// dotnet_sort_system_directives_first = false. Only the order changes: every using keeps its own text, every line keeps
/// its indentation and the blank lines between groups stay where they are (each group is sorted on its own). A block
/// with comments between usings or preprocessor directives is skipped.
/// </summary>
public sealed class SortUsingsFix : ICleanupFix
{
    public string Id => CleanupFixIds.SortUsings;
    public string Title => "Sort usings";
    public bool Semantic => true;

    public async Task<FixOutcome> ApplyAsync(CleanupFile file, CancellationToken ct)
    {
        var systemFirst = file.Flag("dotnet_sort_system_directives_first") ?? true;
        var changes = new List<TextChange>();
        var moved = 0;
        string? skipped = null;
        foreach (var block in file.Root.DescendantNodesAndSelf(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
                     .Select(n => n switch { CompilationUnitSyntax cu => cu.Usings, BaseNamespaceDeclarationSyntax ns => ns.Usings, _ => default })
                     .Where(l => l.Count > 1))
        {
            if (Unsortable(block) is { } why)
            {
                skipped ??= why;
                continue;
            }
            // Groups: runs of usings not separated by a blank line.
            var groups = new List<List<UsingDirectiveSyntax>> { new() };
            for (var i = 0; i < block.Count; i++)
            {
                if (i > 0 && block[i].GetLeadingTrivia().Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia))) groups.Add(new());
                groups[^1].Add(block[i]);
            }
            foreach (var group in groups)
            {
                var sorted = group.OrderBy(u => u, new UsingComparer(systemFirst)).ToList();
                for (var i = 0; i < group.Count; i++)
                {
                    if (sorted[i] == group[i]) continue;
                    moved++;
                    changes.Add(new TextChange(group[i].Span, sorted[i].ToString()));
                }
            }
        }
        if (changes.Count == 0)
            return skipped != null && moved == 0 && NeedsSort(file, systemFirst) ? new FixOutcome.Skipped("UnsortableUsings", skipped) : FixOutcome.None;
        var result = CleanupText.Apply(file.Text.ToString(), changes);
        if (await file.Verify(result, ct).ConfigureAwait(false) is { } reason)
            return new FixOutcome.Skipped("SemanticsNotProven", "Sorting the usings would change the code: " + reason);
        return new FixOutcome.Changed(result, moved);
    }

    private static bool NeedsSort(CleanupFile file, bool systemFirst) =>
        file.Root.DescendantNodesAndSelf(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
            .Select(n => n switch { CompilationUnitSyntax cu => cu.Usings, BaseNamespaceDeclarationSyntax ns => ns.Usings, _ => default })
            .Any(l => l.Count > 1 && !l.SequenceEqual(l.OrderBy(u => u, new UsingComparer(systemFirst))));

    private static string? Unsortable(SyntaxList<UsingDirectiveSyntax> block)
    {
        for (var i = 0; i < block.Count; i++)
        {
            var u = block[i];
            if (CleanupText.HasDirective(u.GetLeadingTrivia()) || CleanupText.HasDirective(u.GetTrailingTrivia()))
                return "The usings are mixed with preprocessor directives.";
            if (i > 0 && !CleanupText.OnlyWhitespace(u.GetLeadingTrivia())) return "A comment stands between the usings.";
            if (!CleanupText.OnlyWhitespace(u.GetTrailingTrivia())) return "A comment follows a using on its line.";
            if (u.DescendantTrivia().Any(t => u.Span.Contains(t.Span) && t.Span.End < u.Span.End && !t.IsKind(SyntaxKind.WhitespaceTrivia)))
                return "A using contains a comment or a line break.";
        }
        return null;
    }

    /// <summary>Global first; then namespaces, static, aliases; by name (segment by segment, ignoring case first), System first.</summary>
    internal sealed class UsingComparer(bool systemFirst) : IComparer<UsingDirectiveSyntax>
    {
        private static int Kind(UsingDirectiveSyntax u) =>
            (u.GlobalKeyword.IsKind(SyntaxKind.None) ? 10 : 0) + (u.Alias != null ? 2 : u.StaticKeyword.IsKind(SyntaxKind.None) ? 0 : 1);

        private static string Name(UsingDirectiveSyntax u) =>
            u.Alias != null ? u.Alias.Name.Identifier.ValueText : (u.NamespaceOrType?.ToString() ?? "").Replace(" ", "").Replace("global::", "");

        public int Compare(UsingDirectiveSyntax? x, UsingDirectiveSyntax? y)
        {
            if (ReferenceEquals(x, y)) return 0;
            if (x == null) return -1;
            if (y == null) return 1;
            var k = Kind(x).CompareTo(Kind(y));
            if (k != 0) return k;
            string a = Name(x), b = Name(y);
            if (systemFirst && x.Alias == null)
            {
                var sa = a == "System" || a.StartsWith("System.", StringComparison.Ordinal);
                var sb = b == "System" || b.StartsWith("System.", StringComparison.Ordinal);
                if (sa != sb) return sa ? -1 : 1;
            }
            var pa = a.Split('.');
            var pb = b.Split('.');
            for (var i = 0; i < Math.Min(pa.Length, pb.Length); i++)
            {
                var c = string.Compare(pa[i], pb[i], StringComparison.OrdinalIgnoreCase);
                if (c == 0) c = string.Compare(pa[i], pb[i], StringComparison.Ordinal);
                if (c != 0) return c;
            }
            return pa.Length.CompareTo(pb.Length);
        }
    }
}
