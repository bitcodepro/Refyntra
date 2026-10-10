using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Host.Protocol;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>Maps Roslyn and framework domain objects to protocol DTOs for one snapshot.</summary>
public sealed class Mapper
{
    private readonly Snapshot _snapshot;
    private readonly Project _fallbackProject;
    private readonly CancellationToken _ct;

    public Mapper(Snapshot snapshot, Project fallbackProject, CancellationToken ct)
    {
        _snapshot = snapshot;
        _fallbackProject = fallbackProject;
        _ct = ct;
    }

    public static PositionDto Position(LinePosition p) => new() { Line = p.Line, Character = p.Character };

    public static RangeDto Range(LinePositionSpan s) => new() { Start = Position(s.Start), End = Position(s.End) };

    public static LocationDto? Location(Location? loc)
    {
        if (loc == null || !loc.IsInSource || string.IsNullOrEmpty(loc.SourceTree?.FilePath)) return null;
        return new LocationDto { Uri = UriPaths.ToUri(loc.SourceTree!.FilePath), Range = Range(loc.GetLineSpan().Span) };
    }

    public ProvenanceDto Provenance(string providerRouteId, Project? project) => new()
    {
        Kind = "owned-semantic",
        ProviderRouteId = providerRouteId,
        SessionEpoch = _snapshot.Epoch,
        SnapshotId = _snapshot.Id,
        ProjectContextId = ContextId(project ?? _fallbackProject),
    };

    public string ContextId(Project project) =>
        _snapshot.Session.ContextFor(project.Id)?.ContextId ?? WorkspaceSession.MakeContextId(project.FilePath ?? project.Name, null);

    public SymbolRefDto Symbol(ISymbol symbol, string providerRouteId = SemanticService.ProviderRouteId)
    {
        symbol = SymbolIds.Normalize(symbol);
        var owner = SymbolFacts.OwningProject(_snapshot.Solution, symbol);
        var ctxProject = owner ?? _fallbackProject;
        var contextId = ContextId(ctxProject);
        return new SymbolRefDto
        {
            SymbolId = SymbolIds.Encode(_snapshot, symbol, contextId),
            Name = SymbolFacts.Name(symbol),
            DisplayName = SymbolFacts.DisplayName(symbol),
            Kind = SymbolFacts.Kind(symbol),
            ContainerName = SymbolFacts.ContainerName(symbol),
            ProjectName = owner?.Name,
            Location = Location(SymbolFacts.PrimaryLocation(symbol)),
            Origin = SymbolFacts.Origin(_snapshot.Solution, symbol, _ct),
            Provenance = Provenance(providerRouteId, ctxProject),
        };
    }

    public EndpointInfoDto Endpoint(EndpointFact e) => new()
    {
        HttpMethods = e.HttpMethods.ToList(),
        Route = e.Route,
        RouteIsDynamic = e.RouteIsDynamic,
        Location = Location(e.Location)!,
        Handler = e.Handler != null ? Symbol(e.Handler, SemanticService.AspNetCore.ProviderRouteId) : null,
        Kind = e.Kind,
    };

    public DiRegistrationInfoDto Registration(DiRegistrationFact r) => new()
    {
        Lifetime = r.Lifetime,
        ServiceType = Symbol(r.ServiceType, SemanticService.DependencyInjection.ProviderRouteId),
        ImplementationType = r.ImplementationType != null ? Symbol(r.ImplementationType, SemanticService.DependencyInjection.ProviderRouteId) : null,
        Form = r.Form,
        CompositionRoot = r.CompositionRoot,
        Location = Location(r.Location)!,
        ImplementationKind = r.ImplementationKind,
        Key = r.Key,
        FactoryLocation = Location(r.FactoryLocation),
    };

    public RelationDto Relation(FrameworkRelation r)
    {
        var project = r.Target.Endpoint != null ? _snapshot.Solution.GetProject(r.Target.Endpoint.ProjectId)
            : r.Target.Registration != null ? _snapshot.Solution.GetProject(r.Target.Registration.ProjectId)
            : r.Target.Location?.SourceTree != null ? _snapshot.Solution.GetDocument(r.Target.Location.SourceTree)?.Project
            : r.Target.Symbol != null ? SymbolFacts.OwningProject(_snapshot.Solution, r.Target.Symbol) : null;
        return new RelationDto
        {
            RelationKind = r.RelationKind,
            Group = r.Group,
            Target = new RelationTargetDto
            {
                Symbol = r.Target.Symbol != null ? Symbol(r.Target.Symbol, r.ProviderRouteId) : null,
                Endpoint = r.Target.Endpoint != null ? Endpoint(r.Target.Endpoint) : null,
                Registration = r.Target.Registration != null ? Registration(r.Target.Registration) : null,
                Location = Location(r.Target.Location),
                Label = r.Target.Label,
            },
            Evidence = r.Evidence.Select(e => new EvidenceDto { Description = e.Description, Location = Location(e.Location) }).ToList(),
            Confidence = r.Confidence,
            Provenance = Provenance(r.ProviderRouteId, project),
            Limitations = r.Limitations.Distinct().ToList(),
        };
    }

    public const string RestoreCommand = "refyntra.runRestore";

    /// <summary>The restore target: the solution when there is one, otherwise the project.</summary>
    public static RecoveryActionDto RestoreAction(string? solutionPath, string? projectPath) =>
        new() { Command = RestoreCommand, Title = "Run dotnet restore", Args = new List<object> { solutionPath ?? projectPath ?? "" } };

    public static List<LoadDiagnosticDto> Diagnostics(IEnumerable<LoadDiagnosticModel> d, string? solutionPath = null) =>
        d.Select(x => new LoadDiagnosticDto
        {
            Severity = x.Severity, Message = x.Message, ProjectPath = x.ProjectPath,
            RecoveryActions = x.RestoreRecommended ? new List<RecoveryActionDto> { RestoreAction(solutionPath, x.ProjectPath) } : null,
            Cause = x.Cause,
        }).ToList();
}
