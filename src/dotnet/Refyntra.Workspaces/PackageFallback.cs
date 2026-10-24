using System.Text.Json;
using System.Xml.Linq;
using NuGet.Frameworks;
using NuGet.Versioning;

namespace Refyntra.Workspaces;

/// <summary>
/// Assemblies of packages that a failed or partial restore left out (a private feed that needs credentials, an offline
/// machine), taken from package folders that already hold them: the NuGet global packages folder (NUGET_PACKAGES,
/// globalPackagesFolder of a NuGet.Config, ~/.nuget/packages) and the folders project.assets.json names. Then the types of
/// such a package resolve (no false "type not found" errors) and its code can be decompiled. Reads files only; never
/// restores, never downloads. Versions and frameworks follow NuGet's own rules (NuGet.Versioning, NuGet.Frameworks): a
/// version outside the requested range or an assembly of an incompatible framework is never substituted.
/// </summary>
public static class PackageFallback
{
    public sealed record Result(IReadOnlyList<string> Assemblies, IReadOnlyList<string> Resolved, IReadOnlyList<string> Unresolved);

    private static readonly Result Nothing = new(Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
    private static readonly FrameworkReducer Reducer = new();

    /// <summary>
    /// The compile assemblies for the project's packages missing after restore. With project.assets.json: the compile
    /// entries of the selected target's packages that are missing from every package folder of the file (exact versions;
    /// excluded compile assets stay excluded). Without it: the PackageReference items of the project file and its
    /// Directory.Packages.props, with their .nuspec dependencies.
    /// </summary>
    public static Result Resolve(string projectPath, string? targetFramework)
    {
        var dir = Path.GetDirectoryName(projectPath) ?? ".";
        var assets = Path.Combine(dir, "obj", "project.assets.json");
        var framework = NuGetFramework.Parse(targetFramework ?? GuessTfm(projectPath) ?? "net8.0");
        if (framework.IsUnsupported) return Nothing;
        if (File.Exists(assets)) return FromAssets(assets, framework, dir);

        var folders = PackageFolders(dir, Array.Empty<string>());
        var dlls = new List<string>();
        var resolved = new List<string>();
        var unresolved = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<(PackageItem item, bool direct)>(PackageReferences(projectPath).Select(p => (p, true)));
        while (queue.Count > 0 && seen.Count < 500)
        {
            var (item, direct) = queue.Dequeue();
            if (!seen.Add(item.Id)) continue;
            var packageDir = FindPackage(folders, item.Id, item.Range);
            if (packageDir == null)
            {
                if (direct) unresolved.Add(item.Id + (item.Range == null ? "" : " " + item.Range.ToNormalizedString()));
                continue;
            }
            resolved.Add(item.Id + "/" + Path.GetFileName(packageDir));
            if (!item.ExcludeCompile) dlls.AddRange(CompileAssemblies(packageDir, framework));
            foreach (var d in Dependencies(packageDir, item.Id, framework))
                if (!seen.Contains(d.Id)) queue.Enqueue((d, false));
        }
        return new Result(dlls.Distinct(StringComparer.OrdinalIgnoreCase).ToList(), resolved, unresolved);
    }

    /// <summary>
    /// From project.assets.json: the target of the project's framework (the RID-less one), its packages that are missing
    /// from the file's package folders, and exactly their compile entries ("_._" marks an intentionally empty folder).
    /// </summary>
    private static Result FromAssets(string assets, NuGetFramework framework, string projectDir)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(File.ReadAllBytes(assets)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return Nothing; }
        using (doc)
        {
            var root = doc.RootElement;
            var assetsFolders = root.TryGetProperty("packageFolders", out var f) && f.ValueKind == JsonValueKind.Object
                ? f.EnumerateObject().Select(p => p.Name).ToList()
                : new List<string>();
            if (!root.TryGetProperty("libraries", out var libraries) || libraries.ValueKind != JsonValueKind.Object) return Nothing;
            if (!root.TryGetProperty("targets", out var targets) || targets.ValueKind != JsonValueKind.Object) return Nothing;
            JsonElement? target = null;
            foreach (var t in targets.EnumerateObject())
            {
                if (t.Name.Contains('/')) continue; // a runtime-specific target: the compile view is the RID-less one
                if (NuGetFramework.Parse(t.Name).Equals(framework)) target = t.Value;
            }
            if (target is not { } selected) return Nothing;

            var folders = PackageFolders(projectDir, assetsFolders);
            var dlls = new List<string>();
            var resolved = new List<string>();
            var unresolved = new List<string>();
            foreach (var entry in selected.EnumerateObject())
            {
                if (!entry.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
                if (!libraries.TryGetProperty(entry.Name, out var lib) || !lib.TryGetProperty("path", out var pathEl) || pathEl.GetString() is not { Length: > 0 } rel) continue;
                if (assetsFolders.Any(a => Directory.Exists(Path.Combine(a, rel)))) continue; // restored: MSBuild already references it
                var compile = entry.Value.TryGetProperty("compile", out var c) && c.ValueKind == JsonValueKind.Object
                    ? c.EnumerateObject().Select(x => x.Name).Where(x => !x.EndsWith("/_._", StringComparison.Ordinal) && x != "_._").ToList()
                    : new List<string>();
                // The exact version of the assets file only: the folder of that version in another package folder.
                var packageDir = folders.Select(x => Path.Combine(x, rel)).FirstOrDefault(Directory.Exists);
                if (packageDir == null)
                {
                    unresolved.Add(entry.Name);
                    continue;
                }
                var files = compile.Select(x => Path.Combine(packageDir, x.Replace('/', Path.DirectorySeparatorChar))).ToList();
                if (files.Any(x => !File.Exists(x)))
                {
                    unresolved.Add(entry.Name);
                    continue;
                }
                resolved.Add(entry.Name);
                dlls.AddRange(files.Where(x => x.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)));
            }
            return new Result(dlls.Distinct(StringComparer.OrdinalIgnoreCase).ToList(), resolved, unresolved);
        }
    }

