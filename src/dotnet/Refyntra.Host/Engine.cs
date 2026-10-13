using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Host.Protocol;
using Refyntra.Host.Rpc;
using Refyntra.Refactorings;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>Protocol v1 method dispatch. Owns the workspace sessions and the prepared plans of this process.</summary>
public sealed class Engine : IRpcHandler, IDisposable
{
    public const int ProtocolMajor = 1;
    /// <summary>
    /// 1.2: refactor/prepare renameFile, PlannedChange kind "rename", fileRename offer, workspace/didRenameFiles.
    /// 1.3: actions csharp.moveTypeToFile / csharp.generateHandler, PlannedChange kind "create", fileCreate offer,
    /// PrepareParams.documentUri / targetFolderUri, workspace/didCreateFiles.
    /// 1.4: code/resolveFrame (stack trace navigation); action csharp.cleanup (PrepareParams.cleanup, plan.cleanup).
    /// 1.5: PrepareParams.generatedEdits ("efMigrations" | "none") and plan.efMigrations (EF Core migrations in a rename).
    /// 1.6: actions csharp.safeDelete / csharp.extractMethod / csharp.changeSignature, PrepareParams.range / signature,
    /// PlannedChange kind "delete", plan.fileDelete, code/signature, workspace/didDeleteFiles.
    /// 1.7: code/hierarchy (call and type hierarchy).
    /// 1.8: workspace/runnableProjects (Run and Debug).
    /// 1.9: code/editActions (single-document Convert / Inline / Introduce edit actions, compile-checked by Roslyn).
    /// 1.10: code/postfix (postfix templates) and code/generate (Generate: constructor, equality, ToString, properties,
    /// missing / overriding / delegating members).
    /// 1.11: code/constructorActions (constructor and DI helpers on Roslyn), actions csharp.registerDi
    /// (PrepareParams.registration) and csharp.fixAll (PrepareParams.fixAll: an edit action in a document, project or solution).
    /// 1.12: code/usages (classified usages) and the code/hierarchy directions "bases" / "containing".
    /// 1.13: code/fileStructure (File Structure: types, members, regions and inherited members of a document).
    /// 1.14: code/stepIntoTargets (Smart Step Into: the calls of the statement a debugger stopped at).
    /// </summary>
    public const int ProtocolMinor = 14;
    /// <summary>How long workspace/snapshotBarrier waits for a missing document sequence (tests shorten it).</summary>
    public TimeSpan BarrierTimeout { get; set; } = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<string, WorkspaceSession> _sessions = new(StringComparer.Ordinal);
    private readonly PlanStore _plans = new();
    private volatile bool _initialized;
    private volatile bool _shutdown;

    public string Epoch { get; } = "ep-" + Guid.NewGuid().ToString("N").Substring(0, 16);
    public bool ShutdownRequested => _shutdown;
    public PlanStore Plans => _plans;
    public WorkspaceSession? FindSession(string workspaceId) => _sessions.TryGetValue(workspaceId, out var s) ? s : null;

    public static string EngineVersion =>
        typeof(Engine).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "0.0.0";

    /// <summary>
    /// The capability catalogue (protocol-v1.md "Capability ids"): the ids of initialize.capabilities and of
    /// capability/query. Framework details (MediatR, ASP.NET Core endpoints, DI) are limitations of csharp.related.
    /// </summary>
    public static readonly string[] Capabilities = { "csharp.find", "csharp.related", "csharp.rename", "csharp.references" };

    public bool RunsInline(string method) => method is "workspace/open" or "workspace/reload" or "workspace/close" or "initialize" or "shutdown";

    private static T Params<T>(JsonElement p) =>
        p.Deserialize<T>(Json.Options) ?? throw new EngineException(ErrorCodes.InvalidParams, "InvalidParams", "Missing params.");

    public async Task<object?> HandleRequestAsync(string method, JsonElement p, string traceId, CancellationToken ct)
    {
        if (method == "initialize") return Initialize(Params<InitializeParams>(p));
        if (!_initialized)
            throw new EngineException(ErrorCodes.NotInitialized, "NotInitialized", "initialize must be the first request.");
        switch (method)
        {
            case "shutdown":
                _shutdown = true;
                foreach (var id in _sessions.Keys.ToList()) CloseWorkspace(id);
                return null;
            case "engine/status":
                return Status(_sessions.Values.FirstOrDefault());
            case "workspace/open":
                return await OpenAsync(Params<WorkspaceOpenParams>(p), ct).ConfigureAwait(false);
            case "workspace/reload":
            {
                var session = RequireSession(Params<WorkspaceParams>(p).WorkspaceId);
                // Start the load first (new generation), then drop the plans: a prepare that is still running sees the
                // new generation when it stores its plan and discards it (no plan survives a reload).
                var load = session.StartLoad(CancellationToken.None);
                _plans.RemoveWorkspace(session.WorkspaceId);
                await load.WaitAsync(ct).ConfigureAwait(false);
                return Status(session);
            }
            case "workspace/close":
                CloseWorkspace(Params<WorkspaceParams>(p).WorkspaceId);
                return null;
            case "workspace/snapshotBarrier":
            {
                var bp = Params<BarrierParams>(p);
                var session = RequireSession(bp.WorkspaceId);
                var snap = await session.BarrierAsync(bp.Sequence, BarrierTimeout, ct).ConfigureAwait(false);
                return new BarrierResult { AcknowledgedSequence = Math.Max(session.AppliedSequence, bp.Sequence), SnapshotId = snap.Id, WorkspaceRevision = session.Revision };
            }
            case "capability/query":
                return await CapabilityQueryAsync(Params<CapabilityQueryParams>(p), ct).ConfigureAwait(false);
            case "code/symbolAt":
                return await SymbolAtAsync(Params<SymbolAtParams>(p), ct).ConfigureAwait(false);
            case "code/search":
                return await SearchAsync(Params<SearchParams>(p), ct).ConfigureAwait(false);
            case "code/related":
                return await RelatedAsync(Params<RelatedParams>(p), ct).ConfigureAwait(false);
            case "code/references":
            case "code/implementations":
                return await LocationsAsync(method, Params<SymbolQueryParams>(p), ct).ConfigureAwait(false);
            case "refactor/prepare":
                return await PrepareAsync(Params<PrepareParams>(p), ct).ConfigureAwait(false);
            case "refactor/revalidate":
                return Revalidate(Params<RevalidateParams>(p), ct);
            case "code/signature":
                return await SignatureAsync(Params<SymbolQueryParams>(p), ct).ConfigureAwait(false);
            case "code/hierarchy":
                return await HierarchyAsync(Params<HierarchyParams>(p), ct).ConfigureAwait(false);
            case "code/usages":
                return await UsagesAsync(Params<UsagesParams>(p), ct).ConfigureAwait(false);
            case "code/fileStructure":
                return await FileStructureAsync(Params<FileStructureParams>(p), ct).ConfigureAwait(false);
            case "code/editActions":
                return await EditActionsAsync(Params<EditActionsParams>(p), ct).ConfigureAwait(false);
            case "code/postfix":
                return await PostfixAsync(Params<PostfixParams>(p), ct).ConfigureAwait(false);
            case "code/generate":
                return await GenerateAsync(Params<GenerateParams>(p), ct).ConfigureAwait(false);
            case "code/constructorActions":
                return await ConstructorActionsAsync(Params<ConstructorActionsParams>(p), ct).ConfigureAwait(false);
            case "code/stepIntoTargets":
                return await StepIntoTargetsAsync(Params<StepIntoTargetsParams>(p), ct).ConfigureAwait(false);
            case "workspace/runnableProjects":
                return RunnableProjects(Params<WorkspaceParams>(p));
            case "code/resolveFrame":
                return await ResolveFrameAsync(Params<ResolveFrameParams>(p), ct).ConfigureAwait(false);
            case "analysis/run":
                return await AnalysisRunAsync(Params<AnalysisRunParams>(p), ct).ConfigureAwait(false);
            default:
                throw new EngineException(ErrorCodes.MethodNotFound, "MethodNotFound", $"Unknown method {method}.");
        }
    }

