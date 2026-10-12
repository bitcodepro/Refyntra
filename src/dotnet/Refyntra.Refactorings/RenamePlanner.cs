using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

public sealed record PlannedEdit(LinePositionSpan Range, string NewText);

public sealed record PlannedFileChange(string Path, string ExpectedHash, string ResultHash, IReadOnlyList<PlannedEdit> Edits);

public static class ReadKinds
{
    /// <summary>Source document: hash of the snapshot text; revalidated against the current overlay or disk text.</summary>
    public const string Source = "source";
    /// <summary>Build input file: hash of bytes or "absent".</summary>
    public const string File = "file";
    /// <summary>Set of *.cs files on disk under a project directory (excluding bin/obj).</summary>
    public const string Membership = "membership";
    /// <summary>Set of documents of a project context in the snapshot.</summary>
    public const string Documents = "documents";
    /// <summary>Project files (*.csproj, path + bytes) under a directory: projects that could start referencing the closure.</summary>
    public const string Projects = "projects";
    /// <summary>Absence precondition: the target path of a file rename or a created file must not exist (also ignoring case).</summary>
    public const string Absent = "absent";
}

public sealed record ReadEntry(string Kind, string Input, string Hash, string? ContextId = null);

public sealed class RenamePlan
{
    public required string PlanId { get; init; }
    public required string WorkspaceId { get; init; }
    public required Snapshot BaseSnapshot { get; init; }
    public required string Title { get; init; }
    public required IReadOnlyList<PlannedFileChange> Changes { get; init; }
    public required IReadOnlyList<ReadEntry> ReadSet { get; init; }
    public required IReadOnlyList<string> ProjectContextIds { get; init; }
    public required IReadOnlyList<string> CheckedContexts { get; init; }
    public required IReadOnlyList<string> UncheckedContexts { get; init; }
    public required IReadOnlyList<string> Limitations { get; init; }
    public required IReadOnlyList<(string description, Location? location)> Evidence { get; init; }
    public required string CompilationDelta { get; init; }
    public required string ValidationStatus { get; init; }
    /// <summary>File rename: file renames applied after the text edits (empty for a text-only plan).</summary>
    public IReadOnlyList<PlannedFileRename> FileRenames { get; init; } = Array.Empty<PlannedFileRename>();
    /// <summary>File rename: what renaming the file together with the type would mean (null when no file is named after it).</summary>
    public FileRenameOffer? FileRenameOffer { get; init; }
    /// <summary>Move Type to File / Generate handler: files created before every text edit (empty otherwise).</summary>
    public IReadOnlyList<PlannedFileCreate> FileCreates { get; init; } = Array.Empty<PlannedFileCreate>();
    /// <summary>The action of the plan (csharp.rename, csharp.moveTypeToFile, csharp.generateHandler).</summary>
    public string ActionId { get; init; } = "csharp.rename";
    /// <summary>Generate handler: the folders the handler can be created in (first = default), with the chosen one.</summary>
    public CreateFileOffer? CreateFileOffer { get; init; }
    /// <summary>Code Cleanup (csharp.cleanup): the fixes, per file per fix counts and the skipped files with reasons.</summary>
    public Cleanup.CleanupReport? Cleanup { get; init; }
    /// <summary>EF Core migrations that reference the symbol: the mode of this plan and those files (null when none do).</summary>
    public EfMigrationOffer? EfMigrations { get; init; }
    /// <summary>Safe Delete (protocol 1.6): files deleted after every text edit (empty otherwise).</summary>
    public IReadOnlyList<PlannedFileDelete> FileDeletes { get; init; } = Array.Empty<PlannedFileDelete>();
}

public sealed record RenameOutcome(RenamePlan? Plan, string? ReasonCode, string? Message)
{
    public static RenameOutcome Unavailable(string reason, string message) => new(null, reason, message);
}

/// <param name="Limitations">For status "limited": the limitations of the plan (revalidation never upgrades to "valid").</param>
public sealed record RevalidationOutcome(string Status, string? ReasonCode, string? Message, IReadOnlyList<string>? Limitations = null);

/// <summary>Plans a C# rename on the immutable snapshot with Roslyn's Renamer. Never writes files.</summary>
public static class RenamePlanner
{
    private static readonly string[] BuildInputNames = { "Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props", "global.json", ".editorconfig" };

