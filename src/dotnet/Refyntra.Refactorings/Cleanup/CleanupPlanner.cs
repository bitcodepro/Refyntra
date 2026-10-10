using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>Per file: how often each fix changed it.</summary>
public sealed record CleanupFileReport(string Path, IReadOnlyList<(string fixId, int count)> Fixes);

/// <summary>A file (or a fix in a file, or a fix as a whole) that was not cleaned, and why.</summary>
public sealed record CleanupSkip(string? Path, string? FixId, string ReasonCode, string Message);

/// <summary>What a Code Cleanup plan does: the fixes run, per file per fix counts, skipped files/fixes with reasons.</summary>
public sealed record CleanupReport(
    IReadOnlyList<(string id, string title)> Fixes,
    IReadOnlyList<CleanupFileReport> Files,
    IReadOnlyList<CleanupSkip> Skipped,
    int FilesInScope);

/// <summary>
/// Code Cleanup: runs an explicit list of small fixes over the C# files of a scope (files, folders or projects) and
/// returns one text-only plan through the same pipeline as every refactoring (read set, revalidation, one EditApplier,
/// reconcile, Undo). Every change is proven: the fixes only return text whose semantic fingerprint
/// (<see cref="SemanticFingerprint"/>) equals the original in every project context; each fix is idempotent. Files that
/// cannot be edited exactly as previewed (generated, read-only, not UTF-8, mixed line endings, too large, project not
/// loaded) are skipped with the reason. Never writes files.
/// </summary>
public static class CleanupPlanner
{
    public const string ActionId = "csharp.cleanup";
    /// <summary>Largest scope (C# files) one plan covers.</summary>
    public const int MaxFiles = 2000;
    /// <summary>Largest file a fix touches.</summary>
    public const int MaxFileChars = 512 * 1024;
    /// <summary>Most skipped entries listed in the plan (the rest are counted).</summary>
    public const int MaxSkipped = 300;

    /// <summary>Every fix, in the order they run on a file.</summary>
    public static readonly IReadOnlyList<ICleanupFix> Fixes = new ICleanupFix[]
    {
        new RemoveUnnecessaryUsingsFix(),
        new SortUsingsFix(),
        new FileScopedNamespaceFix(),
        new WhitespaceFix(),
    };

    /// <summary>The conservative default profile (setting refyntra.cleanup.profile).</summary>
    public static readonly IReadOnlyList<string> DefaultProfile = new[] { CleanupFixIds.RemoveUnnecessaryUsings, CleanupFixIds.SortUsings, CleanupFixIds.Whitespace };

