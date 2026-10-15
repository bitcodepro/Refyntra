using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Workspaces;

/// <param name="RestoreRecommended">True when "dotnet restore" is the recovery (missing/unresolved assets or packages).</param>
/// <param name="Cause">Machine-readable cause (<see cref="LoadCauses"/>); null for an MSBuild/workspace message.</param>
public sealed record LoadDiagnosticModel(string Severity, string Message, string? ProjectPath, bool RestoreRecommended = false, string? Cause = null);

public static class LoadCauses
{
    public const string MissingAssets = "missingAssets", MissingPackages = "missingPackages", MissingProjectReference = "missingProjectReference";
}

public static class ProjectStates
{
    public const string Loaded = "loaded", Partial = "partial", Failed = "failed";
}

public sealed class ProjectContext
{
    public required string ContextId { get; init; }
    public ProjectId? ProjectId { get; init; }
    public required string Name { get; init; }
    public required string ProjectPath { get; init; }
    public string? TargetFramework { get; init; }
    public required string State { get; set; }
    public int DocumentCount { get; init; }
    public List<LoadDiagnosticModel> Diagnostics { get; } = new();
}

/// <summary>An immutable view of the solution with the overlay applied at one point of the document sequence.</summary>
public sealed class Snapshot
{
    public required string Id { get; init; }
    public required Solution Solution { get; init; }
    public required long Sequence { get; init; }
    public required long Revision { get; init; }
    public required WorkspaceSession Session { get; init; }
    /// <summary>Load generation of the MSBuild solution this snapshot derives from (changes on every reload).</summary>
    public required long Generation { get; init; }
    public string Epoch => Session.Epoch;
}

public static class EngineStates
{
    public const string NotStarted = "NotStarted", Loading = "Loading", Ready = "Ready", Partial = "Partial",
        Unsupported = "Unsupported", TrustRequired = "TrustRequired", Restarting = "Restarting", Failed = "Failed";
}

/// <summary>
/// One opened workspace: a single MSBuildWorkspace, the loaded base solution, the overlay of open editor buffers
/// and the chain of immutable snapshots. Document events are applied strictly in sequence order.
/// </summary>
public sealed class WorkspaceSession : IDisposable
{
    private static long _snapshotCounter;
    private readonly object _gate = new();
    private readonly Dictionary<string, string> _overlays = new(UriPaths.PathComparer);
    private readonly List<(long seq, TaskCompletionSource<bool> tcs)> _waiters = new();
    private readonly Dictionary<string, (Snapshot snapshot, int count)> _pinned = new(StringComparer.Ordinal);
    private Dictionary<string, ImmutableArray<DocumentId>> _pathIndex = new(UriPaths.PathComparer);
    private readonly Dictionary<DocumentId, (string name, IReadOnlyList<string> folders, string? filePath, Encoding? encoding)> _removed = new();
    private MSBuildWorkspace? _workspace;
    /// <summary>The workspace of a solution built from the project index (until MSBuild's own load replaces it).</summary>
    private Workspace? _cacheWorkspace;
    private Snapshot? _current;
    private long _appliedSequence = -1; // protocol: client sequences are zero-based, -1 = nothing received yet
    private long _revision;
    private bool _disposed;
    /// <summary>Incremented when a load starts; snapshots carry the generation of the load that produced their solution.</summary>
    private long _loadGeneration;
    private long _solutionGeneration;

    public string WorkspaceId { get; }
    public string Path { get; }
    public string Epoch { get; }
    public string State { get; private set; } = EngineStates.NotStarted;
    public string? ReasonCode { get; private set; }
    public string? Message { get; private set; }
    /// <summary>What the user can do about a Failed state (e.g. which SDK to install), when known.</summary>
    public string? Recovery { get; private set; }
    public SdkInfo? Sdk { get; private set; }
    public IReadOnlyList<ProjectContext> Projects { get; private set; } = Array.Empty<ProjectContext>();
    public IReadOnlyList<LoadDiagnosticModel> Diagnostics { get; private set; } = Array.Empty<LoadDiagnosticModel>();
    public Task LoadTask { get; private set; } = Task.CompletedTask;
    /// <summary>The current solution comes from the persistent project index; MSBuild is still loading in the background.</summary>
    public bool FromProjectIndex { get; private set; }
    private readonly TaskCompletionSource _firstUsable = new(TaskCreationOptions.RunContinuationsAsynchronously);
    /// <summary>Completes when the first load produced a usable solution (from the project index or MSBuild) or ended.</summary>
    public Task FirstUsable => _firstUsable.Task;