    /// <summary>Cheap guards that do not run the rename (used by capability/query too).</summary>
    public static (string reason, string message)? Guard(Snapshot snapshot, ISymbol symbol, string? newName, CancellationToken ct)
    {
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) symbol = ctor.ContainingType;
        if (!symbol.Locations.Any(l => l.IsInSource))
            return ("MetadataSymbol", "The symbol is defined in a referenced assembly, not in source.");
        if (symbol.Kind is SymbolKind.Namespace)
            return ("UnsupportedSymbolKind", "Renaming namespaces is not supported.");
        if (symbol is IMethodSymbol m && m.MethodKind is not (MethodKind.Ordinary or MethodKind.LocalFunction))
            return ("UnsupportedSymbolKind", $"Renaming {m.MethodKind} methods is not supported.");
        if (symbol.Kind is not (SymbolKind.NamedType or SymbolKind.Method or SymbolKind.Property or SymbolKind.Field or SymbolKind.Event
            or SymbolKind.Parameter or SymbolKind.Local or SymbolKind.TypeParameter))
            return ("UnsupportedSymbolKind", $"Renaming {symbol.Kind} symbols is not supported.");
        if (symbol.IsImplicitlyDeclared)
            return ("UnsupportedSymbolKind", "The symbol is implicitly declared.");
        foreach (var loc in symbol.Locations.Where(l => l.IsInSource))
            if (SymbolFacts.IsGeneratedTree(snapshot.Solution, loc.SourceTree!, ct))
                return ("GeneratedCode", "The symbol is declared in generated code.");
        if (ImplementsOrOverridesMetadata(symbol))
            return ("ImplementsMetadataMember", "The member implements or overrides a member declared in a referenced assembly; renaming it would break that contract.");
        if (newName != null)
        {
            var bare = newName.StartsWith('@') ? newName.Substring(1) : newName;
            if (!SyntaxFacts.IsValidIdentifier(bare) || (!newName.StartsWith('@') && SyntaxFacts.GetKeywordKind(bare) != SyntaxKind.None))
                return ("InvalidIdentifier", "The new name is not a valid C# identifier.");
            if (bare == symbol.Name)
                return ("SameName", "The new name equals the current name.");
        }
        return null;
    }

    private static bool ImplementsOrOverridesMetadata(ISymbol symbol)
    {
        if (symbol is IMethodSymbol { OverriddenMethod: { } om } && !om.Locations.Any(l => l.IsInSource)) return true;
        if (symbol is IPropertySymbol { OverriddenProperty: { } op } && !op.Locations.Any(l => l.IsInSource)) return true;
        if (symbol.Kind is SymbolKind.Method or SymbolKind.Property or SymbolKind.Event && symbol.ContainingType != null)
        {
            foreach (var iface in symbol.ContainingType.AllInterfaces)
            foreach (var member in iface.GetMembers())
            {
                if (member.Locations.Any(l => l.IsInSource)) continue;
                var impl = symbol.ContainingType.FindImplementationForInterfaceMember(member);
                if (SymbolEqualityComparer.Default.Equals(impl, symbol)) return true;
            }
        }
        return false;
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, ISymbol symbol, string newName, CancellationToken ct, bool renameFile = false,
        string? generatedEdits = null)
    {
        var efMode = generatedEdits == GeneratedEditModes.None ? GeneratedEditModes.None : GeneratedEditModes.EfMigrations;
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) symbol = ctor.ContainingType;
        var guard = Guard(snapshot, symbol, newName, ct);
        if (guard != null) return RenameOutcome.Unavailable(guard.Value.reason, guard.Value.message);
        var bareNew = newName.StartsWith('@') ? newName.Substring(1) : newName;
        var solution = snapshot.Solution;
        var session = snapshot.Session;

        var options = new SymbolRenameOptions(RenameOverloads: false, RenameInStrings: false, RenameInComments: false, RenameFile: false);
        Solution renamed;
        try
        {
            renamed = await Renamer.RenameSymbolAsync(solution, symbol, options, newName, ct).ConfigureAwait(false);
        }
        catch (ArgumentException ex)
        {
            return RenameOutcome.Unavailable("RenameRejected", "Roslyn rejected the rename: " + ex.GetType().Name);
        }

        var changes = renamed.GetChanges(solution);
        var projectChanges = changes.GetProjectChanges().ToList();

        // EF Core migrations and model snapshots (proven by verified EF attribute identity) are generated by EF but may
        // be edited when the edits only rename references to the symbol (mode efMigrations), or are left untouched
        // (mode none: their edits are dropped and the compilation delta shows what breaks). Other generated code is refused.
        var efPaths = new SortedSet<string>(UriPaths.PathComparer);
        var efProjects = new HashSet<ProjectId>();
        foreach (var pc in projectChanges)
        foreach (var docId in pc.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
        {
            var oldDoc = solution.GetDocument(docId)!;
            if (oldDoc.FilePath == null || await EfMigrationEdits.MigrationContextAsync(oldDoc, ct).ConfigureAwait(false) == null) continue;
            if (!await EfMigrationEdits.OnlyRenamesReferencesAsync(oldDoc, renamed.GetDocument(docId)!, symbol, newName, bareNew, ct).ConfigureAwait(false))
                return RenameOutcome.Unavailable("GeneratedCode",
                    $"The rename would change more than the references to {symbol.Name} in the EF Core migration {Path.GetFileName(oldDoc.FilePath)}; migrations are generated by EF Core.");
            efPaths.Add(oldDoc.FilePath);
            efProjects.Add(docId.ProjectId);
        }
        if (efPaths.Count > 0 && efMode == GeneratedEditModes.None)
        {
            foreach (var path in efPaths)
            foreach (var id in solution.GetDocumentIdsWithFilePath(path))
                if (solution.GetDocument(id) is { } d && renamed.GetDocument(id) is not null)
                    renamed = renamed.WithDocumentText(id, await d.GetTextAsync(ct).ConfigureAwait(false));
            changes = renamed.GetChanges(solution);
            projectChanges = changes.GetProjectChanges().ToList();
        }
        if (changes.GetAddedProjects().Any() || changes.GetRemovedProjects().Any()
            || projectChanges.Any(p => p.GetAddedDocuments().Any() || p.GetRemovedDocuments().Any() || p.GetAddedAdditionalDocuments().Any()
                || p.GetRemovedAdditionalDocuments().Any() || p.GetChangedAdditionalDocuments().Any() || p.GetChangedAnalyzerConfigDocuments().Any()))
            return RenameOutcome.Unavailable("ResourceOperation", "The rename would add, remove or change non-source files; only text edits are supported.");

        // Text changes, grouped by file path (linked documents in several contexts must agree).
        var byPath = new Dictionary<string, PlannedFileChange>(UriPaths.PathComparer);
        var affectedProjects = new HashSet<ProjectId>();
        foreach (var pc in projectChanges)
        foreach (var docId in pc.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
        {
            var oldDoc = solution.GetDocument(docId)!;
            var newDoc = renamed.GetDocument(docId)!;
            if (oldDoc.FilePath == null) return RenameOutcome.Unavailable("GeneratedCode", "The rename touches a document without a file path.");
            if (efMode == GeneratedEditModes.None && efPaths.Contains(oldDoc.FilePath)) continue; // restored to the original text
            if (!efPaths.Contains(oldDoc.FilePath) && SymbolFacts.IsGeneratedTree(solution, (await oldDoc.GetSyntaxTreeAsync(ct).ConfigureAwait(false))!, ct))
                return RenameOutcome.Unavailable("GeneratedCode", "The rename would edit generated code: " + Path.GetFileName(oldDoc.FilePath));
            if (IsReadOnly(oldDoc.FilePath))
                return RenameOutcome.Unavailable("ReadOnlyFile", "The rename would edit a read-only file: " + Path.GetFileName(oldDoc.FilePath));
            affectedProjects.Add(docId.ProjectId);
            var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
            if (TargetGuard(session, oldDoc.FilePath, oldText) is { } targetGuard) return targetGuard;
            var newText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
            // Minimal edits (one per renamed occurrence, as the Refactor Preview lists them); SourceText.GetTextChanges
            // gives one change over the whole document for Renamer output. It stays the fallback when they do not add up.
            var minimalEdits = (await newDoc.GetTextChangesAsync(oldDoc, ct).ConfigureAwait(false)).OrderBy(c => c.Span.Start).ToList();
            if (oldText.WithChanges(minimalEdits).ToString() != newText.ToString())
                minimalEdits = newText.GetTextChanges(oldText).OrderBy(c => c.Span.Start).ToList();
            var edits = minimalEdits
                .Select(c => new PlannedEdit(oldText.Lines.GetLinePositionSpan(c.Span), c.NewText ?? "")).ToList();
            for (var i = 1; i < edits.Count; i++)
                if (edits[i].Range.Start < edits[i - 1].Range.End)
                    return RenameOutcome.Unavailable("OverlappingEdits", "Roslyn produced overlapping edits.");
            var change = new PlannedFileChange(oldDoc.FilePath, Hashing.Sha256Text(oldText.ToString()), Hashing.Sha256Text(newText.ToString()), edits);
            if (byPath.TryGetValue(oldDoc.FilePath, out var existing))
            {
                if (existing.ResultHash != change.ResultHash || existing.ExpectedHash != change.ExpectedHash)
                    return RenameOutcome.Unavailable("LinkedContextMismatch", "A linked file would be renamed differently in its project contexts.");
                continue;
            }
            byPath[oldDoc.FilePath] = change;
        }
        if (byPath.Count == 0) return RenameOutcome.Unavailable("NoChanges", "The rename produces no text changes.");

        // Affected closure: owner + edited projects, their dependencies and every reverse dependent.
        var owner = SymbolFacts.OwningProject(solution, symbol);
        if (owner != null) affectedProjects.Add(owner.Id);
        affectedProjects.UnionWith(efProjects);
        var graph = solution.GetProjectDependencyGraph();
        var closure = new HashSet<ProjectId>(affectedProjects);
        foreach (var p in affectedProjects)
        {
            closure.UnionWith(graph.GetProjectsThatThisProjectTransitivelyDependsOn(p));
            closure.UnionWith(graph.GetProjectsThatTransitivelyDependOnThisProject(p));
        }
        var closureContexts = closure.Select(id => session.ContextFor(id)).Where(c => c != null).Select(c => c!).ToList();
        var incomplete = closureContexts.Where(c => c.State != ProjectStates.Loaded).ToList();
        if (incomplete.Count > 0)
            return RenameOutcome.Unavailable("IncompleteProjectClosure",
                "Projects in the affected closure are not completely loaded: " + string.Join(", ", incomplete.Select(c => c.Name)));
        if (session.Projects.Any(p => p.State == ProjectStates.Failed))
            return RenameOutcome.Unavailable("IncompleteProjectClosure", "Some projects of the solution failed to load; their references cannot be checked.");

        // Compilation delta: a rename must not introduce new errors (conflicts, collisions, broken references). Errors
        // are compared by (id, file, span); spans after the rename are mapped back through the rename's own text
        // changes, so a new error that replaces a fixed error of the same id is still a new error.
        var changeMap = new Dictionary<string, IReadOnlyList<TextChange>>(UriPaths.PathComparer);
        foreach (var pc in projectChanges)
        foreach (var docId in pc.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
        {
            var oldDoc = solution.GetDocument(docId)!;
            if (oldDoc.FilePath == null || changeMap.ContainsKey(oldDoc.FilePath)) continue;
            // Document.GetTextChangesAsync gives the minimal edits; SourceText.GetTextChanges returns a single change over
            // the whole document for Renamer output, which would map every pre-existing error to a new key.
            var minimal = await renamed.GetDocument(docId)!.GetTextChangesAsync(oldDoc, ct).ConfigureAwait(false);
            changeMap[oldDoc.FilePath] = minimal.OrderBy(c => c.Span.Start).ToList();
        }
        var newErrors = new List<string>();
        // Mode none: new errors in the untouched EF Core migrations are expected (and reported); anywhere else they refuse.
        var migrationErrors = new List<string>();
        foreach (var pid in closure)
        {
            var before = await ErrorKeysAsync(solution.GetProject(pid), null, ct).ConfigureAwait(false);
            var after = await ErrorKeysAsync(renamed.GetProject(pid), changeMap, ct).ConfigureAwait(false);
            foreach (var (key, entry) in after)
                if (entry.count > (before.TryGetValue(key, out var b) ? b.count : 0))
                    (efMode == GeneratedEditModes.None && entry.file != null && efPaths.Contains(entry.file) ? migrationErrors : newErrors).Add(entry.label);
        }
        if (newErrors.Count > 0)
            return RenameOutcome.Unavailable("RenameConflict", "The rename introduces compiler errors: " + string.Join(", ", newErrors.Distinct().Take(10)));

        var unknownImports = new List<string>();
        var readSet = BuildReadSet(snapshot, closure, ct, unknownImports);
        var contextIds = closureContexts.Select(c => c.ContextId).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var limitations = new List<string>
        {
            "String literals, comments, reflection names, JSON, routes and serialization contracts are not renamed.",
            "Overloads are not renamed together.",
        };
        // File rename: the files named after a top-level type can be renamed with it (a separate resource operation).
        var fileRename = FileRenamePlanner.Plan(snapshot, symbol, bareNew, renameFile, unknownImports.Count > 0,
            byPath.ToDictionary(kv => kv.Key, kv => kv.Value.ResultHash, UriPaths.PathComparer), ct);
        var fileRenames = fileRename?.renames ?? new List<PlannedFileRename>();
        if (fileRename is { } fr)
            foreach (var (oldPath, newPath) in fr.offer.Files)
                limitations.Add(fr.offer.Included
                    ? $"The file {Path.GetFileName(oldPath)} is renamed to {Path.GetFileName(newPath)} after the text edits, as a separate step; if that step fails, the text edits stay applied (nothing is rolled back)."
                    : fr.offer.Available
                        ? $"The file {Path.GetFileName(oldPath)} keeps its name (renaming the file was not requested)."
                        : $"The file {Path.GetFileName(oldPath)} keeps its name: {fr.offer.Message}");
        if (fileRenames.Count == 0) limitations.Add("The file name is not changed.");
        foreach (var r in fileRenames) readSet.Add(new ReadEntry(ReadKinds.Absent, "absent:" + r.NewPath, "absent"));
        // EF Core migrations: what was renamed in them, what keeps the old name, and (mode none) that the build breaks.
        var efFileNames = string.Join(", ", efPaths.Select(Path.GetFileName));
        if (efPaths.Count > 0 && efMode == GeneratedEditModes.EfMigrations)
            limitations.Add($"EF Core migrations (generated by EF): in {efFileNames} only the code references to {symbol.Name} are renamed (for example typeof({symbol.Name}) in [DbContext(typeof({symbol.Name}))]); nothing else in those files is changed.");
        if (efPaths.Count > 0 && efMode == GeneratedEditModes.None)
            limitations.Add($"The project will not build until the migrations are updated: {efFileNames} still reference {symbol.Name} (EF Core migrations were left unchanged as requested).");
        var (stringFiles, oldClassNames) = await EfMigrationEdits.OldNameTextAsync(solution, closure, symbol, ct).ConfigureAwait(false);
        if (stringFiles.Count > 0 && symbol is INamedTypeSymbol named)
            limitations.Add($"The EF Core model snapshot and migration metadata keep the old name as text: \"{Frameworks.Abstractions.SymbolIdentity.FullMetadataName(named.OriginalDefinition)}\" in {string.Join(", ", stringFiles.Select(Path.GetFileName))} is not changed (strings in migrations are never edited). EF Core tolerates this, but the next migration you add may contain changes for this type because the snapshot still uses the old name; review that migration before you apply it to a database.");
        if (oldClassNames.Count > 0)
            limitations.Add($"Migration and model snapshot classes keep their names ({string.Join(", ", oldClassNames)}); EF Core finds them by their [DbContext] attribute, not by their name.");
        if (unknownImports.Count > 0)
            limitations.Add("MSBuild imports with computed paths are not fingerprinted: " + string.Join(", ", unknownImports.Distinct().Take(5)));
        if (symbol.DeclaredAccessibility is Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal
            && symbol.Kind is not (SymbolKind.Local or SymbolKind.Parameter or SymbolKind.TypeParameter))
            limitations.Add("The symbol is publicly visible; consumers outside the loaded solution are not updated.");
        var evidence = new List<(string, Location?)>
        {
            ($"Roslyn Renamer on snapshot {snapshot.Id}: {byPath.Count} file(s), {byPath.Values.Sum(c => c.Edits.Count)} edit(s)", SymbolFacts.PrimaryLocation(symbol)),
            (migrationErrors.Count > 0 ? $"No new compiler errors in {closure.Count} project context(s) outside the unchanged EF Core migrations" : $"No new compiler errors in {closure.Count} project context(s)", null),
        };
        if (efPaths.Count > 0)
            evidence.Add((efMode == GeneratedEditModes.EfMigrations
                ? $"EF Core migration file(s) proven by the verified [DbContext]/[Migration] attributes and Migration/ModelSnapshot base types: {efFileNames}; every edit in them renames a reference to {symbol.Name}"
                : $"EF Core migration file(s) proven by the verified [DbContext]/[Migration] attributes and Migration/ModelSnapshot base types: {efFileNames}; left unchanged, new compiler errors there: {string.Join(", ", migrationErrors.Distinct().Take(10))}", null));
        foreach (var r in fileRenames)
            evidence.Add(($"{Path.GetFileName(r.NewPath)} stays in the same Compile items as {Path.GetFileName(r.OldPath)} in {r.ProjectPaths.Count} project(s) (SDK default glob, same folder, no Compile pattern or explicit item for either name); the target does not exist", null));
        var plan = new RenamePlan
        {
            PlanId = "plan-" + Guid.NewGuid().ToString("N"),
            WorkspaceId = session.WorkspaceId,
            BaseSnapshot = snapshot,
            Title = $"Rename {symbol.Name} to {bareNew}",
            Changes = byPath.Values.OrderBy(c => c.Path, StringComparer.Ordinal).ToList(),
            ReadSet = readSet,
            ProjectContextIds = contextIds,
            CheckedContexts = contextIds,
            UncheckedContexts = Array.Empty<string>(),
            Limitations = limitations,
            Evidence = evidence,
            CompilationDelta = migrationErrors.Count > 0 ? "failed" : "passed",
            // An import we cannot fingerprint means the read set is not closed: limited, never valid. Migrations left
            // unchanged (mode none) break the build: limited, never presented as safe.
            ValidationStatus = unknownImports.Count > 0 || (efPaths.Count > 0 && efMode == GeneratedEditModes.None) ? "limited" : "valid",
            FileRenames = fileRenames,
            FileRenameOffer = fileRename?.offer,
            EfMigrations = efPaths.Count > 0 ? new EfMigrationOffer(efMode, efPaths.ToList()) : null,
        };
        return new RenameOutcome(plan, null, null);
    }

    /// <summary>
    /// Compiler errors of a project keyed by (id, file, span). With <paramref name="mapBack"/> the spans of edited
    /// files are mapped back to the text before the rename.
    /// </summary>
    internal static async Task<Dictionary<string, (int count, string label, string? file)>> ErrorKeysAsync(Project? project,
        IReadOnlyDictionary<string, IReadOnlyList<TextChange>>? mapBack, CancellationToken ct)
    {
        var result = new Dictionary<string, (int count, string label, string? file)>(StringComparer.Ordinal);
        if (project == null) return result;
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation == null) return result;
        foreach (var d in compilation.GetDiagnostics(ct).Where(d => d.Severity == DiagnosticSeverity.Error))
        {
            string key, label;
            string? errorFile = null;
            if (d.Location.IsInSource && d.Location.SourceTree?.FilePath is { Length: > 0 } file)
            {
                var span = d.Location.SourceSpan;
                int start = span.Start, end = span.End;
                if (mapBack != null && mapBack.TryGetValue(file, out var changes))
                {
                    start = MapToOld(changes, start, isEnd: false);
                    end = MapToOld(changes, end, isEnd: true);
                }
                key = $"{d.Id}|{file.ToLowerInvariant()}|{start}|{end}";
                label = $"{d.Id} in {Path.GetFileName(file)}:{d.Location.GetLineSpan().StartLinePosition.Line + 1}";
                errorFile = file;
            }
            else
            {
                key = d.Id + "|";
                label = d.Id;
            }
            result[key] = result.TryGetValue(key, out var c) ? (c.count + 1, label, errorFile) : (1, label, errorFile);
        }
        return result;
    }

    /// <summary>
    /// Maps a position in the renamed text back to the original text. A position inside an edit maps to the start of
    /// the replaced span (or its end, for an end position).
    /// </summary>
    public static int MapToOld(IReadOnlyList<TextChange> changes, int position, bool isEnd)
    {
        var delta = 0;
        foreach (var c in changes)
        {
            var newStart = c.Span.Start + delta;
            var newEnd = newStart + (c.NewText?.Length ?? 0);
            if (position <= newStart) return position - delta;
            if (position < newEnd) return isEnd ? c.Span.End : c.Span.Start;
            if (position == newEnd && isEnd) return c.Span.End;
            delta += (c.NewText?.Length ?? 0) - c.Span.Length;
        }
        return position - delta;
    }

    /// <summary>
    /// Targets the extension cannot edit exactly as previewed: files that are not UTF-8 on disk, and closed files with
    /// mixed line endings (VS Code normalizes them when it loads the file, so the result would differ from the preview).
    /// </summary>
    internal static RenameOutcome? TargetGuard(WorkspaceSession session, string path, SourceText snapshotText)
    {
        byte[] bytes;
        try { bytes = File.Exists(path) ? File.ReadAllBytes(path) : Array.Empty<byte>(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return RenameOutcome.Unavailable("UnreadableFile", "The rename would edit a file that cannot be read: " + Path.GetFileName(path));
        }
        if (!TextFiles.IsUtf8(bytes))
            return RenameOutcome.Unavailable("UnsupportedEncoding",
                $"The rename would edit {Path.GetFileName(path)}, which is not saved as UTF-8 (read as {snapshotText.Encoding?.WebName ?? "unknown"}). Refyntra edits only UTF-8 files; convert the file to UTF-8 first.");
        if (!session.HasOverlay(path) && TextFiles.LineEndings(snapshotText.ToString()) == "mixed")
            return RenameOutcome.Unavailable("MixedLineEndings",
                $"The rename would edit {Path.GetFileName(path)}, which mixes line endings (CRLF and LF). VS Code normalizes them when it opens the file, so the result would differ from the preview. Normalize the line endings first (for example open the file and save it).");
        return null;
    }

    /// <summary>
    /// Conservative fingerprint of the whole affected project closure: every source document, the project files,
    /// Directory.Build.*, Directory.Packages.props, global.json, .editorconfig (present or absent, in every ancestor
    /// directory), obj/project.assets.json, the solution file, the project document sets and the on-disk *.cs membership.
    /// </summary>
    public static List<ReadEntry> BuildReadSet(Snapshot snapshot, IEnumerable<ProjectId> closure, CancellationToken ct, List<string>? unknownImports = null)
    {
        var entries = new Dictionary<string, ReadEntry>(UriPaths.PathComparer);
        void Add(ReadEntry e) => entries.TryAdd(e.Kind + "|" + e.Input, e);
        var solution = snapshot.Solution;
        if (snapshot.Session.SolutionPath is { } sln) Add(new ReadEntry(ReadKinds.File, sln, Hashing.FileBytes(sln)));
        // Every project file of the solution/workspace, not only the closure: a project outside the closure can start
        // referencing the renamed symbol's project (a ProjectReference added to its project file).
        foreach (var path in solution.Projects.Select(p => p.FilePath).Concat(snapshot.Session.Projects.Select(c => (string?)c.ProjectPath))
                     .OfType<string>().Where(Path.IsPathRooted).Distinct(UriPaths.PathComparer).OrderBy(p => p, StringComparer.Ordinal))
            Add(new ReadEntry(ReadKinds.File, path, Hashing.FileBytes(path)));
        // A project-only workspace (no solution): project files appearing next to the opened project.
        if (snapshot.Session.SolutionPath == null && ProjectsRoot(snapshot.Session.Path) is { } root)
            Add(new ReadEntry(ReadKinds.Projects, "projects:" + root, ProjectFilesHash(root)));
        foreach (var pid in closure.OrderBy(p => solution.GetProject(p)?.FilePath, StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            var project = solution.GetProject(pid);
            if (project == null) continue;
            var ctx = snapshot.Session.ContextFor(pid);
            foreach (var doc in project.Documents)
            {
                if (doc.FilePath == null) continue;
                var text = doc.GetTextAsync(ct).GetAwaiter().GetResult();
                Add(new ReadEntry(ReadKinds.Source, doc.FilePath, Hashing.Sha256Text(text.ToString())));
            }
            foreach (var doc in project.AdditionalDocuments.Concat(project.AnalyzerConfigDocuments))
                if (doc.FilePath != null) Add(new ReadEntry(ReadKinds.File, doc.FilePath, Hashing.FileBytes(doc.FilePath)));
            Add(new ReadEntry(ReadKinds.Documents, "documents:" + (ctx?.ContextId ?? project.Name), DocumentSetHash(project), ctx?.ContextId));
            if (project.FilePath == null) continue;
            Add(new ReadEntry(ReadKinds.File, project.FilePath, Hashing.FileBytes(project.FilePath)));
            var dir = Path.GetDirectoryName(project.FilePath)!;
            Add(new ReadEntry(ReadKinds.File, Path.Combine(dir, "obj", "project.assets.json"), Hashing.FileBytes(Path.Combine(dir, "obj", "project.assets.json"))));
            Add(new ReadEntry(ReadKinds.Membership, "membership:" + dir, MembershipHash(dir)));
            var importers = new List<string> { project.FilePath };
            for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
                foreach (var name in BuildInputNames)
                {
                    var f = Path.Combine(d.FullName, name);
                    Add(new ReadEntry(ReadKinds.File, f, Hashing.FileBytes(f)));
                    if (name.StartsWith("Directory.", StringComparison.Ordinal) && File.Exists(f)) importers.Add(f);
                }
            // Explicit <Import Project="..."/> of the project and of the Directory.* files (one level, literal paths).
            foreach (var importer in importers)
            foreach (var import in ExplicitImports(importer))
            {
                if (import.resolved != null) Add(new ReadEntry(ReadKinds.File, import.resolved, Hashing.FileBytes(import.resolved)));
                else unknownImports?.Add(Path.GetFileName(importer) + ": " + import.raw);
            }
        }
        return entries.Values.ToList();
    }

    internal static bool IsReadOnly(string path)
    {
        try { return File.Exists(path) && new FileInfo(path).IsReadOnly; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return true; }
    }

    /// <summary>
    /// Import elements of an MSBuild file. Paths using only $(MSBuildThisFileDirectory) / $(MSBuildProjectDirectory)
    /// are resolved; other properties, wildcards and conditions are reported as unresolved (raw text).
    /// </summary>
    public static List<(string raw, string? resolved)> ExplicitImports(string msbuildFile)
    {
        var result = new List<(string, string?)>();
        try
        {
            var xml = System.Xml.Linq.XDocument.Load(msbuildFile);
            var dir = Path.GetDirectoryName(msbuildFile)!;
            foreach (var el in xml.Descendants().Where(e => e.Name.LocalName == "Import"))
            {
                var raw = (string?)el.Attribute("Project");
                if (string.IsNullOrWhiteSpace(raw)) continue;
                if (el.Attribute("Sdk") != null) continue; // SDK imports belong to the SDK identity (global.json)
                var p = raw.Replace("$(MSBuildThisFileDirectory)", dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                    .Replace("$(MSBuildProjectDirectory)", dir, StringComparison.OrdinalIgnoreCase);
                if (p.Contains("$(") || p.Contains('*') || p.Contains('?') || p.Contains("%(") || p.Contains("@("))
                    result.Add((raw, null));
                else
                {
                    // A conditional literal import is fingerprinted too (present or absent).
                    result.Add((raw, Path.GetFullPath(Path.Combine(dir, p.Replace('\\', Path.DirectorySeparatorChar)))));
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            result.Add((Path.GetFileName(msbuildFile) + " (unreadable)", null));
        }
        return result;
    }

    /// <summary>For a project-only workspace: the parent of the project's directory (where sibling projects live).</summary>
    public static string? ProjectsRoot(string workspacePath)
    {
        var dir = Path.GetDirectoryName(workspacePath);
        return dir == null ? null : Path.GetDirectoryName(dir) ?? dir;
    }

    /// <summary>Hash of the *.csproj files (relative path + bytes) at most three levels below <paramref name="root"/>; bin/obj excluded.</summary>
    public static string ProjectFilesHash(string root)
    {
        try
        {
            var files = new List<string>();
            void Walk(string dir, int depth)
            {
                files.AddRange(Directory.EnumerateFiles(dir, "*.csproj"));
                if (depth >= 3) return;
                foreach (var d in Directory.EnumerateDirectories(dir))
                {
                    var name = Path.GetFileName(d);
                    if (name is "bin" or "obj" or "node_modules" || name.StartsWith('.')) continue;
                    Walk(d, depth + 1);
                }
            }
            Walk(root, 0);
            return Hashing.Sha256Text(string.Join("|", files.OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .Select(f => Path.GetRelativePath(root, f) + "=" + Hashing.FileBytes(f))));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "unreadable";
        }
    }

    public static string DocumentSetHash(Project project) =>
        Hashing.Sha256Text(string.Join("\n", project.Documents.Select(d => d.FilePath ?? d.Name).OrderBy(x => x, StringComparer.OrdinalIgnoreCase)));

    public static string MembershipHash(string dir)
    {
        try
        {
            var files = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(dir, f).Replace('\\', '/'))
                .Where(f => !f.StartsWith("bin/", StringComparison.OrdinalIgnoreCase) && !f.StartsWith("obj/", StringComparison.OrdinalIgnoreCase)
                    && !f.Contains("/bin/", StringComparison.OrdinalIgnoreCase) && !f.Contains("/obj/", StringComparison.OrdinalIgnoreCase))
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase);
            return Hashing.Sha256Text(string.Join("\n", files));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "unreadable";
        }
    }

    /// <summary>Recomputes every read-set fingerprint against the current snapshot and the disk.</summary>
    public static RevalidationOutcome Revalidate(RenamePlan plan, Snapshot current, CancellationToken ct)
    {
        if (current.Epoch != plan.BaseSnapshot.Epoch)
            return new RevalidationOutcome("stale", "EpochChanged", "The host restarted after the plan was prepared.");
        if (!ReferenceEquals(current.Session, plan.BaseSnapshot.Session) || current.Generation != plan.BaseSnapshot.Generation)
            return new RevalidationOutcome("stale", "WorkspaceReloaded", "The workspace was reloaded or reopened after the plan was prepared.");
        // Created files first (a precise reason): the target must still be absent (also ignoring case) and its Compile
        // membership still proven. A target that appeared also changes the membership fingerprint below.
        if (CreateFilePlanner.Revalidate(plan.FileCreates) is { } createGuard)
            return new RevalidationOutcome("stale", createGuard.code == "TargetExists" ? "TargetExists" : "FileCreateUnsafe", "Creating the file is no longer safe: " + createGuard.message);
        foreach (var entry in plan.ReadSet)
        {
            ct.ThrowIfCancellationRequested();
            string? now;
            switch (entry.Kind)
            {
                case ReadKinds.Source:
                {
                    var ids = current.Session.DocumentIdsForPath(entry.Input);
                    var doc = ids.Select(current.Solution.GetDocument).FirstOrDefault(d => d != null);
                    if (doc == null) return Stale(entry, "A source file of the affected projects is no longer in the workspace.");
                    var snapSource = doc.GetTextAsync(ct).GetAwaiter().GetResult();
                    var snapText = Hashing.Sha256Text(snapSource.ToString());
                    if (snapText != entry.Hash) return Stale(entry, "A source file of the affected projects changed.");
                    if (!current.Session.HasOverlay(entry.Input))
                    {
                        // Decoded with the encoding Roslyn detected for the snapshot: an unchanged legacy-encoded file
                        // gives the same text (and hash) as the snapshot.
                        now = TextFiles.HashText(entry.Input, snapSource.Encoding);
                        if (now != entry.Hash) return Stale(entry, "A source file of the affected projects changed on disk.");
                    }
                    break;
                }
                case ReadKinds.File:
                    now = Hashing.FileBytes(entry.Input);
                    if (now != entry.Hash) return Stale(entry, "A build input changed: " + Path.GetFileName(entry.Input));
                    break;
                case ReadKinds.Membership:
                    now = MembershipHash(entry.Input.Substring("membership:".Length));
                    if (now != entry.Hash) return Stale(entry, "Source files were added or removed in an affected project.");
                    break;
                case ReadKinds.Absent:
                    break; // checked below with the other file-rename guards (absence ignoring case)
                case ReadKinds.Projects:
                    now = ProjectFilesHash(entry.Input.Substring("projects:".Length));
                    if (now != entry.Hash) return Stale(entry, "Project files were added, removed or changed next to the opened project.");
                    break;
                case ReadKinds.Documents:
                {
                    var ctx = entry.ContextId != null ? current.Session.ContextById(entry.ContextId) : null;
                    var project = ctx?.ProjectId != null ? current.Solution.GetProject(ctx.ProjectId) : null;
                    if (project == null || DocumentSetHash(project) != entry.Hash)
                        return Stale(entry, "The document set of an affected project changed.");
                    break;
                }
            }
        }
        // File rename: the target of every file rename must still be absent and the rename still proven safe.
        if (FileRenamePlanner.Revalidate(plan.FileRenames) is { } fileGuard)
            return new RevalidationOutcome("stale", fileGuard.code == "TargetExists" ? "TargetExists" : "FileRenameUnsafe", "The file rename is no longer safe: " + fileGuard.message);
        // Safe Delete: every file to delete must still exist and be writable (its text is a Source entry of the read set).
        if (SolutionPlanBuilder.RevalidateDeletes(plan.FileDeletes) is { } deleteGuard)
            return new RevalidationOutcome("stale", "FileDeleteUnsafe", "Deleting the file is no longer safe: " + deleteGuard.message);

        // Revalidation never upgrades: a plan prepared as "limited" stays "limited", with the same limitations.
        if (plan.ValidationStatus != "valid")
            return new RevalidationOutcome("limited", "LimitedValidation",
                "The read set is unchanged, but the plan could only be partly validated. " + string.Join(" ", plan.Limitations.Where(l => l.StartsWith("MSBuild imports", StringComparison.Ordinal) || l.StartsWith("The project will not build", StringComparison.Ordinal))),
                plan.Limitations);
        return new RevalidationOutcome("valid", null, null);
    }

    private static RevalidationOutcome Stale(ReadEntry entry, string message) =>
        new("stale", "ReadSetChanged", message + " (" + Path.GetFileName(entry.Input.Replace("membership:", "").Replace("documents:", "").Replace("projects:", "")) + ")");
}

/// <summary>Bounded store of prepared plans; each plan pins its base snapshot until discarded or evicted.</summary>
public sealed class PlanStore
{
    public const int MaxPlans = 32;
    private readonly ConcurrentDictionary<string, RenamePlan> _plans = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _order = new();

    public void Add(RenamePlan plan)
    {
        plan.BaseSnapshot.Session.Pin(plan.BaseSnapshot);
        _plans[plan.PlanId] = plan;
        _order.Enqueue(plan.PlanId);
        while (_plans.Count > MaxPlans && _order.TryDequeue(out var oldest)) Remove(oldest);
    }

    public RenamePlan? Get(string planId) => _plans.TryGetValue(planId, out var p) ? p : null;

    public void Remove(string planId)
    {
        if (_plans.TryRemove(planId, out var p)) p.BaseSnapshot.Session.Unpin(p.BaseSnapshot.Id);
    }

    public void RemoveWorkspace(string workspaceId)
    {
        foreach (var p in _plans.Values.Where(p => p.WorkspaceId == workspaceId).ToList()) Remove(p.PlanId);
    }

    public int Count => _plans.Count;

    /// <summary>The projects a prepared plan proved Compile membership of <paramref name="path"/> for (a planned created file), or null.</summary>
    public IReadOnlyList<string>? CreatedFileProjects(string workspaceId, string path) =>
        _plans.Values.Where(p => p.WorkspaceId == workspaceId).SelectMany(p => p.FileCreates)
            .FirstOrDefault(c => UriPaths.PathComparer.Equals(c.Path, path))?.ProjectPaths;
}
