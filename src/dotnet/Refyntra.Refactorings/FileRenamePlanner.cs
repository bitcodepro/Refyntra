using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// One file rename of a plan (a resource operation): applied after every text edit of the plan, as its own
/// operation. <see cref="ResultHash"/> is the text the renamed file must have (the result of the plan's text edits).
/// <see cref="ProjectPaths"/> are the projects whose Compile membership was proven (re-checked on revalidation).
/// </summary>
public sealed record PlannedFileRename(string OldPath, string NewPath, string ResultHash, IReadOnlyList<string> ProjectPaths);

/// <summary>
/// What "also rename the file" means for a type rename: the files named after the type, whether renaming them is
/// proven safe (<see cref="Available"/>) and whether the plan contains the rename operations (<see cref="Included"/>).
/// </summary>
public sealed record FileRenameOffer(IReadOnlyList<(string OldPath, string NewPath)> Files, bool Available, bool Included, string? ReasonCode, string? Message);

/// <summary>
/// File rename: rename the file together with a top-level type (Foo.cs ↔ class Foo, partial parts Foo.*.cs). Offered only
/// when every guard holds and Compile membership of the new path is proven statically; otherwise the rename
/// stays text-only and the reason is shown. Never writes files.
/// </summary>
public static class FileRenamePlanner
{
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>Properties that change which files the SDK default Compile glob includes (or where bin/obj are).</summary>
    private static readonly HashSet<string> GlobProperties = new(StringComparer.OrdinalIgnoreCase)
    {
        "DefaultItemExcludes", "DefaultItemExcludesInProjectFolder", "BaseIntermediateOutputPath", "BaseOutputPath",
        "IntermediateOutputPath", "OutputPath", "DefaultExcludesInProjectFolder",
    };

    /// <summary>File name after the rename: "Foo.cs" → "Bar.cs", "Foo.Part1.cs" → "Bar.Part1.cs"; null if the file is not named after the type.</summary>
    public static string? NewFileName(string fileName, string oldTypeName, string newTypeName)
    {
        if (!fileName.EndsWith(".cs", StringComparison.Ordinal)) return null;
        if (fileName == oldTypeName + ".cs") return newTypeName + ".cs";
        if (fileName.StartsWith(oldTypeName + ".", StringComparison.Ordinal) && fileName.Length > oldTypeName.Length + ".cs".Length + 1)
            return newTypeName + fileName.Substring(oldTypeName.Length);
        return null;
    }

    /// <summary>
    /// The offer for a rename of <paramref name="symbol"/> to <paramref name="newName"/>, or null when no file is named
    /// after the symbol (nothing to offer). <paramref name="results"/> maps edited paths to their result hash.
    /// </summary>
    public static (FileRenameOffer offer, List<PlannedFileRename> renames)? Plan(Snapshot snapshot, ISymbol symbol, string newName, bool requested,
        bool planLimited, IReadOnlyDictionary<string, string> results, CancellationToken ct)
    {
        if (symbol is not INamedTypeSymbol type || type.ContainingType != null) return null;
        var declFiles = type.DeclaringSyntaxReferences.Select(r => r.SyntaxTree.FilePath).Where(f => !string.IsNullOrEmpty(f))
            .Distinct(UriPaths.PathComparer).OrderBy(f => f, StringComparer.Ordinal).ToList();
        var files = new List<(string OldPath, string NewPath)>();
        foreach (var f in declFiles)
            if (NewFileName(Path.GetFileName(f), type.Name, newName) is { } n)
                files.Add((f, Path.Combine(Path.GetDirectoryName(f)!, n)));
        if (files.Count == 0) return null;

        var refusal = Check(snapshot, type, declFiles, files, planLimited, results, ct);
        var renames = new List<PlannedFileRename>();
        if (refusal == null)
            foreach (var (oldPath, newPath) in files)
                renames.Add(new PlannedFileRename(oldPath, newPath, results[oldPath], ProjectsOf(snapshot, oldPath)));
        var included = refusal == null && requested;
        var offer = new FileRenameOffer(files, refusal == null, included, refusal?.code, refusal?.message);
        return (offer, included ? renames : new List<PlannedFileRename>());
    }

