using Refyntra.Frameworks.EfCore;
using Refyntra.Host.Protocol;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>efcore/migrations (protocol 1.18): the "Refyntra EF Core" view's model, from source only (EfMigrations).</summary>
internal static class EfCoreTools
{
    public static async Task<EfMigrationsResultDto> MigrationsAsync(Snapshot snap, string state, CancellationToken ct)
    {
        var result = new EfMigrationsResultDto { SnapshotId = snap.Id, State = state };
        foreach (var c in await EfMigrations.DiscoverAsync(snap.Solution.Projects, ct).ConfigureAwait(false))
        {
            if (c.Project.FilePath == null) continue;
            result.Contexts.Add(new EfContextDto
            {
                Name = c.Context.Name,
                FullName = c.Context.ToDisplayString(),
                ProjectName = c.Project.AssemblyName,
                ProjectUri = UriPaths.ToUri(c.Project.FilePath),
                MigrationsProjectUri = UriPaths.ToUri(c.MigrationsProject.FilePath ?? c.Project.FilePath),
                MigrationsNamespace = c.MigrationsNamespace,
                Location = Mapper.Location(c.Declaration),
                OnModelCreating = Mapper.Location(c.OnModelCreating),
                Migrations = c.Migrations.Select(m => new EfMigrationDto
                {
                    Id = m.Id, Name = m.Name, ClassName = m.Type.Name, Location = Mapper.Location(m.Main), DesignerLocation = Mapper.Location(m.Designer),
                }).ToList(),
                Snapshot = c.Snapshot == null ? null : new EfNamedLocationDto { Name = c.Snapshot.Name, Location = Mapper.Location(c.SnapshotLocation) },
                Configurations = c.Configurations.Select(x => new EfNamedLocationDto { Name = x.Type.Name, Location = Mapper.Location(x.Location) }).ToList(),
            });
        }
        return result;
    }
}
