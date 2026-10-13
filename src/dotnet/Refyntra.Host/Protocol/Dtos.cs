using System.Text.Json;
using System.Text.Json.Serialization;

// Wire DTOs for protocol v1. They must serialize exactly like packages/contracts/src/protocol.ts:
// camelCase names, string literal "enums", optional fields omitted when null. Fields typed `T | null`
// in the contract (not optional) carry [JsonIgnore(Condition = Never)] so that null is written explicitly.
namespace Refyntra.Host.Protocol;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = false,
        WriteIndented = false,
    };
}

public sealed class PositionDto
{
    public int Line { get; set; }
    public int Character { get; set; }
}

public sealed class RangeDto
{
    public PositionDto Start { get; set; } = new();
    public PositionDto End { get; set; } = new();
}

public class LocationDto
{
    public string Uri { get; set; } = "";
    public RangeDto Range { get; set; } = new();
}

public sealed class LocationWithPreviewDto : LocationDto
{
    public string? ProjectName { get; set; }
    public string? Preview { get; set; }
}

public class TraceParams
{
    public string TraceId { get; set; } = "";
}

public class WorkspaceParams : TraceParams
{
    public string WorkspaceId { get; set; } = "";
}

// ------------------------------------------------------------------ lifecycle

public sealed class InitializeParams : TraceParams
{
    public int ProtocolMajor { get; set; } = -1;
    public int ProtocolMinor { get; set; }
    public string ClientName { get; set; } = "";
    public string ClientVersion { get; set; } = "";
}

public sealed class LimitsDto
{
    public long MaxMessageBytes { get; set; }
}

public sealed class InitializeResult
{
    public int ProtocolMajor { get; set; }
    public int ProtocolMinor { get; set; }
    public string EngineVersion { get; set; } = "";
    public string SessionEpoch { get; set; } = "";
    public List<string> Capabilities { get; set; } = new();
    public LimitsDto Limits { get; set; } = new();
}

public sealed class LoadDiagnosticDto
{
    public string Severity { get; set; } = "error";
    public string Message { get; set; } = "";
    public string? ProjectPath { get; set; }
    /// <summary>Optional (protocol 1.1): what the UI can offer, e.g. refyntra.runRestore.</summary>
    public List<RecoveryActionDto>? RecoveryActions { get; set; }
    /// <summary>Optional (additive): machine-readable cause — missingAssets, missingPackages, missingProjectReference; absent for raw MSBuild messages.</summary>
    public string? Cause { get; set; }
}

public sealed class ProjectContextInfoDto
{
    public string ProjectContextId { get; set; } = "";
    public string Name { get; set; } = "";
    public string ProjectPath { get; set; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? TargetFramework { get; set; }
    public string State { get; set; } = "loaded";
    public int DocumentCount { get; set; }
    public List<LoadDiagnosticDto> Diagnostics { get; set; } = new();
}

public sealed class SdkDto
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Version { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Path { get; set; }
}

public sealed class EngineStatusDto
{
    public string State { get; set; } = "NotStarted";
    public string SessionEpoch { get; set; } = "";
    public SdkDto Sdk { get; set; } = new();
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? SolutionPath { get; set; }
    public List<ProjectContextInfoDto> Projects { get; set; } = new();
    public List<LoadDiagnosticDto> Diagnostics { get; set; } = new();
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
}

public sealed class WorkspaceOpenParams : WorkspaceParams
{
    public string Path { get; set; } = "";
    public bool Trusted { get; set; }
}

// ------------------------------------------------------------------ documents

public sealed class DocumentEventParams
{
    public string WorkspaceId { get; set; } = "";
    public string Uri { get; set; } = "";
    public long Sequence { get; set; }
    public long WorkspaceRevision { get; set; }
    public string? LanguageId { get; set; }
    public int? Version { get; set; }
    public string? Text { get; set; }
}

public sealed class BarrierParams : WorkspaceParams
{
    public long Sequence { get; set; }
}

public sealed class BarrierResult
{
    public long AcknowledgedSequence { get; set; }
    public string SnapshotId { get; set; } = "";
    public long WorkspaceRevision { get; set; }
}

// ------------------------------------------------------------------ availability

public sealed class RecoveryActionDto
{
    public string Command { get; set; } = "";
    public string Title { get; set; } = "";
    public List<object>? Args { get; set; }
}

public sealed class AvailabilityScopeDto
{
    public string WorkspaceId { get; set; } = "";
    public string? ProjectContextId { get; set; }
    public string? DocumentUri { get; set; }
    public string? SymbolId { get; set; }
}

public sealed class AvailabilityDto
{
    public string CapabilityId { get; set; } = "";
    public string ProviderRouteId { get; set; } = "";
    public AvailabilityScopeDto Scope { get; set; } = new();
    public string State { get; set; } = "unknown";
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public List<RecoveryActionDto> RecoveryActions { get; set; } = new();
    public string RequiredTrust { get; set; } = "workspace";
    public string Guarantee { get; set; } = "owned-semantic";
    public List<string> Limitations { get; set; } = new();
}

public sealed class CapabilityQueryParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string? Uri { get; set; }
    public PositionDto? Position { get; set; }
    public string? SymbolId { get; set; }
}

