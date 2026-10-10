using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// One file created by a plan (a resource operation): created before every text edit of the plan, with exactly
/// <see cref="Text"/> (<see cref="ResultHash"/> = SHA-256 of it). <see cref="AnchorPath"/> is an existing member of the
/// same folder whose Compile membership the new file shares; <see cref="ProjectPaths"/> are the projects the proof
/// covers (re-checked on revalidation, and the projects the host adds the document to after the client created it).
/// </summary>
public sealed record PlannedFileCreate(string Path, string Text, string ResultHash, string AnchorPath, IReadOnlyList<string> ProjectPaths);

/// <summary>A folder a generated file can be created in (Generate handler).</summary>
public sealed record FolderChoice(string Folder, string ProjectPath, string ProjectName, int HandlerCount, string Namespace, string AnchorPath);

/// <summary>Generate handler: the folder choices (first = default) and the chosen one.</summary>
public sealed record CreateFileOffer(string Path, IReadOnlyList<FolderChoice> Folders, string SelectedFolder);

/// <summary>
/// Shared safety of the create-file refactorings (Move Type to File, Generate handler): absence precondition,
/// file-system guards, the static Compile-membership proof (the same proof as the file rename, with an existing file of
/// the folder as the anchor), the compilation delta (no new compiler error in the affected closure) and the read set.
/// Never writes files.
/// </summary>
public static class CreateFilePlanner
{
    /// <summary>Largest file this version creates (the text travels in the plan).</summary>
    public const int MaxCreatedFileChars = 512 * 1024;

    /// <summary>File-system guards for a new file next to <paramref name="anchorPath"/> (prepare and revalidate).</summary>
    public static (string code, string message)? CheckTarget(string newPath, string anchorPath)
    {
        var newName = Path.GetFileName(newPath);
        if (!newName.EndsWith(".cs", StringComparison.Ordinal) || newName.Length <= 3)
            return ("InvalidFileName", $"{newName} is not a C# file name.");
        if (newName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || newName.Contains('/') || newName.Contains('\\'))
            return ("InvalidFileName", $"{newName} is not a valid file name.");
        if (FileRenamePlanner.ReservedNames.Contains(newName.Split('.')[0]))
            return ("ReservedFileName", $"{newName} is a reserved file name on Windows.");
        if (!string.Equals(Path.GetDirectoryName(newPath), Path.GetDirectoryName(anchorPath), StringComparison.Ordinal))
            return ("UnprovenMembership", $"{newName} would not be in the folder of {Path.GetFileName(anchorPath)}.");
        try
        {
            var anchor = new FileInfo(anchorPath);
            if (!anchor.Exists) return ("SourceFileMissing", $"{anchor.Name} does not exist on disk.");
            for (var d = anchor.Directory; d != null; d = d.Parent)
                if (d.LinkTarget != null) return ("SymbolicLink", $"The folder is reached through a symbolic link ({d.Name}).");
            var dir = anchor.DirectoryName!;
            if (File.Exists(newPath) || Directory.Exists(newPath)
                || Directory.EnumerateFileSystemEntries(dir).Any(e => string.Equals(Path.GetFileName(e), newName, StringComparison.OrdinalIgnoreCase)))
                return ("TargetExists", $"{newName} already exists (names are compared ignoring case).");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ("UnreadableFile", "The folder cannot be read.");
        }
        return null;
    }

    /// <summary>Every guard of a new file: disk, collisions in the solution, Compile membership in every project.</summary>
    public static (string code, string message)? Check(Snapshot snapshot, string newPath, string anchorPath, IReadOnlyList<string> projects, bool planLimited)
    {
        if (CheckTarget(newPath, anchorPath) is { } disk) return disk;
        var newName = Path.GetFileName(newPath);
        if (snapshot.Solution.Projects.SelectMany(p => p.Documents.Concat(p.AdditionalDocuments))
            .Any(d => d.FilePath != null && string.Equals(d.FilePath, newPath, StringComparison.OrdinalIgnoreCase)))
            return ("TargetExists", $"A document named {newName} already belongs to the solution.");
        if (planLimited)
            return ("UnprovenMembership", $"Some MSBuild imports could not be checked, so it cannot be proven that {newName} would belong to the project.");
        if (projects.Count == 0) return ("UnprovenMembership", $"The project of {Path.GetFileName(anchorPath)} is unknown.");
        foreach (var project in projects)
            if (FileRenamePlanner.ProveCompileMembership(project, anchorPath, newPath, "the file is not created", "new", "creating the file") is { } m)
                return m;
        return null;
    }

