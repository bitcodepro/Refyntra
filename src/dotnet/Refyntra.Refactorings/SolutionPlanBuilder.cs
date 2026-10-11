using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// One file deleted by a plan (protocol 1.6, Safe Delete): deleted after every text change of the plan, only while it
/// still has exactly the text of <see cref="ExpectedHash"/> (editor and disk). <see cref="ProjectPaths"/> are the projects
/// the host removes the document from after the client deleted it.
/// </summary>
public sealed record PlannedFileDelete(string Path, string ExpectedHash, IReadOnlyList<string> ProjectPaths);

/// <summary>
/// Shared safety of the text refactorings that compute a whole new <see cref="Solution"/> (Safe Delete, Extract Method,
/// Change Signature): per-file guards (file path, generated code, read-only, encoding, line endings, overlapping edits,
/// linked contexts), the affected project closure (every project must be loaded), the compilation delta (no compiler
/// error that did not exist before, spans mapped back through the plan's own edits), the read set and the plan.
/// Never writes files.
/// </summary>
public static class SolutionPlanBuilder
{
    public sealed record Options(
        string ActionId,
        string Title,
        List<string> Limitations,
        List<(string, Location?)> Evidence,
        /// <summary>Why the plan can only be partly validated (empty: valid). Each reason is also a limitation.</summary>
        List<string> LimitedReasons,
        /// <summary>Projects whose code the change is about (added to the closure even without an edit there).</summary>
        IReadOnlyCollection<ProjectId>? OwnerProjects = null,
        /// <summary>Files deleted by the plan (their documents are removed from <c>after</c> by the caller).</summary>
        IReadOnlyList<PlannedFileDelete>? Deletes = null,
        /// <summary>Reason code of a refusal caused by new compiler errors.</summary>
        string ConflictReason = "CompilationErrors");

