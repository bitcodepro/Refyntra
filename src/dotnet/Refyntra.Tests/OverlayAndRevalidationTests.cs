using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>Tests that change buffers or files work on their own copy of the Shop fixture.</summary>
public sealed class OverlayAndRevalidationTests
{
    private static async Task<(TestClient client, string dir)> OpenCopyAsync()
    {
        var sln = await Fixtures.CopyAsync("Shop", "Shop.sln");
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, Path.GetDirectoryName(sln)!);
    }

    private static int CountKind(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Count(r => r.GetProperty("relationKind").GetString() == kind);

    [Fact]
    public async Task UnsavedBufferChangesResultsAfterBarrierAndOldSnapshotIsStale()
    {
        var (c, dir) = await OpenCopyAsync();
        await using var _ = c;
        var contracts = Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs");
        var program = Path.Combine(dir, "Shop.Api", "Program.cs");

        var snap1 = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap1, contracts, "record GetOrderQuery", 7);
        var before = await c.RelatedAsync(snap1, s.GetProperty("symbolId").GetString()!);
        Assert.Equal(1, CountKind(before, "mediatr.send"));
        Assert.Equal(1, CountKind(before, "aspnet.endpoint"));

        // Unsaved edit: the endpoint no longer sends GetOrderQuery (disk is unchanged).
        var original = await File.ReadAllTextAsync(program);
        var edited = original.Replace("await sender.Send(new GetOrderQuery(id))", "await Task.FromResult(id)");
        Assert.NotEqual(original, edited);
        await c.DidOpenAsync(program, original);
        await c.DidChangeAsync(program, edited);
        var snap2 = await c.BarrierAsync();
        Assert.NotEqual(snap1, snap2);

        var stale = await Assert.ThrowsAsync<RpcError>(() => c.RelatedAsync(snap1, s.GetProperty("symbolId").GetString()!));
        Assert.Equal(-33004, stale.Code);

        var s2 = await c.SymbolAtTextAsync(snap2, contracts, "record GetOrderQuery", 7);
        var after = await c.RelatedAsync(snap2, s2.GetProperty("symbolId").GetString()!);
        Assert.Equal(0, CountKind(after, "mediatr.send"));
        Assert.Equal(0, CountKind(after, "aspnet.endpoint"));
        Assert.Equal(original, await File.ReadAllTextAsync(program)); // the host never writes files

        // didClose drops the overlay: disk text is used again.
        await c.DidCloseAsync(program);
        var snap3 = await c.BarrierAsync();
        var s3 = await c.SymbolAtTextAsync(snap3, contracts, "record GetOrderQuery", 7);
        Assert.Equal(1, CountKind(await c.RelatedAsync(snap3, s3.GetProperty("symbolId").GetString()!), "mediatr.send"));
    }

    [Fact]
    public async Task Utf16PositionsWithEmojiAndCrlf()
    {
        var (c, dir) = await OpenCopyAsync();
        await using var _ = c;
        var file = Path.Combine(dir, "Shop.Api", "Services", "OrderMetricsUser.cs");
        var text = "using Shop.Api.Generated;\r\n\r\nnamespace Shop.Api.Services;\r\n\r\n// 🚀 emoji 👩‍👩‍👧 before code\r\npublic static class OrderMetricsUser\r\n{\r\n    /* 🚀🚀 */ public static int Count() => OrderMetrics.Requests + Count2();\r\n    public static int Count2() => 0; // 🚀\r\n}\r\n";
        await c.DidOpenAsync(file, text);
        var snap = await c.BarrierAsync();

        var (line, ch) = TestClient.Position(text.Replace("\r\n", "\n"), "Count2()");
        Assert.Equal(7, line);
        Assert.Equal(text.Split("\r\n")[7].IndexOf("Count2()", StringComparison.Ordinal), ch); // UTF-16 code units: each 🚀 counts 2
        var s = await c.SymbolAtAsync(snap, file, line, ch);
        Assert.Equal("Count2", s.GetProperty("name").GetString());
        var decl = s.GetProperty("location").GetProperty("range").GetProperty("start");
        Assert.Equal(8, decl.GetProperty("line").GetInt32());
        Assert.Equal(22, decl.GetProperty("character").GetInt32());

        var r = await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "Total");
        Assert.Equal("prepared", r.GetProperty("kind").GetString());
        var change = Assert.Single(r.GetProperty("plan").GetProperty("writeSet").EnumerateArray());
        Assert.Equal(Hashing.Sha256Text(text), change.GetProperty("expectedHash").GetString());
        var applied = ShopTests.Apply(text, change.GetProperty("edits"));
        Assert.Equal(text.Replace("Count2", "Total"), applied);
        Assert.Equal(Hashing.Sha256Text(applied), change.GetProperty("resultHash").GetString());
    }

    [Fact]
    public async Task RevalidateIsStaleAfterDiskEditOfANonEditedDependencyFile()
    {
        var (c, dir) = await OpenCopyAsync();
        await using var _ = c;
        var contracts = Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs");
        var services = Path.Combine(dir, "Shop.Api", "Services", "OrderServices.cs");
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, contracts, "record GetOrderQuery", 7);
        var plan = (await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "FetchOrderQuery")).GetProperty("plan");
        Assert.DoesNotContain(plan.GetProperty("writeSet").EnumerateArray(), w => w.GetProperty("uri").GetString() == UriPaths.ToUri(services));
        var planId = plan.GetProperty("planId").GetString()!;
        Assert.Equal("valid", (await c.RevalidateAsync(snap, planId)).GetProperty("status").GetString());

        await File.AppendAllTextAsync(services, "\n// touched\n");
        var r = await c.RevalidateAsync(await c.BarrierAsync(), planId);
        Assert.Equal("stale", r.GetProperty("status").GetString());
        Assert.Equal("ReadSetChanged", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task RevalidateIsStaleAfterUnsavedEditOfANonEditedDependencyFile()
    {
        var (c, dir) = await OpenCopyAsync();
        await using var _ = c;
        var contracts = Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs");
        var services = Path.Combine(dir, "Shop.Api", "Services", "OrderServices.cs");
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, contracts, "record GetOrderQuery", 7);
        var planId = (await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "FetchOrderQuery")).GetProperty("plan").GetProperty("planId").GetString()!;

        var text = await File.ReadAllTextAsync(services);
        await c.DidOpenAsync(services, text);
        var unchanged = await c.BarrierAsync();
        Assert.Equal("valid", (await c.RevalidateAsync(unchanged, planId)).GetProperty("status").GetString());
        await c.DidChangeAsync(services, text + "\n// dirty buffer\n");
        var r = await c.RevalidateAsync(await c.BarrierAsync(), planId);
        Assert.Equal("stale", r.GetProperty("status").GetString());
    }

    [Fact]
    public async Task RevalidateIsStaleAfterProjectFileOrBuildInputChange()
    {
        var (c, dir) = await OpenCopyAsync();
        await using var _ = c;
        var contracts = Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs");
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, contracts, "record GetOrderQuery", 7);
        var id = s.GetProperty("symbolId").GetString()!;
        var plan1 = (await c.PrepareRenameAsync(snap, id, "FetchOrderQuery")).GetProperty("plan").GetProperty("planId").GetString()!;

        var csproj = Path.Combine(dir, "Shop.Api", "Shop.Api.csproj");
        await File.WriteAllTextAsync(csproj, (await File.ReadAllTextAsync(csproj)).Replace("</Project>", "  <!-- changed -->\n</Project>"));
        var r1 = await c.RevalidateAsync(await c.BarrierAsync(), plan1);
        Assert.Equal("stale", r1.GetProperty("status").GetString());
        Assert.Contains("Shop.Api.csproj", r1.GetProperty("message").GetString());

        // A new Directory.Build.props next to a project (absent before) also invalidates.
        var snap2 = await c.BarrierAsync();
        var s2 = await c.SymbolAtTextAsync(snap2, contracts, "record GetOrderQuery", 7);
        await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Api", "Shop.Api.csproj"), await File.ReadAllTextAsync(csproj)); // unchanged content
        var plan2 = (await c.PrepareRenameAsync(snap2, s2.GetProperty("symbolId").GetString()!, "FetchOrderQuery")).GetProperty("plan").GetProperty("planId").GetString()!;
        Assert.Equal("valid", (await c.RevalidateAsync(snap2, plan2)).GetProperty("status").GetString());
        await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Contracts", "Directory.Build.props"), "<Project />");
        Assert.Equal("stale", (await c.RevalidateAsync(await c.BarrierAsync(), plan2)).GetProperty("status").GetString());

        // A new source file under a project directory (Compile glob membership) invalidates.
        File.Delete(Path.Combine(dir, "Shop.Contracts", "Directory.Build.props"));
        var snap3 = await c.BarrierAsync();
        var s3 = await c.SymbolAtTextAsync(snap3, contracts, "record GetOrderQuery", 7);
        var plan3 = (await c.PrepareRenameAsync(snap3, s3.GetProperty("symbolId").GetString()!, "FetchOrderQuery")).GetProperty("plan").GetProperty("planId").GetString()!;
        Assert.Equal("valid", (await c.RevalidateAsync(snap3, plan3)).GetProperty("status").GetString());
        await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Api", "NewFile.cs"), "namespace Shop.Api; public class FetchOrderQuery { }");
        Assert.Equal("stale", (await c.RevalidateAsync(await c.BarrierAsync(), plan3)).GetProperty("status").GetString());
    }
}

