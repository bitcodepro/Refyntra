using Refyntra.Host.Protocol;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>solution/structure (protocol 1.20): the Solution Explorer model of a loaded workspace (no barrier).</summary>
public static class SolutionStructureHandler
{
    public static SolutionStructureResultDto Handle(WorkspaceSession session)
    {
        var snap = session.Current;
        var model = ProjectStructureBuilder.Build(session.Path, snap?.Solution, session.Projects);
        return new SolutionStructureResultDto
        {
            State = session.State,
            SnapshotId = snap?.Id,
            SolutionUri = model.SolutionPath == null ? null : UriPaths.ToUri(model.SolutionPath),
            Format = model.Format,
            Folders = model.Folders.Select(f => new SolutionFolderDto { Id = f.Id, Name = f.Name, ParentId = f.ParentId, FileUris = f.Files.Select(UriPaths.ToUri).ToList() }).ToList(),
            Projects = model.Projects.Select(p => new ProjectStructureDto
            {
                Name = p.Name,
                ProjectUri = UriPaths.ToUri(p.ProjectPath),
                FolderId = p.FolderId,
                Kind = p.Kind,
                TargetFrameworks = p.TargetFrameworks.ToList(),
                State = p.State,
                Sdk = p.Sdk,
                CentralPackageManagement = p.CentralPackageManagement,
                PackagesPropsUri = p.PackagesPropsPath == null ? null : UriPaths.ToUri(p.PackagesPropsPath),
                ProjectReferences = p.ProjectReferences.Select(r => new ProjectReferenceDto { Name = r.Name, ProjectUri = UriPaths.ToUri(r.ProjectPath) }).ToList(),
                Packages = p.Packages.Select(x => new PackageReferenceDto { Id = x.Id, Version = x.Version, ResolvedVersion = x.ResolvedVersion, Central = x.Central, VersionOverride = x.VersionOverride }).ToList(),
                Frameworks = p.Frameworks.ToList(),
                Analyzers = p.Analyzers.Select(a => new AnalyzerReferenceDto { Name = a.Name, Uri = a.Path == null ? null : UriPaths.ToUri(a.Path) }).ToList(),
                Items = p.Items.Select(i => new ProjectItemDto { Uri = UriPaths.ToUri(i.Path), ItemType = i.ItemType, VirtualPath = i.VirtualPath, Linked = i.Linked }).ToList(),
                ExcludedUris = p.Excluded.Select(UriPaths.ToUri).ToList(),
                ItemsTruncated = p.ItemsTruncated,
            }).ToList(),
        };
    }
}
