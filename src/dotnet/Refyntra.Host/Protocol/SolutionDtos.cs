namespace Refyntra.Host.Protocol;

// solution/structure (protocol 1.20): the Solution Explorer model (packages/contracts/src/protocol.ts SolutionStructureResult).

public sealed class SolutionFolderDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? ParentId { get; set; }
    public List<string> FileUris { get; set; } = new();
}

public sealed class ProjectItemDto
{
    public string Uri { get; set; } = "";
    public string ItemType { get; set; } = "";
    public string VirtualPath { get; set; } = "";
    public bool Linked { get; set; }
}

public sealed class PackageReferenceDto
{
    public string Id { get; set; } = "";
    public string? Version { get; set; }
    public string? ResolvedVersion { get; set; }
    public bool Central { get; set; }
    public bool VersionOverride { get; set; }
}

public sealed class ProjectReferenceDto
{
    public string Name { get; set; } = "";
    public string ProjectUri { get; set; } = "";
}

public sealed class AnalyzerReferenceDto
{
    public string Name { get; set; } = "";
    public string? Uri { get; set; }
}

public sealed class ProjectStructureDto
{
    public string Name { get; set; } = "";
    public string ProjectUri { get; set; } = "";
    public string? FolderId { get; set; }
    public string Kind { get; set; } = "";
    public List<string> TargetFrameworks { get; set; } = new();
    public string State { get; set; } = "";
    public string? Sdk { get; set; }
    public bool CentralPackageManagement { get; set; }
    public string? PackagesPropsUri { get; set; }
    public List<ProjectReferenceDto> ProjectReferences { get; set; } = new();
    public List<PackageReferenceDto> Packages { get; set; } = new();
    public List<string> Frameworks { get; set; } = new();
    public List<AnalyzerReferenceDto> Analyzers { get; set; } = new();
    public List<ProjectItemDto> Items { get; set; } = new();
    public List<string> ExcludedUris { get; set; } = new();
    public bool ItemsTruncated { get; set; }
}

public sealed class SolutionStructureResultDto
{
    public string State { get; set; } = "";
    public string? SnapshotId { get; set; }
    public string? SolutionUri { get; set; }
    /// <summary>"sln", "slnx" or "project" (a single project file was opened).</summary>
    public string Format { get; set; } = "";
    public List<SolutionFolderDto> Folders { get; set; } = new();
    public List<ProjectStructureDto> Projects { get; set; } = new();
}