    public void HandleNotification(string method, JsonElement p)
    {
        if (!_initialized) return;
        switch (method)
        {
            case "textDocument/didOpen":
            case "textDocument/didChange":
            case "textDocument/didSave":
            case "textDocument/didClose":
            {
                var e = p.Deserialize<DocumentEventParams>(Json.Options)!;
                if (!_sessions.TryGetValue(e.WorkspaceId, out var session))
                {
                    Log.Warn("overlay", "document event for unknown workspace ignored");
                    return;
                }
                var kind = method switch
                {
                    "textDocument/didOpen" => WorkspaceSession.DocumentEventKind.Open,
                    "textDocument/didChange" => WorkspaceSession.DocumentEventKind.Change,
                    "textDocument/didSave" => WorkspaceSession.DocumentEventKind.Save,
                    _ => WorkspaceSession.DocumentEventKind.Close,
                };
                string path;
                try { path = UriPaths.ToPath(e.Uri); }
                catch (ArgumentException) { Log.Warn("overlay", "non-file uri ignored"); return; }
                session.ApplyDocumentEvent(kind, path, e.Text, e.Sequence, e.WorkspaceRevision);
                break;
            }
            case "workspace/didRenameFiles":
            {
                // File rename host resync: the client renamed files (e.g. a type rename with its file). The documents keep
                // their identity and move to the new path; the project model is not reloaded (membership was proven).
                var e = p.Deserialize<DidRenameFilesParams>(Json.Options)!;
                if (!_sessions.TryGetValue(e.WorkspaceId, out var session))
                {
                    Log.Warn("overlay", "file rename for unknown workspace ignored");
                    return;
                }
                var pairs = new List<(string, string)>();
                foreach (var f in e.Files)
                {
                    try { pairs.Add((UriPaths.ToPath(f.OldUri), UriPaths.ToPath(f.NewUri))); }
                    catch (ArgumentException) { Log.Warn("overlay", "non-file uri in file rename ignored"); }
                }
                session.ApplyFileRenames(pairs, e.Sequence, e.WorkspaceRevision);
                break;
            }
            case "workspace/didCreateFiles":
            {
                // Created files host resync: the client created files of a plan (Move Type to File, Generate handler). The
                // new documents join the projects whose membership the plan proved; no reload.
                var e = p.Deserialize<DidCreateFilesParams>(Json.Options)!;
                if (!_sessions.TryGetValue(e.WorkspaceId, out var session))
                {
                    Log.Warn("overlay", "file create for unknown workspace ignored");
                    return;
                }
                var creates = new List<(string, IReadOnlyList<string>)>();
                foreach (var f in e.Files)
                {
                    string path;
                    try { path = UriPaths.ToPath(f.Uri); }
                    catch (ArgumentException) { Log.Warn("overlay", "non-file uri in file create ignored"); continue; }
                    if (_plans.CreatedFileProjects(e.WorkspaceId, path) is { } projects) creates.Add((path, projects));
                    else Log.Warn("overlay", "created file of no known plan ignored (a reload picks it up)");
                }
                session.ApplyFileCreates(creates, e.Sequence, e.WorkspaceRevision);
                break;
            }
            case "workspace/didDeleteFiles":
            {
                // Deleted files host resync (Safe Delete): the client deleted files of a plan; their documents leave the
                // snapshot (only paths that no longer exist on disk). No reload.
                var e = p.Deserialize<DidDeleteFilesParams>(Json.Options)!;
                if (!_sessions.TryGetValue(e.WorkspaceId, out var session))
                {
                    Log.Warn("overlay", "file delete for unknown workspace ignored");
                    return;
                }
                var paths = new List<string>();
                foreach (var f in e.Files)
                {
                    try { paths.Add(UriPaths.ToPath(f.Uri)); }
                    catch (ArgumentException) { Log.Warn("overlay", "non-file uri in file delete ignored"); }
                }
                session.ApplyFileDeletes(paths, e.Sequence, e.WorkspaceRevision);
                break;
            }
            case "refactor/discard":
            {
                var d = p.Deserialize<DiscardParams>(Json.Options)!;
                _plans.Remove(d.PlanId);
                break;
            }
            default:
                Log.Warn("rpc", $"unknown notification {method} ignored");
                break;
        }
    }

    // ------------------------------------------------------------------ lifecycle

    private InitializeResult Initialize(InitializeParams p)
    {
        if (p.ProtocolMajor != ProtocolMajor)
            throw new EngineException(ErrorCodes.ProtocolMismatch, "ProtocolMismatch",
                $"Protocol major {p.ProtocolMajor} is not supported; the host speaks {ProtocolMajor}.{ProtocolMinor}.",
                "Update the extension and the host to matching versions.");
        _initialized = true;
        return new InitializeResult
        {
            ProtocolMajor = ProtocolMajor,
            ProtocolMinor = ProtocolMinor,
            EngineVersion = EngineVersion,
            SessionEpoch = Epoch,
            Capabilities = Capabilities.ToList(),
            Limits = new LimitsDto { MaxMessageBytes = RpcServer.MaxMessageBytes },
        };
    }

