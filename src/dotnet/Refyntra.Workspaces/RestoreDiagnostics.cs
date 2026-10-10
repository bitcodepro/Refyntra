using System.Text.Json;

namespace Refyntra.Workspaces;

/// <summary>Detects load problems whose recovery is "dotnet restore". Reads files only; never runs restore.</summary>
public static class RestoreDiagnostics
{
    private static readonly string[] Markers =
    {
        "NETSDK1004", // assets file not found
        "NETSDK1005", // assets file has no target for the TFM
        "NETSDK1047",
        "NETSDK1064", // package not found, it might have been deleted since restore
        "NU1101", "NU1102", "NU1103",
        "project.assets.json",
        "Run a NuGet package restore",
    };

    /// <summary>
    /// MSBuildWorkspace reports every MSBuild log item (warnings included) as a failure and drops the code. These messages
    /// are advisories that do not change the compilation (NuGet audit NU1901-NU1905, deprecated packages,
    /// notices, end-of-life target framework NETSDK1138), so they must not make a project partial. Anything else stays
    /// an error: the workspace does not tell warnings from errors.
    /// </summary>
    public static bool IsAdvisory(string message) =>
        AdvisoryPatterns.Any(p => p.IsMatch(message));

    private static readonly System.Text.RegularExpressions.Regex[] AdvisoryPatterns =
    {
        new(@"with message: (Warning As Error: )?Package '[^']+' [^ ]+ has a known (low|moderate|high|critical) severity vulnerability", System.Text.RegularExpressions.RegexOptions.CultureInvariant),
        new(@"with message: (Warning As Error: )?Package '[^']+' [^ ]+ is deprecated", System.Text.RegularExpressions.RegexOptions.CultureInvariant),
        new(@"with message: (Warning As Error: )?The target framework '[^']+' is out of support and will not receive security updates", System.Text.RegularExpressions.RegexOptions.CultureInvariant),
    };

    public static bool MentionsRestore(string message) =>
        Markers.Any(m => message.Contains(m, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Packages listed in project.assets.json ("libraries" of type package) that exist in none of its "packageFolders".
    /// Returns an empty list when the file cannot be parsed (no false recovery advice).
    /// </summary>
    public static List<string> MissingPackages(string assetsPath)
    {
        var missing = new List<string>();
        try
        {
            using var stream = File.OpenRead(assetsPath);
            using var doc = JsonDocument.Parse(stream);
            var root = doc.RootElement;
            if (!root.TryGetProperty("packageFolders", out var foldersEl) || foldersEl.ValueKind != JsonValueKind.Object) return missing;
            var folders = foldersEl.EnumerateObject().Select(f => f.Name).ToList();
            if (folders.Count == 0 || !root.TryGetProperty("libraries", out var libs) || libs.ValueKind != JsonValueKind.Object) return missing;
            foreach (var lib in libs.EnumerateObject())
            {
                if (!lib.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
                if (!lib.Value.TryGetProperty("path", out var pathEl) || pathEl.GetString() is not { Length: > 0 } rel) continue;
                if (!folders.Any(f => Directory.Exists(Path.Combine(f, rel)))) missing.Add(lib.Name);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            missing.Clear();
        }
        return missing;
    }
}