// ------------------------------------------------------------------ symbols

public sealed class ProvenanceDto
{
    public string Kind { get; set; } = "owned-semantic";
    public string ProviderRouteId { get; set; } = "";
    public string SessionEpoch { get; set; } = "";
    public string SnapshotId { get; set; } = "";
    public string ProjectContextId { get; set; } = "";
    public string? ObservationId { get; set; }
}

public sealed class SymbolRefDto
{
    public string? SymbolId { get; set; }
    public string Name { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Kind { get; set; } = "other";
    public string? ContainerName { get; set; }
    public string? ProjectName { get; set; }
    public LocationDto? Location { get; set; }
    public string Origin { get; set; } = "source";
    public ProvenanceDto Provenance { get; set; } = new();
}

public sealed class SymbolAtParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    public PositionDto Position { get; set; } = new();
}

public sealed class SearchFiltersDto
{
    public bool? Type { get; set; }
    public bool? Member { get; set; }
    public string? Project { get; set; }
    public string? Route { get; set; }
    public string? Method { get; set; }
    /// <summary>Filter "entity:" — only EF Core entities.</summary>
    public bool? Entity { get; set; }
    /// <summary>Filter "table:NAME" — EF Core entities by mapped table name.</summary>
    public string? Table { get; set; }
}

public sealed class SearchParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Query { get; set; } = "";
    public SearchFiltersDto Filters { get; set; } = new();
    public int Limit { get; set; } = 50;
}

public sealed class SearchItemDto
{
    public SymbolRefDto? Symbol { get; set; }
    public EndpointInfoDto? Endpoint { get; set; }
    public double Score { get; set; }
}

public sealed class SearchResultDto
{
    public List<SearchItemDto> Items { get; set; } = new();
    public bool Truncated { get; set; }
    public string SnapshotId { get; set; } = "";
}

// ------------------------------------------------------------------ relations

public sealed class EndpointInfoDto
{
    public List<string> HttpMethods { get; set; } = new();
    public string Route { get; set; } = "";
    public bool RouteIsDynamic { get; set; }
    public LocationDto Location { get; set; } = new();
    public SymbolRefDto? Handler { get; set; }
    public string Kind { get; set; } = "minimal-api";
}

public sealed class DiRegistrationInfoDto
{
    public string Lifetime { get; set; } = "unknown";
    public SymbolRefDto ServiceType { get; set; } = new();
    public SymbolRefDto? ImplementationType { get; set; }
    public string Form { get; set; } = "";
    public string CompositionRoot { get; set; } = "";
    public LocationDto Location { get; set; } = new();
    /// <summary>"type" | "factory" | "instance" (additive, optional).</summary>
    public string? ImplementationKind { get; set; }
    /// <summary>Key of a keyed registration as shown (additive, optional).</summary>
    public string? Key { get; set; }
    /// <summary>Location of the factory delegate of a factory registration (additive, optional).</summary>
    public LocationDto? FactoryLocation { get; set; }
}

public sealed class EvidenceDto
{
    public string Description { get; set; } = "";
    public LocationDto? Location { get; set; }
}

public sealed class RelationTargetDto
{
    public SymbolRefDto? Symbol { get; set; }
    public EndpointInfoDto? Endpoint { get; set; }
    public DiRegistrationInfoDto? Registration { get; set; }
    public LocationDto? Location { get; set; }
    public string Label { get; set; } = "";
}

