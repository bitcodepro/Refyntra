using System.Text.Json;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace Refyntra.Workspaces;

/// <summary>An item of a project as the Solution Explorer shows it (solution/structure, protocol 1.20).</summary>
/// <param name="Path">Full path on disk.</param>
/// <param name="ItemType">Compile, AdditionalFiles, None, Content, EmbeddedResource …</param>
/// <param name="VirtualPath">Where the item is shown inside the project ('/'-separated, file name last).</param>
/// <param name="Linked">The file lives outside the project folder (Link metadata or a path outside).</param>
public sealed record ProjectItemEntry(string Path, string ItemType, string VirtualPath, bool Linked);

public sealed record PackageEntry(string Id, string? Version, string? ResolvedVersion, bool Central, bool VersionOverride);

public sealed record ProjectReferenceEntry(string Name, string ProjectPath);

public sealed record ProjectStructureEntry
{
    public required string Name { get; init; }
    public required string ProjectPath { get; init; }
    public string? FolderId { get; init; }
    /// <summary>web, console, worker, desktop, test, library, maui, blazor-wasm, unknown.</summary>
    public required string Kind { get; init; }
    public required IReadOnlyList<string> TargetFrameworks { get; init; }
    /// <summary>loaded, partial, failed, notLoaded (in the solution file, not in the loaded workspace).</summary>
    public required string State { get; init; }
    public string? Sdk { get; init; }
    public bool CentralPackageManagement { get; init; }
    public string? PackagesPropsPath { get; init; }
    public IReadOnlyList<ProjectReferenceEntry> ProjectReferences { get; init; } = Array.Empty<ProjectReferenceEntry>();
    public IReadOnlyList<PackageEntry> Packages { get; init; } = Array.Empty<PackageEntry>();
    public IReadOnlyList<string> Frameworks { get; init; } = Array.Empty<string>();
    public IReadOnlyList<(string Name, string? Path)> Analyzers { get; init; } = Array.Empty<(string, string?)>();
    public IReadOnlyList<ProjectItemEntry> Items { get; init; } = Array.Empty<ProjectItemEntry>();
    /// <summary>C# files in the project folder that the evaluation does not compile (Compile Remove, other globs).</summary>
    public IReadOnlyList<string> Excluded { get; init; } = Array.Empty<string>();
    public bool ItemsTruncated { get; init; }
}

public sealed record SolutionStructure(string? SolutionPath, string Format, IReadOnlyList<SolutionFolderEntry> Folders, IReadOnlyList<ProjectStructureEntry> Projects);

/// <summary>
/// The Solution Explorer model: the solution file (folders, entries) joined with the loaded MSBuild evaluation (Roslyn
/// projects: compile items, links, project and analyzer references, target frameworks) and the project files themselves
/// (package references, Central Package Management, framework references from project.assets.json when restored).
/// </summary>
public static class ProjectStructureBuilder
{
    public const int MaxItemsPerProject = 5000;
    private static readonly HashSet<string> SkippedDirs = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", ".git", ".vs", ".vscode", ".idea" };