    private async Task<EngineStatusDto> OpenAsync(WorkspaceOpenParams p, CancellationToken ct)
    {
        if (!p.Trusted)
            throw new EngineException(ErrorCodes.TrustRequired, "TrustRequired",
                "The workspace is not trusted. Loading runs MSBuild evaluation, which can execute project code.",
                "Trust the workspace, then open it again.");
        if (string.IsNullOrWhiteSpace(p.WorkspaceId) || string.IsNullOrWhiteSpace(p.Path))
            throw new EngineException(ErrorCodes.InvalidParams, "InvalidParams", "workspaceId and path are required.");
        if (!(p.Path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || p.Path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)
            || p.Path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)))
            throw new EngineException(ErrorCodes.InvalidParams, "UnsupportedPath", "path must be a .sln, .slnx or .csproj file.");
        CloseWorkspace(p.WorkspaceId);
        var session = new WorkspaceSession(p.WorkspaceId, p.Path, Epoch);
        _sessions[p.WorkspaceId] = session;
        // Synchronous up to here so document notifications that follow this request find the session.
        await session.StartLoad(CancellationToken.None).WaitAsync(ct).ConfigureAwait(false);
        if (session.State == EngineStates.Failed && session.ReasonCode == "SdkNotFound")
            throw new EngineException(ErrorCodes.SdkNotFound, "SdkNotFound", session.Message ?? "No .NET SDK was found.",
                session.Recovery ?? "Install the .NET SDK required by global.json, then reload the workspace.");
        return Status(session);
    }

    private void CloseWorkspace(string workspaceId)
    {
        if (_sessions.TryRemove(workspaceId, out var old))
        {
            _plans.RemoveWorkspace(workspaceId);
            old.Dispose();
        }
    }

    private EngineStatusDto Status(WorkspaceSession? s)
    {
        if (s == null)
            return new EngineStatusDto { State = EngineStates.NotStarted, SessionEpoch = Epoch, Sdk = new SdkDto() };
        return new EngineStatusDto
        {
            State = s.State,
            SessionEpoch = Epoch,
            Sdk = new SdkDto { Version = s.Sdk?.Version, Path = s.Sdk?.Path },
            SolutionPath = s.SolutionPath,
            Projects = s.Projects.Select(c => new ProjectContextInfoDto
            {
                ProjectContextId = c.ContextId,
                Name = c.Name,
                ProjectPath = c.ProjectPath,
                TargetFramework = c.TargetFramework,
                State = c.State,
                DocumentCount = c.DocumentCount,
                Diagnostics = Mapper.Diagnostics(c.Diagnostics, s.SolutionPath),
            }).ToList(),
            Diagnostics = Mapper.Diagnostics(s.Diagnostics, s.SolutionPath),
            ReasonCode = s.ReasonCode,
            Message = s.Message,
        };
    }

    private WorkspaceSession RequireSession(string workspaceId) =>
        _sessions.TryGetValue(workspaceId ?? "", out var s)
            ? s
            : throw new EngineException(ErrorCodes.WorkspaceNotLoaded, "WorkspaceNotLoaded", "The workspace is not open.", "Open the workspace first.");

    private Snapshot RequireSnapshot(string workspaceId, string snapshotId) => RequireSession(workspaceId).RequireCurrent(snapshotId);

    private static Project AnyProject(Snapshot s) =>
        s.Solution.Projects.FirstOrDefault() ?? throw new EngineException(ErrorCodes.WorkspaceNotLoaded, "NoProjectsLoaded", "No project is loaded.");

    private static string PathOf(string uri)
    {
        try { return UriPaths.ToPath(uri); }
        catch (ArgumentException ex) { throw new EngineException(ErrorCodes.InvalidParams, "InvalidUri", ex.Message); }
    }

    private async Task<(ISymbol symbol, Project project)?> SubjectAsync(Snapshot snap, string? symbolId, string? uri, PositionDto? position, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(symbolId)) return await SymbolIds.ResolveAsync(snap, symbolId, ct).ConfigureAwait(false);
        if (uri != null && position != null)
            return await SemanticService.SymbolAtAsync(snap, PathOf(uri), position.Line, position.Character, ct).ConfigureAwait(false);
        throw new EngineException(ErrorCodes.InvalidParams, "InvalidParams", "Either symbolId or uri and position are required.");
    }

    // ------------------------------------------------------------------ queries

    private async Task<SymbolRefDto?> SymbolAtAsync(SymbolAtParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var hit = await SemanticService.SymbolAtAsync(snap, PathOf(p.Uri), p.Position.Line, p.Position.Character, ct).ConfigureAwait(false);
        if (hit == null) return null;
        return new Mapper(snap, hit.Value.project, ct).Symbol(hit.Value.symbol);
    }

    private async Task<SearchResultDto> SearchAsync(SearchParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var f = p.Filters ?? new SearchFiltersDto();
        var model = await SemanticService.SearchAsync(snap, p.Query ?? "",
            new SearchFiltersModel(f.Type == true, f.Member == true, f.Project, f.Route, f.Method, f.Entity == true, f.Table), p.Limit, ct).ConfigureAwait(false);
        var fallback = AnyProject(snap);
        var result = new SearchResultDto { Truncated = model.Truncated, SnapshotId = snap.Id };
        foreach (var h in model.Items)
        {
            var mapper = new Mapper(snap, h.Project ?? fallback, ct);
            result.Items.Add(new SearchItemDto
            {
                Symbol = h.Symbol != null ? mapper.Symbol(h.Symbol) : null,
                Endpoint = h.Endpoint != null ? mapper.Endpoint(h.Endpoint) : null,
                Score = h.Score,
            });
        }
        return result;
    }

    private async Task<ResolveFrameResultDto> ResolveFrameAsync(ResolveFrameParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var found = await StackFrameResolver.ResolveAsync(snap, new FrameQuery(p.TypeName, p.MethodName, p.LocalFunctionName, p.MethodArity, p.ParameterTypes), ct).ConfigureAwait(false);
        var result = new ResolveFrameResultDto { SnapshotId = snap.Id };
        foreach (var c in found)
            result.Candidates.Add(new FrameCandidateDto { Symbol = new Mapper(snap, c.Project, ct).Symbol(c.Symbol), Location = Mapper.Location(c.Location)!, Confidence = c.Confidence, Reason = c.Reason });
        return result;
    }

    private async Task<RelatedResultDto> RelatedAsync(RelatedParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var subject = await SubjectAsync(snap, p.SymbolId, p.Uri, p.Position, ct).ConfigureAwait(false);
        if (subject == null)
            return new RelatedResultDto { Subject = null, Completeness = SemanticService.Completeness(snap), ScopeNotes = SemanticService.ScopeNotes(snap), ScopeDetails = SemanticService.Details(snap, Array.Empty<FrameworkScope>()), SnapshotId = snap.Id };
        var model = await SemanticService.RelatedAsync(snap, subject.Value.symbol, subject.Value.project, ct).ConfigureAwait(false);
        var mapper = new Mapper(snap, subject.Value.project, ct);
        return new RelatedResultDto
        {
            Subject = mapper.Symbol(subject.Value.symbol),
            Relations = model.Relations.Select(mapper.Relation).ToList(),
            Completeness = model.Completeness,
            ScopeNotes = model.ScopeNotes,
            ScopeDetails = model.Details,
            SnapshotId = snap.Id,
        };
    }

    private async Task<LocationsResultDto> LocationsAsync(string method, SymbolQueryParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var (symbol, _) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
        var model = method == "code/references"
            ? await SemanticService.ReferencesAsync(snap, symbol, ct).ConfigureAwait(false)
            : await SemanticService.ImplementationsAsync(snap, symbol, ct).ConfigureAwait(false);
        return new LocationsResultDto
        {
            Locations = model.Locations.Select(h =>
            {
                var l = Mapper.Location(h.Location)!;
                return new LocationWithPreviewDto { Uri = l.Uri, Range = l.Range, ProjectName = h.Project?.Name, Preview = SymbolFacts.Preview(h.Location) };
            }).ToList(),
            Completeness = model.Completeness,
            SnapshotId = snap.Id,
        };
    }

    // ------------------------------------------------------------------ capabilities

    private async Task<List<AvailabilityDto>> CapabilityQueryAsync(CapabilityQueryParams p, CancellationToken ct)
    {
        var session = RequireSession(p.WorkspaceId);
        var snap = session.RequireCurrent(p.SnapshotId);
        var list = new List<AvailabilityDto>();
        var health = new RecoveryActionDto { Command = "refyntra.showHealth", Title = "Show Refyntra health" };
        AvailabilityDto Make(string capability, string state, string? reason = null, string? message = null) => new()
        {
            CapabilityId = capability,
            ProviderRouteId = SemanticService.ProviderRouteId,
            Scope = new AvailabilityScopeDto { WorkspaceId = p.WorkspaceId, DocumentUri = p.Uri, SymbolId = p.SymbolId },
            State = state,
            ReasonCode = reason,
            Message = message,
            RequiredTrust = "workspace",
            // Every catalogue capability is answered by Roslyn from symbol identity (framework relations too: they are
            // matched by verified symbol identity and carry their own confidence, proven or likely).
            Guarantee = "owned-semantic",
        };

        var partial = session.State == EngineStates.Partial;
        AvailabilityDto Semantic(string capability)
        {
            var a = Make(capability, partial ? "limited" : "available", partial ? "PartialLoad" : null, partial ? session.Message : null);
            if (partial)
            {
                a.Limitations.AddRange(SemanticService.ScopeNotes(snap));
                if (session.Projects.Any(c => c.Diagnostics.Any(d => d.RestoreRecommended)) || session.Diagnostics.Any(d => d.RestoreRecommended))
                    a.RecoveryActions.Add(Mapper.RestoreAction(session.SolutionPath, session.Projects.FirstOrDefault(c => c.Diagnostics.Any(d => d.RestoreRecommended))?.ProjectPath));
                a.RecoveryActions.Add(health);
            }
            return a;
        }

        (ISymbol symbol, Project project)? subject = null;
        string? contextId = null;
        if (p.SymbolId != null || (p.Uri != null && p.Position != null))
        {
            subject = await SubjectAsync(snap, p.SymbolId, p.Uri, p.Position, ct).ConfigureAwait(false);
            if (subject != null) contextId = new Mapper(snap, subject.Value.project, ct).ContextId(subject.Value.project);
        }

        var find = Semantic("csharp.find");
        list.Add(find);

        var related = Semantic("csharp.related");
        related.Scope.ProjectContextId = contextId;
        var detected = new List<string>();
        foreach (var (module, name, what) in new[]
                 {
                     ((Frameworks.Abstractions.IFrameworkModule)SemanticService.MediatR, "MediatR", "request/handler and Send relations"),
                     (SemanticService.AspNetCore, "ASP.NET Core", "Minimal API endpoint relations"),
                     (SemanticService.DependencyInjection, "Microsoft.Extensions.DependencyInjection", "DI registration relations"),
                     (SemanticService.EfCore, "EF Core", "entity/DbContext/table relations"),
                 })
        {
            var facts = await SemanticService.GetFactsAsync(snap, module, ct).ConfigureAwait(false);
            var detection = module.Detection(facts);
            if (detection == null)
            {
                related.Limitations.Add($"{name} is not referenced by a loaded project: no {what}.");
                continue;
            }
            detected.Add(name);
            if (module is Frameworks.MediatR.MediatRModule && facts is Frameworks.MediatR.MediatRModule.Facts mf && !mf.VersionVerified)
                related.Limitations.Add($"MediatR version not verified ({detection}): MediatR relations have confidence likely.");
        }
        related.Limitations.Add("Framework relations are matched by verified symbol identity; each relation carries its confidence (proven, or likely for framework extension registrations and unverified versions).");
        if (!partial) related.Message = detected.Count > 0 ? "Frameworks: " + string.Join(", ", detected) : "No supported framework detected; declarations, implementations and references only.";
        list.Add(related);

        var rename = Make("csharp.rename", "unknown", "NoSymbol", "No symbol at the position.");
        rename.Limitations.Add("Preview first: the host returns a plan and never writes files.");
        var references = Make("csharp.references", "unknown", "NoSymbol", "No symbol at the position.");
        if (subject != null)
        {
            rename.Scope.ProjectContextId = contextId;
            references = Semantic("csharp.references");
            references.Scope.ProjectContextId = contextId;
            var guard = RenamePlanner.Guard(snap, subject.Value.symbol, null, ct);
            if (guard != null)
            {
                rename.State = "unavailable";
                rename.ReasonCode = guard.Value.reason;
                rename.Message = guard.Value.message;
            }
            else if (partial)
            {
                rename.State = "limited";
                rename.ReasonCode = "PartialLoad";
                rename.Message = "Some projects are not completely loaded; prepare refuses renames whose project closure is incomplete.";
                rename.RecoveryActions.Add(health);
            }
            else
            {
                rename.State = "available";
                rename.ReasonCode = null;
                rename.Message = null;
            }
        }
        list.Add(rename);
        list.Add(references);
        if (subject != null) list.AddRange(await CreateFileActionsAsync(snap, subject.Value.symbol, p.Uri, Make, ct).ConfigureAwait(false));
        list.AddRange(await CodeActionsAsync(snap, subject?.symbol, p.Uri, p.Position, Make, ct).ConfigureAwait(false));
        // Code ↔ tests: there is no supported public test integration, so running is explained, not offered.
        if (subject != null && TestNavigation.IsTestSymbol(subject.Value.symbol))
        {
            var run = Make("tests.run", "unavailable", "NoPublicTestIntegration",
                "Run test: unavailable — no supported public test integration. VS Code does not expose other extensions' test controllers, and Refyntra does not call undocumented commands; run the test from the Testing view of your test extension.");
            run.Scope.ProjectContextId = contextId;
            run.Limitations.Add("Navigation between tests and code is available in Related (group Tests).");
            list.Add(run);
        }
        return list;
    }

    /// <summary>Move Type to File / Generate handler at the subject: shown only where they apply, with the reason when unavailable.</summary>
    private static async Task<List<AvailabilityDto>> CreateFileActionsAsync(Snapshot snap, ISymbol symbol, string? uri,
        Func<string, string, string?, string?, AvailabilityDto> make, CancellationToken ct)
    {
        var list = new List<AvailabilityDto>();
        string? path = null;
        if (uri != null) { try { path = UriPaths.ToPath(uri); } catch (ArgumentException) { } }
        var move = MoveTypePlanner.Applicability(snap, symbol, path, ct);
        if (move.Show)
        {
            var a = make(MoveTypePlanner.ActionId, move.ReasonCode == null ? "available" : "unavailable", move.ReasonCode, move.Message);
            a.Limitations.Add("Preview first: the new file and the edit of this file are shown before anything is written.");
            list.Add(a);
        }
        var generate = await GenerateHandlerPlanner.AnalyzeAsync(snap, symbol, ct).ConfigureAwait(false);
        if (generate.Applicability.Show)
        {
            var a = make(GenerateHandlerPlanner.ActionId, generate.Applicability.ReasonCode == null ? "available" : "unavailable", generate.Applicability.ReasonCode, generate.Applicability.Message);
            a.Limitations.Add("No DI registration is generated (MediatR scans assemblies); Handle throws NotImplementedException until implemented.");
            list.Add(a);
        }
        return list;
    }

    /// <summary>
    /// Safe Delete and Change Signature at the subject (shown only for symbol kinds they apply to, with the reason when
    /// unavailable); Extract Method inside a member body (it works on the editor selection).
    /// </summary>
    private static async Task<List<AvailabilityDto>> CodeActionsAsync(Snapshot snap, ISymbol? symbol, string? uri, PositionDto? position,
        Func<string, string, string?, string?, AvailabilityDto> make, CancellationToken ct)
    {
        var list = new List<AvailabilityDto>();
        if (symbol != null && symbol.Kind is not (SymbolKind.Namespace or SymbolKind.TypeParameter or SymbolKind.Alias or SymbolKind.Label or SymbolKind.RangeVariable or SymbolKind.Discard)
            && symbol.Locations.Any(l => l.IsInSource))
        {
            var g = SafeDeletePlanner.Guard(snap, symbol, ct);
            var a = make(SafeDeletePlanner.ActionId, g == null ? "available" : "unavailable", g?.reason, g?.message);
            a.Limitations.Add("Preview first: deletes only when nothing else uses the symbol; otherwise the uses are listed.");
            list.Add(a);
        }
        if (symbol is IMethodSymbol)
        {
            var g = ChangeSignaturePlanner.Guard(snap, symbol, ct);
            var a = make(ChangeSignaturePlanner.ActionId, g == null ? "available" : "unavailable", g?.reason, g?.message);
            a.Limitations.Add("Preview first: the method, its overrides/implementations and every call site found by the compiler are updated.");
            list.Add(a);
        }
        if (uri != null && position != null)
        {
            string? path = null;
            try { path = UriPaths.ToPath(uri); } catch (ArgumentException) { }
            if (path != null && await ExtractMethodPlanner.InsideBodyAsync(snap, path, position.Line, position.Character, ct).ConfigureAwait(false))
            {
                var a = make(ExtractMethodPlanner.ActionId, "available", null, "Select statements or an expression first.");
                a.Limitations.Add("Preview first: works on the editor selection; refuses selections it cannot extract without changing behavior.");
                list.Add(a);
            }
        }
        return list;
    }

    /// <summary>workspace/runnableProjects (protocol 1.8): the loaded projects classified for Run and Debug.</summary>
    private RunnableProjectsResultDto RunnableProjects(WorkspaceParams p)
    {
        var session = RequireSession(p.WorkspaceId);
        var snap = session.Current;
        if (snap == null) return new RunnableProjectsResultDto { Projects = new(), State = session.State };
        var list = RunnableProjectDetector.Detect(snap.Solution);
        return new RunnableProjectsResultDto
        {
            State = session.State,
            SnapshotId = snap.Id,
            Projects = list.Select(r => new RunnableProjectDto
            {
                Name = r.Name,
                ProjectUri = UriPaths.ToUri(r.ProjectPath),
                Kind = r.Kind,
                Runnable = r.Runnable,
                Reason = r.Reason,
                WindowsOnly = r.WindowsOnly,
                TargetFrameworks = r.TargetFrameworks.ToList(),
                Outputs = r.Outputs.Where(o => o.OutputPath != null).Select(o => new RunnableOutputDto { TargetFramework = o.Tfm, OutputUri = UriPaths.ToUri(o.OutputPath!) }).ToList(),
                AssemblyName = r.AssemblyName,
                LaunchSettingsUri = r.LaunchSettingsPath == null ? null : UriPaths.ToUri(r.LaunchSettingsPath),
            }).ToList(),
        };
    }

    private async Task<FileStructureResultDto> FileStructureAsync(FileStructureParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var result = new FileStructureResultDto { SnapshotId = snap.Id, Completeness = SemanticService.Completeness(snap) };
        var doc = snap.Session.DocumentIdsForPath(PathOf(p.Uri)).Select(snap.Solution.GetDocument).FirstOrDefault(d => d != null);
        var model = doc == null ? null : await FileStructure.ComputeAsync(doc, p.IncludeInherited, ct).ConfigureAwait(false);
        if (model == null)
        {
            result.ReasonCode = "DocumentNotFound";
            return result;
        }
        StructureMemberDto Member(StructureMember m) => new()
        {
            Name = m.Name, Kind = m.Kind, Accessibility = m.Accessibility, IsStatic = m.IsStatic, Signature = m.Signature,
            Range = ToRange(m.Range), SelectionRange = ToRange(m.SelectionRange), Region = m.Region, DeclaringType = m.DeclaringType,
            Uri = m.DeclaringType == null ? null : m.FilePath is { } f ? UriPaths.ToUri(f) : null, Navigable = m.Navigable,
        };
        result.Types = model.Types.Select(t => new StructureTypeDto
        {
            Name = t.Name, FullName = t.FullName, Kind = t.Kind, Accessibility = t.Accessibility, IsStatic = t.IsStatic, Signature = t.Signature,
            Range = ToRange(t.Range), SelectionRange = ToRange(t.SelectionRange), Region = t.Region, ContainingType = t.ContainingType,
            Members = t.Members.Select(Member).ToList(), Inherited = t.Inherited.Select(Member).ToList(),
        }).ToList();
        result.Regions = model.Regions.Select(r => new StructureRegionDto { Name = r.Name, Range = ToRange(r.Range) }).ToList();
        return result;
    }

    private async Task<StepIntoTargetsResultDto> StepIntoTargetsAsync(StepIntoTargetsParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var result = new StepIntoTargetsResultDto { SnapshotId = snap.Id };
        var doc = snap.Session.DocumentIdsForPath(PathOf(p.Uri)).Select(snap.Solution.GetDocument).FirstOrDefault(d => d != null);
        if (doc == null)
        {
            result.ReasonCode = "DocumentNotFound";
            return result;
        }
        var model = await StepIntoTargets.ComputeAsync(doc, new Microsoft.CodeAnalysis.Text.LinePosition(p.Position.Line, p.Position.Character), ct).ConfigureAwait(false);
        if (model == null)
        {
            result.ReasonCode = "NoStatement";
            return result;
        }
        result.Statement = ToRange(model.Statement);
        result.NextStatement = model.NextStatement is { } n ? new PositionDto { Line = n.Line, Character = n.Character } : null;
        result.Targets = model.Targets.Select(t => new StepIntoTargetDto
        {
            Label = t.Label, Detail = t.Detail, Kind = t.Kind, CallRange = ToRange(t.CallSpan), Reason = t.Reason, IsVirtual = t.IsVirtual,
            BreakAt = t.BreakAt is { } b && t.FilePath != null
                ? new LocationDto { Uri = UriPaths.ToUri(t.FilePath), Range = new RangeDto { Start = new PositionDto { Line = b.Line, Character = b.Character }, End = new PositionDto { Line = b.Line, Character = b.Character } } }
                : null,
        }).ToList();
        return result;
    }

    private async Task<EditActionsResultDto> EditActionsAsync(EditActionsParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var path = PathOf(p.Uri);
        var range = new Microsoft.CodeAnalysis.Text.LinePositionSpan(new(p.Range.Start.Line, p.Range.Start.Character), new(p.Range.End.Line, p.Range.End.Character));
        var result = new EditActionsResultDto { SnapshotId = snap.Id };
        if (string.IsNullOrEmpty(p.ActionId))
        {
            foreach (var a in await EditActionsPlanner.ListAsync(snap, path, range, ct).ConfigureAwait(false))
                result.Items.Add(new EditActionDto { ActionId = a.ActionId, Title = a.Title, Kind = a.Kind });
            return result;
        }
        var outcome = await EditActionsPlanner.ComputeAsync(snap, path, range, p.ActionId, ct).ConfigureAwait(false);
        result.ReasonCode = outcome.ReasonCode;
        result.Message = outcome.Message;
        result.DocumentHash = outcome.DocumentHash;
        result.Edits = outcome.Edits?.Select(e => new TextEditDto
        {
            Range = new RangeDto { Start = new PositionDto { Line = e.Range.Start.Line, Character = e.Range.Start.Character }, End = new PositionDto { Line = e.Range.End.Line, Character = e.Range.End.Character } },
            NewText = e.NewText,
        }).ToList();
        return result;
    }

    private static RangeDto ToRange(Microsoft.CodeAnalysis.Text.LinePositionSpan r) =>
        new() { Start = new PositionDto { Line = r.Start.Line, Character = r.Start.Character }, End = new PositionDto { Line = r.End.Line, Character = r.End.Character } };

    private async Task<PostfixResultDto> PostfixAsync(PostfixParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var outcome = await PostfixPlanner.ListAsync(snap, PathOf(p.Uri), new(p.Position.Line, p.Position.Character), ct).ConfigureAwait(false);
        return new PostfixResultDto
        {
            SnapshotId = snap.Id,
            TypeName = outcome.TypeName,
            ExpressionRange = outcome.ExpressionRange is { } r ? ToRange(r) : null,
            Items = outcome.Items.Select(i => new PostfixTemplateDto { Name = i.Name, Detail = i.Detail, Snippet = i.Snippet }).ToList(),
        };
    }

    private async Task<GenerateResultDto> GenerateAsync(GenerateParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var path = PathOf(p.Uri);
        var position = new Microsoft.CodeAnalysis.Text.LinePosition(p.Position.Line, p.Position.Character);
        var result = new GenerateResultDto { SnapshotId = snap.Id };
        if (string.IsNullOrEmpty(p.Kind))
        {
            var (typeName, kinds) = await GeneratePlanner.ListAsync(snap, path, position, ct).ConfigureAwait(false);
            result.TypeName = typeName;
            result.Kinds = kinds.Select(k => new GenerateKindDto
            {
                Kind = k.Kind, Title = k.Title,
                Members = k.Members.Select(m => new GenerateMemberDto { Id = m.Id, Name = m.Name, Detail = m.Detail, Picked = m.Picked, Group = m.Group }).ToList(),
            }).ToList();
            return result;
        }
        var outcome = await GeneratePlanner.ComputeAsync(snap, path, position, p.Kind, new GenerateOptions(p.Members, p.Equatable, p.Operators), ct).ConfigureAwait(false);
        result.ReasonCode = outcome.ReasonCode;
        result.Message = outcome.Message;
        result.DocumentHash = outcome.DocumentHash;
        result.Edits = outcome.Edits?.Select(e => new TextEditDto { Range = ToRange(e.Range), NewText = e.NewText }).ToList();
        return result;
    }

    private static ChoiceDto Choice(CtorChoice c) => new() { Id = c.Id, Label = c.Label, Detail = c.Detail, Picked = c.Picked };

    private async Task<ConstructorActionsResultDto> ConstructorActionsAsync(ConstructorActionsParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var path = PathOf(p.Uri);
        var position = new Microsoft.CodeAnalysis.Text.LinePosition(p.Position.Line, p.Position.Character);
        var result = new ConstructorActionsResultDto { SnapshotId = snap.Id };
        if (string.IsNullOrEmpty(p.ActionId))
        {
            foreach (var a in await ConstructorPlanner.ListAsync(snap, path, position, ct).ConfigureAwait(false))
                result.Items.Add(new ConstructorActionDto { ActionId = a.ActionId, Title = a.Title, Kind = a.Kind, Preferred = a.Preferred, Member = a.Member, Members = a.Members?.ToList(), TypeId = a.TypeId });
            return result;
        }
        if (p.ActionId == ConstructorPlanner.RegisterDi)
        {
            var info = await DiRegistrationPlanner.DescribeAsync(snap, path, position, p.TypeId, ct).ConfigureAwait(false);
            result.ReasonCode = info.ReasonCode;
            result.Message = info.Message;
            if (info.ReasonCode == null)
                result.Registration = new RegistrationInfoDto
                {
                    Service = info.Service, ServiceId = info.ServiceId, Lifetimes = DiRegistrationPlanner.Lifetimes.ToList(),
                    Implementations = info.Implementations.Select(Choice).ToList(), Roots = info.Roots.Select(Choice).ToList(),
                };
            return result;
        }
        var outcome = await ConstructorPlanner.ComputeAsync(snap, path, position, new CtorRequest(p.ActionId, p.Member, p.Members, p.Type, p.ConstructorId), ct).ConfigureAwait(false);
        result.ReasonCode = outcome.ReasonCode;
        result.Message = outcome.Message;
        result.Need = outcome.Need;
        result.Choices = outcome.Choices?.Select(Choice).ToList();
        result.Note = outcome.Note;
        result.RegisterTypeId = outcome.RegisterTypeId;
        result.RegisterTypeName = outcome.RegisterTypeName;
        result.Files = outcome.Files?.Select(f => new DocumentEditsDto
        {
            Uri = UriPaths.ToUri(f.Path), DocumentHash = f.DocumentHash,
            Edits = f.Edits.Select(e => new TextEditDto { Range = ToRange(e.Range), NewText = e.NewText }).ToList(),
        }).ToList();
        return result;
    }

    private async Task<HierarchyResultDto> HierarchyAsync(HierarchyParams p, CancellationToken ct)
    {
        if (Array.IndexOf(HierarchyService.Directions, p.Direction) < 0)
            throw new EngineException(ErrorCodes.InvalidParams, "InvalidParams", "direction must be incoming, outgoing, supertypes, subtypes, bases or containing.");
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var (symbol, project) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
        var model = await HierarchyService.QueryAsync(snap, symbol, p.Direction, ct).ConfigureAwait(false);
        var mapper = new Mapper(snap, project, ct);
        return new HierarchyResultDto
        {
            Items = model.Items.Select(h =>
            {
                var ranges = h.FromLocations.Select(Mapper.Location).Where(l => l != null).ToList();
                return new HierarchyItemDto { Symbol = mapper.Symbol(h.Symbol), FromRanges = ranges.Select(l => l!.Range).ToList(), FromUri = ranges.FirstOrDefault()?.Uri };
            }).ToList(),
            Completeness = model.Completeness,
            Truncated = model.Truncated,
            SnapshotId = snap.Id,
        };
    }

    private async Task<UsagesResultDto> UsagesAsync(UsagesParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var (symbol, project) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
        var model = await UsageClassifier.FindAsync(snap, symbol, p.Limit, ct).ConfigureAwait(false);
        var mapper = new Mapper(snap, project, ct);
        return new UsagesResultDto
        {
            Subject = mapper.Symbol(symbol),
            Items = model.Items.Select(u => new UsageItemDto
            {
                Uri = UriPaths.ToUri(u.Location.SourceTree!.FilePath), Range = Mapper.Range(u.Span), Kind = u.Kind,
                ContainingMember = u.ContainingMember, ContainingType = u.ContainingType, ProjectName = u.Project.Name, IsTest = u.IsTest, LineText = u.LineText,
            }).ToList(),
            Total = model.Total,
            Truncated = model.Truncated,
            Completeness = model.Completeness,
            SnapshotId = snap.Id,
        };
    }

    private async Task<SignatureInfoDto> SignatureAsync(SymbolQueryParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var (symbol, _) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
        var info = await ChangeSignaturePlanner.DescribeAsync(snap, symbol, ct).ConfigureAwait(false);
        return new SignatureInfoDto
        {
            Name = info.Name,
            Display = info.Display,
            Parameters = info.Parameters.Select(x => new SignatureParameterDto { Name = x.Name, Type = x.Type, DefaultValue = x.DefaultValue, Modifiers = x.Modifiers }).ToList(),
            ReasonCode = info.ReasonCode,
            Message = info.Message,
            SnapshotId = snap.Id,
        };
    }

    // ------------------------------------------------------------------ analysis

    public const string Or1001HelpUri = "https://github.com/refyntra/refyntra/blob/main/docs/rules/OR1001.md";

    private async Task<AnalysisRunResultDto> AnalysisRunAsync(AnalysisRunParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var filter = p.Uri != null ? PathOf(p.Uri) : null;
        bool Keep(Location? l) => filter == null || (l?.SourceTree?.FilePath is { } f && string.Equals(Path.GetFullPath(f), Path.GetFullPath(filter), StringComparison.OrdinalIgnoreCase));
        var model = await Semantics.Rules.Or1001Rule.RunAsync(snap, ct).ConfigureAwait(false);
        var result = new AnalysisRunResultDto { Completeness = model.Completeness, SnapshotId = snap.Id };
        foreach (var d in model.Diagnostics.Where(d => Keep(d.Location)))
        {
            var loc = Mapper.Location(d.Location);
            if (loc == null) continue;
            var evidence = d.Evidence.Select(e => new EvidenceDto { Description = e.Description, Location = Mapper.Location(e.Location) }).ToList();
            result.Diagnostics.Add(new RuleDiagnosticDto
            {
                Id = d.Id,
                Severity = "warning",
                Message = d.Message,
                Location = loc,
                RelatedLocations = evidence.Where(e => e.Location != null).Select(e => new RelatedLocationDto { Location = e.Location!, Message = e.Description }).ToList(),
                Evidence = evidence,
                Confidence = d.Confidence,
                Completeness = d.Completeness,
                CompositionRoot = d.CompositionRoot,
                HelpUri = Or1001HelpUri,
            });
        }
        foreach (var a in model.Abstentions.Where(a => Keep(a.Location)))
            result.Abstentions.Add(new RuleAbstentionDto { RuleId = Semantics.Rules.Or1001Rule.Id, Reason = a.Reason, Message = a.Message, Location = Mapper.Location(a.Location), CompositionRoot = a.CompositionRoot });
        return result;
    }

    // ------------------------------------------------------------------ refactoring

    private async Task<PrepareResultDto> PrepareAsync(PrepareParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        if (p.ActionId is not ("csharp.rename" or MoveTypePlanner.ActionId or GenerateHandlerPlanner.ActionId or Refactorings.Cleanup.CleanupPlanner.ActionId
            or SafeDeletePlanner.ActionId or ExtractMethodPlanner.ActionId or ChangeSignaturePlanner.ActionId or EditActionsPlanner.IntroduceParameterAction
            or DiRegistrationPlanner.ActionId or EditActionsPlanner.FixAllAction))
            return new PrepareResultDto { Kind = "unavailable", ReasonCode = "UnsupportedAction", Message = $"Action {p.ActionId} is not supported." };
        RenameOutcome outcome;
        if (p.ActionId == Refactorings.Cleanup.CleanupPlanner.ActionId)
        {
            // Code Cleanup (1.4): no symbol; the scope (files, folders, projects) and the fix ids come in params.cleanup.
            outcome = await Refactorings.Cleanup.CleanupPlanner.PrepareAsync(snap, (p.Cleanup?.ScopeUris ?? new()).Select(PathOf).ToList(), p.Cleanup?.Fixes, ct).ConfigureAwait(false);
        }
        else if (p.ActionId == ExtractMethodPlanner.ActionId)
        {
            // Extract Method (1.6): no symbol; the selection comes in documentUri + range, the name in newName.
            if (p.DocumentUri == null || p.Range == null)
                return new PrepareResultDto { Kind = "unavailable", ReasonCode = "InvalidParams", Message = "Extract Method needs documentUri and range." };
            outcome = await ExtractMethodPlanner.PrepareAsync(snap, PathOf(p.DocumentUri), p.Range.Start.Line, p.Range.Start.Character, p.Range.End.Line, p.Range.End.Character, p.NewName ?? "", ct).ConfigureAwait(false);
        }
        else if (p.ActionId == EditActionsPlanner.IntroduceParameterAction)
        {
            // Introduce Parameter (1.10, additive action id): the selected expression comes in documentUri + range.
            if (p.DocumentUri == null || p.Range == null)
                return new PrepareResultDto { Kind = "unavailable", ReasonCode = "InvalidParams", Message = "Introduce Parameter needs documentUri and range." };
            outcome = await EditActionsPlanner.PrepareIntroduceParameterAsync(snap, PathOf(p.DocumentUri),
                new Microsoft.CodeAnalysis.Text.LinePositionSpan(new(p.Range.Start.Line, p.Range.Start.Character), new(p.Range.End.Line, p.Range.End.Character)), ct).ConfigureAwait(false);
        }
        else if (p.ActionId == DiRegistrationPlanner.ActionId)
        {
            // Register in DI (1.11): the service at documentUri + range.start (or registration.typeId).
            if (p.DocumentUri == null || p.Registration == null)
                return new PrepareResultDto { Kind = "unavailable", ReasonCode = "InvalidParams", Message = "Register in DI needs documentUri and registration." };
            var at = p.Range?.Start ?? new PositionDto();
            outcome = await DiRegistrationPlanner.PrepareAsync(snap, PathOf(p.DocumentUri), new(at.Line, at.Character), p.Registration.TypeId, p.Registration.Lifetime,
                p.Registration.ImplementationId, p.Registration.RootId, ct).ConfigureAwait(false);
        }
        else if (p.ActionId == EditActionsPlanner.FixAllAction)
        {
            // Fix in scope (1.11): one edit action in the document, its project or the solution.
            if (p.DocumentUri == null || p.FixAll == null)
                return new PrepareResultDto { Kind = "unavailable", ReasonCode = "InvalidParams", Message = "Fix in scope needs documentUri and fixAll." };
            outcome = await EditActionsPlanner.PrepareFixAllAsync(snap, PathOf(p.DocumentUri), p.FixAll.ActionId, p.FixAll.Scope, ct).ConfigureAwait(false);
        }
        else
        {
            var (symbol, _) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
            outcome = p.ActionId switch
            {
                MoveTypePlanner.ActionId => await MoveTypePlanner.PrepareAsync(snap, symbol, p.DocumentUri != null ? PathOf(p.DocumentUri) : null, ct).ConfigureAwait(false),
                GenerateHandlerPlanner.ActionId => await GenerateHandlerPlanner.PrepareAsync(snap, symbol, p.TargetFolderUri != null ? PathOf(p.TargetFolderUri) : null, ct).ConfigureAwait(false),
                SafeDeletePlanner.ActionId => await SafeDeletePlanner.PrepareAsync(snap, symbol, ct).ConfigureAwait(false),
                ChangeSignaturePlanner.ActionId => await ChangeSignaturePlanner.PrepareAsync(snap, symbol,
                    p.Signature?.Parameters.Select(x => new ParameterSpec(x.From, x.Name, x.Type, x.DefaultValue, x.CallSiteValue)).ToList(), ct).ConfigureAwait(false),
                _ => await RenamePlanner.PrepareAsync(snap, symbol, p.NewName ?? "", ct, p.RenameFile, p.GeneratedEdits).ConfigureAwait(false),
            };
        }
        if (outcome.Plan == null)
            return new PrepareResultDto { Kind = "unavailable", ReasonCode = outcome.ReasonCode, Message = outcome.Message };
        ct.ThrowIfCancellationRequested();
        var plan = outcome.Plan;
        _plans.Add(plan);
        // A reload (or close/reopen) that started while this prepare was running makes the plan unusable: the snapshot
        // belongs to the previous load. Checked after Add so that it cannot race with the reload's RemoveWorkspace.
        if (snap.Generation != snap.Session.LoadGeneration || snap.Session.IsDisposed
            || !_sessions.TryGetValue(p.WorkspaceId, out var live) || !ReferenceEquals(live, snap.Session))
        {
            _plans.Remove(plan.PlanId);
            return new PrepareResultDto { Kind = "unavailable", ReasonCode = "WorkspaceReloaded", Message = "The workspace was reloaded while the plan was prepared. Prepare it again." };
        }
        return new PrepareResultDto
        {
            Kind = "prepared",
            Plan = new RefactorPlanDto
            {
                PlanId = plan.PlanId,
                ActionId = plan.ActionId,
                ProviderRouteId = SemanticService.ProviderRouteId,
                ProtocolMajor = ProtocolMajor,
                WorkspaceId = plan.WorkspaceId,
                Kind = "owned-semantic",
                SessionEpoch = snap.Epoch,
                BaseWorkspaceRevision = snap.Revision,
                BaseSnapshotId = snap.Id,
                ProjectContextIds = plan.ProjectContextIds.ToList(),
                // Created files come first (1.3; ADR-004 Amendment 2 explains the order), then text, then file renames.
                WriteSet = plan.FileCreates.Select(c => (object)new PlannedFileCreateDto { Uri = UriPaths.ToUri(c.Path), ResultHash = c.ResultHash, Text = c.Text })
                    .Concat(plan.Changes.Select(c => new PlannedTextChangeDto
                {
                    Kind = "text",
                    Uri = UriPaths.ToUri(c.Path),
                    ExpectedHash = c.ExpectedHash,
                    ResultHash = c.ResultHash,
                    Edits = c.Edits.Select(e => new TextEditDto { Range = Mapper.Range(e.Range), NewText = e.NewText }).ToList(),
                }))
                    // File rename: resource operations follow every text change (applied after them).
                    .Concat(plan.FileRenames.Select(r => new PlannedFileRenameDto { OldUri = UriPaths.ToUri(r.OldPath), NewUri = UriPaths.ToUri(r.NewPath), ResultHash = r.ResultHash }))
                    // Deleted files (1.6): last, after every text change and file rename.
                    .Concat(plan.FileDeletes.Select(d => new PlannedFileDeleteDto { Uri = UriPaths.ToUri(d.Path), ExpectedHash = d.ExpectedHash }))
                    .ToList(),
                FileDelete = plan.FileDeletes.Count == 0 ? null : new FileDeleteOfferDto { Files = plan.FileDeletes.Select(d => UriPaths.ToUri(d.Path)).ToList() },
                FileRename = plan.FileRenameOffer is { } offer
                    ? new FileRenameOfferDto
                    {
                        Files = offer.Files.Select(f => new FileRenamePairDto { OldUri = UriPaths.ToUri(f.OldPath), NewUri = UriPaths.ToUri(f.NewPath) }).ToList(),
                        Available = offer.Available,
                        Included = offer.Included,
                        ReasonCode = offer.ReasonCode,
                        Message = offer.Message,
                    }
                    : null,
                FileCreate = plan.FileCreates.Count == 0 ? null : new FileCreateOfferDto
                {
                    Files = plan.FileCreates.Select(c => UriPaths.ToUri(c.Path)).ToList(),
                    FolderChoices = plan.CreateFileOffer?.Folders.Select(f => new FolderChoiceDto { FolderUri = UriPaths.ToUri(f.Folder), ProjectName = f.ProjectName, HandlerCount = f.HandlerCount, Namespace = f.Namespace }).ToList(),
                    SelectedFolderUri = plan.CreateFileOffer is { } co ? UriPaths.ToUri(co.SelectedFolder) : null,
                },
                ReadSet = plan.ReadSet.Select(r => new InputFingerprintDto { Input = r.Input, Hash = r.Hash }).ToList(),
                Evidence = plan.Evidence.Select(e => new EvidenceDto { Description = e.description, Location = Mapper.Location(e.location) }).ToList(),
                Limitations = plan.Limitations.ToList(),
                Validation = new PlanValidationDto
                {
                    Status = plan.ValidationStatus,
                    CheckedContexts = plan.CheckedContexts.ToList(),
                    UncheckedContexts = plan.UncheckedContexts.ToList(),
                    CompilationDelta = plan.CompilationDelta,
                },
                Title = plan.Title,
                Cleanup = plan.Cleanup is { } cr ? CleanupReportDto.From(cr) : null,
                EfMigrations = plan.EfMigrations is { } ef ? new EfMigrationsOfferDto { Mode = ef.Mode, Files = ef.Files.Select(UriPaths.ToUri).ToList() } : null,
            },
        };
    }

    private RevalidateResultDto Revalidate(RevalidateParams p, CancellationToken ct)
    {
        var plan = _plans.Get(p.PlanId);
        if (plan == null || plan.WorkspaceId != p.WorkspaceId)
            return new RevalidateResultDto { Status = "invalid", ReasonCode = "UnknownPlan", Message = "The plan does not exist (discarded, evicted or from another session)." };
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var outcome = RenamePlanner.Revalidate(plan, snap, ct);
        return new RevalidateResultDto { Status = outcome.Status, ReasonCode = outcome.ReasonCode, Message = outcome.Message, Limitations = outcome.Limitations?.ToList() };
    }

    public void Dispose()
    {
        foreach (var id in _sessions.Keys.ToList()) CloseWorkspace(id);
    }
}