public sealed class RelationDto
{
    public string RelationKind { get; set; } = "";
    public string Group { get; set; } = "";
    public RelationTargetDto Target { get; set; } = new();
    public List<EvidenceDto> Evidence { get; set; } = new();
    public string Confidence { get; set; } = "proven";
    public ProvenanceDto Provenance { get; set; } = new();
    public List<string> Limitations { get; set; } = new();
}

public sealed class RelatedParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string? SymbolId { get; set; }
    public string? Uri { get; set; }
    public PositionDto? Position { get; set; }
}

public sealed class RelatedResultDto
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public SymbolRefDto? Subject { get; set; }
    public List<RelationDto> Relations { get; set; } = new();
    public string Completeness { get; set; } = "complete";
    public List<string> ScopeNotes { get; set; } = new();
    /// <summary>Structured form of the scope (additive; protocol-v1.md). Null only from older hosts.</summary>
    public Refyntra.Semantics.ScopeDetails? ScopeDetails { get; set; }
    public string SnapshotId { get; set; } = "";
}

public sealed class SymbolQueryParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string SymbolId { get; set; } = "";
}

/// <summary>code/hierarchy (protocol 1.7): call or type hierarchy neighbours of the subject.</summary>
public sealed class HierarchyParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string SymbolId { get; set; } = "";
    /// <summary>"incoming" | "outgoing" | "supertypes" | "subtypes" | "bases" | "containing" (the last two: protocol 1.12).</summary>
    public string Direction { get; set; } = "";
}

public sealed class HierarchyItemDto
{
    public SymbolRefDto Symbol { get; set; } = new();
    /// <summary>Call sites: in the caller (incoming) or in the subject (outgoing). Empty for type hierarchy.</summary>
    public List<RangeDto> FromRanges { get; set; } = new();
    /// <summary>Document of FromRanges (the caller for incoming, the subject for outgoing).</summary>
    public string? FromUri { get; set; }
}

public sealed class HierarchyResultDto
{
    public List<HierarchyItemDto> Items { get; set; } = new();
    public string Completeness { get; set; } = "complete";
    public bool Truncated { get; set; }
    public string SnapshotId { get; set; } = "";
}

/// <summary>code/usages (protocol 1.12): the classified usages of a symbol.</summary>
public sealed class UsagesParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string SymbolId { get; set; } = "";
    /// <summary>At most this many items (default 1000, at most 50000); <c>total</c> says how many there are.</summary>
    public int Limit { get; set; }
}

public sealed class UsageItemDto
{
    public string Uri { get; set; } = "";
    public RangeDto Range { get; set; } = new();
    /// <summary>read | write | readWrite | invocation | nameof | attribute | inheritance | typeArgument | objectCreation | other.</summary>
    public string Kind { get; set; } = "other";
    public string? ContainingMember { get; set; }
    public string? ContainingType { get; set; }
    public string? ProjectName { get; set; }
    public bool IsTest { get; set; }
    /// <summary>The whole source line of the usage (untrimmed, at most 400 characters).</summary>
    public string LineText { get; set; } = "";
}

public sealed class UsagesResultDto
{
    public SymbolRefDto? Subject { get; set; }
    public List<UsageItemDto> Items { get; set; } = new();
    public int Total { get; set; }
    public bool Truncated { get; set; }
    public string Completeness { get; set; } = "complete";
    public string SnapshotId { get; set; } = "";
}

/// <summary>code/fileStructure (protocol 1.13): the types and members of one C# document.</summary>
public sealed class FileStructureParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    /// <summary>Also the members inherited from base classes (an interface: base interfaces).</summary>
    public bool IncludeInherited { get; set; }
}

public sealed class StructureMemberDto
{
    public string Name { get; set; } = "";
    /// <summary>method | constructor | destructor | property | indexer | field | constant | event | operator | enumMember.</summary>
    public string Kind { get; set; } = "method";
    /// <summary>public | internal | protected | private | protectedInternal | privateProtected.</summary>
    public string Accessibility { get; set; } = "private";
    public bool IsStatic { get; set; }
    /// <summary>Short signature: "Find(int) : OrderDto?", "Total : decimal".</summary>
    public string Signature { get; set; } = "";
    /// <summary>The declaration (own members: in the requested document; inherited: in <see cref="Uri"/>).</summary>
    public RangeDto Range { get; set; } = new();
    /// <summary>The name.</summary>
    public RangeDto SelectionRange { get; set; } = new();
    /// <summary>Innermost #region around the member (own members only).</summary>
    public string? Region { get; set; }
    /// <summary>Inherited members: the declaring type ("Base&lt;T&gt;").</summary>
    public string? DeclaringType { get; set; }
    /// <summary>Inherited members declared in the solution: their file. Null for metadata (not navigable).</summary>
    public string? Uri { get; set; }
    public bool Navigable { get; set; } = true;
}

