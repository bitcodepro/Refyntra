using Refyntra.Refactorings.Cleanup;
using Refyntra.Workspaces;

// Code Cleanup wire DTOs (protocol 1.4); mirror CleanupParams / CleanupReport in packages/contracts/src/protocol.ts.
namespace Refyntra.Host.Protocol;

public sealed class CleanupParamsDto
{
    /// <summary>File, folder or project file URIs; every C# document of the loaded solution under them is in scope.</summary>
    public List<string> ScopeUris { get; set; } = new();
    /// <summary>Fix ids to run (empty: the default profile).</summary>
    public List<string>? Fixes { get; set; }
}

public sealed class CleanupFixDto
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
}

public sealed class CleanupFixCountDto
{
    public string FixId { get; set; } = "";
    public int Count { get; set; }
}

public sealed class CleanupFileDto
{
    public string Uri { get; set; } = "";
    public List<CleanupFixCountDto> Fixes { get; set; } = new();
}

public sealed class CleanupSkipDto
{
    public string? Uri { get; set; }
    public string? FixId { get; set; }
    public string ReasonCode { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class CleanupReportDto
{
    public List<CleanupFixDto> Fixes { get; set; } = new();
    public List<CleanupFileDto> Files { get; set; } = new();
    public List<CleanupSkipDto> Skipped { get; set; } = new();
    public int FilesInScope { get; set; }

    public static CleanupReportDto From(CleanupReport r) => new()
    {
        Fixes = r.Fixes.Select(f => new CleanupFixDto { Id = f.id, Title = f.title }).ToList(),
        Files = r.Files.Select(f => new CleanupFileDto
        {
            Uri = UriPaths.ToUri(f.Path),
            Fixes = f.Fixes.Select(x => new CleanupFixCountDto { FixId = x.fixId, Count = x.count }).ToList(),
        }).ToList(),
        Skipped = r.Skipped.Select(s => new CleanupSkipDto { Uri = s.Path != null ? UriPaths.ToUri(s.Path) : null, FixId = s.FixId, ReasonCode = s.ReasonCode, Message = s.Message }).ToList(),
        FilesInScope = r.FilesInScope,
    };
}
