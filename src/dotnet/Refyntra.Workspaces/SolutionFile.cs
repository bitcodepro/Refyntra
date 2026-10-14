using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Refyntra.Workspaces;

/// <summary>A solution folder of a .sln / .slnx file (solution/structure, protocol 1.20).</summary>
public sealed record SolutionFolderEntry(string Id, string Name, string? ParentId, IReadOnlyList<string> Files);

/// <summary>A project entry of a solution file: its full path and the solution folder it sits in (null: the root).</summary>
public sealed record SolutionProjectEntry(string Name, string ProjectPath, string? FolderId);

/// <summary>What a solution file says, read as text/XML only (no MSBuild): solution folders, projects and solution items.</summary>
public sealed record SolutionFileModel(string Format, IReadOnlyList<SolutionFolderEntry> Folders, IReadOnlyList<SolutionProjectEntry> Projects);

public static class SolutionFileReader
{
    private const string FolderType = "2150E333-8FDC-42A3-9474-1A3956D46DE8";
    private static readonly Regex ProjectLine = new("^Project\\(\"\\{(?<type>[^}]*)\\}\"\\)\\s*=\\s*\"(?<name>[^\"]*)\"\\s*,\\s*\"(?<path>[^\"]*)\"\\s*,\\s*\"\\{(?<guid>[^}]*)\\}\"", RegexOptions.IgnoreCase);
    private static readonly Regex Nested = new("^\\s*\\{(?<child>[^}]*)\\}\\s*=\\s*\\{(?<parent>[^}]*)\\}", RegexOptions.IgnoreCase);
    private static readonly Regex Item = new("^\\s*(?<path>[^=]+?)\\s*=\\s*(?<same>.+?)\\s*$");

    /// <summary>Reads a .sln, .slnx or .csproj path; a project file is a one-project "solution" without folders.</summary>
    public static SolutionFileModel Read(string path)
    {
        if (path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)) return ReadSlnx(path);
        if (path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)) return ReadSln(path);
        return new SolutionFileModel("project", Array.Empty<SolutionFolderEntry>(), new[] { new SolutionProjectEntry(Path.GetFileNameWithoutExtension(path), Path.GetFullPath(path), null) });
    }

    private static string Full(string dir, string relative) =>
        Path.GetFullPath(Path.Combine(dir, relative.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)));

    public static SolutionFileModel ReadSln(string path)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        var folders = new Dictionary<string, (string Name, List<string> Files)>(StringComparer.OrdinalIgnoreCase);
        var projects = new List<(string Guid, string Name, string Path)>();
        var parents = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? currentFolder = null;
        bool inItems = false, inNested = false;
        foreach (var raw in File.ReadLines(path))
        {
            var line = raw.Trim();
            var m = ProjectLine.Match(line);
            if (m.Success)
            {
                var guid = m.Groups["guid"].Value.ToUpperInvariant();
                if (m.Groups["type"].Value.Equals(FolderType, StringComparison.OrdinalIgnoreCase))
                {
                    folders[guid] = (m.Groups["name"].Value, new List<string>());
                    currentFolder = guid;
                }
                else
                {
                    currentFolder = null;
                    var p = m.Groups["path"].Value;
                    if (p.EndsWith("proj", StringComparison.OrdinalIgnoreCase)) projects.Add((guid, m.Groups["name"].Value, Full(dir, p)));
                }
                continue;
            }
            if (line.StartsWith("EndProject", StringComparison.Ordinal) && !line.StartsWith("EndProjectSection", StringComparison.Ordinal)) { currentFolder = null; inItems = false; continue; }
            if (line.StartsWith("ProjectSection(SolutionItems)", StringComparison.Ordinal)) { inItems = currentFolder != null; continue; }
            if (line.StartsWith("EndProjectSection", StringComparison.Ordinal)) { inItems = false; continue; }
            if (line.StartsWith("GlobalSection(NestedProjects)", StringComparison.Ordinal)) { inNested = true; continue; }
            if (line.StartsWith("EndGlobalSection", StringComparison.Ordinal)) { inNested = false; continue; }
            if (inItems && currentFolder != null)
            {
                var im = Item.Match(line);
                if (im.Success) folders[currentFolder].Files.Add(Full(dir, im.Groups["path"].Value));
            }
            else if (inNested)
            {
                var nm = Nested.Match(line);
                if (nm.Success) parents[nm.Groups["child"].Value.ToUpperInvariant()] = nm.Groups["parent"].Value.ToUpperInvariant();
            }
        }
        string? Parent(string guid) => parents.TryGetValue(guid, out var p) && folders.ContainsKey(p) ? p : null;
        return new SolutionFileModel(
            "sln",
            folders.Select(f => new SolutionFolderEntry(f.Key, f.Value.Name, Parent(f.Key), f.Value.Files)).ToList(),
            projects.Select(p => new SolutionProjectEntry(p.Name, p.Path, Parent(p.Guid))).ToList());
    }

    public static SolutionFileModel ReadSlnx(string path)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        var doc = XDocument.Load(path);
        var folders = new List<SolutionFolderEntry>();
        var projects = new List<SolutionProjectEntry>();
        static string Normalize(string name) => "/" + name.Trim('/') + "/";
        static string? ParentOf(string id)
        {
            var inner = id.TrimEnd('/');
            var cut = inner.LastIndexOf('/');
            return cut <= 0 ? null : inner.Substring(0, cut + 1);
        }
        void AddProject(XElement e, string? folder)
        {
            var p = (string?)e.Attribute("Path");
            if (p == null || !p.EndsWith("proj", StringComparison.OrdinalIgnoreCase)) return;
            projects.Add(new SolutionProjectEntry(Path.GetFileNameWithoutExtension(p.Replace('\\', '/').Split('/').Last()), Full(dir, p), folder));
        }
        var root = doc.Root;
        if (root == null) return new SolutionFileModel("slnx", folders, projects);
        var known = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in root.Descendants().Where(e => e.Name.LocalName == "Folder"))
        {
            var name = (string?)f.Attribute("Name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            var id = Normalize(name);
            known.Add(id);
            var files = f.Elements().Where(e => e.Name.LocalName == "File").Select(e => (string?)e.Attribute("Path")).Where(p => p != null).Select(p => Full(dir, p!)).ToList();
            folders.Add(new SolutionFolderEntry(id, id.TrimEnd('/').Split('/').Last(), null, files));
            foreach (var pe in f.Elements().Where(e => e.Name.LocalName == "Project")) AddProject(pe, id);
        }
        // A folder "/a/b/" whose parent "/a/" is not declared still nests under the nearest declared ancestor.
        string? DeclaredParent(string id)
        {
            for (var p = ParentOf(id); p != null; p = ParentOf(p))
                if (known.Contains(p)) return p;
            return null;
        }
        folders = folders.Select(f => f with { ParentId = DeclaredParent(f.Id) }).ToList();
        foreach (var pe in root.Elements().Where(e => e.Name.LocalName == "Project")) AddProject(pe, null);
        return new SolutionFileModel("slnx", folders, projects);
    }
}