public sealed class StructureTypeDto
{
    public string Name { get; set; } = "";
    /// <summary>With the containing types: "Outer.Inner&lt;T&gt;".</summary>
    public string FullName { get; set; } = "";
    /// <summary>class | struct | interface | enum | record | recordStruct | delegate.</summary>
    public string Kind { get; set; } = "class";
    public string Accessibility { get; set; } = "internal";
    public bool IsStatic { get; set; }
    public string Signature { get; set; } = "";
    public RangeDto Range { get; set; } = new();
    public RangeDto SelectionRange { get; set; } = new();
    public string? Region { get; set; }
    /// <summary>Nested types: the full name of the containing type.</summary>
    public string? ContainingType { get; set; }
    public List<StructureMemberDto> Members { get; set; } = new();
    public List<StructureMemberDto> Inherited { get; set; } = new();
}

public sealed class StructureRegionDto
{
    public string Name { get; set; } = "";
    public RangeDto Range { get; set; } = new();
}

public sealed class FileStructureResultDto
{
    public List<StructureTypeDto> Types { get; set; } = new();
    public List<StructureRegionDto> Regions { get; set; } = new();
    /// <summary>"DocumentNotFound" when the document is not part of the loaded solution.</summary>
    public string? ReasonCode { get; set; }
    public string Completeness { get; set; } = "complete";
    public string SnapshotId { get; set; } = "";
}

/// <summary>workspace/runnableProjects (protocol 1.8): one loaded project as Run and Debug sees it.</summary>
public sealed class RunnableProjectDto
{
    public string Name { get; set; } = "";
    public string ProjectUri { get; set; } = "";
    /// <summary>"console" | "web" | "worker" | "winforms" | "wpf" | "test" | "library" | "maui" | "blazor-wasm".</summary>
    public string Kind { get; set; } = "";
    public bool Runnable { get; set; }
    public string? Reason { get; set; }
    public bool WindowsOnly { get; set; }
    public List<string> TargetFrameworks { get; set; } = new();
    public List<RunnableOutputDto> Outputs { get; set; } = new();
    public string? AssemblyName { get; set; }
    public string? LaunchSettingsUri { get; set; }
}

public sealed class RunnableOutputDto
{
    public string? TargetFramework { get; set; }
    public string OutputUri { get; set; } = "";
}

public sealed class RunnableProjectsResultDto
{
    public List<RunnableProjectDto> Projects { get; set; } = new();
    /// <summary>Engine state of the workspace (Loading: the list may still be empty).</summary>
    public string State { get; set; } = "";
    public string? SnapshotId { get; set; }
}

public sealed class LocationsResultDto
{
    public List<LocationWithPreviewDto> Locations { get; set; } = new();
    public string Completeness { get; set; } = "complete";
    public string SnapshotId { get; set; } = "";
}

// ------------------------------------------------------------------ refactoring plans

public sealed class TextEditDto
{
    public RangeDto Range { get; set; } = new();
    public string NewText { get; set; } = "";
}

public sealed class PlannedTextChangeDto
{
    public string Kind { get; set; } = "text";
    public string Uri { get; set; } = "";
    public string ExpectedHash { get; set; } = "";
    public string ResultHash { get; set; } = "";
    public List<TextEditDto> Edits { get; set; } = new();
}

/// <summary>File rename resource operation (protocol 1.2): rename a file after every text edit of the plan.</summary>
public sealed class PlannedFileRenameDto
{
    public string Kind { get; set; } = "rename";
    public string OldUri { get; set; } = "";
    public string NewUri { get; set; } = "";
    /// <summary>SHA-256 of the text the renamed file must have (the result of the plan's text edits).</summary>
    public string ResultHash { get; set; } = "";
}