    /// <summary>Revalidation of every planned created file against the current disk (absence, guards, membership).</summary>
    public static (string code, string message)? Revalidate(IReadOnlyList<PlannedFileCreate> creates)
    {
        foreach (var c in creates)
        {
            if (CheckTarget(c.Path, c.AnchorPath) is { } disk) return disk;
            foreach (var project in c.ProjectPaths)
                if (FileRenamePlanner.ProveCompileMembership(project, c.AnchorPath, c.Path, "the file is not created", "new", "creating the file") is { } m)
                    return m;
        }
        return null;
    }

    /// <summary>The projects (all contexts) whose file is one of <paramref name="projectPaths"/>.</summary>
    public static List<ProjectId> ProjectIds(Solution solution, IEnumerable<string> projectPaths)
    {
        var set = new HashSet<string>(projectPaths, UriPaths.PathComparer);
        return solution.Projects.Where(p => p.FilePath != null && set.Contains(p.FilePath)).Select(p => p.Id).ToList();
    }

    /// <summary>The solution with <paramref name="text"/> added as a new document at <paramref name="path"/> to every project in <paramref name="projects"/>.</summary>
    public static Solution AddDocument(Solution solution, IEnumerable<ProjectId> projects, string path, string text)
    {
        foreach (var pid in projects)
        {
            var project = solution.GetProject(pid);
            if (project?.FilePath == null) continue;
            var rel = Path.GetRelativePath(Path.GetDirectoryName(project.FilePath)!, Path.GetDirectoryName(path)!);
            var folders = rel == "." ? Array.Empty<string>() : rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            solution = solution.AddDocument(DocumentId.CreateNewId(pid, Path.GetFileName(path)), Path.GetFileName(path),
                SourceText.From(text, new System.Text.UTF8Encoding(false), SourceHashAlgorithm.Sha256), folders, path);
        }
        return solution;
    }

