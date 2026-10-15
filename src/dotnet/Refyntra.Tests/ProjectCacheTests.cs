using Xunit.Abstractions;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>The persistent project index: a second open of an unchanged solution starts from it, MSBuild then replaces it.</summary>
public sealed class ProjectCacheTests
{
    private readonly ITestOutputHelper _out;
    public ProjectCacheTests(ITestOutputHelper output) => _out = output;

    private static async Task<(TestClient c, JsonElement status)> OpenAsync(string sln)
    {
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        return (c, await c.OpenAsync(sln));
    }

    [Fact]
    public async Task ASecondOpenStartsFromTheIndexAndMsBuildConfirmsIt()
    {
        var sln = await Fixtures.CopyAsync("Shop", "Shop.sln");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var (c1, s1) = await OpenAsync(sln);
        _out.WriteLine($"open without the index: {sw.ElapsedMilliseconds} ms");
        Assert.Equal("Ready", s1.GetProperty("state").GetString());
        Assert.False(s1.TryGetProperty("fromProjectIndex", out var f1) && f1.ValueKind == JsonValueKind.True);
        await c1.DisposeAsync();

        sw.Restart();
        var (c2, s2) = await OpenAsync(sln);
        _out.WriteLine($"open from the index: {sw.ElapsedMilliseconds} ms");
        try
        {
            Assert.Equal("Ready", s2.GetProperty("state").GetString());
            Assert.True(s2.TryGetProperty("fromProjectIndex", out var f2) && f2.ValueKind == JsonValueKind.True, s2.ToString());
            var snap = await c2.BarrierAsync();
            var file = Directory.EnumerateFiles(Path.GetDirectoryName(sln)!, "OrderRequests.cs", SearchOption.AllDirectories).First();
            var s = await c2.SymbolAtTextAsync(snap, file, "record OrderDto", 7);
            Assert.Equal(JsonValueKind.Object, s.ValueKind);
            var refs = await c2.RequestAsync("code/references", new { traceId = "t", workspaceId = c2.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
            Assert.True(refs.GetProperty("locations").GetArrayLength() > 0);
            // MSBuild's load replaces the index solution; refactorings wait for it.
            for (var i = 0; i < 300; i++)
            {
                var st = await c2.RequestAsync("engine/status", new { traceId = "t", workspaceId = c2.WorkspaceId });
                if (!st.TryGetProperty("fromProjectIndex", out var f) || f.ValueKind != JsonValueKind.True)
                {
                    _out.WriteLine($"MSBuild confirmed after {sw.ElapsedMilliseconds} ms");
                    return;
                }
                await Task.Delay(100);
            }
            Assert.Fail("MSBuild did not replace the index solution");
        }
        finally
        {
            await c2.DisposeAsync();
        }
    }

    [Fact]
    public void TheKeyChangesWithAProjectFileAndANewSourceFile()
    {
        var dir = Directory.CreateTempSubdirectory("refyntra-key-").FullName;
        var sln = Path.Combine(dir, "A.sln");
        var proj = Path.Combine(dir, "A", "A.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(proj)!);
        File.WriteAllText(sln, "x");
        File.WriteAllText(proj, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        var k1 = ProjectCache.Key(sln, new[] { proj }, "10.0.100");
        Assert.Equal(k1, ProjectCache.Key(sln, new[] { proj }, "10.0.100"));
        File.WriteAllText(Path.Combine(dir, "A", "New.cs"), "class N {}");
        var k2 = ProjectCache.Key(sln, new[] { proj }, "10.0.100");
        Assert.NotEqual(k1, k2);
        File.WriteAllText(proj, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup /></Project>");
        Assert.NotEqual(k2, ProjectCache.Key(sln, new[] { proj }, "10.0.100"));
        Assert.NotEqual(k2, ProjectCache.Key(sln, new[] { proj }, "10.0.200"));
        File.WriteAllText(Path.Combine(dir, "A", "bin.cs"), "");
        Directory.CreateDirectory(Path.Combine(dir, "A", "obj"));
        var k3 = ProjectCache.Key(sln, new[] { proj }, "10.0.100");
        File.WriteAllText(Path.Combine(dir, "A", "obj", "Gen.cs"), "");
        Assert.Equal(k3, ProjectCache.Key(sln, new[] { proj }, "10.0.100"));
    }
}