/// <summary>Created file resource operation (protocol 1.3): created with exactly <see cref="Text"/> before every text change.</summary>
public sealed class PlannedFileCreateDto
{
    public string Kind { get; set; } = "create";
    public string Uri { get; set; } = "";
    /// <summary>SHA-256 of <see cref="Text"/>.</summary>
    public string ResultHash { get; set; } = "";
    public string Text { get; set; } = "";
}

/// <summary>A folder a generated file can be created in (protocol 1.3, Generate handler).</summary>
/// <summary>Deleted file resource operation (protocol 1.6, Safe Delete): deleted after every text change, only while its text is unchanged.</summary>
public sealed class PlannedFileDeleteDto
{
    public string Kind { get; set; } = "delete";
    public string Uri { get; set; } = "";
    /// <summary>SHA-256 of the text the file must still have when it is deleted.</summary>
    public string ExpectedHash { get; set; } = "";
}

/// <summary>The files a plan deletes (protocol 1.6).</summary>
public sealed class FileDeleteOfferDto
{
    public List<string> Files { get; set; } = new();
}

/// <summary>workspace/didDeleteFiles (protocol 1.6): files deleted by the client; part of the document sequence.</summary>
public sealed class DidDeleteFilesParams
{
    public string WorkspaceId { get; set; } = "";
    public long Sequence { get; set; }
    public long WorkspaceRevision { get; set; }
    public List<CreatedFileDto> Files { get; set; } = new();
}

/// <summary>One parameter of a new signature (protocol 1.6, Change Signature).</summary>
public sealed class ParameterSpecDto
{
    /// <summary>Index of the existing parameter (kept, moved or renamed); null adds a parameter.</summary>
    public int? From { get; set; }
    public string Name { get; set; } = "";
    /// <summary>Type of an added parameter.</summary>
    public string? Type { get; set; }
    /// <summary>Default value in the declaration (an added parameter becomes optional).</summary>
    public string? DefaultValue { get; set; }
    /// <summary>Value passed at every existing call site for an added parameter.</summary>
    public string? CallSiteValue { get; set; }
}

public sealed class SignatureParamsDto
{
    public List<ParameterSpecDto> Parameters { get; set; } = new();
}

/// <summary>code/signature (protocol 1.6): the current parameters of the method at the subject.</summary>
public sealed class SignatureInfoDto
{
    public string? Name { get; set; }
    public string? Display { get; set; }
    public List<SignatureParameterDto> Parameters { get; set; } = new();
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public string SnapshotId { get; set; } = "";
}

public sealed class SignatureParameterDto
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public string? DefaultValue { get; set; }
    /// <summary>"ref", "out", "in", "params", "this" (space separated), or empty.</summary>
    public string Modifiers { get; set; } = "";
}

public sealed class FolderChoiceDto
{
    public string FolderUri { get; set; } = "";
    public string ProjectName { get; set; } = "";
    public int HandlerCount { get; set; }
    public string Namespace { get; set; } = "";
}

/// <summary>The file a create-file plan creates and, for Generate handler, the folder choices (first = default).</summary>
public sealed class FileCreateOfferDto
{
    public List<string> Files { get; set; } = new();
    public List<FolderChoiceDto>? FolderChoices { get; set; }
    public string? SelectedFolderUri { get; set; }
}

/// <summary>workspace/didCreateFiles (protocol 1.3): files created by the client; part of the document sequence.</summary>
public sealed class DidCreateFilesParams
{
    public string WorkspaceId { get; set; } = "";
    public long Sequence { get; set; }
    public long WorkspaceRevision { get; set; }
    public List<CreatedFileDto> Files { get; set; } = new();
}

public sealed class CreatedFileDto
{
    public string Uri { get; set; } = "";
}

public sealed class FileRenamePairDto
{
    public string OldUri { get; set; } = "";
    public string NewUri { get; set; } = "";
}

/// <summary>What "also rename the file" means for a type rename (protocol 1.2).</summary>
public sealed class FileRenameOfferDto
{
    public List<FileRenamePairDto> Files { get; set; } = new();
    public bool Available { get; set; }
    public bool Included { get; set; }
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
}

/// <summary>workspace/didRenameFiles (protocol 1.2): files renamed by the client; part of the document sequence.</summary>
public sealed class DidRenameFilesParams
{
    public string WorkspaceId { get; set; } = "";
    public long Sequence { get; set; }
    public long WorkspaceRevision { get; set; }
    public List<FileRenamePairDto> Files { get; set; } = new();
}