    /// <summary>The folders to look in: the assets file's, then NUGET_PACKAGES, NuGet.Config globalPackagesFolder, ~/.nuget/packages.</summary>
    public static IReadOnlyList<string> PackageFolders(string projectDir, IEnumerable<string> assetsFolders)
    {
        var list = new List<string>(assetsFolders);
        if (Environment.GetEnvironmentVariable("NUGET_PACKAGES") is { Length: > 0 } env) list.Add(env);
        if (GlobalPackagesFolderFromConfig(projectDir) is { } configured) list.Add(configured);
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (home.Length > 0) list.Add(Path.Combine(home, ".nuget", "packages"));
        return list.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>globalPackagesFolder from the nearest NuGet.Config files (the folder and its parents), relative to the config.</summary>
    private static string? GlobalPackagesFolderFromConfig(string dir)
    {
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            foreach (var name in new[] { "NuGet.Config", "nuget.config", "NuGet.config" })
            {
                var file = Path.Combine(d.FullName, name);
                if (!File.Exists(file)) continue;
                try
                {
                    var value = XDocument.Load(file).Descendants("config").Elements("add")
                        .FirstOrDefault(e => string.Equals((string?)e.Attribute("key"), "globalPackagesFolder", StringComparison.OrdinalIgnoreCase))?.Attribute("value")?.Value;
                    if (!string.IsNullOrWhiteSpace(value)) return Path.GetFullPath(Path.Combine(d.FullName, Environment.ExpandEnvironmentVariables(value)));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException) { }
                break;
            }
        }
        return null;
    }

    /// <summary>A package to look for: its id, the version range NuGet would accept (null: any) and whether its compile assets are excluded.</summary>
    public sealed record PackageItem(string Id, VersionRange? Range, bool ExcludeCompile = false);

