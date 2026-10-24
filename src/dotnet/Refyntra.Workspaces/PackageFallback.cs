using System.Text.Json;
using System.Xml.Linq;

namespace Refyntra.Workspaces;

/// <summary>
/// Assemblies of packages that a failed or partial restore left out (a private feed that needs credentials, an offline
/// machine), taken from package folders that already hold them: the NuGet global packages folder (NUGET_PACKAGES,
/// globalPackagesFolder of a NuGet.Config, ~/.nuget/packages) and the folders project.assets.json names. Then the types of
/// such a package resolve (no false "type not found" errors) and its code can be decompiled. Reads files only; never
/// restores, never downloads.
/// </summary>
public static class PackageFallback
{
    public sealed record Result(IReadOnlyList<string> Assemblies, IReadOnlyList<string> Resolved, IReadOnlyList<string> Unresolved);

    /// <summary>
    /// The compile assemblies for the project's packages missing after restore. With project.assets.json: its libraries
    /// missing from every package folder (exact versions and the compile assets of the project's target). Without it:
    /// the PackageReference items of the project file and its Directory.Packages.props, with their dependencies (.nuspec).
    /// </summary>
    public static Result Resolve(string projectPath, string? targetFramework)
    {
        var dir = Path.GetDirectoryName(projectPath) ?? ".";
        var assets = Path.Combine(dir, "obj", "project.assets.json");
        var folders = PackageFolders(dir, File.Exists(assets) ? AssetsFolders(assets) : Array.Empty<string>());
        var wanted = new List<(string id, string? version)>();
        if (File.Exists(assets))
        {
            var missing = RestoreDiagnostics.MissingPackages(assets);
            if (missing.Count == 0) return new Result(Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
            foreach (var m in missing)
            {
                var slash = m.IndexOf('/');
                wanted.Add(slash < 0 ? (m, null) : (m[..slash], m[(slash + 1)..]));
            }
        }
        else wanted.AddRange(PackageReferences(projectPath));

        var tfm = targetFramework ?? GuessTfm(projectPath);
        var dlls = new List<string>();
        var resolved = new List<string>();
        var unresolved = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<(string id, string? version, bool direct)>(wanted.Select(w => (w.id, w.version, true)));
        // Dependencies are followed only without an assets file (with one, every package is already listed); bounded.
        var followDependencies = !File.Exists(assets);
        while (queue.Count > 0 && seen.Count < 500)
        {
            var (id, version, direct) = queue.Dequeue();
            if (!seen.Add(id)) continue;
            var packageDir = FindPackage(folders, id, version);
            if (packageDir == null)
            {
                if (direct) unresolved.Add(version == null ? id : id + "/" + version);
                continue;
            }
            var found = CompileAssemblies(packageDir, tfm);
            if (found.Count > 0 || direct) resolved.Add(id + "/" + Path.GetFileName(packageDir));
            dlls.AddRange(found);
            if (followDependencies)
                foreach (var d in Dependencies(packageDir, id, tfm))
                    if (!seen.Contains(d.id)) queue.Enqueue((d.id, d.version, false));
        }
        return new Result(dlls.Distinct(StringComparer.OrdinalIgnoreCase).ToList(), resolved, unresolved);
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

    private static IReadOnlyList<string> AssetsFolders(string assets)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(assets));
            return doc.RootElement.TryGetProperty("packageFolders", out var f) && f.ValueKind == JsonValueKind.Object
                ? f.EnumerateObject().Select(p => p.Name).ToList()
                : Array.Empty<string>();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return Array.Empty<string>();
        }
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

    /// <summary>PackageReference Include/Version of the project file, versions from Directory.Packages.props (Central Package Management).</summary>
    public static List<(string id, string? version)> PackageReferences(string projectPath)
    {
        var result = new List<(string, string?)>();
        var central = CentralVersions(Path.GetDirectoryName(projectPath) ?? ".");
        foreach (var file in new[] { projectPath }.Concat(DirectoryBuildProps(Path.GetDirectoryName(projectPath) ?? ".")))
        {
            XDocument doc;
            try { doc = XDocument.Load(file); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException) { continue; }
            foreach (var e in doc.Descendants().Where(e => e.Name.LocalName == "PackageReference"))
            {
                var id = (string?)e.Attribute("Include") ?? (string?)e.Attribute("Update");
                if (string.IsNullOrWhiteSpace(id) || id.Contains("$(")) continue;
                var version = (string?)e.Attribute("Version") ?? e.Elements().FirstOrDefault(x => x.Name.LocalName == "Version")?.Value
                    ?? (string?)e.Attribute("VersionOverride") ?? (central.TryGetValue(id, out var v) ? v : null);
                if (result.All(r => !string.Equals(r.Item1, id, StringComparison.OrdinalIgnoreCase))) result.Add((id, version));
            }
        }
        return result;
    }

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
    /// The package folder: the exact version when present (a range or floating version takes its lower bound), else the
    /// highest version in the cache.
    /// </summary>
    public static string? FindPackage(IReadOnlyList<string> folders, string id, string? version)
    {
        var exact = version == null ? null : version.Trim().TrimStart('[', '(').Split(',')[0].Trim().TrimEnd(']', ')').Replace("*", "");
        foreach (var folder in folders)
        {
            var root = Path.Combine(folder, id.ToLowerInvariant());
            if (!Directory.Exists(root)) continue;
            if (!string.IsNullOrEmpty(exact) && Directory.Exists(Path.Combine(root, exact.ToLowerInvariant()))) return Path.Combine(root, exact.ToLowerInvariant());
        }
        string? best = null;
        Version? bestVersion = null;
        foreach (var folder in folders)
        {
            var root = Path.Combine(folder, id.ToLowerInvariant());
            if (!Directory.Exists(root)) continue;
            foreach (var v in Directory.EnumerateDirectories(root))
            {
                var name = Path.GetFileName(v);
                var core = Version.TryParse(name.Split('-', '+')[0], out var parsed) ? parsed : new Version(0, 0);
                if (best == null || core > bestVersion!) (best, bestVersion) = (v, core);
            }
        }
        return best;
    }

