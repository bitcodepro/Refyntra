using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>
/// Locations in C# that the Razor source generator produced from .razor / .cshtml markup: the generated code carries
/// #line directives, so the mapped span is the place in the markup file the user wrote.
/// </summary>
public static class RazorMapping
{
    public static bool IsRazorPath(string? path) =>
        path != null && (path.EndsWith(".razor", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".cshtml", StringComparison.OrdinalIgnoreCase));

    /// <summary>The markup file and span of a location in Razor-generated code, or null.</summary>
    public static (string Path, LinePositionSpan Span)? Map(Location loc)
    {
        if (!loc.IsInSource) return null;
        var mapped = loc.GetMappedLineSpan();
        if (!mapped.HasMappedPath || !IsRazorPath(mapped.Path)) return null;
        var path = mapped.Path;
        if (!Path.IsPathRooted(path) && loc.SourceTree?.FilePath is { } generated) path = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(generated) ?? "", path));
        return (path, mapped.Span);
    }

    /// <summary>
    /// The Razor-generated document and position for a position in .razor / .cshtml markup (the reverse of
    /// <see cref="Map"/>, through the #line mappings of the generated code), or null when nothing is mapped there.
    /// </summary>
    public static async Task<(Document Document, int Position)?> ToGeneratedAsync(Solution solution, string path, int line, int character, CancellationToken ct)
    {
        foreach (var project in solution.Projects)
        {
            if (!project.AdditionalDocuments.Any(d => d.FilePath != null && string.Equals(Path.GetFullPath(d.FilePath), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase))) continue;
            foreach (var generated in await project.GetSourceGeneratedDocumentsAsync(ct).ConfigureAwait(false))
            {
                var tree = await generated.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
                if (tree == null) continue;
                foreach (var m in tree.GetLineMappings(ct))
                {
                    if (m.IsHidden || !m.MappedSpan.HasMappedPath) continue;
                    var mappedPath = m.MappedSpan.Path;
                    if (!Path.IsPathRooted(mappedPath)) mappedPath = Path.Combine(Path.GetDirectoryName(tree.FilePath) ?? "", mappedPath);
                    if (!string.Equals(Path.GetFullPath(mappedPath), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase)) continue;
                    var ms = m.MappedSpan.Span;
                    if (line < ms.Start.Line || line > ms.End.Line || line == ms.Start.Line && character < ms.Start.Character || line == ms.End.Line && character > ms.End.Character) continue;
                    var text = await generated.GetTextAsync(ct).ConfigureAwait(false);
                    var genLine = m.Span.Start.Line + (line - ms.Start.Line);
                    var genChar = line == ms.Start.Line ? m.Span.Start.Character + (character - ms.Start.Character) : character;
                    if (genLine >= text.Lines.Count) continue;
                    var l = text.Lines[genLine];
                    return (generated, Math.Min(l.Start + genChar, l.End));
                }
            }
        }
        return null;
    }
}