    /// <summary>PackageReference items of the project file (and Directory.Build.props), versions from Directory.Packages.props (Central Package Management).</summary>
    public static List<PackageItem> PackageReferences(string projectPath)
    {
        var result = new List<PackageItem>();
        var central = CentralVersions(Path.GetDirectoryName(projectPath) ?? ".");
        foreach (var file in new[] { projectPath }.Concat(DirectoryBuildProps(Path.GetDirectoryName(projectPath) ?? ".")))
        {
            XDocument doc;
            try { doc = XDocument.Load(file); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException) { continue; }
            foreach (var e in doc.Descendants().Where(e => e.Name.LocalName == "PackageReference"))
            {
                var id = (string?)e.Attribute("Include") ?? (string?)e.Attribute("Update");
                if (string.IsNullOrWhiteSpace(id) || id.Contains("$(") || result.Any(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase))) continue;
                var version = Value(e, "VersionOverride") ?? Value(e, "Version") ?? (central.TryGetValue(id, out var v) ? v : null);
                var exclude = (Value(e, "ExcludeAssets") ?? "").Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
                result.Add(new PackageItem(id, Range(version), exclude.Any(x => x.Equals("compile", StringComparison.OrdinalIgnoreCase) || x.Equals("all", StringComparison.OrdinalIgnoreCase))));
            }
        }
        return result;
    }

    private static string? Value(XElement e, string name) =>
        (string?)e.Attribute(name) ?? e.Elements().FirstOrDefault(x => x.Name.LocalName == name)?.Value;

    /// <summary>A NuGet version range ("1.2.0" means 1.2.0 or higher, "[1.0.0]" exactly); null when absent, unparseable or an MSBuild expression.</summary>
    private static VersionRange? Range(string? version) =>
        string.IsNullOrWhiteSpace(version) || version.Contains("$(") ? null : VersionRange.TryParse(version.Trim(), out var r) ? r : null;

    private static IEnumerable<string> DirectoryBuildProps(string dir)
    {
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            var file = Path.Combine(d.FullName, "Directory.Build.props");
            if (File.Exists(file))
            {
                yield return file;
                yield break;
            }
        }
    }

    private static Dictionary<string, string> CentralVersions(string dir)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            var file = Path.Combine(d.FullName, "Directory.Packages.props");
            if (!File.Exists(file)) continue;
            try
            {
                foreach (var e in XDocument.Load(file).Descendants().Where(e => e.Name.LocalName == "PackageVersion"))
                    if ((string?)e.Attribute("Include") is { Length: > 0 } id && (string?)e.Attribute("Version") is { Length: > 0 } v && !map.ContainsKey(id)) map[id] = v;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException) { }
            break;
        }
        return map;
    }

    /// <summary>
    /// The package folder of the version NuGet would pick among those in the cache: the lowest one in the range (NuGet's
    /// rule for a range), the highest when no version is given. A version outside the range is never taken.
    /// </summary>
    public static string? FindPackage(IReadOnlyList<string> folders, string id, VersionRange? range)
    {
        var candidates = new List<(NuGetVersion version, string dir)>();
        foreach (var folder in folders)
        {
            var root = Path.Combine(folder, id.ToLowerInvariant());
            if (!Directory.Exists(root)) continue;
            foreach (var v in Directory.EnumerateDirectories(root))
                if (NuGetVersion.TryParse(Path.GetFileName(v), out var parsed) && candidates.All(c => c.version != parsed)) candidates.Add((parsed, v));
        }
        if (candidates.Count == 0) return null;
        if (range == null) return candidates.MaxBy(c => c.version).dir;
        var best = range.FindBestMatch(candidates.Select(c => c.version));
        return best == null ? null : candidates.First(c => c.version == best).dir;
    }

    /// <summary>The compile assemblies of a package for a framework: ref/ before lib/, the nearest compatible framework folder.</summary>
    public static List<string> CompileAssemblies(string packageDir, NuGetFramework framework)
    {
        foreach (var kind in new[] { "ref", "lib" })
        {
            var root = Path.Combine(packageDir, kind);
            if (!Directory.Exists(root)) continue;
            var chosen = BestFramework(Directory.EnumerateDirectories(root).Select(Path.GetFileName).OfType<string>().ToList(), framework);
            if (chosen == null) continue;
            // A folder holding only "_._" is intentionally empty for this framework: nothing to reference, no fallback to lib.
            return Directory.EnumerateFiles(Path.Combine(root, chosen), "*.dll").ToList();
        }
        return new List<string>();
    }

    /// <summary>Among framework folder names (lib/net8.0, ref/netstandard2.0, lib/net8.0-windows7.0), NuGet's nearest compatible one.</summary>
    public static string? BestFramework(IReadOnlyList<string> folders, string targetFramework) => BestFramework(folders, NuGetFramework.Parse(targetFramework));

    private static string? BestFramework(IReadOnlyList<string> folders, NuGetFramework framework)
    {
        var parsed = folders.OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => (name: f, fw: NuGetFramework.ParseFolder(f)))
            .Where(x => !x.fw.IsUnsupported)
            .ToList();
        var nearest = Reducer.GetNearest(framework, parsed.Select(x => x.fw));
        return nearest == null ? null : parsed.First(x => x.fw.Equals(nearest)).name;
    }

    /// <summary>The package's dependencies from its .nuspec: the group of NuGet's nearest framework, else the ungrouped list.</summary>
    private static List<PackageItem> Dependencies(string packageDir, string id, NuGetFramework framework)
    {
        var nuspec = Path.Combine(packageDir, id.ToLowerInvariant() + ".nuspec");
        if (!File.Exists(nuspec)) nuspec = Directory.EnumerateFiles(packageDir, "*.nuspec").FirstOrDefault() ?? "";
        if (!File.Exists(nuspec)) return new();
        try
        {
            var deps = XDocument.Load(nuspec).Descendants().FirstOrDefault(e => e.Name.LocalName == "dependencies");
            if (deps == null) return new();
            IEnumerable<XElement> items = deps.Elements().Where(e => e.Name.LocalName == "dependency");
            var groups = deps.Elements().Where(e => e.Name.LocalName == "group")
                .Select(g => (group: g, fw: g.Attribute("targetFramework") is { } a ? NuGetFramework.Parse(a.Value) : NuGetFramework.AnyFramework))
                .Where(x => !x.fw.IsUnsupported)
                .ToList();
            if (groups.Count > 0)
            {
                var nearest = Reducer.GetNearest(framework, groups.Select(x => x.fw));
                items = nearest == null ? Enumerable.Empty<XElement>() : groups.First(x => x.fw.Equals(nearest)).group.Elements().Where(e => e.Name.LocalName == "dependency");
            }
            return items
                .Where(e => !((string?)e.Attribute("exclude") ?? "").Split(',', StringSplitOptions.TrimEntries).Any(x => x.Equals("Compile", StringComparison.OrdinalIgnoreCase)))
                .Select(e => new PackageItem((string?)e.Attribute("id") ?? "", Range((string?)e.Attribute("version"))))
                .Where(d => d.Id.Length > 0)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return new();
        }
    }

    private static string? GuessTfm(string projectPath)
    {
        try
        {
            var doc = XDocument.Load(projectPath);
            var tf = doc.Descendants().FirstOrDefault(e => e.Name.LocalName is "TargetFramework" or "TargetFrameworks")?.Value;
            return tf?.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }
}
