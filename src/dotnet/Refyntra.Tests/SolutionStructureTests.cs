using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>solution/structure (protocol 1.20) on copies of the Explorer fixture, opened as .sln and as .slnx.</summary>
public sealed class ExplorerFixture : IAsyncLifetime
{
    public TestClient Sln { get; private set; } = null!;
    public TestClient Slnx { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("Explorer", "Explorer.sln");
        Dir = Path.GetDirectoryName(sln)!;
        Sln = TestClient.InProcess();
        await Sln.InitializeAsync();
        Assert.Equal("Ready", (await Sln.OpenAsync(sln)).GetProperty("state").GetString());
        Slnx = TestClient.InProcess();
        await Slnx.InitializeAsync();
        Assert.Equal("Ready", (await Slnx.OpenAsync(Path.Combine(Dir, "Explorer.slnx"))).GetProperty("state").GetString());
    }

    public async Task DisposeAsync()
    {
        await Sln.DisposeAsync();
        await Slnx.DisposeAsync();
    }
}

public sealed class SolutionStructureTests : IClassFixture<ExplorerFixture>
{
    private readonly ExplorerFixture _f;

    public SolutionStructureTests(ExplorerFixture f) => _f = f;

    private static async Task<JsonElement> StructureAsync(TestClient c) =>
        await c.RequestAsync("solution/structure", new { traceId = "t", workspaceId = c.WorkspaceId });