    /// <summary>Compiler errors (Error severity) of the document at <paramref name="path"/> in <paramref name="solution"/>.</summary>
    public static async Task<List<Diagnostic>> DocumentErrorsAsync(Solution solution, string path, CancellationToken ct)
    {
        var result = new List<Diagnostic>();
        foreach (var doc in solution.Projects.SelectMany(p => p.Documents).Where(d => d.FilePath != null && UriPaths.PathComparer.Equals(d.FilePath, path)))
        {
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model == null) continue;
            result.AddRange(model.GetDiagnostics(cancellationToken: ct).Where(d => d.Severity == DiagnosticSeverity.Error));
        }
        return result;
    }

    /// <summary>
    /// Builds the plan of a create-file refactoring: guards, compilation delta (no new compiler error in the affected
    /// closure, the new file included), read set (+ absence precondition) and the plan. <paramref name="edit"/> is the
    /// optional text change of an existing file (Move Type to File: the removal of the moved type).
    /// </summary>
    internal static async Task<RenameOutcome> BuildPlanAsync(Snapshot snapshot, string actionId, string title, PlannedFileCreate create,
        PlannedFileChange? edit, IReadOnlyList<TextChange> editChanges, List<string> limitations, List<(string, Location?)> evidence,
        CreateFileOffer? offer, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        var session = snapshot.Session;
        if (create.Text.Length > MaxCreatedFileChars)
            return RenameOutcome.Unavailable("FileTooLarge", $"{Path.GetFileName(create.Path)} would be larger than this version creates ({MaxCreatedFileChars / 1024} KB).");
        var owners = ProjectIds(solution, create.ProjectPaths);
        if (owners.Count == 0) return RenameOutcome.Unavailable("UnprovenMembership", "The project of the new file is not loaded.");
        var affected = new HashSet<ProjectId>(owners);
        var after = AddDocument(solution, owners, create.Path, create.Text);
        if (edit != null)
        {
            foreach (var id in session.DocumentIdsForPath(edit.Path))
            {
                if (solution.GetDocument(id) is not { } doc) continue;
                affected.Add(id.ProjectId);
                var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                after = after.WithDocumentText(id, text.WithChanges(editChanges), PreservationMode.PreserveIdentity);
            }
        }

        var graph = solution.GetProjectDependencyGraph();
        var closure = new HashSet<ProjectId>(affected);
        foreach (var p in affected)
        {
            closure.UnionWith(graph.GetProjectsThatThisProjectTransitivelyDependsOn(p));
            closure.UnionWith(graph.GetProjectsThatTransitivelyDependOnThisProject(p));
        }
        var closureContexts = closure.Select(id => session.ContextFor(id)).Where(c => c != null).Select(c => c!).ToList();
        var incomplete = closureContexts.Where(c => c.State != ProjectStates.Loaded).ToList();
        if (incomplete.Count > 0)
            return RenameOutcome.Unavailable("IncompleteProjectClosure", "Projects in the affected closure are not completely loaded: " + string.Join(", ", incomplete.Select(c => c.Name)));
        if (session.Projects.Any(p => p.State == ProjectStates.Failed))
            return RenameOutcome.Unavailable("IncompleteProjectClosure", "Some projects of the solution failed to load; their code cannot be checked.");

        // Compilation delta: no compiler error after the change that did not exist before (the new file has no "before":
        // every error in it is new). Spans of the edited file are mapped back through its own change.
        var mapBack = new Dictionary<string, IReadOnlyList<TextChange>>(UriPaths.PathComparer);
        if (edit != null) mapBack[edit.Path] = editChanges;
        var newErrors = new List<string>();
        foreach (var pid in closure)
        {
            var before = await RenamePlanner.ErrorKeysAsync(solution.GetProject(pid), null, ct).ConfigureAwait(false);
            var afterKeys = await RenamePlanner.ErrorKeysAsync(after.GetProject(pid), mapBack, ct).ConfigureAwait(false);
            foreach (var (key, entry) in afterKeys)
                if (entry.count > (before.TryGetValue(key, out var b) ? b.count : 0)) newErrors.Add(entry.label);
        }
        if (newErrors.Count > 0)
            return RenameOutcome.Unavailable("CompilationErrors", "The change would introduce compiler errors: " + string.Join(", ", newErrors.Distinct().Take(10)));

        var unknownImports = new List<string>();
        var readSet = RenamePlanner.BuildReadSet(snapshot, closure, ct, unknownImports);
        if (Check(snapshot, create.Path, create.AnchorPath, create.ProjectPaths, unknownImports.Count > 0) is { } guard)
            return RenameOutcome.Unavailable(guard.code, guard.message);
        readSet.Add(new ReadEntry(ReadKinds.Absent, "absent:" + create.Path, "absent"));
        readSet.Add(new ReadEntry(ReadKinds.File, create.AnchorPath, Hashing.FileBytes(create.AnchorPath)));
        var contextIds = closureContexts.Select(c => c.ContextId).OrderBy(x => x, StringComparer.Ordinal).ToList();
        evidence.Add(($"No new compiler errors in {closure.Count} project context(s), the new file included", null));
        evidence.Add(($"{Path.GetFileName(create.Path)} is included by the same Compile items as {Path.GetFileName(create.AnchorPath)} in {create.ProjectPaths.Count} project(s) (SDK default glob, same folder, no Compile pattern or explicit item for either name); the target does not exist", null));
        limitations.Add($"{Path.GetFileName(create.Path)} is created on disk first (a created file cannot stay unsaved){(edit != null ? $"; then {Path.GetFileName(edit.Path)} is edited (not saved). If the edit fails, the new file stays and nothing is rolled back" : "")}.");
        var plan = new RenamePlan
        {
            PlanId = "plan-" + Guid.NewGuid().ToString("N"),
            WorkspaceId = session.WorkspaceId,
            BaseSnapshot = snapshot,
            Title = title,
            ActionId = actionId,
            Changes = edit != null ? new[] { edit } : Array.Empty<PlannedFileChange>(),
            ReadSet = readSet,
            ProjectContextIds = contextIds,
            CheckedContexts = contextIds,
            UncheckedContexts = Array.Empty<string>(),
            Limitations = limitations,
            Evidence = evidence,
            CompilationDelta = "passed",
            ValidationStatus = "valid",
            FileCreates = new[] { create },
            CreateFileOffer = offer,
        };
        return new RenameOutcome(plan, null, null);
    }

    /// <summary>First line break of <paramref name="text"/> ("\n" when there is none).</summary>
    public static string LineBreak(string text)
    {
        var i = text.IndexOf('\n');
        return i > 0 && text[i - 1] == '\r' ? "\r\n" : "\n";
    }

    /// <summary>
    /// Greedy using minimisation: drops each candidate (in order) whose removal keeps <paramref name="accept"/> true.
    /// The result is a set where no single remaining using can be dropped.
    /// </summary>
    public static async Task<List<T>> MinimiseAsync<T>(IReadOnlyList<T> candidates, Func<IReadOnlyList<T>, Task<bool>> accept)
    {
        var kept = candidates.ToList();
        foreach (var c in candidates)
        {
            var trial = kept.Where(k => !EqualityComparer<T>.Default.Equals(k, c)).ToList();
            if (await accept(trial).ConfigureAwait(false)) kept = trial;
        }
        return kept;
    }
}
