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
}