    private static Dictionary<string, JsonElement> Projects(JsonElement r) =>
        r.GetProperty("projects").EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);

    private static string FolderName(JsonElement r, string? id) =>
        id == null ? "" : r.GetProperty("folders").EnumerateArray().First(f => f.GetProperty("id").GetString() == id).GetProperty("name").GetString()!;

    private static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SolutionFoldersNestProjectsAsTheSolutionFileSays(bool slnx)
    {
        var r = await StructureAsync(slnx ? _f.Slnx : _f.Sln);
        Assert.Equal(slnx ? "slnx" : "sln", r.GetProperty("format").GetString());
        Assert.EndsWith(slnx ? "Explorer.slnx" : "Explorer.sln", r.GetProperty("solutionUri").GetString());
        var folders = r.GetProperty("folders").EnumerateArray().ToList();
        Assert.Equal(new[] { "Libraries", "Solution Items", "src", "tests" }, folders.Select(f => f.GetProperty("name").GetString()).OrderBy(n => n, StringComparer.Ordinal));
        var libraries = folders.Single(f => f.GetProperty("name").GetString() == "Libraries");
        Assert.Equal("src", FolderName(r, Str(libraries, "parentId")));
        var items = folders.Single(f => f.GetProperty("name").GetString() == "Solution Items");
        Assert.Equal(new[] { "Directory.Packages.props", "README.md" }, items.GetProperty("fileUris").EnumerateArray().Select(u => u.GetString()!.Split('/').Last()).OrderBy(n => n, StringComparer.Ordinal));

        var p = Projects(r);
        Assert.Equal(new[] { "Explorer.App", "Explorer.Core", "Explorer.Tests" }, p.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("src", FolderName(r, Str(p["Explorer.App"], "folderId")));
        Assert.Equal("Libraries", FolderName(r, Str(p["Explorer.Core"], "folderId")));
        Assert.Equal("tests", FolderName(r, Str(p["Explorer.Tests"], "folderId")));
        Assert.Equal("console", p["Explorer.App"].GetProperty("kind").GetString());
        Assert.Equal("library", p["Explorer.Core"].GetProperty("kind").GetString());
        Assert.Equal("test", p["Explorer.Tests"].GetProperty("kind").GetString());
        Assert.All(p.Values, x => Assert.Equal("loaded", x.GetProperty("state").GetString()));
        Assert.All(p.Values, x => Assert.Equal(new[] { "net10.0" }, x.GetProperty("targetFrameworks").EnumerateArray().Select(t => t.GetString())));
    }

    [Fact]
    public async Task ItemsAreTheCompileItemsWithLinksAndExclusions()
    {
        var app = Projects(await StructureAsync(_f.Sln))["Explorer.App"];
        var items = app.GetProperty("items").EnumerateArray().ToList();
        var compile = items.Where(i => i.GetProperty("itemType").GetString() == "Compile").ToList();
        Assert.Contains(compile, i => i.GetProperty("virtualPath").GetString() == "Program.cs" && !i.GetProperty("linked").GetBoolean());
        var linked = Assert.Single(compile, i => i.GetProperty("linked").GetBoolean());
        Assert.Equal("Shared/SharedInfo.cs", linked.GetProperty("virtualPath").GetString());
        Assert.EndsWith("/shared/SharedInfo.cs", linked.GetProperty("uri").GetString());
        // Compile Remove="Legacy/**": not compiled, reported as excluded; generated obj/ files are not items.
        Assert.DoesNotContain(items, i => i.GetProperty("virtualPath").GetString()!.StartsWith("Legacy/", StringComparison.Ordinal));
        Assert.Contains(app.GetProperty("excludedUris").EnumerateArray(), u => u.GetString()!.EndsWith("/Legacy/Old.cs", StringComparison.Ordinal));
        Assert.DoesNotContain(items, i => i.GetProperty("uri").GetString()!.Contains("/obj/", StringComparison.Ordinal));
        // Other files of an SDK-style project are None items (default globs).
        Assert.Contains(items, i => i.GetProperty("virtualPath").GetString() == "appsettings.json" && i.GetProperty("itemType").GetString() == "None");
    }

    [Fact]
    public async Task DependenciesListProjectsPackagesFrameworksAndAnalyzers()
    {
        var p = Projects(await StructureAsync(_f.Slnx));
        var app = p["Explorer.App"];
        Assert.Equal(new[] { "Explorer.Core" }, app.GetProperty("projectReferences").EnumerateArray().Select(r => r.GetProperty("name").GetString()));
        Assert.Contains("Microsoft.NETCore.App", app.GetProperty("frameworks").EnumerateArray().Select(f => f.GetString()));
        Assert.NotEmpty(app.GetProperty("analyzers").EnumerateArray());
        var core = p["Explorer.Core"];
        Assert.True(core.GetProperty("centralPackageManagement").GetBoolean());
        Assert.EndsWith("/Directory.Packages.props", core.GetProperty("packagesPropsUri").GetString());
        var mediatr = Assert.Single(core.GetProperty("packages").EnumerateArray());
        Assert.Equal("MediatR", mediatr.GetProperty("id").GetString());
        Assert.Equal("12.5.0", mediatr.GetProperty("version").GetString());
        Assert.True(mediatr.GetProperty("central").GetBoolean());
        Assert.Equal("12.5.0", mediatr.GetProperty("resolvedVersion").GetString());
    }

    [Fact]
    public void ReaderHandlesSolutionItemsNestingAndUndeclaredSlnxParents()
    {
        var dir = Path.Combine(Path.GetTempPath(), "refyntra-sln-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var slnx = Path.Combine(dir, "a b.slnx");
            File.WriteAllText(slnx, "<Solution><Folder Name=\"/x/y/\"><Project Path=\"p q/P.csproj\" /></Folder><Project Path=\"R.csproj\" /></Solution>");
            var m = SolutionFileReader.Read(slnx);
            var folder = Assert.Single(m.Folders);
            Assert.Equal("y", folder.Name);
            Assert.Null(folder.ParentId);
            Assert.Equal(2, m.Projects.Count);
            Assert.Equal(Path.Combine(dir, "p q", "P.csproj"), m.Projects.Single(p => p.Name == "P").ProjectPath);
            Assert.Equal("/x/y/", m.Projects.Single(p => p.Name == "P").FolderId);
            Assert.Null(m.Projects.Single(p => p.Name == "R").FolderId);
            var csproj = SolutionFileReader.Read(Path.Combine(dir, "R.csproj"));
            Assert.Equal("project", csproj.Format);
            Assert.Single(csproj.Projects);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }
}