public sealed class BrokenFixtureTests
{
    [Fact]
    public async Task MissingProjectReferenceGivesPartialStateButLoadedProjectIsServed()
    {
        await Fixtures.EnsureRestoredAsync(Fixtures.BrokenSln, allowFailure: true);
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(Fixtures.BrokenSln);
        Assert.Equal("Partial", status.GetProperty("state").GetString());
        Assert.Equal("PartialLoad", status.GetProperty("reasonCode").GetString());
        var project = Assert.Single(status.GetProperty("projects").EnumerateArray());
        Assert.Equal("partial", project.GetProperty("state").GetString());
        Assert.Contains(project.GetProperty("diagnostics").EnumerateArray(), d => d.GetProperty("message").GetString()!.Contains("Missing.Lib"));

        var widget = Path.Combine(Path.GetDirectoryName(Fixtures.BrokenSln)!, "Broken.App", "Widget.cs");
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, widget, "class Widget", 6);
        Assert.Equal("Widget", s.GetProperty("name").GetString());
        var related = await c.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
        Assert.Equal("partial", related.GetProperty("completeness").GetString());
        Assert.NotEmpty(related.GetProperty("scopeNotes").EnumerateArray());
        // Structured scope (additive): counts and the cause, so the client can explain it in plain language.
        var details = related.GetProperty("scopeDetails");
        Assert.Equal(1, details.GetProperty("projectsTotal").GetInt32());
        Assert.Equal(0, details.GetProperty("projectsComplete").GetInt32());
        Assert.Equal(1, details.GetProperty("projectsPartial").GetInt32());
        Assert.Equal(0, details.GetProperty("projectsFailed").GetInt32());
        Assert.Equal(1, details.GetProperty("causes").GetProperty("missingProjectReferences").GetInt32());
        Assert.False(details.GetProperty("restoreRecommended").GetBoolean());
        Assert.EndsWith(".sln", details.GetProperty("solutionPath").GetString());