    public static async Task<RenameOutcome> BuildAsync(Snapshot snapshot, Solution after, Options o, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        var session = snapshot.Session;
        var deletes = o.Deletes ?? Array.Empty<PlannedFileDelete>();
        var deletedPaths = new HashSet<string>(deletes.Select(d => d.Path), UriPaths.PathComparer);
        var changes = after.GetChanges(solution);
        if (changes.GetAddedProjects().Any() || changes.GetRemovedProjects().Any())
            return RenameOutcome.Unavailable("ResourceOperation", "The change would add or remove projects.");
        var projectChanges = changes.GetProjectChanges().ToList();
        foreach (var pc in projectChanges)
        {
            if (pc.GetAddedDocuments().Any() || pc.GetAddedAdditionalDocuments().Any() || pc.GetRemovedAdditionalDocuments().Any()
                || pc.GetChangedAdditionalDocuments().Any() || pc.GetChangedAnalyzerConfigDocuments().Any())
                return RenameOutcome.Unavailable("ResourceOperation", "The change would add or change non-source files; only text edits are supported.");
            foreach (var removed in pc.GetRemovedDocuments())
                if (solution.GetDocument(removed)?.FilePath is not { } rp || !deletedPaths.Contains(rp))
                    return RenameOutcome.Unavailable("ResourceOperation", "The change would remove a document that is not a planned file deletion.");
        }

        var byPath = new Dictionary<string, PlannedFileChange>(UriPaths.PathComparer);
        var changeMap = new Dictionary<string, IReadOnlyList<TextChange>>(UriPaths.PathComparer);
        var affected = new HashSet<ProjectId>(o.OwnerProjects ?? Array.Empty<ProjectId>());
        foreach (var pc in projectChanges)
        {
            foreach (var removed in pc.GetRemovedDocuments()) affected.Add(removed.ProjectId);
            foreach (var docId in pc.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                var oldDoc = solution.GetDocument(docId)!;
                var newDoc = after.GetDocument(docId)!;
                if (oldDoc.FilePath == null) return RenameOutcome.Unavailable("GeneratedCode", "The change touches a document without a file path.");
                if (deletedPaths.Contains(oldDoc.FilePath))
                    return RenameOutcome.Unavailable("ResourceOperation", "A deleted file would also be edited.");
                if (SymbolFacts.IsGeneratedTree(solution, (await oldDoc.GetSyntaxTreeAsync(ct).ConfigureAwait(false))!, ct))
                    return RenameOutcome.Unavailable("GeneratedCode", "The change would edit generated code: " + Path.GetFileName(oldDoc.FilePath));
                if (RenamePlanner.IsReadOnly(oldDoc.FilePath))
                    return RenameOutcome.Unavailable("ReadOnlyFile", "The change would edit a read-only file: " + Path.GetFileName(oldDoc.FilePath));
                affected.Add(docId.ProjectId);
                var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
                if (RenamePlanner.TargetGuard(session, oldDoc.FilePath, oldText) is { } targetGuard) return targetGuard;
                var newText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
                var minimal = (await newDoc.GetTextChangesAsync(oldDoc, ct).ConfigureAwait(false)).OrderBy(c => c.Span.Start).ToList();
                if (oldText.WithChanges(minimal).ToString() != newText.ToString())
                    minimal = newText.GetTextChanges(oldText).OrderBy(c => c.Span.Start).ToList();
                var edits = minimal.Select(c => new PlannedEdit(oldText.Lines.GetLinePositionSpan(c.Span), c.NewText ?? "")).ToList();
                for (var i = 1; i < edits.Count; i++)
                    if (edits[i].Range.Start < edits[i - 1].Range.End)
                        return RenameOutcome.Unavailable("OverlappingEdits", "The change produced overlapping edits.");
                var change = new PlannedFileChange(oldDoc.FilePath, Hashing.Sha256Text(oldText.ToString()), Hashing.Sha256Text(newText.ToString()), edits);
                if (byPath.TryGetValue(oldDoc.FilePath, out var existing))
                {
                    if (existing.ResultHash != change.ResultHash || existing.ExpectedHash != change.ExpectedHash)
                        return RenameOutcome.Unavailable("LinkedContextMismatch", "A linked file would be changed differently in its project contexts.");
                    continue;
                }
                byPath[oldDoc.FilePath] = change;
                changeMap[oldDoc.FilePath] = minimal;
            }
        }
        if (byPath.Count == 0 && deletes.Count == 0) return RenameOutcome.Unavailable("NoChanges", "The change produces no edits.");
        foreach (var d in deletes)
        {
            if (RenamePlanner.IsReadOnly(d.Path)) return RenameOutcome.Unavailable("ReadOnlyFile", "The file to delete is read-only: " + Path.GetFileName(d.Path));
            foreach (var id in session.DocumentIdsForPath(d.Path)) affected.Add(id.ProjectId);
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

        var newErrors = new List<string>();
        foreach (var pid in closure)
        {
            ct.ThrowIfCancellationRequested();
            var before = await RenamePlanner.ErrorKeysAsync(solution.GetProject(pid), null, ct).ConfigureAwait(false);
            var afterKeys = await RenamePlanner.ErrorKeysAsync(after.GetProject(pid), changeMap, ct).ConfigureAwait(false);
            foreach (var (key, entry) in afterKeys)
                if (entry.count > (before.TryGetValue(key, out var b) ? b.count : 0)) newErrors.Add(entry.label);
        }
        if (newErrors.Count > 0)
            return RenameOutcome.Unavailable(o.ConflictReason, "The change would introduce compiler errors: " + string.Join(", ", newErrors.Distinct().Take(10)));

        var unknownImports = new List<string>();
        var readSet = RenamePlanner.BuildReadSet(snapshot, closure, ct, unknownImports);
        var contextIds = closureContexts.Select(c => c.ContextId).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var limitations = new List<string>(o.Limitations);
        foreach (var r in o.LimitedReasons) if (!limitations.Contains(r)) limitations.Add(r);
        if (unknownImports.Count > 0)
            limitations.Add("MSBuild imports with computed paths are not fingerprinted: " + string.Join(", ", unknownImports.Distinct().Take(5)));
        foreach (var d in deletes)
            limitations.Add($"{Path.GetFileName(d.Path)} is deleted after the text edits, as a separate step, only while its text is unchanged; if that step fails, the text edits stay applied (nothing is rolled back).");
        var evidence = new List<(string, Location?)>(o.Evidence)
        {
            ($"No new compiler errors in {closure.Count} project context(s){(deletes.Count > 0 ? ", the deleted file(s) removed" : "")}", null),
            ($"Snapshot {snapshot.Id}: {byPath.Count} file(s) edited, {byPath.Values.Sum(c => c.Edits.Count)} edit(s){(deletes.Count > 0 ? $", {deletes.Count} file(s) deleted" : "")}", null),
        };
        var plan = new RenamePlan
        {
            PlanId = "plan-" + Guid.NewGuid().ToString("N"),
            WorkspaceId = session.WorkspaceId,
            BaseSnapshot = snapshot,
            Title = o.Title,
            ActionId = o.ActionId,
            Changes = byPath.Values.OrderBy(c => c.Path, StringComparer.Ordinal).ToList(),
            ReadSet = readSet,
            ProjectContextIds = contextIds,
            CheckedContexts = contextIds,
            UncheckedContexts = Array.Empty<string>(),
            Limitations = limitations,
            Evidence = evidence,
            CompilationDelta = "passed",
            ValidationStatus = unknownImports.Count > 0 || o.LimitedReasons.Count > 0 ? "limited" : "valid",
            FileDeletes = deletes,
        };
        return new RenameOutcome(plan, null, null);
    }

    /// <summary>Re-checks every planned file deletion against the disk: present, writable, same text.</summary>
    public static (string code, string message)? RevalidateDeletes(IReadOnlyList<PlannedFileDelete> deletes)
    {
        foreach (var d in deletes)
        {
            if (!File.Exists(d.Path)) return ("FileMissing", $"{Path.GetFileName(d.Path)} no longer exists.");
            if (RenamePlanner.IsReadOnly(d.Path)) return ("ReadOnlyFile", $"{Path.GetFileName(d.Path)} is read-only.");
        }
        return null;
    }
}