    /// <summary>Fixes that are known but not offered in this version, with the reason.</summary>
    public static readonly IReadOnlyDictionary<string, string> NotOffered = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [CleanupFixIds.EditorConfigCodeStyle] =
            "Not available: the IDE code-style analyzers (IDExxxx) and their code fixes ship in the Roslyn Features/CodeStyle layers, whose analyzers and code fix providers are internal types reached only through MEF; Refyntra uses public Roslyn APIs only. Use VS Code's own code actions or dotnet format for these.",
    };

    private static readonly IReadOnlySet<string> RemovableDiagnostics = new HashSet<string>(StringComparer.Ordinal) { "CS0105" };

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, IReadOnlyList<string> scopePaths, IReadOnlyList<string>? fixIds, CancellationToken ct)
    {
        var session = snapshot.Session;
        var solution = snapshot.Solution;
        var skipped = new List<CleanupSkip>();
        var requested = (fixIds == null || fixIds.Count == 0 ? DefaultProfile : fixIds).Distinct(StringComparer.Ordinal).ToList();
        foreach (var id in requested.Where(id => Fixes.All(f => f.Id != id)))
            skipped.Add(new CleanupSkip(null, id, NotOffered.ContainsKey(id) ? "NotOffered" : "UnknownFix", NotOffered.TryGetValue(id, out var why) ? why : $"Unknown fix id {id}."));
        var fixes = Fixes.Where(f => requested.Contains(f.Id)).ToList();
        if (fixes.Count == 0)
            return RenameOutcome.Unavailable("NoFixes", "No supported cleanup fix was selected. " + string.Join(" ", skipped.Select(s => s.Message)));
        if (scopePaths.Count == 0) return RenameOutcome.Unavailable("NoScope", "Choose a file, a folder or a project to clean up.");

        // Scope: every C# document of the loaded solution under one of the paths (a file, a folder or a project file).
        var byPath = new Dictionary<string, List<Document>>(UriPaths.PathComparer);
        foreach (var project in solution.Projects)
        foreach (var doc in project.Documents)
        {
            if (doc.FilePath is not { } path || !path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
            if (!scopePaths.Any(s => InScope(s, path, project.FilePath)) || IsBuildOutput(project, path)) continue;
            if (!byPath.TryGetValue(path, out var list)) byPath[path] = list = new List<Document>();
            list.Add(doc);
        }
        if (byPath.Count == 0) return RenameOutcome.Unavailable("NoFilesInScope", "The chosen scope contains no C# file of the loaded solution.");
        if (byPath.Count > MaxFiles)
            return RenameOutcome.Unavailable("ScopeTooLarge", $"The scope has {byPath.Count} C# files; one cleanup covers at most {MaxFiles}. Choose a folder or a project.");

        // Analysis solution: doc comments parsed, so crefs bind and the compiler reports unused usings soundly.
        var analysis = solution;
        foreach (var pid in byPath.Values.SelectMany(l => l).Select(d => d.Project.Id).Distinct())
            if (analysis.GetProject(pid)?.ParseOptions is CSharpParseOptions po && po.DocumentationMode != DocumentationMode.Diagnose)
                analysis = analysis.WithProjectParseOptions(pid, po.WithDocumentationMode(DocumentationMode.Diagnose));

        var optionSets = new Dictionary<ProjectId, AnalyzerConfigSet?>();
        var changes = new List<PlannedFileChange>();
        var reports = new List<CleanupFileReport>();
        var changedProjects = new HashSet<ProjectId>();
        foreach (var (path, docs) in byPath.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            var first = docs[0];
            var original = await first.GetTextAsync(ct).ConfigureAwait(false);
            if (FileGuard(snapshot, docs, path, original, ct) is { } guard)
            {
                skipped.Add(new CleanupSkip(path, null, guard.code, guard.message));
                continue;
            }
            var contexts = docs.Select(d => analysis.GetDocument(d.Id)!).ToList();
            // The original's fingerprint, computed on the first proof (most files of a scope need none).
            List<SemanticFingerprint>? baselines = null;
            var options = Options(optionSets, first.Project, path);
            var root = await contexts[0].GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var conditional = root!.DescendantTrivia(descendIntoTrivia: true).Any(t => t.IsKind(SyntaxKind.IfDirectiveTrivia));

            async Task<string?> Verify(string candidate, CancellationToken token)
            {
                if (baselines == null)
                {
                    baselines = new List<SemanticFingerprint>();
                    foreach (var c in contexts) baselines.Add(await SemanticFingerprint.ComputeAsync(c, token).ConfigureAwait(false));
                }
                for (var i = 0; i < contexts.Count; i++)
                {
                    var after = contexts[i].WithText(SourceText.From(candidate, original.Encoding, original.ChecksumAlgorithm));
                    var tree = await after.GetSyntaxTreeAsync(token).ConfigureAwait(false);
                    if (tree!.GetDiagnostics(token).Any(d => d.Severity == DiagnosticSeverity.Error)) return "the result would not parse";
                    var fp = await SemanticFingerprint.ComputeAsync(after, token).ConfigureAwait(false);
                    if (baselines[i].Compare(fp, RemovableDiagnostics) is { } why)
                        return why + (contexts.Count > 1 ? $" in {ContextName(session, contexts[i].Project)}" : "");
                }
                return null;
            }

            var current = original;
            var counts = new List<(string, int)>();
            foreach (var fix in fixes)
            {
                if (fix.Semantic && conditional)
                {
                    skipped.Add(new CleanupSkip(path, fix.Id, "ConditionalCompilation", "The file uses #if; code in other configurations cannot be checked, so usings and namespaces are left alone."));
                    continue;
                }
                var currentDocs = contexts.Select(c => c.WithText(current)).ToList();
                var file = new CleanupFile
                {
                    Path = path,
                    Text = current,
                    Root = (await currentDocs[0].GetSyntaxRootAsync(ct).ConfigureAwait(false))!,
                    Options = options,
                    LanguageVersions = currentDocs.Select(d => (d.Project.ParseOptions as CSharpParseOptions)?.LanguageVersion ?? LanguageVersion.Default).ToList(),
                    Contexts = currentDocs,
                    Verify = Verify,
                };
                var outcome = await fix.ApplyAsync(file, ct).ConfigureAwait(false);
                switch (outcome)
                {
                    case FixOutcome.Changed changed when changed.Text != current.ToString():
                        current = SourceText.From(changed.Text, original.Encoding, original.ChecksumAlgorithm);
                        counts.Add((fix.Id, changed.Count));
                        break;
                    case FixOutcome.Skipped s:
                        skipped.Add(new CleanupSkip(path, fix.Id, s.ReasonCode, s.Message));
                        break;
                }
            }
            if (counts.Count == 0) continue;
            // Minimal edits (Roslyn's text differencing), in the coordinates of the original text.
            var newDoc = first.WithText(current);
            var minimal = (await newDoc.GetTextChangesAsync(first, ct).ConfigureAwait(false)).OrderBy(c => c.Span.Start).ToList();
            var edits = minimal.Select(c => new PlannedEdit(original.Lines.GetLinePositionSpan(c.Span), c.NewText ?? "")).ToList();
            if (original.WithChanges(minimal).ToString() != current.ToString())
            {
                skipped.Add(new CleanupSkip(path, null, "EditMismatch", "The edits could not be computed exactly; the file is left alone."));
                continue;
            }
            changes.Add(new PlannedFileChange(path, Hashing.Sha256Text(original.ToString()), Hashing.Sha256Text(current.ToString()), edits));
            reports.Add(new CleanupFileReport(path, counts));
            foreach (var d in docs) changedProjects.Add(d.Project.Id);
        }

        var fixList = fixes.Select(f => (f.Id, f.Title)).ToList();
        if (changes.Count == 0)
        {
            var reasons = skipped.Where(s => s.Path != null).GroupBy(s => s.ReasonCode).Select(g => $"{g.Key}: {g.Count()}").ToList();
            return RenameOutcome.Unavailable("NoChanges",
                $"Code Cleanup found nothing to change in {byPath.Count} file(s)" + (reasons.Count > 0 ? $" (skipped: {string.Join(", ", reasons)})." : "."));
        }

        // Read set: the edited projects and what they depend on (their binding can change only through these inputs).
        var graph = solution.GetProjectDependencyGraph();
        var closure = new HashSet<ProjectId>(changedProjects);
        foreach (var p in changedProjects) closure.UnionWith(graph.GetProjectsThatThisProjectTransitivelyDependsOn(p));
        var closureContexts = closure.Select(id => session.ContextFor(id)).Where(c => c != null).Select(c => c!).ToList();
        if (closureContexts.FirstOrDefault(c => c.State != ProjectStates.Loaded) is { } incomplete)
            return RenameOutcome.Unavailable("IncompleteProjectClosure", $"{incomplete.Name} is not completely loaded; its code cannot be checked.");
        var unknownImports = new List<string>();
        var readSet = RenamePlanner.BuildReadSet(snapshot, closure, ct, unknownImports);
        var contextIds = closureContexts.Select(c => c.ContextId).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var limitations = new List<string>
        {
            "Each change is kept only when Roslyn proves the code means the same in every loaded project context of the file (symbol bindings, declared symbols, literal values, diagnostics).",
            "Files using #if keep their usings and namespaces: other build configurations cannot be checked.",
            "The edited files are not saved; Undo restores them while they are unchanged.",
        };
        if (unknownImports.Count > 0)
            limitations.Add("MSBuild imports with computed paths are not fingerprinted: " + string.Join(", ", unknownImports.Distinct().Take(5)));
        var evidence = new List<(string, Location?)>
        {
            ($"Code Cleanup on snapshot {snapshot.Id}: {changes.Count} of {byPath.Count} file(s) changed, {changes.Sum(c => c.Edits.Count)} edit(s)", null),
            ("Semantic fingerprint unchanged for every changed file in every project context (doc comments bound)", null),
        };
        var total = skipped.Count;
        var listed = skipped.Take(MaxSkipped).ToList();
        if (total > MaxSkipped) listed.Add(new CleanupSkip(null, null, "MoreSkipped", $"{total - MaxSkipped} more skipped entries are not listed."));
        var plan = new RenamePlan
        {
            PlanId = "plan-" + Guid.NewGuid().ToString("N"),
            WorkspaceId = session.WorkspaceId,
            BaseSnapshot = snapshot,
            Title = $"Code Cleanup: {changes.Count} file(s)",
            ActionId = ActionId,
            Changes = changes,
            ReadSet = readSet,
            ProjectContextIds = contextIds,
            CheckedContexts = contextIds,
            UncheckedContexts = Array.Empty<string>(),
            Limitations = limitations,
            Evidence = evidence,
            CompilationDelta = "passed",
            ValidationStatus = unknownImports.Count > 0 ? "limited" : "valid",
            Cleanup = new CleanupReport(fixList, reports, listed, byPath.Count),
        };
        return new RenameOutcome(plan, null, null);
    }

    private static bool InScope(string scope, string path, string? projectPath)
    {
        if (projectPath != null && scope.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) return UriPaths.PathComparer.Equals(scope, projectPath);
        if (UriPaths.PathComparer.Equals(scope, path)) return true;
        var dir = scope.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return path.StartsWith(dir, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    /// <summary>Documents under the project's bin/ or obj/ (generated AssemblyInfo, global usings): never in a cleanup scope.</summary>
    private static bool IsBuildOutput(Project project, string path)
    {
        if (project.FilePath == null) return false;
        var rel = Path.GetRelativePath(Path.GetDirectoryName(project.FilePath)!, path).Replace('\\', '/');
        return rel.StartsWith("obj/", StringComparison.OrdinalIgnoreCase) || rel.StartsWith("bin/", StringComparison.OrdinalIgnoreCase);
    }

    private static string ContextName(WorkspaceSession session, Project project) =>
        session.ContextFor(project.Id) is { } c ? c.Name + (c.TargetFramework != null ? $" ({c.TargetFramework})" : "") : project.Name;

    /// <summary>Why a file is not touched at all, or null.</summary>
    private static (string code, string message)? FileGuard(Snapshot snapshot, IReadOnlyList<Document> docs, string path, SourceText text, CancellationToken ct)
    {
        var name = Path.GetFileName(path);
        foreach (var d in docs)
            if (snapshot.Session.ContextFor(d.Project.Id) is { } c && c.State != ProjectStates.Loaded)
                return ("IncompleteProject", $"{c.Name} is not completely loaded.");
        var tree = docs[0].GetSyntaxTreeAsync(ct).GetAwaiter().GetResult();
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return ("GeneratedCode", "Generated code.");
        if (text.Length > MaxFileChars) return ("FileTooLarge", $"Larger than {MaxFileChars / 1024} KB.");
        if (RenamePlanner.IsReadOnly(path)) return ("ReadOnlyFile", "The file is read-only.");
        byte[] bytes;
        try { bytes = File.Exists(path) ? File.ReadAllBytes(path) : Array.Empty<byte>(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return ("UnreadableFile", "The file cannot be read."); }
        if (!TextFiles.IsUtf8(bytes)) return ("UnsupportedEncoding", $"Not saved as UTF-8 ({name}); Refyntra edits only UTF-8 files.");
        if (TextFiles.LineEndings(text.ToString()) == "mixed") return ("MixedLineEndings", "The file mixes CRLF and LF line endings.");
        var texts = docs.Select(d => d.GetTextAsync(ct).GetAwaiter().GetResult().ToString()).Distinct(StringComparer.Ordinal).Count();
        if (texts > 1) return ("LinkedContextMismatch", "The file has different text in its project contexts.");
        return null;
    }

    /// <summary>.editorconfig options of a file, read from the project's analyzer config documents with public Roslyn APIs.</summary>
    private static ImmutableDictionary<string, string> Options(Dictionary<ProjectId, AnalyzerConfigSet?> cache, Project project, string path)
    {
        if (!cache.TryGetValue(project.Id, out var set))
        {
            var configs = new List<AnalyzerConfig>();
            foreach (var doc in project.AnalyzerConfigDocuments)
            {
                if (doc.FilePath == null || !doc.TryGetText(out var t) && (t = ReadText(doc.FilePath)) == null) continue;
                configs.Add(AnalyzerConfig.Parse(t, doc.FilePath));
            }
            set = configs.Count > 0 ? AnalyzerConfigSet.Create(configs) : null;
            cache[project.Id] = set;
        }
        return set?.GetOptionsForSourcePath(path).AnalyzerOptions ?? ImmutableDictionary<string, string>.Empty;
    }

    private static SourceText? ReadText(string path)
    {
        try { return File.Exists(path) ? SourceText.From(File.ReadAllText(path)) : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }
}