public sealed class InputFingerprintDto
{
    public string Input { get; set; } = "";
    public string Hash { get; set; } = "";
}

public sealed class PlanValidationDto
{
    public string Status { get; set; } = "valid";
    public List<string> CheckedContexts { get; set; } = new();
    public List<string> UncheckedContexts { get; set; } = new();
    public string CompilationDelta { get; set; } = "not-run";
}

public sealed class RefactorPlanDto
{
    public string PlanId { get; set; } = "";
    public string ActionId { get; set; } = "";
    public string ProviderRouteId { get; set; } = "";
    public int ProtocolMajor { get; set; }
    public string WorkspaceId { get; set; } = "";
    public string Kind { get; set; } = "owned-semantic";
    public string SessionEpoch { get; set; } = "";
    public long BaseWorkspaceRevision { get; set; }
    public string BaseSnapshotId { get; set; } = "";
    public List<string> ProjectContextIds { get; set; } = new();
    /// <summary>PlannedFileCreateDto entries (1.3), then PlannedTextChangeDto entries, then PlannedFileRenameDto entries, then PlannedFileDeleteDto entries (1.6).</summary>
    public List<object> WriteSet { get; set; } = new();
    public FileRenameOfferDto? FileRename { get; set; }
    /// <summary>Create-file plans (protocol 1.3): the created file and the folder choices.</summary>
    public FileCreateOfferDto? FileCreate { get; set; }
    public List<InputFingerprintDto> ReadSet { get; set; } = new();
    public List<EvidenceDto> Evidence { get; set; } = new();
    public List<string> Limitations { get; set; } = new();
    public PlanValidationDto Validation { get; set; } = new();
    public string Title { get; set; } = "";
    /// <summary>Code Cleanup (protocol 1.4): fixes, per file per fix counts, skipped files with reasons.</summary>
    public CleanupReportDto? Cleanup { get; set; }
    /// <summary>Rename (protocol 1.5): EF Core migrations that reference the symbol, and the mode of this plan.</summary>
    public EfMigrationsOfferDto? EfMigrations { get; set; }
    /// <summary>Safe Delete (protocol 1.6): the files the plan deletes. Required when the writeSet has a "delete".</summary>
    public FileDeleteOfferDto? FileDelete { get; set; }
}

/// <summary>EF Core migrations a rename touches (protocol 1.5): the files and whether this plan edits them.</summary>
public sealed class EfMigrationsOfferDto
{
    /// <summary>"efMigrations" (the references in the files are renamed) or "none" (the files are left unchanged).</summary>
    public string Mode { get; set; } = "efMigrations";
    public List<string> Files { get; set; } = new();
}

public sealed class PrepareParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string ActionId { get; set; } = "";
    public string SymbolId { get; set; } = "";
    public string NewName { get; set; } = "";
    /// <summary>File rename (protocol 1.2): include the rename of the files named after the type when it is proven safe.</summary>
    public bool RenameFile { get; set; }
    /// <summary>Generate handler (protocol 1.3): the folder to create the handler in (one of the offered choices).</summary>
    public string? TargetFolderUri { get; set; }
    /// <summary>Move Type to File (protocol 1.3): the document of the cursor (the declaration to move).</summary>
    public string? DocumentUri { get; set; }
    /// <summary>Code Cleanup (protocol 1.4, action csharp.cleanup): the scope and the fixes.</summary>
    public CleanupParamsDto? Cleanup { get; set; }
    /// <summary>
    /// Rename (protocol 1.5): what to do with EF Core migrations that reference the symbol: "efMigrations" (default:
    /// rename the references in them too) or "none" (leave them unchanged; the plan is limited).
    /// </summary>
    public string? GeneratedEdits { get; set; }
    /// <summary>Extract Method (protocol 1.6): the selection in <see cref="DocumentUri"/> (statements or one expression).</summary>
    public RangeDto? Range { get; set; }
    /// <summary>Change Signature (protocol 1.6): the new parameter list.</summary>
    public SignatureParamsDto? Signature { get; set; }
    /// <summary>Register in DI (protocol 1.11, action csharp.registerDi): the service at documentUri + range.start (or typeId) and the choices.</summary>
    public RegistrationParamsDto? Registration { get; set; }
    /// <summary>Fix in scope (protocol 1.11, action csharp.fixAll): the edit action and the scope around documentUri.</summary>
    public FixAllParamsDto? FixAll { get; set; }
}