        var r = await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "Gadget");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("IncompleteProjectClosure", r.GetProperty("reasonCode").GetString());

        var caps = await c.RequestAsync("capability/query", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap });
        var nav = caps.EnumerateArray().Single(a => a.GetProperty("capabilityId").GetString() == "csharp.find");
        Assert.Equal("limited", nav.GetProperty("state").GetString());
        Assert.Equal("refyntra.showHealth", nav.GetProperty("recoveryActions")[0].GetProperty("command").GetString());
    }

    [Fact]
    public async Task MissingAssetsAreReportedWithRestoreRecovery()
    {
        var work = Path.Combine(AppContext.BaseDirectory, "work", "noassets-" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Directory.CreateDirectory(Path.Combine(work, "Lib"));
        foreach (var f in Directory.EnumerateFiles(Fixtures.FixturesDir, "Directory.*")) File.Copy(f, Path.Combine(work, Path.GetFileName(f)));
        var csproj = Path.Combine(work, "Lib", "Lib.csproj");
        await File.WriteAllTextAsync(csproj, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        await File.WriteAllTextAsync(Path.Combine(work, "Lib", "A.cs"), "namespace Lib; public class A { }");
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(csproj);
        Assert.Equal("Partial", status.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("solutionPath").ValueKind);
        var project = Assert.Single(status.GetProperty("projects").EnumerateArray());
        Assert.Contains(project.GetProperty("diagnostics").EnumerateArray(), d => d.GetProperty("message").GetString()!.Contains("Run dotnet restore"));
        Assert.False(File.Exists(Path.Combine(work, "Lib", "obj", "project.assets.json"))); // no automatic restore
    }
}