    public WorkspaceSession(string workspaceId, string path, string epoch)
    {
        WorkspaceId = workspaceId;
        Path = System.IO.Path.GetFullPath(path);
        Epoch = epoch;
    }

    public Snapshot? Current { get { lock (_gate) return _current; } }
    public long AppliedSequence { get { lock (_gate) return _appliedSequence; } }
    public long Revision { get { lock (_gate) return _revision; } }
    /// <summary>Generation of the most recently started load. A snapshot of an older generation predates a reload.</summary>
    public long LoadGeneration { get { lock (_gate) return _loadGeneration; } }
    public bool IsDisposed { get { lock (_gate) return _disposed; } }

    public string? SolutionPath =>
        Path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || Path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) ? Path : null;

    /// <summary>Starts loading. The returned task completes when loading finished (successfully or not).</summary>
    public Task StartLoad(CancellationToken ct)
    {
        lock (_gate)
        {
            State = _current == null ? EngineStates.Loading : EngineStates.Restarting;
            var generation = ++_loadGeneration;
            LoadTask = Task.Run(() => LoadCoreAsync(generation, ct), CancellationToken.None);
            return LoadTask;
        }
    }

    private async Task LoadCoreAsync(long generation, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            if (!File.Exists(Path))
            {
                SetFailed("PathNotFound", "The solution or project file does not exist.");
                return;
            }
            var dir = System.IO.Path.GetDirectoryName(Path)!;
            try
            {
                Sdk = MsBuildBootstrap.EnsureRegistered(dir);
            }
            catch (EngineException ex)
            {
                SetFailed(ex.ReasonCode, ex.Message);
                Recovery = ex.Recovery;
                return;
            }
            // The persistent project index: on a first load whose inputs are unchanged, the solution is built from it
            // at once (reads work while MSBuild loads); MSBuild's load then replaces it and refreshes the index.
            var expected = ExpectedProjects();
            var key = Sdk?.Version is { } sdkVersion && expected.Count > 0 ? ProjectCache.Key(Path, expected, sdkVersion) : null;
            if (key != null && Current == null && ProjectCache.Load(Path, key) is { } entry)
            {
                try
                {
                    InstallFromIndex(generation, entry);
                    Log.Write("info", "workspace", $"opened {entry.Projects.Count} project(s) from the project index", op: "workspace/index", durationMs: sw.Elapsed.TotalMilliseconds);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    Log.Warn("cache", "project index not usable: " + ex.GetType().Name + ": " + ex.Message);
                }
            }
            await LoadWithWorkspaceAsync(generation, ct).ConfigureAwait(false);
            if (key != null && State == EngineStates.Ready && Current is { } loaded && loaded.Generation == generation
                && Sdk?.Version is { } v && ProjectCache.Key(Path, expected, v) == key)
                ProjectCache.Store(Path, key, loaded.Solution, Projects);
            Log.Write("info", "workspace", $"loaded {Projects.Count} project(s), state {State}", op: "workspace/load",
                durationMs: sw.Elapsed.TotalMilliseconds, status: State);
        }
        catch (OperationCanceledException)
        {
            SetFailed("Cancelled", "Loading was cancelled.");
        }
        catch (Exception ex)
        {
            Log.Error("workspace", "load failed: " + ex.GetType().Name + ": " + ex.Message);
            SetFailed("LoadFailed", "Loading failed: " + ex.GetType().Name + ": " + ex.Message);
        }
        finally
        {
            _firstUsable.TrySetResult();
        }
    }

    private void InstallFromIndex(long generation, ProjectCache.Entry entry)
    {
        var (workspace, solution, ids) = ProjectCache.Build(entry);
        var contexts = entry.Contexts.Select(c => new ProjectContext
        {
            ContextId = c.ContextId,
            ProjectId = ids[c.ProjectIndex],
            Name = c.Name,
            ProjectPath = c.ProjectPath,
            TargetFramework = c.TargetFramework,
            State = ProjectStates.Loaded,
            DocumentCount = c.DocumentCount,
        }).ToList();
        var index = new Dictionary<string, ImmutableArray<DocumentId>>(UriPaths.PathComparer);
        foreach (var project in solution.Projects)
        foreach (var doc in project.Documents)
        {
            if (doc.FilePath == null) continue;
            index[doc.FilePath] = index.TryGetValue(doc.FilePath, out var arr) ? arr.Add(doc.Id) : ImmutableArray.Create(doc.Id);
        }
        lock (_gate)
        {
            if (_disposed || generation != _loadGeneration || _current != null)
            {
                workspace.Dispose();
                return;
            }
            _cacheWorkspace = workspace;
            // A negative generation: plans are not prepared on it (MSBuild's load has not confirmed the projects yet).
            _solutionGeneration = -generation;
            _pathIndex = index;
            var sol = solution;
            foreach (var (p, text) in _overlays) sol = ApplyText(sol, p, text);
            _current = NewSnapshotLocked(sol);
            Projects = contexts;
            Diagnostics = Array.Empty<LoadDiagnosticModel>();
            FromProjectIndex = true;
            State = EngineStates.Ready;
            ReasonCode = null;
            Message = null;
            ReleaseWaitersLocked();
        }
        _firstUsable.TrySetResult();
    }

    private void SetFailed(string reason, string message)
    {
        lock (_gate)
        {
            State = _current == null ? EngineStates.Failed : EngineStates.Partial;
            ReasonCode = reason;
            Message = message;
            if (_current == null) Projects = Array.Empty<ProjectContext>();
            ReleaseWaitersLocked();
        }
    }

    private async Task LoadWithWorkspaceAsync(long generation, CancellationToken ct)
    {
        var workspace = MSBuildWorkspace.Create();
        Solution solution;
        try
        {
            if (SolutionPath != null)
                solution = await workspace.OpenSolutionAsync(Path, cancellationToken: ct).ConfigureAwait(false);
            else
            {
                var project = await workspace.OpenProjectAsync(Path, cancellationToken: ct).ConfigureAwait(false);
                solution = project.Solution;
            }
        }
        catch
        {
            workspace.Dispose();
            throw;
        }

        var wsDiagnostics = workspace.Diagnostics
            .Select(d => new LoadDiagnosticModel(d.Kind == WorkspaceDiagnosticKind.Failure && !RestoreDiagnostics.IsAdvisory(d.Message) ? "error" : "warning", d.Message, null, RestoreDiagnostics.MentionsRestore(d.Message)))
            .ToList();

        var expected = ExpectedProjects();
        var contexts = new List<ProjectContext>();
        var sessionDiagnostics = new List<LoadDiagnosticModel>();
        var claimed = new HashSet<LoadDiagnosticModel>();
        foreach (var project in solution.Projects.Where(p => p.Language == LanguageNames.CSharp))
        {
            var path = project.FilePath ?? project.Name;
            var tfm = GuessTfm(project);
            var ctx = new ProjectContext
            {
                ContextId = MakeContextId(path, tfm),
                ProjectId = project.Id,
                Name = project.Name,
                ProjectPath = path,
                TargetFramework = tfm,
                State = ProjectStates.Loaded,
                DocumentCount = project.DocumentIds.Count,
            };
            foreach (var d in wsDiagnostics)
            {
                if (d.Message.Contains(path, StringComparison.OrdinalIgnoreCase))
                {
                    ctx.Diagnostics.Add(d with { ProjectPath = path });
                    claimed.Add(d);
                }
            }
            foreach (var missing in MissingProjectReferences(path))
                ctx.Diagnostics.Add(new LoadDiagnosticModel("error",
                    $"Referenced project not found: {missing}. References to it are unresolved.", path, Cause: LoadCauses.MissingProjectReference));
            var assets = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path) ?? "", "obj", "project.assets.json");
            if (File.Exists(path) && !File.Exists(assets))
                ctx.Diagnostics.Add(new LoadDiagnosticModel("error",
                    "project.assets.json is missing (packages are not restored). Recovery: Run dotnet restore.", path, RestoreRecommended: true, Cause: LoadCauses.MissingAssets));
            else if (File.Exists(assets) && RestoreDiagnostics.MissingPackages(assets) is { Count: > 0 } missingPackages)
                ctx.Diagnostics.Add(new LoadDiagnosticModel("error",
                    $"{missingPackages.Count} package(s) listed in project.assets.json are missing from the package folders (e.g. {string.Join(", ", missingPackages.Take(3))}). Recovery: Run dotnet restore.",
                    path, RestoreRecommended: true, Cause: LoadCauses.MissingPackages));
            if (ctx.Diagnostics.Any(d => d.Severity == "error")) ctx.State = ProjectStates.Partial;
            contexts.Add(ctx);
        }
        foreach (var exp in expected)
        {
            if (contexts.Any(c => UriPaths.PathComparer.Equals(c.ProjectPath, exp))) continue;
            var ctx = new ProjectContext
            {
                ContextId = MakeContextId(exp, null),
                Name = System.IO.Path.GetFileNameWithoutExtension(exp),
                ProjectPath = exp,
                TargetFramework = null,
                State = ProjectStates.Failed,
                DocumentCount = 0,
            };
            foreach (var d in wsDiagnostics.Where(d => d.Message.Contains(exp, StringComparison.OrdinalIgnoreCase)))
            {
                ctx.Diagnostics.Add(d with { ProjectPath = exp });
                claimed.Add(d);
            }
            if (ctx.Diagnostics.Count == 0)
                ctx.Diagnostics.Add(new LoadDiagnosticModel("error", "The project could not be loaded.", exp));
            contexts.Add(ctx);
        }
        sessionDiagnostics.AddRange(wsDiagnostics.Where(d => !claimed.Contains(d)));

        var index = new Dictionary<string, ImmutableArray<DocumentId>>(UriPaths.PathComparer);
        foreach (var project in solution.Projects)
        foreach (var doc in project.Documents)
        {
            if (doc.FilePath == null) continue;
            index[doc.FilePath] = index.TryGetValue(doc.FilePath, out var arr) ? arr.Add(doc.Id) : ImmutableArray.Create(doc.Id);
        }

        MSBuildWorkspace? old;
        lock (_gate)
        {
            if (_disposed || generation != _loadGeneration)
            {
                // Closed, or a newer load started meanwhile: that load owns the session state.
                workspace.Dispose();
                return;
            }
            old = _workspace;
            _cacheWorkspace?.Dispose();
            _cacheWorkspace = null;
            FromProjectIndex = false;
            _solutionGeneration = generation;
            _workspace = workspace;
            _pathIndex = index;
            _removed.Clear();
            var sol = solution;
            foreach (var (p, text) in _overlays) sol = ApplyText(sol, p, text);
            _current = NewSnapshotLocked(sol);
            Projects = contexts;
            Diagnostics = sessionDiagnostics;
            var loaded = contexts.Count(c => c.State != ProjectStates.Failed);
            if (loaded == 0)
            {
                State = EngineStates.Failed;
                ReasonCode = "NoProjectsLoaded";
                Message = "No C# project could be loaded.";
            }
            else if (contexts.Any(c => c.State != ProjectStates.Loaded))
            {
                State = EngineStates.Partial;
                ReasonCode = "PartialLoad";
                Message = $"{contexts.Count(c => c.State == ProjectStates.Loaded)} of {contexts.Count} projects loaded completely.";
            }
            else
            {
                State = EngineStates.Ready;
                ReasonCode = null;
                Message = null;
            }
            ReleaseWaitersLocked();
        }
        old?.Dispose();
    }

    public static string MakeContextId(string projectPath, string? tfm) =>
        "pc_" + Hashing.ShortId(projectPath.ToLowerInvariant() + "|Debug|" + (tfm ?? ""));

    private static string? GuessTfm(Project project)
    {
        var output = project.OutputFilePath;
        if (output == null) return null;
        var dir = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(output));
        return dir != null && Regex.IsMatch(dir, "^(net|netstandard|netcoreapp)[0-9.]+(-[a-z0-9.]+)?$", RegexOptions.IgnoreCase) ? dir : null;
    }

    private List<string> ExpectedProjects()
    {
        var list = new List<string>();
        try
        {
            var dir = System.IO.Path.GetDirectoryName(Path)!;
            if (Path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
            {
                var rx = new Regex("^Project\\(\"[^\"]*\"\\)\\s*=\\s*\"[^\"]*\"\\s*,\\s*\"([^\"]+\\.csproj)\"", RegexOptions.IgnoreCase);
                foreach (var line in File.ReadLines(Path))
                {
                    var m = rx.Match(line);
                    if (m.Success) list.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, m.Groups[1].Value.Replace('\\', System.IO.Path.DirectorySeparatorChar))));
                }
            }
            else if (Path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var e in XDocument.Load(Path).Descendants("Project"))
                {
                    var p = (string?)e.Attribute("Path");
                    if (p != null && p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                        list.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, p.Replace('\\', System.IO.Path.DirectorySeparatorChar))));
                }
            }
            else if (Path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                list.Add(Path);
            }
        }
        catch (Exception ex) when (ex is IOException or System.Xml.XmlException)
        {
            Log.Warn("workspace", "could not parse solution file: " + ex.GetType().Name);
        }
        return list;
    }

    private static IEnumerable<string> MissingProjectReferences(string projectPath)
    {
        var result = new List<string>();
        try
        {
            if (!File.Exists(projectPath)) return result;
            var dir = System.IO.Path.GetDirectoryName(projectPath)!;
            foreach (var e in XDocument.Load(projectPath).Descendants().Where(x => x.Name.LocalName == "ProjectReference"))
            {
                var inc = (string?)e.Attribute("Include");
                if (string.IsNullOrWhiteSpace(inc) || inc.Contains("$(")) continue;
                var full = System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, inc.Replace('\\', System.IO.Path.DirectorySeparatorChar)));
                if (!File.Exists(full)) result.Add(System.IO.Path.GetFileName(full));
            }
        }
        catch (Exception ex) when (ex is IOException or System.Xml.XmlException)
        {
        }
        return result;
    }

    // ------------------------------------------------------------------ overlay

    public enum DocumentEventKind { Open, Change, Save, Close }

    /// <summary>Applies one document event. Events with a sequence at or below the applied one are ignored.</summary>
    public bool ApplyDocumentEvent(DocumentEventKind kind, string path, string? text, long sequence, long workspaceRevision)
    {
        lock (_gate)
        {
            if (sequence <= _appliedSequence)
            {
                Log.Warn("overlay", $"ignored out-of-order document event {sequence} (applied {_appliedSequence})");
                return false;
            }
            string? newText = null;
            var remove = false;
            switch (kind)
            {
                case DocumentEventKind.Open:
                case DocumentEventKind.Change:
                    _overlays[path] = text ?? "";
                    newText = text ?? "";
                    break;
                case DocumentEventKind.Close:
                    // The overlay is always dropped. The disk text replaces it; a file that is missing (deleted while
                    // open) or unreadable leaves the snapshot, as MSBuild's *.cs globbing would drop it on a reload.
                    _overlays.Remove(path);
                    newText = _current != null ? ReadDiskTextLocked(_current.Solution, path) : null;
                    remove = newText == null;
                    break;
                case DocumentEventKind.Save:
                    break;
            }
            _appliedSequence = sequence;
            _revision = Math.Max(_revision, workspaceRevision);
            if (_current != null && (newText != null || remove))
            {
                var sol = remove ? RemoveDocumentsLocked(_current.Solution, path) : ApplyText(_current.Solution, path, newText!);
                if (!ReferenceEquals(sol, _current.Solution)) _current = NewSnapshotLocked(sol);
            }
            ReleaseWaitersLocked();
            return true;
        }
    }

    /// <summary>
    /// File rename: files renamed by the client (one event of the document sequence). Every document of an old path keeps its
    /// id and moves to the new path, in the snapshot and in the path index; an overlay moves with it. Documents that a
    /// didClose of the (now missing) old path already removed come back under the new path. The text is the overlay of
    /// the new path, else the moved overlay, else the disk text. Works in either order relative to the editor's
    /// didClose(old)/didOpen(new) events. No project reload: Compile membership of the new name was proven by the plan.
    /// </summary>
    public bool ApplyFileRenames(IReadOnlyList<(string oldPath, string newPath)> renames, long sequence, long workspaceRevision)
    {
        lock (_gate)
        {
            if (sequence <= _appliedSequence)
            {
                Log.Warn("overlay", $"ignored out-of-order file rename {sequence} (applied {_appliedSequence})");
                return false;
            }
            _appliedSequence = sequence;
            _revision = Math.Max(_revision, workspaceRevision);
            if (_current != null)
            {
                var sol = _current.Solution;
                foreach (var (oldPath, newPath) in renames)
                {
                    if (!_pathIndex.Remove(oldPath, out var ids) || ids.IsEmpty) continue;
                    if (_overlays.Remove(oldPath, out var moved) && !_overlays.ContainsKey(newPath)) _overlays[newPath] = moved;
                    var name = System.IO.Path.GetFileName(newPath);
                    foreach (var id in ids)
                    {
                        if (sol.GetDocument(id) != null)
                        {
                            sol = sol.WithDocumentFilePath(id, newPath).WithDocumentName(id, name);
                        }
                        else if (_removed.Remove(id, out var info) && sol.GetProject(id.ProjectId) != null)
                        {
                            var text = _overlays.TryGetValue(newPath, out var o) ? o : TextFiles.TryRead(newPath, info.encoding);
                            if (text == null) { _removed[id] = (name, info.folders, newPath, info.encoding); continue; }
                            sol = sol.AddDocument(id, name, SourceText.From(text, info.encoding ?? new UTF8Encoding(false), SourceHashAlgorithm.Sha256), info.folders, newPath);
                        }
                    }
                    _pathIndex[newPath] = _pathIndex.TryGetValue(newPath, out var existing) ? existing.AddRange(ids) : ids;
                    if (_overlays.TryGetValue(newPath, out var overlay)) sol = ApplyText(sol, newPath, overlay);
                    Log.Info("overlay", $"file renamed by the client: {ids.Length} document(s) moved");
                }
                if (!ReferenceEquals(sol, _current.Solution)) _current = NewSnapshotLocked(sol);
            }
            ReleaseWaitersLocked();
            return true;
        }
    }

    /// <summary>
    /// Created files (Move Type to File, Generate handler): files the client created (one event of the document sequence).
    /// Each new path becomes a document of the given projects (every context of those project files), with the text of
    /// its overlay (a didOpen may come first) or the disk text. A path that is already a document is left alone. No project
    /// reload: Compile membership of the new file was proven by the plan.
    /// </summary>
    public bool ApplyFileCreates(IReadOnlyList<(string path, IReadOnlyList<string> projectPaths)> creates, long sequence, long workspaceRevision)
    {
        lock (_gate)
        {
            if (sequence <= _appliedSequence)
            {
                Log.Warn("overlay", $"ignored out-of-order file create {sequence} (applied {_appliedSequence})");
                return false;
            }
            _appliedSequence = sequence;
            _revision = Math.Max(_revision, workspaceRevision);
            if (_current != null)
            {
                var sol = _current.Solution;
                foreach (var (path, projectPaths) in creates)
                {
                    if (_pathIndex.TryGetValue(path, out var known) && !known.IsEmpty) continue;
                    var text = _overlays.TryGetValue(path, out var o) ? o : TextFiles.TryRead(path, null);
                    if (text == null) continue;
                    var set = new HashSet<string>(projectPaths, UriPaths.PathComparer);
                    var ids = ImmutableArray.CreateBuilder<DocumentId>();
                    foreach (var project in sol.Projects.Where(p => p.FilePath != null && set.Contains(p.FilePath)).ToList())
                    {
                        var rel = System.IO.Path.GetRelativePath(System.IO.Path.GetDirectoryName(project.FilePath!)!, System.IO.Path.GetDirectoryName(path)!);
                        var folders = rel == "." ? Array.Empty<string>() : rel.Split(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar);
                        var id = DocumentId.CreateNewId(project.Id, System.IO.Path.GetFileName(path));
                        sol = sol.AddDocument(id, System.IO.Path.GetFileName(path), SourceText.From(text, new UTF8Encoding(false), SourceHashAlgorithm.Sha256), folders, path);
                        ids.Add(id);
                    }
                    if (ids.Count == 0) continue;
                    _pathIndex[path] = ids.ToImmutable();
                    Log.Info("overlay", $"file created by the client: added to {ids.Count} project context(s)");
                }
                if (!ReferenceEquals(sol, _current.Solution)) _current = NewSnapshotLocked(sol);
            }
            ReleaseWaitersLocked();
            return true;
        }
    }

    /// <summary>
    /// Deleted files (Safe Delete, protocol 1.6): files the client deleted (one event of the document sequence). A path
    /// that no longer exists on disk leaves the snapshot in every context, with its overlay; a path that still exists is
    /// left alone (the client reported a delete that did not happen). No project reload.
    /// </summary>
    public bool ApplyFileDeletes(IReadOnlyList<string> paths, long sequence, long workspaceRevision)
    {
        lock (_gate)
        {
            if (sequence <= _appliedSequence)
            {
                Log.Warn("overlay", $"ignored out-of-order file delete {sequence} (applied {_appliedSequence})");
                return false;
            }
            _appliedSequence = sequence;
            _revision = Math.Max(_revision, workspaceRevision);
            if (_current != null)
            {
                var sol = _current.Solution;
                foreach (var path in paths)
                {
                    if (System.IO.File.Exists(path)) { Log.Warn("overlay", "file reported deleted still exists; ignored"); continue; }
                    if (!_pathIndex.Remove(path, out var ids) || ids.IsEmpty) continue;
                    _overlays.Remove(path);
                    var present = ids.Where(id => sol.GetDocument(id) != null).ToImmutableArray();
                    foreach (var id in ids) _removed.Remove(id);
                    if (present.Length > 0) sol = sol.RemoveDocuments(present);
                    Log.Info("overlay", $"file deleted by the client: removed from {present.Length} project context(s)");
                }
                if (!ReferenceEquals(sol, _current.Solution)) _current = NewSnapshotLocked(sol);
            }
            ReleaseWaitersLocked();
            return true;
        }
    }

    public bool HasOverlay(string path)
    {
        lock (_gate) return _overlays.ContainsKey(path);
    }

    public ImmutableArray<DocumentId> DocumentIdsForPath(string path)
    {
        lock (_gate) return _pathIndex.TryGetValue(path, out var ids) ? ids : ImmutableArray<DocumentId>.Empty;
    }

    /// <summary>
    /// Disk text of a document decoded like the loaded snapshot (the encoding Roslyn detected when it loaded the file),
    /// or null when the file is missing or unreadable.
    /// </summary>
    private string? ReadDiskTextLocked(Solution solution, string path)
    {
        Encoding? encoding = null;
        if (_pathIndex.TryGetValue(path, out var ids))
            foreach (var id in ids)
                if (solution.GetDocument(id) is { } doc && doc.TryGetText(out var t) && t.Encoding != null)
                {
                    encoding = t.Encoding;
                    break;
                }
        return TextFiles.TryRead(path, encoding);
    }

    /// <summary>Removes every document of <paramref name="path"/> from the solution, remembering it for a later didOpen.</summary>
    private Solution RemoveDocumentsLocked(Solution solution, string path)
    {
        if (!_pathIndex.TryGetValue(path, out var ids) || ids.IsEmpty) return solution;
        var present = new List<DocumentId>();
        foreach (var id in ids)
        {
            var doc = solution.GetDocument(id);
            if (doc == null) continue;
            present.Add(id);
            _removed[id] = (doc.Name, doc.Folders, doc.FilePath, doc.TryGetText(out var t) ? t.Encoding : null);
        }
        if (present.Count == 0) return solution;
        Log.Info("overlay", $"document closed while missing or unreadable: removed from the snapshot ({present.Count} context(s))");
        return solution.RemoveDocuments(present.ToImmutableArray());
    }

    /// <summary>
    /// Razor markup (.razor / .cshtml) is an additional document that the Razor source generator reads: the editor text
    /// replaces it, so the generated code (and every feature on it) follows unsaved markup.
    /// </summary>
    private static Solution ApplyAdditionalText(Solution solution, string path, string text)
    {
        if (!(path.EndsWith(".razor", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".cshtml", StringComparison.OrdinalIgnoreCase))) return solution;
        foreach (var project in solution.Projects.ToList())
            foreach (var doc in project.AdditionalDocuments)
                if (doc.FilePath != null && string.Equals(System.IO.Path.GetFullPath(doc.FilePath), System.IO.Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase)
                    && doc.GetTextAsync().GetAwaiter().GetResult().ToString() != text)
                    solution = solution.WithAdditionalDocumentText(doc.Id, SourceText.From(text, new UTF8Encoding(false), SourceHashAlgorithm.Sha256));
        return solution;
    }

    private Solution ApplyText(Solution solution, string path, string text)
    {
        if (!_pathIndex.TryGetValue(path, out var ids) || ids.IsEmpty) return ApplyAdditionalText(solution, path, text);
        // A document removed by didClose of a missing file comes back with the text of the next didOpen/didChange.
        foreach (var id in ids)
        {
            if (solution.GetDocument(id) != null || !_removed.Remove(id, out var info)) continue;
            if (solution.GetProject(id.ProjectId) == null) continue;
            solution = solution.AddDocument(id, info.name, SourceText.From(text, info.encoding ?? new UTF8Encoding(false), SourceHashAlgorithm.Sha256), info.folders, info.filePath);
        }
        var changed = new List<DocumentId>();
        SourceText? template = null;
        foreach (var id in ids)
        {
            var doc = solution.GetDocument(id);
            if (doc == null) continue;
            var current = doc.GetTextAsync().GetAwaiter().GetResult();
            template ??= current;
            if (current.ToString() != text) changed.Add(id);
        }
        if (changed.Count == 0) return solution;
        var newText = SourceText.From(text, template?.Encoding ?? new UTF8Encoding(false), template?.ChecksumAlgorithm ?? SourceHashAlgorithm.Sha256);
        return solution.WithDocumentText(changed, newText, PreservationMode.PreserveIdentity);
    }

    private Snapshot NewSnapshotLocked(Solution solution) => new()
    {
        Id = "snap-" + Interlocked.Increment(ref _snapshotCounter),
        Solution = solution,
        Sequence = _appliedSequence,
        Revision = _revision,
        Session = this,
        Generation = _solutionGeneration,
    };

    private void ReleaseWaitersLocked()
    {
        var loaded = _current != null || State is EngineStates.Failed;
        if (!loaded) return;
        for (var i = _waiters.Count - 1; i >= 0; i--)
        {
            if (_waiters[i].seq <= _appliedSequence)
            {
                _waiters[i].tcs.TrySetResult(true);
                _waiters.RemoveAt(i);
            }
        }
    }

    /// <summary>Waits until loading is done and every document event with sequence &lt;= <paramref name="sequence"/> is applied.</summary>
    public async Task<Snapshot> BarrierAsync(long sequence, TimeSpan timeout, CancellationToken ct)
    {
        await LoadTask.WaitAsync(ct).ConfigureAwait(false);
        TaskCompletionSource<bool> tcs;
        lock (_gate)
        {
            if (_current == null)
                throw new EngineException(ErrorCodes.WorkspaceNotLoaded, ReasonCode ?? "WorkspaceNotLoaded", Message ?? "The workspace is not loaded.");
            if (_appliedSequence >= sequence) return _current;
            tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add((sequence, tcs));
        }
        try
        {
            await tcs.Task.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw new EngineException(ErrorCodes.BarrierTimeout, "BarrierTimeout",
                $"Document sequence {sequence} was not received (applied {AppliedSequence}).", "Replay the open documents (didOpen with the current text), then call the barrier again.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // The waiter was cancelled by Dispose (workspace/close or a new workspace/open): not an internal error.
            throw new EngineException(ErrorCodes.WorkspaceNotLoaded, "WorkspaceNotLoaded", "The workspace was closed while the barrier was waiting.", "Open the workspace again.");
        }
        finally
        {
            // Every exit path removes the waiter: cancelled and timed-out barriers must not accumulate.
            lock (_gate) _waiters.RemoveAll(w => w.tcs == tcs);
        }
        lock (_gate)
        {
            if (_disposed || _current == null)
                throw new EngineException(ErrorCodes.WorkspaceNotLoaded, _disposed ? "WorkspaceNotLoaded" : ReasonCode ?? "WorkspaceNotLoaded",
                    _disposed ? "The workspace was closed while the barrier was waiting." : Message ?? "The workspace is not loaded.");
            return _current;
        }
    }

    /// <summary>Returns the current snapshot if <paramref name="snapshotId"/> names it; otherwise throws StaleSnapshot.</summary>
    public Snapshot RequireCurrent(string? snapshotId)
    {
        lock (_gate)
        {
            if (_current == null)
                throw new EngineException(ErrorCodes.WorkspaceNotLoaded, ReasonCode ?? "WorkspaceNotLoaded", Message ?? "The workspace is not loaded.");
            if (snapshotId != _current.Id)
                throw new EngineException(ErrorCodes.StaleSnapshot, "StaleSnapshot",
                    $"Snapshot {snapshotId} is not current ({_current.Id}). Call workspace/snapshotBarrier again.");
            return _current;
        }
    }

    public void Pin(Snapshot snapshot)
    {
        lock (_gate)
            _pinned[snapshot.Id] = _pinned.TryGetValue(snapshot.Id, out var p) ? (p.snapshot, p.count + 1) : (snapshot, 1);
    }

    public void Unpin(string snapshotId)
    {
        lock (_gate)
        {
            if (!_pinned.TryGetValue(snapshotId, out var p)) return;
            if (p.count <= 1) _pinned.Remove(snapshotId);
            else _pinned[snapshotId] = (p.snapshot, p.count - 1);
        }
    }

    public int PinnedCount { get { lock (_gate) return _pinned.Count; } }
    public int PendingBarrierCount { get { lock (_gate) return _waiters.Count; } }

    public ProjectContext? ContextFor(ProjectId id) => Projects.FirstOrDefault(c => c.ProjectId == id);
    public ProjectContext? ContextById(string contextId) => Projects.FirstOrDefault(c => c.ContextId == contextId);

    public void Dispose()
    {
        MSBuildWorkspace? ws;
        lock (_gate)
        {
            _disposed = true;
            ws = _workspace;
            _workspace = null;
            _cacheWorkspace?.Dispose();
            _cacheWorkspace = null;
            foreach (var w in _waiters) w.tcs.TrySetCanceled();
            _waiters.Clear();
        }
        ws?.Dispose();
    }
}