    public static SolutionStructure Build(string openedPath, Solution? solution, IReadOnlyList<ProjectContext> contexts)
    {
        SolutionFileModel file;
        try { file = SolutionFileReader.Read(openedPath); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            file = new SolutionFileModel(openedPath.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) ? "slnx" : openedPath.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) ? "sln" : "project", Array.Empty<SolutionFolderEntry>(), Array.Empty<SolutionProjectEntry>());
        }
        var runnable = solution == null ? new Dictionary<string, RunnableProject>(UriPaths.PathComparer) : RunnableProjectDetector.Detect(solution).GroupBy(r => r.ProjectPath, UriPaths.PathComparer).ToDictionary(g => g.Key, g => g.First(), UriPaths.PathComparer);
        var roslyn = solution == null
            ? new Dictionary<string, List<Project>>(UriPaths.PathComparer)
            : solution.Projects.Where(p => p.FilePath != null).GroupBy(p => Path.GetFullPath(p.FilePath!), UriPaths.PathComparer).ToDictionary(g => g.Key, g => g.ToList(), UriPaths.PathComparer);
        var entries = file.Projects.ToList();
        // Projects loaded through references only (not in the solution file) are shown at the root, as MSBuild loaded them.
        foreach (var path in roslyn.Keys)
            if (!entries.Any(e => UriPaths.PathComparer.Equals(e.ProjectPath, path)))
                entries.Add(new SolutionProjectEntry(Path.GetFileNameWithoutExtension(path), path, null));
        var projects = entries.Select(e => BuildProject(e, roslyn.TryGetValue(e.ProjectPath, out var ps) ? ps : null, runnable.TryGetValue(e.ProjectPath, out var r) ? r : null, contexts, solution)).ToList();
        return new SolutionStructure(file.Format == "project" ? null : Path.GetFullPath(openedPath), file.Format, file.Folders, projects);
    }

    private static string StateOf(string projectPath, IReadOnlyList<ProjectContext> contexts, bool loaded)
    {
        var mine = contexts.Where(c => UriPaths.PathComparer.Equals(c.ProjectPath, projectPath)).ToList();
        if (mine.Count == 0) return loaded ? ProjectStates.Loaded : "notLoaded";
        if (mine.Any(c => c.State == ProjectStates.Failed)) return mine.All(c => c.State == ProjectStates.Failed) ? ProjectStates.Failed : ProjectStates.Partial;
        return mine.Any(c => c.State == ProjectStates.Partial) ? ProjectStates.Partial : ProjectStates.Loaded;
    }

    public static string KindOf(RunnableProject? r, ProjectFacts facts)
    {
        var kind = r?.Kind ?? RunnableProjectDetector.Classify(facts).Kind;
        return kind switch
        {
            RunnableKinds.Wpf or RunnableKinds.WinForms => "desktop",
            _ => kind,
        };
    }

    private static ProjectStructureEntry BuildProject(SolutionProjectEntry e, List<Project>? instances, RunnableProject? runnable, IReadOnlyList<ProjectContext> contexts, Solution? solution)
    {
        var path = e.ProjectPath;
        var dir = Path.GetDirectoryName(path)!;
        ProjectFacts facts;
        XDocument? xml = null;
        try
        {
            facts = RunnableProjectDetector.FromProjectFile(path);
            xml = File.Exists(path) ? XDocument.Load(path) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            facts = new ProjectFacts { ProjectPath = path, Name = e.Name };
        }
        var sdk = facts.Sdks.FirstOrDefault();
        var tfms = runnable?.TargetFrameworks.ToList() ?? new List<string>();
        if (tfms.Count == 0)
        {
            var list = facts.Properties.TryGetValue("TargetFrameworks", out var many) ? many : facts.Properties.TryGetValue("TargetFramework", out var one) ? one : null;
            if (list != null) tfms = list.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(t => !t.Contains("$(")).ToList();
        }
        var (cpm, propsPath, central) = CentralPackages(dir, facts);
        var assets = ReadAssets(dir);
        var packages = new List<PackageEntry>();
        if (xml?.Root != null)
        {
            foreach (var pr in xml.Root.Descendants().Where(x => x.Name.LocalName == "PackageReference"))
            {
                var id = (string?)pr.Attribute("Include");
                if (string.IsNullOrWhiteSpace(id) || packages.Any(p => p.Id.Equals(id, StringComparison.OrdinalIgnoreCase))) continue;
                var v = (string?)pr.Attribute("Version") ?? pr.Elements().FirstOrDefault(x => x.Name.LocalName == "Version")?.Value;
                var ov = (string?)pr.Attribute("VersionOverride") ?? pr.Elements().FirstOrDefault(x => x.Name.LocalName == "VersionOverride")?.Value;
                var isCentral = cpm && v == null && ov == null && central.ContainsKey(id);
                var version = ov ?? v ?? (cpm && central.TryGetValue(id, out var cv) ? cv : null);
                packages.Add(new PackageEntry(id, version, assets.Resolved(id), isCentral, ov != null));
            }
        }
        packages.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Id, b.Id));
        var frameworks = assets.FrameworkReferences.Count > 0 ? assets.FrameworkReferences.ToList() : GuessFrameworks(tfms, facts, xml);

        var links = LinkedItems(xml, dir);
        var projectRefs = new List<ProjectReferenceEntry>();
        var analyzers = new List<(string, string?)>();
        var items = new List<ProjectItemEntry>();
        var compiled = new HashSet<string>(UriPaths.PathComparer);
        var truncated = false;
        if (instances != null && solution != null)
        {
            foreach (var p in instances)
            {
                foreach (var pr in p.ProjectReferences)
                {
                    var target = solution.GetProject(pr.ProjectId);
                    if (target?.FilePath == null || projectRefs.Any(x => UriPaths.PathComparer.Equals(x.ProjectPath, target.FilePath))) continue;
                    projectRefs.Add(new ProjectReferenceEntry(Path.GetFileNameWithoutExtension(target.FilePath), Path.GetFullPath(target.FilePath)));
                }
                foreach (var a in p.AnalyzerReferences)
                {
                    var name = a.Display ?? (a.FullPath == null ? null : Path.GetFileNameWithoutExtension(a.FullPath));
                    if (name == null || analyzers.Any(x => x.Item1.Equals(name, StringComparison.OrdinalIgnoreCase))) continue;
                    analyzers.Add((name, a.FullPath));
                }
                void Add(TextDocument d, string type)
                {
                    if (d.FilePath == null || !compiled.Add(Path.GetFullPath(d.FilePath))) return;
                    var full = Path.GetFullPath(d.FilePath);
                    if (IsUnder(full, Path.Combine(dir, "obj")) || IsUnder(full, Path.Combine(dir, "bin"))) return; // generated (GlobalUsings, AssemblyInfo)
                    var inside = IsUnder(full, dir);
                    // Link metadata from the project file wins (Roslyn splits it only on the platform's separator).
                    var virt = links.TryGetValue(full, out var link) ? link
                        : inside ? Path.GetRelativePath(dir, full).Replace('\\', '/')
                        : string.Join('/', d.Folders.SelectMany(f => f.Split('\\', '/')).Append(Path.GetFileName(full)));
                    if (items.Count >= MaxItemsPerProject) { truncated = true; return; }
                    items.Add(new ProjectItemEntry(full, type, virt, !inside));
                }
                foreach (var d in p.Documents) Add(d, "Compile");
                foreach (var d in p.AdditionalDocuments) Add(d, "AdditionalFiles");
            }
        }
        // Explicit items with Link metadata (None / Content / EmbeddedResource …) from the project file.
        if (xml?.Root != null)
        {
            foreach (var x in xml.Root.Descendants().Where(x => x.Parent?.Name.LocalName == "ItemGroup" && x.Name.LocalName is not ("Compile" or "PackageReference" or "ProjectReference" or "FrameworkReference" or "PackageVersion" or "Using" or "InternalsVisibleTo")))
            {
                var inc = (string?)x.Attribute("Include");
                if (inc == null || inc.IndexOfAny(new[] { '*', '?', '$', ';' }) >= 0) continue;
                var full = FullOf(dir, inc);
                if (!File.Exists(full) || compiled.Contains(full)) continue;
                var link = (string?)x.Attribute("Link") ?? x.Elements().FirstOrDefault(c => c.Name.LocalName == "Link")?.Value;
                var inside = IsUnder(full, dir);
                compiled.Add(full);
                items.Add(new ProjectItemEntry(full, x.Name.LocalName, (link ?? (inside ? Path.GetRelativePath(dir, full) : Path.GetFileName(full))).Replace('\\', '/'), !inside || link != null));
            }
        }
        // SDK-style projects include every other file of the folder as None/Content (default globs); C# files the
        // evaluation does not compile are "excluded" (shown greyed or hidden, a client setting).
        var excluded = new List<string>();
        if (sdk != null && Directory.Exists(dir) && instances != null)
        {
            var nested = NestedProjectDirs(dir);
            foreach (var f in Files(dir, nested))
            {
                if (compiled.Contains(f) || f.Equals(path, StringComparison.OrdinalIgnoreCase)) continue;
                if (f.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) { if (excluded.Count < MaxItemsPerProject) excluded.Add(f); continue; }
                if (items.Count >= MaxItemsPerProject) { truncated = true; break; }
                var rel = Path.GetRelativePath(dir, f).Replace('\\', '/');
                items.Add(new ProjectItemEntry(f, DefaultItemType(sdk, rel), rel, false));
            }
        }
        items.Sort((a, b) => string.CompareOrdinal(a.VirtualPath, b.VirtualPath));
        return new ProjectStructureEntry
        {
            Name = e.Name,
            ProjectPath = path,
            FolderId = e.FolderId,
            Kind = KindOf(runnable, facts),
            TargetFrameworks = tfms,
            State = StateOf(path, contexts, instances != null),
            Sdk = sdk,
            CentralPackageManagement = cpm,
            PackagesPropsPath = propsPath,
            ProjectReferences = projectRefs.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            Packages = packages,
            Frameworks = frameworks,
            Analyzers = analyzers.OrderBy(a => a.Item1, StringComparer.OrdinalIgnoreCase).ToList(),
            Items = items,
            Excluded = excluded,
            ItemsTruncated = truncated,
        };
    }

    /// <summary>Explicit items with Link metadata: full path → the link path ('/'-separated), as written in the project file.</summary>
    private static Dictionary<string, string> LinkedItems(XDocument? xml, string dir)
    {
        var map = new Dictionary<string, string>(UriPaths.PathComparer);
        if (xml?.Root == null) return map;
        foreach (var x in xml.Root.Descendants().Where(x => x.Parent?.Name.LocalName == "ItemGroup"))
        {
            var inc = (string?)x.Attribute("Include");
            var link = (string?)x.Attribute("Link") ?? x.Elements().FirstOrDefault(c => c.Name.LocalName == "Link")?.Value;
            if (inc == null || link == null || inc.IndexOfAny(new[] { '*', '?', '$', ';' }) >= 0 || link.Contains("$(")) continue;
            map[FullOf(dir, inc)] = link.Replace('\\', '/').Trim('/');
        }
        return map;
    }

    private static string FullOf(string dir, string include) =>
        Path.GetFullPath(Path.Combine(dir, include.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)));

    private static string DefaultItemType(string sdk, string rel)
    {
        var web = sdk.StartsWith("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase) || sdk.StartsWith("Microsoft.NET.Sdk.Razor", StringComparison.OrdinalIgnoreCase) || sdk.StartsWith("Microsoft.NET.Sdk.BlazorWebAssembly", StringComparison.OrdinalIgnoreCase);
        if (web && (rel.StartsWith("wwwroot/", StringComparison.OrdinalIgnoreCase) || rel.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || rel.EndsWith(".config", StringComparison.OrdinalIgnoreCase)
            || rel.EndsWith(".cshtml", StringComparison.OrdinalIgnoreCase) || rel.EndsWith(".razor", StringComparison.OrdinalIgnoreCase)))
            return "Content";
        if (rel.EndsWith(".resx", StringComparison.OrdinalIgnoreCase)) return "EmbeddedResource";
        return "None";
    }

    public static bool IsUnder(string path, string dir)
    {
        var d = dir.EndsWith(Path.DirectorySeparatorChar) ? dir : dir + Path.DirectorySeparatorChar;
        return path.StartsWith(d, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    private static HashSet<string> NestedProjectDirs(string dir)
    {
        var set = new HashSet<string>(UriPaths.PathComparer);
        foreach (var sub in SafeDirs(dir))
            CollectNested(sub, set, 0);
        return set;
    }

    private static void CollectNested(string d, HashSet<string> set, int depth)
    {
        if (depth > 12) return;
        try
        {
            if (Directory.EnumerateFiles(d, "*.*proj").Any()) { set.Add(d); return; }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return; }
        foreach (var s in SafeDirs(d)) CollectNested(s, set, depth + 1);
    }

    private static IEnumerable<string> SafeDirs(string d)
    {
        try
        {
            return Directory.EnumerateDirectories(d).Where(s => !SkippedDirs.Contains(Path.GetFileName(s)) && !Path.GetFileName(s).StartsWith('.')).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return Array.Empty<string>(); }
    }

    private static IEnumerable<string> Files(string dir, HashSet<string> nested)
    {
        var stack = new Stack<string>();
        stack.Push(dir);
        var count = 0;
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            string[] files;
            try { files = Directory.GetFiles(d); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (var f in files.OrderBy(f => f, StringComparer.Ordinal))
            {
                if (Path.GetFileName(f).StartsWith('.')) continue;
                if (++count > MaxItemsPerProject * 2) yield break;
                yield return Path.GetFullPath(f);
            }
            foreach (var s in SafeDirs(d).Where(s => !nested.Contains(s)).OrderByDescending(s => s, StringComparer.Ordinal)) stack.Push(s);
        }
    }

    /// <summary>Central Package Management: the nearest Directory.Packages.props and its PackageVersion items.</summary>
    public static (bool Enabled, string? PropsPath, Dictionary<string, string> Versions) CentralPackages(string projectDir, ProjectFacts facts)
    {
        var versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? props = null;
        for (var d = projectDir; d != null; d = Path.GetDirectoryName(d))
        {
            var p = Path.Combine(d, "Directory.Packages.props");
            if (File.Exists(p)) { props = p; break; }
        }
        var enabled = false;
        if (props != null)
        {
            try
            {
                var doc = XDocument.Load(props);
                var flag = doc.Descendants().LastOrDefault(x => x.Name.LocalName == "ManagePackageVersionsCentrally")?.Value;
                enabled = flag != null && flag.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
                foreach (var pv in doc.Descendants().Where(x => x.Name.LocalName == "PackageVersion"))
                {
                    var id = (string?)pv.Attribute("Include") ?? (string?)pv.Attribute("Update");
                    var v = (string?)pv.Attribute("Version") ?? pv.Elements().FirstOrDefault(x => x.Name.LocalName == "Version")?.Value;
                    if (id != null && v != null) versions[id] = v;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException) { }
        }
        if (facts.Properties.TryGetValue("ManagePackageVersionsCentrally", out var own))
            enabled = own.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
        return (enabled && props != null, enabled ? props : null, versions);
    }

    private sealed record Assets(Dictionary<string, string> Libraries, IReadOnlyList<string> FrameworkReferences)
    {
        public string? Resolved(string id) => Libraries.TryGetValue(id, out var v) ? v : null;
    }

    private static Assets ReadAssets(string dir)
    {
        var libs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var fw = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var file = Path.Combine(dir, "obj", "project.assets.json");
        try
        {
            if (!File.Exists(file) || new FileInfo(file).Length > 64 * 1024 * 1024) return new Assets(libs, Array.Empty<string>());
            using var doc = JsonDocument.Parse(File.ReadAllBytes(file));
            if (doc.RootElement.TryGetProperty("libraries", out var l) && l.ValueKind == JsonValueKind.Object)
                foreach (var p in l.EnumerateObject())
                {
                    var slash = p.Name.IndexOf('/');
                    if (slash > 0 && p.Value.TryGetProperty("type", out var t) && t.GetString() == "package") libs[p.Name[..slash]] = p.Name[(slash + 1)..];
                }
            if (doc.RootElement.TryGetProperty("project", out var proj) && proj.TryGetProperty("frameworks", out var fws) && fws.ValueKind == JsonValueKind.Object)
                foreach (var f in fws.EnumerateObject())
                    if (f.Value.TryGetProperty("frameworkReferences", out var refs) && refs.ValueKind == JsonValueKind.Object)
                        foreach (var r in refs.EnumerateObject()) fw.Add(r.Name);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return new Assets(libs, fw.ToList());
    }

    private static List<string> GuessFrameworks(IReadOnlyList<string> tfms, ProjectFacts facts, XDocument? xml)
    {
        var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in tfms)
        {
            if (t.StartsWith("netstandard", StringComparison.OrdinalIgnoreCase)) set.Add("NETStandard.Library");
            else if (t.StartsWith("net4", StringComparison.OrdinalIgnoreCase) || t.StartsWith("net3", StringComparison.OrdinalIgnoreCase) || t.StartsWith("net2", StringComparison.OrdinalIgnoreCase)) set.Add(".NETFramework");
            else set.Add("Microsoft.NETCore.App");
        }
        if (facts.Sdks.Any(s => s.StartsWith("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase))) set.Add("Microsoft.AspNetCore.App");
        bool Prop(string n) => facts.Properties.TryGetValue(n, out var v) && v.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
        if (Prop("UseWPF") || Prop("UseWindowsForms")) set.Add("Microsoft.WindowsDesktop.App");
        if (xml?.Root != null)
            foreach (var fr in xml.Root.Descendants().Where(x => x.Name.LocalName == "FrameworkReference"))
                if ((string?)fr.Attribute("Include") is { } inc) set.Add(inc);
        return set.ToList();
    }
}
