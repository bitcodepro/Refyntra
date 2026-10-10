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
    /// <summary>1.2: refactor/prepare renameFile, PlannedChange kind "rename", fileRename offer, workspace/didRenameFiles.</summary>
    public const int ProtocolMinor = 2;
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
            new SearchFiltersModel(f.Type == true, f.Member == true, f.Project, f.Route, f.Method), p.Limit, ct).ConfigureAwait(false);
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
        if (p.ActionId != "csharp.rename")
            return new PrepareResultDto { Kind = "unavailable", ReasonCode = "UnsupportedAction", Message = $"Action {p.ActionId} is not supported." };
        var (symbol, project) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
        var outcome = await RenamePlanner.PrepareAsync(snap, symbol, p.NewName ?? "", ct, p.RenameFile).ConfigureAwait(false);
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
            return new PrepareResultDto { Kind = "unavailable", ReasonCode = "WorkspaceReloaded", Message = "The workspace was reloaded while the rename was prepared. Prepare it again." };
        }
        var mapper = new Mapper(snap, project, ct);
        return new PrepareResultDto
        {
            Kind = "prepared",
            Plan = new RefactorPlanDto
            {
                PlanId = plan.PlanId,
                ActionId = "csharp.rename",
                ProviderRouteId = SemanticService.ProviderRouteId,
                ProtocolMajor = ProtocolMajor,
                WorkspaceId = plan.WorkspaceId,
                Kind = "owned-semantic",
                SessionEpoch = snap.Epoch,
                BaseWorkspaceRevision = snap.Revision,
                BaseSnapshotId = snap.Id,
                ProjectContextIds = plan.ProjectContextIds.ToList(),
                WriteSet = plan.Changes.Select(c => new PlannedTextChangeDto
                {
                    Kind = "text",
                    Uri = UriPaths.ToUri(c.Path),
                    ExpectedHash = c.ExpectedHash,
                    ResultHash = c.ResultHash,
                    Edits = c.Edits.Select(e => new TextEditDto { Range = Mapper.Range(e.Range), NewText = e.NewText }).ToList(),
                }).Cast<object>()
                    // File rename: resource operations follow every text change (applied after them).
                    .Concat(plan.FileRenames.Select(r => new PlannedFileRenameDto { OldUri = UriPaths.ToUri(r.OldPath), NewUri = UriPaths.ToUri(r.NewPath), ResultHash = r.ResultHash }))
                    .ToList(),
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