    /// <summary>The compile assemblies of a package for a target: ref/&lt;tfm&gt; before lib/&lt;tfm&gt;, the nearest compatible framework.</summary>
    public static List<string> CompileAssemblies(string packageDir, string? tfm)
    {
        foreach (var kind in new[] { "ref", "lib" })
        {
            var root = Path.Combine(packageDir, kind);
            if (!Directory.Exists(root)) continue;
            var frameworks = Directory.EnumerateDirectories(root).Select(Path.GetFileName).OfType<string>().ToList();
            var chosen = BestFramework(frameworks, tfm);
            if (chosen == null) continue;
            var dlls = Directory.EnumerateFiles(Path.Combine(root, chosen), "*.dll").ToList();
            if (dlls.Count > 0) return dlls;
        }
        return new List<string>();
    }

    /// <summary>Among a package's framework folders, the one closest to the project's target (a simplified NuGet rule).</summary>
    public static string? BestFramework(IReadOnlyList<string> frameworks, string? tfm)
    {
        if (frameworks.Count == 0) return null;
        var target = Parse(tfm ?? "net8.0");
        var ranked = frameworks
            .Select(f => (name: f, fw: Parse(f)))
            .Where(x => x.fw.family != "?" && Compatible(target, x.fw))
            .OrderByDescending(x => Rank(target, x.fw))
            .ThenByDescending(x => x.fw.version)
            .ToList();
        return ranked.Count > 0 ? ranked[0].name : null;
    }

    private static (string family, Version version) Parse(string tfm)
    {
        var t = tfm.ToLowerInvariant().Split('-')[0];
        if (t.StartsWith("netstandard", StringComparison.Ordinal)) return ("netstandard", V(t["netstandard".Length..]));
        if (t.StartsWith("netcoreapp", StringComparison.Ordinal)) return ("core", V(t["netcoreapp".Length..]));
        if (t.StartsWith("net", StringComparison.Ordinal))
        {
            var rest = t[3..];
            if (rest.Contains('.')) return ("core", V(rest));
            if (rest.Length >= 2 && rest.All(char.IsDigit)) return ("framework", new Version(rest[0] - '0', rest[1] - '0', rest.Length > 2 ? rest[2] - '0' : 0));
        }
        return ("?", new Version(0, 0));
    }

    private static Version V(string s) => Version.TryParse(s.Contains('.') ? s : s + ".0", out var v) ? v : new Version(0, 0);

    private static bool Compatible((string family, Version version) target, (string family, Version version) lib) => (target.family, lib.family) switch
    {
        ("core", "core") or ("framework", "framework") => lib.version <= target.version,
        ("core", "netstandard") => lib.version <= new Version(2, 1),
        ("framework", "netstandard") => lib.version <= new Version(2, 0),
        ("netstandard", "netstandard") => lib.version <= target.version,
        _ => false,
    };

    private static int Rank((string family, Version version) target, (string family, Version version) lib) => lib.family == target.family ? 1 : 0;

    /// <summary>The package's dependencies from its .nuspec: the group of the nearest framework, else the ungrouped list.</summary>
    private static List<(string id, string? version)> Dependencies(string packageDir, string id, string? tfm)
    {
        var nuspec = Path.Combine(packageDir, id.ToLowerInvariant() + ".nuspec");
        if (!File.Exists(nuspec)) nuspec = Directory.EnumerateFiles(packageDir, "*.nuspec").FirstOrDefault() ?? "";
        if (!File.Exists(nuspec)) return new();
        try
        {
            var deps = XDocument.Load(nuspec).Descendants().FirstOrDefault(e => e.Name.LocalName == "dependencies");
            if (deps == null) return new();
            var groups = deps.Elements().Where(e => e.Name.LocalName == "group").ToList();
            IEnumerable<XElement> items = deps.Elements().Where(e => e.Name.LocalName == "dependency");
            if (groups.Count > 0)
            {
                var names = groups.Select(g => ((string?)g.Attribute("targetFramework") ?? "").ToLowerInvariant().Replace(".netstandard", "netstandard").Replace(".netcoreapp", "netcoreapp").Replace(".netframework", "net")).ToList();
                var best = BestFramework(names.Where(n => n.Length > 0).ToList(), tfm);
                var group = best == null ? groups.FirstOrDefault(g => g.Attribute("targetFramework") == null) : groups[names.IndexOf(best)];
                items = group?.Elements().Where(e => e.Name.LocalName == "dependency") ?? Enumerable.Empty<XElement>();
            }
            return items.Select(e => ((string?)e.Attribute("id") ?? "", (string?)e.Attribute("version"))).Where(d => d.Item1.Length > 0).ToList();
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