public sealed class RegistrationParamsDto
{
    public string? TypeId { get; set; }
    public string Lifetime { get; set; } = "Scoped";
    public string? ImplementationId { get; set; }
    public string? RootId { get; set; }
}

public sealed class FixAllParamsDto
{
    public string ActionId { get; set; } = "";
    /// <summary>"document" | "project" | "solution".</summary>
    public string Scope { get; set; } = "document";
}

public sealed class PrepareResultDto
{
    public string Kind { get; set; } = "unavailable";
    public RefactorPlanDto? Plan { get; set; }
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
}

public sealed class RevalidateParams : WorkspaceParams
{
    public string PlanId { get; set; } = "";
    public string SnapshotId { get; set; } = "";
}

public sealed class RevalidateResultDto
{
    /// <summary>valid | limited | stale | invalid. "limited" only for a plan prepared as limited (never upgraded).</summary>
    public string Status { get; set; } = "valid";
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    /// <summary>Set with status "limited": the plan's limitations, to show before applying.</summary>
    public List<string>? Limitations { get; set; }
}

public sealed class DiscardParams
{
    public string WorkspaceId { get; set; } = "";
    public string PlanId { get; set; } = "";
}

public sealed class RpcErrorData
{
    public string ReasonCode { get; set; } = "";
    public string Message { get; set; } = "";
    public string? Recovery { get; set; }
}

// ------------------------------------------------------------------ analysis (rules, additive in protocol 1.1)

public sealed class AnalysisRunParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    /// <summary>Optional: only results whose primary location is in this document.</summary>
    public string? Uri { get; set; }
}

public sealed class RelatedLocationDto
{
    public LocationDto Location { get; set; } = new();
    public string Message { get; set; } = "";
}

public sealed class RuleDiagnosticDto
{
    public string Id { get; set; } = "";
    public string Severity { get; set; } = "warning";
    public string Message { get; set; } = "";
    public LocationDto Location { get; set; } = new();
    public List<RelatedLocationDto> RelatedLocations { get; set; } = new();
    public List<EvidenceDto> Evidence { get; set; } = new();
    public string Confidence { get; set; } = "proven";
    public string Completeness { get; set; } = "complete";
    public string? CompositionRoot { get; set; }
    public string? HelpUri { get; set; }
}

public sealed class RuleAbstentionDto
{
    public string RuleId { get; set; } = "";
    public string Reason { get; set; } = "";
    public string? Message { get; set; }
    public LocationDto? Location { get; set; }
    public string? CompositionRoot { get; set; }
}

public sealed class AnalysisRunResultDto
{
    public List<RuleDiagnosticDto> Diagnostics { get; set; } = new();
    public List<RuleAbstentionDto> Abstentions { get; set; } = new();
    public string Completeness { get; set; } = "complete";
    public string SnapshotId { get; set; } = "";
}

/// <summary>
/// code/editActions (protocol 1.9): the single-document edit actions at a range (no actionId), or the computed,
/// compile-checked edits of one action (actionId set).
/// </summary>
public sealed class EditActionsParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    public RangeDto Range { get; set; } = new();
    public string? ActionId { get; set; }
}

public sealed class EditActionDto
{
    public string ActionId { get; set; } = "";
    public string Title { get; set; } = "";
    /// <summary>Code action kind, e.g. "refactor.rewrite.refyntra.invertIf".</summary>
    public string Kind { get; set; } = "";
}

public sealed class EditActionsResultDto
{
    public List<EditActionDto> Items { get; set; } = new();
    /// <summary>The edits of the requested action (null when listing or refused).</summary>
    public List<TextEditDto>? Edits { get; set; }
    /// <summary>SHA-256 of the document text the edits apply to.</summary>
    public string? DocumentHash { get; set; }
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public string SnapshotId { get; set; } = "";
}

/// <summary>code/postfix (protocol 1.10): the postfix templates after the dot before <see cref="Position"/>.</summary>
public sealed class PostfixParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    public PositionDto Position { get; set; } = new();
}

public sealed class PostfixTemplateDto
{
    /// <summary>Template name typed after the dot ("foreach").</summary>
    public string Name { get; set; } = "";
    /// <summary>The inserted code without tab stops.</summary>
    public string Detail { get; set; } = "";
    /// <summary>VS Code snippet that replaces the expression, the dot and the typed name.</summary>
    public string Snippet { get; set; } = "";
}