    private static List<string> ProjectsOf(Snapshot snapshot, string path) =>
        snapshot.Session.DocumentIdsForPath(path).Select(id => snapshot.Solution.GetProject(id.ProjectId)?.FilePath)
            .OfType<string>().Distinct(UriPaths.PathComparer).OrderBy(p => p, StringComparer.Ordinal).ToList();

    private static (string code, string message)? Check(Snapshot snapshot, INamedTypeSymbol type, List<string> declFiles,
        List<(string OldPath, string NewPath)> files, bool planLimited, IReadOnlyDictionary<string, string> results, CancellationToken ct)
    {
        var name = type.Name;
        if (type.IsFileLocal)
            return ("FileLocalType", $"{name} is a file-local type; its file keeps its name (renaming it could change which code sees the type).");
        var unmatched = declFiles.Where(f => !files.Any(x => UriPaths.PathComparer.Equals(x.OldPath, f))).ToList();
        if (unmatched.Count > 0)
            return ("FileNameDoesNotMatch", $"Not every part of {name} is in a file named after it ({string.Join(", ", unmatched.Select(Path.GetFileName))}); only the code is renamed.");
        if (planLimited)
            return ("UnprovenMembership", "Some MSBuild imports could not be checked, so it cannot be proven that the renamed file stays in the project; only the code is renamed.");
        var newPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (oldPath, newPath) in files)
        {
            ct.ThrowIfCancellationRequested();
            var file = Path.GetFileName(oldPath);
            if (!results.ContainsKey(oldPath))
                return ("NoTextChange", $"{file} has no text change in the plan; only the code is renamed.");
            if (!newPaths.Add(newPath))
                return ("TargetExists", $"Two files would be renamed to {Path.GetFileName(newPath)}.");
            var tree = snapshot.Session.DocumentIdsForPath(oldPath).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null)?.GetSyntaxTreeAsync(ct).GetAwaiter().GetResult();
            if (tree == null) return ("NotInWorkspace", $"{file} is not a document of the loaded projects.");
            if (SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return ("GeneratedCode", $"{file} is generated code.");
            if (OtherTopLevelContent(snapshot.Solution, tree, type, ct) is { } other)
                return ("OtherTypesInFile", $"{file} also contains {other}; the file keeps its name and only the code is renamed.");
            if (CheckDisk(oldPath, newPath) is { } disk) return disk;
            // A document with the new path anywhere in the solution (e.g. linked from elsewhere) is a collision.
            if (snapshot.Solution.Projects.SelectMany(p => p.Documents).Any(d => d.FilePath != null && string.Equals(d.FilePath, newPath, StringComparison.OrdinalIgnoreCase)))
                return ("TargetExists", $"A document named {Path.GetFileName(newPath)} already belongs to the solution.");
            var projects = ProjectsOf(snapshot, oldPath);
            if (projects.Count == 0) return ("UnprovenMembership", $"The project of {file} is unknown.");
            foreach (var project in projects)
                if (ProveCompileMembership(project, oldPath, newPath) is { } m) return m;
        }
        return null;
    }

    /// <summary>A description of other top-level content of the file (another type, top-level statements), or null.</summary>
    private static string? OtherTopLevelContent(Solution solution, SyntaxTree tree, INamedTypeSymbol type, CancellationToken ct)
    {
        var root = tree.GetRoot(ct);
        if (root is CompilationUnitSyntax cu && cu.Members.OfType<GlobalStatementSyntax>().Any()) return "top-level statements";
        SemanticModel? model = null;
        foreach (var member in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).OfType<MemberDeclarationSyntax>())
        {
            if (member is BaseNamespaceDeclarationSyntax) continue;
            if (member is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)) return "other top-level members";
            model ??= solution.GetDocument(tree)?.GetSemanticModelAsync(ct).GetAwaiter().GetResult();
            var declared = model?.GetDeclaredSymbol(member, ct);
            if (!SymbolEqualityComparer.Default.Equals(declared?.OriginalDefinition, type.OriginalDefinition))
                return "the type " + (declared?.Name ?? member.Kind().ToString());
        }
        return null;
    }

    /// <summary>
    /// File system guards for one rename (prepare and revalidate): case-only rename, reserved names, missing source,
    /// symbolic links, read-only source, an existing target (also ignoring case, on every platform).
    /// </summary>
    public static (string code, string message)? CheckDisk(string oldPath, string newPath)
    {
        var oldName = Path.GetFileName(oldPath);
        var newName = Path.GetFileName(newPath);
        if (string.Equals(oldPath, newPath, StringComparison.OrdinalIgnoreCase))
            return ("CaseOnlyFileRename", $"Renaming {oldName} to {newName} changes only the letter case; this version does not rename such files (case-insensitive file systems need a temporary name). Only the code is renamed; rename the file yourself if needed.");
        if (ReservedNames.Contains(newName.Split('.')[0]))
            return ("ReservedFileName", $"{newName} is a reserved file name on Windows; only the code is renamed.");
        try
        {
            var info = new FileInfo(oldPath);
            if (!info.Exists) return ("SourceFileMissing", $"{oldName} does not exist on disk.");
            if (info.LinkTarget != null || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
                return ("SymbolicLink", $"{oldName} is a symbolic link; only the code is renamed.");
            for (var d = info.Directory; d != null; d = d.Parent)
                if (d.LinkTarget != null) return ("SymbolicLink", $"{oldName} is in a folder reached through a symbolic link ({d.Name}); only the code is renamed.");
            if (info.IsReadOnly) return ("ReadOnlyFile", $"{oldName} is read-only; only the code is renamed.");
            var dir = info.DirectoryName!;
            if (File.Exists(newPath) || Directory.Exists(newPath)
                || Directory.EnumerateFileSystemEntries(dir).Any(e => string.Equals(Path.GetFileName(e), newName, StringComparison.OrdinalIgnoreCase)))
                return ("TargetExists", $"{newName} already exists (names are compared ignoring case); only the code is renamed.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ("UnreadableFile", $"{oldName} or its folder cannot be read.");
        }
        return null;
    }

    /// <summary>
    /// Static proof that <paramref name="newPath"/> is included by the same Compile items as <paramref name="oldPath"/> in
    /// every evaluation of <paramref name="projectPath"/>: both are *.cs files in the same folder inside the project folder
    /// (not linked, not under bin/obj), the SDK default Compile glob is not disabled or customised, and no Compile item
    /// in the project file, the nearest Directory.Build.props/targets or their literal imports uses a pattern or names
    /// either file. Anything that cannot be read or resolved refuses (never "probably fine").
    /// </summary>
    public static (string code, string message)? ProveCompileMembership(string projectPath, string oldPath, string newPath)
    {
        var file = Path.GetFileName(oldPath);
        var projectDir = Path.GetDirectoryName(projectPath)!;
        var projectName = Path.GetFileName(projectPath);
        if (!string.Equals(Path.GetDirectoryName(oldPath), Path.GetDirectoryName(newPath), StringComparison.Ordinal))
            return ("UnprovenMembership", "The renamed file would move to another folder.");
        var rel = Path.GetRelativePath(projectDir, oldPath);
        if (Path.IsPathRooted(rel) || rel.StartsWith("..", StringComparison.Ordinal))
            return ("LinkedFile", $"{file} is outside the folder of {projectName} (a linked file); only the code is renamed.");
        var segments = rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (segments.Take(segments.Length - 1).Any(s => s.Equals("bin", StringComparison.OrdinalIgnoreCase) || s.Equals("obj", StringComparison.OrdinalIgnoreCase)))
            return ("BuildOutputFolder", $"{file} is under bin/ or obj/; only the code is renamed.");

        var inputs = new List<string> { projectPath };
        foreach (var name in new[] { "Directory.Build.props", "Directory.Build.targets" })
            if (Nearest(projectDir, name) is { } found) inputs.Add(found);
        foreach (var importer in inputs.ToList())
        foreach (var (raw, resolved) in RenamePlanner.ExplicitImports(importer))
        {
            if (resolved == null)
                return ("UnprovenMembership", $"{Path.GetFileName(importer)} imports {raw}, which cannot be checked; only the code is renamed.");
            if (File.Exists(resolved)) inputs.Add(resolved);
        }

        foreach (var input in inputs.Distinct(UriPaths.PathComparer))
        {
            XDocument xml;
            try { xml = XDocument.Load(input); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
            {
                return ("UnprovenMembership", $"{Path.GetFileName(input)} cannot be read; only the code is renamed.");
            }
            var where = Path.GetFileName(input);
            foreach (var el in xml.Descendants())
            {
                var local = el.Name.LocalName;
                if (local is "EnableDefaultItems" or "EnableDefaultCompileItems" && el.Parent?.Name.LocalName == "PropertyGroup")
                {
                    if (!string.Equals(el.Value.Trim(), "true", StringComparison.OrdinalIgnoreCase) || HasCondition(el))
                        return ("DefaultCompileItemsDisabled", $"{where} sets {local}={el.Value.Trim()}{(HasCondition(el) ? " (conditionally)" : "")}: Compile items are not the SDK default glob, so the renamed file might leave the project; only the code is renamed.");
                    continue;
                }
                if (GlobProperties.Contains(local) && el.Parent?.Name.LocalName == "PropertyGroup")
                    return ("CustomItemExcludes", $"{where} sets {local}, which changes the default Compile glob; only the code is renamed.");
                if (local != "Compile" || el.Parent?.Name.LocalName != "ItemGroup") continue;
                foreach (var attr in new[] { "Include", "Remove", "Update", "Exclude" })
                {
                    var value = (string?)el.Attribute(attr);
                    if (string.IsNullOrWhiteSpace(value)) continue;
                    foreach (var part in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        if (part.IndexOfAny(new[] { '*', '?' }) >= 0 || part.Contains("$(") || part.Contains("@(") || part.Contains("%("))
                            return ("CompilePattern", $"{where} has <Compile {attr}=\"{part}\">, a pattern that might treat {Path.GetFileName(newPath)} differently from {file}; only the code is renamed.");
                        string full;
                        try { full = Path.GetFullPath(Path.Combine(projectDir, part.Replace('\\', Path.DirectorySeparatorChar))); }
                        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
                        {
                            return ("CompilePattern", $"{where} has a Compile item that cannot be resolved ({part}); only the code is renamed.");
                        }
                        if (string.Equals(full, oldPath, StringComparison.OrdinalIgnoreCase) || string.Equals(full, newPath, StringComparison.OrdinalIgnoreCase))
                            return ("ExplicitCompileItem", $"{where} lists {Path.GetFileName(full)} explicitly (<Compile {attr}=\"{part}\">); renaming the file would need a project file change, which this version does not make. Only the code is renamed.");
                    }
                }
            }
        }
        return null;
    }

    private static bool HasCondition(XElement el)
    {
        for (var e = el; e != null; e = e.Parent)
            if (e.Attribute("Condition") != null) return true;
        return false;
    }

    private static string? Nearest(string dir, string name)
    {
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            var f = Path.Combine(d.FullName, name);
            if (File.Exists(f)) return f;
        }
        return null;
    }

    /// <summary>Revalidation of every planned file rename against the current disk (absence, guards, membership).</summary>
    public static (string code, string message)? Revalidate(IReadOnlyList<PlannedFileRename> renames)
    {
        foreach (var r in renames)
        {
            if (CheckDisk(r.OldPath, r.NewPath) is { } disk) return disk;
            foreach (var project in r.ProjectPaths)
                if (ProveCompileMembership(project, r.OldPath, r.NewPath) is { } m) return m;
        }
        return null;
    }
}
