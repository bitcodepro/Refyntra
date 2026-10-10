using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Frameworks.Abstractions;

public static class RelationKinds
{
    public const string Declaration = "declaration", MediatRHandler = "mediatr.handler", MediatRRequest = "mediatr.request",
        MediatRResponse = "mediatr.response", MediatRSend = "mediatr.send", MediatRNotificationHandler = "mediatr.notificationHandler",
        MediatRBehavior = "mediatr.behavior", DiOpenGenericUsage = "di.openGenericUsage",
        AspNetEndpoint = "aspnet.endpoint", DiRegistration = "di.registration", DiImplementation = "di.implementation",
        DiService = "di.service", Implementation = "implementation", Reference = "reference", Test = "test";

    // EF Core (group "data", queries in "callers").
    public const string EfCoreEntity = "efcore.entity", EfCoreDbContext = "efcore.dbContext", EfCoreConfiguration = "efcore.configuration",
        EfCoreNavigation = "efcore.navigation", EfCoreTable = "efcore.table", EfCoreQuery = "efcore.query", EfCoreMigration = "efcore.migration";
}

public static class RelationGroups
{
    public const string Declarations = "declarations", Handlers = "handlers", Callers = "callers", Endpoints = "endpoints",
        Registrations = "registrations", Implementations = "implementations", References = "references", Tests = "tests",
        Data = "data";

    public static readonly string[] Order = { Declarations, Handlers, Callers, Endpoints, Data, Registrations, Implementations, References, Tests };
    public static int IndexOf(string group) { var i = Array.IndexOf(Order, group); return i < 0 ? Order.Length : i; }
}

public static class Confidences
{
    public const string Proven = "proven", Likely = "likely", Heuristic = "heuristic";
}

public sealed record EvidenceItem(string Description, Location? Location = null);

/// <summary>A Minimal API endpoint found in source.</summary>
public sealed record EndpointFact(
    IReadOnlyList<string> HttpMethods,
    string Route,
    bool RouteIsDynamic,
    Location Location,
    IMethodSymbol? Handler,
    SyntaxTree Tree,
    TextSpan HandlerSpan,
    string CompositionRoot,
    ProjectId ProjectId,
    IReadOnlyList<string> Limitations,
    string Kind = "minimal-api",
    INamedTypeSymbol? Controller = null,
    string Confidence = Confidences.Proven);

/// <summary>An explicit Microsoft DI registration found in source.</summary>
public sealed record DiRegistrationFact(
    string Lifetime,
    ITypeSymbol ServiceType,
    ITypeSymbol? ImplementationType,
    string Form,
    string CompositionRoot,
    Location Location,
    int Order,
    ProjectId ProjectId,
    IReadOnlyList<string> Limitations,
    string Confidence = Confidences.Proven,
    IReadOnlySet<string>? Traits = null,
    string? Key = null,
    Location? FactoryLocation = null)
{
    /// <summary>"type", "factory" or "instance".</summary>
    public string ImplementationKind => Has(DiTraits.Factory) ? "factory" : Has(DiTraits.Instance) ? "instance" : "type";

    public bool Has(string trait) => Traits?.Contains(trait) == true;
}

/// <summary>Structured facts about how a registration is made (rules decide on these, never on limitation text).</summary>
public static class DiTraits
{
    public const string Factory = "factory", Instance = "instance", OpenGeneric = "openGeneric", TryAdd = "tryAdd",
        Conditional = "conditional", FrameworkExtension = "frameworkExtension", Keyed = "keyed";
}

/// <summary>
/// A call inside a composition root that receives the IServiceCollection (as receiver or argument) and is not a
/// recognised registration, e.g. <c>services.AddInfrastructure()</c>. <see cref="CalleeRoot"/> is the composition root
/// id of the called source method; null when the target is not a source method with a body.
/// </summary>
public sealed record DiCollectionCallFact(
    string CallerRoot,
    string? CalleeRoot,
    string Method,
    bool IsSourceMethod,
    bool Conditional,
    Location Location,
    ProjectId ProjectId);

public sealed record RelationTarget(string Label, ISymbol? Symbol = null, Location? Location = null,
    EndpointFact? Endpoint = null, DiRegistrationFact? Registration = null);

public sealed record FrameworkRelation(
    string RelationKind,
    string Group,
    RelationTarget Target,
    IReadOnlyList<EvidenceItem> Evidence,
    string Confidence,
    IReadOnlyList<string> Limitations,
    string ProviderRouteId);

/// <summary>Per-snapshot input for framework modules.</summary>
public sealed class FrameworkContext
{
    public FrameworkContext(Solution solution, IReadOnlySet<ProjectId> loadedProjects)
    {
        Solution = solution;
        LoadedProjects = loadedProjects;
    }

    public Solution Solution { get; }
    public IReadOnlySet<ProjectId> LoadedProjects { get; }

    public IEnumerable<Project> Projects => Solution.Projects.Where(p => p.Language == LanguageNames.CSharp && LoadedProjects.Contains(p.Id));
}

/// <summary>
/// A framework module computes facts for a snapshot once (cached by the caller) and answers relation queries for a symbol.
/// </summary>
public interface IFrameworkModule
{
    string Id { get; }
    string ProviderRouteId { get; }
    Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct);
    IReadOnlyList<FrameworkRelation> Relate(object facts, ISymbol subject, FrameworkContext context);
    /// <summary>Short evidence of detection, e.g. "MediatR 12.5.0.0 (MediatR.Contracts 2.0.0.0)". Null when not detected.</summary>
    string? Detection(object facts);
}