public sealed class PostfixResultDto
{
    public List<PostfixTemplateDto> Items { get; set; } = new();
    /// <summary>The expression the templates apply to (start to the dot).</summary>
    public RangeDto? ExpressionRange { get; set; }
    public string? TypeName { get; set; }
    public string SnapshotId { get; set; } = "";
}

/// <summary>code/generate (protocol 1.10): list the Generate kinds for the type at the position, or generate one (<see cref="Kind"/>).</summary>
public sealed class GenerateParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    public PositionDto Position { get; set; } = new();
    public string? Kind { get; set; }
    /// <summary>Picked member ids (null: the preselected ones).</summary>
    public List<string>? Members { get; set; }
    /// <summary>Equality: implement IEquatable&lt;T&gt;.</summary>
    public bool Equatable { get; set; }
    /// <summary>Equality: generate the == and != operators.</summary>
    public bool Operators { get; set; }
}

public sealed class GenerateMemberDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Detail { get; set; } = "";
    public bool Picked { get; set; }
    public string? Group { get; set; }
}

public sealed class GenerateKindDto
{
    public string Kind { get; set; } = "";
    public string Title { get; set; } = "";
    public List<GenerateMemberDto> Members { get; set; } = new();
}

public sealed class GenerateResultDto
{
    public string? TypeName { get; set; }
    public List<GenerateKindDto> Kinds { get; set; } = new();
    public List<TextEditDto>? Edits { get; set; }
    public string? DocumentHash { get; set; }
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public string SnapshotId { get; set; } = "";
}

/// <summary>code/constructorActions (protocol 1.11): without actionId the constructor / DI actions at the position; with it the edits, a question or a refusal.</summary>
public sealed class ConstructorActionsParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string Uri { get; set; } = "";
    public PositionDto Position { get; set; } = new();
    public string? ActionId { get; set; }
    public string? Member { get; set; }
    public List<string>? Members { get; set; }
    /// <summary>Create field and inject: a documentation comment id ("T:...") of a choice, or a typed type name.</summary>
    public string? Type { get; set; }
    /// <summary>The chosen constructor (an id of an earlier "constructor" choice).</summary>
    public string? ConstructorId { get; set; }
    /// <summary>csharp.ctor.registerDi: the service type (documentation comment id); absent: the type at the position.</summary>
    public string? TypeId { get; set; }
}

public sealed class ConstructorActionDto
{
    public string ActionId { get; set; } = "";
    public string Title { get; set; } = "";
    /// <summary>"quickfix" | "rewrite".</summary>
    public string Kind { get; set; } = "";
    public bool Preferred { get; set; }
    public string? Member { get; set; }
    public List<string>? Members { get; set; }
    public string? TypeId { get; set; }
}

public sealed class ChoiceDto
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string? Detail { get; set; }
    public bool Picked { get; set; }
}

public sealed class DocumentEditsDto
{
    public string Uri { get; set; } = "";
    public string DocumentHash { get; set; } = "";
    public List<TextEditDto> Edits { get; set; } = new();
}

public sealed class RegistrationInfoDto
{
    public string? Service { get; set; }
    public string? ServiceId { get; set; }
    public List<ChoiceDto> Implementations { get; set; } = new();
    public List<ChoiceDto> Roots { get; set; } = new();
    public List<string> Lifetimes { get; set; } = new();
}

public sealed class ConstructorActionsResultDto
{
    public List<ConstructorActionDto> Items { get; set; } = new();
    /// <summary>The edits of the computed action per document (null when listing, asking or refused).</summary>
    public List<DocumentEditsDto>? Files { get; set; }
    /// <summary>"members" | "constructor" | "type": ask the user, then compute again with the answer.</summary>
    public string? Need { get; set; }
    public List<ChoiceDto>? Choices { get; set; }
    public string? Note { get; set; }
    /// <summary>Create field and inject: the injected type is not registered in DI yet.</summary>
    public string? RegisterTypeId { get; set; }
    public string? RegisterTypeName { get; set; }
    /// <summary>csharp.ctor.registerDi: the choices for the registration (then refactor/prepare csharp.registerDi).</summary>
    public RegistrationInfoDto? Registration { get; set; }
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public string SnapshotId { get; set; } = "";
}
