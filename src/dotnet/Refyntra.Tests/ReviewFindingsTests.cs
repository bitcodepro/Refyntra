using System.Text;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Regression tests for the review findings (S = safety, R = robustness, C = contract). Every test that changes files
/// works on its own copy of a fixture; tests/fixtures is never modified.
/// </summary>
public sealed class ReviewFindingsTests
{
    // ------------------------------------------------------------------ helpers

    private static async Task<(TestClient c, string dir, string sln)> OpenCopyAsync(string fixture, string slnFile, Func<string, Task>? beforeOpen = null, string? openPath = null)
    {
        var sln = await Fixtures.CopyAsync(fixture, slnFile);
        var dir = Path.GetDirectoryName(sln)!;
        if (beforeOpen != null) await beforeOpen(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(openPath?.Replace("{dir}", dir) ?? sln);
        Assert.True(status.GetProperty("state").GetString() == "Ready", status.ToString());
        return (c, dir, sln);
    }

    /// <summary>Adds a project to a fixture copy (and to its solution), then restores the solution.</summary>
    private static async Task AddProjectAsync(string dir, string sln, string name, string csproj, params (string file, string text)[] files)
    {
        var pdir = Path.Combine(dir, name);
        Directory.CreateDirectory(pdir);
        var path = Path.Combine(pdir, name + ".csproj");
        await File.WriteAllTextAsync(path, csproj);
        foreach (var (file, text) in files) await File.WriteAllTextAsync(Path.Combine(pdir, file), text);
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "sln", sln, "add", path }, dir, TimeSpan.FromMinutes(2));
        Assert.True(code == 0, output);
        await RestoreAsync(sln);
    }

    private static async Task RestoreAsync(string sln)
    {
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "restore", sln, "--nologo" }, Path.GetDirectoryName(sln)!, TimeSpan.FromMinutes(5));
        Assert.True(code == 0, output);
    }

    private static async Task<JsonElement> PrepareAsync(TestClient c, string file, string needle, int offset, string newName)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        return await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, newName);
    }

    private static async Task<string> PreparedPlanIdAsync(TestClient c, string file, string needle, int offset, string newName)
    {
        var r = await PrepareAsync(c, file, needle, offset, newName);
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan").GetProperty("planId").GetString()!;
    }

    private static async Task<JsonElement> RevalidateAsync(TestClient c, string planId) => await c.RevalidateAsync(await c.BarrierAsync(), planId);

    private static async Task<List<string>> SearchAsync(TestClient c, string query)
    {
        var snap = await c.BarrierAsync();
        var r = await c.RequestAsync("code/search", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, query, filters = new { }, limit = 50 });
        return r.GetProperty("items").EnumerateArray().Where(i => i.TryGetProperty("symbol", out var s) && s.ValueKind == JsonValueKind.Object)
            .Select(i => i.GetProperty("symbol").GetProperty("name").GetString()!).ToList();
    }

    private static async Task<JsonElement> WaitForUnsolicitedAsync(TestClient c, long id, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            foreach (var m in c.Unsolicited)
                if (m.TryGetProperty("id", out var mid) && mid.ValueKind == JsonValueKind.Number && mid.GetInt64() == id) return m;
            await Task.Delay(20);
        }
        throw new TimeoutException("no response with id " + id);
    }

    // ------------------------------------------------------------------ R1 malformed frame with an unparseable id

    [Fact]
    public async Task R1_MalformedFrameWithAnUnparseableRecoveredIdDoesNotCrashTheHost()
    {
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        // The id regex accepts "\q" as a JSON string, but JSON does not: parsing the recovered id must not throw out of the server.
        await c.SendRawAsync(Encoding.UTF8.GetBytes("{\"id\":\"\\q\","));
        await c.SendRawAsync(Encoding.UTF8.GetBytes("{\"id\":\"\\u12\","));
        var status = await c.RequestAsync("engine/status", new { traceId = "t" }, TimeSpan.FromSeconds(10));
        Assert.Equal("NotStarted", status.GetProperty("state").GetString());
        Assert.False(c.ServerTask!.IsCompleted);
    }

    // ------------------------------------------------------------------ R2 cancel vs completion race

    [Fact]
    public async Task R2_CancelRacingWithCompletionNeverKillsTheHost()
    {
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var stress = Task.Run(async () =>
        {
            for (var round = 0; round < 20 && !c.ServerTask!.IsCompleted; round++)
            {
                var pending = new List<Task<JsonElement>>();
                for (var i = 0; i < 200 && !c.ServerTask!.IsCompleted; i++)
                {
                    var id = c.NextId();
                    pending.Add(c.RawRequestAsync("engine/status", new { traceId = "t" }, id, TimeSpan.FromSeconds(30)));
                    // Several cancels per request widen the window between "pending lookup" and "completion disposes the CTS".
                    for (var k = 0; k < 3; k++) await c.NotifyAsync("$/cancelRequest", new { id });
                }
                await Task.WhenAll(pending);
            }
        });
        // A dead server stops reading its input, so a writer can block: bound the whole stress run.
        await Task.WhenAny(stress, c.ServerTask!, Task.Delay(TimeSpan.FromMinutes(2)));
        Assert.False(c.ServerTask!.IsCompleted, "the host exited during the cancel stress: " + (c.ServerTask.IsFaulted ? c.ServerTask.Exception!.InnerException!.GetType().Name : "exit"));
        Assert.True(stress.IsCompletedSuccessfully, "the stress run did not finish");
        var status = await c.RequestAsync("engine/status", new { traceId = "t" });
        Assert.Equal("NotStarted", status.GetProperty("state").GetString());
        await c.DisposeAsync();
    }

    // ------------------------------------------------------------------ R3 barrier waiters

    [Fact]
    public async Task R3_CancelledBarrierWaitersAreRemovedAndCloseGivesWorkspaceNotLoaded()
    {
        var (c, _, _) = await OpenCopyAsync("Renames", "Renames.sln");
        await using var _c = c;
        var session = c.Engine!.FindSession(c.WorkspaceId)!;
        for (var i = 0; i < 5; i++)
        {
            var id = c.NextId();
            var t = c.RawRequestAsync("workspace/snapshotBarrier", new { traceId = "t", workspaceId = c.WorkspaceId, sequence = 1000 + i }, id, TimeSpan.FromSeconds(20));
            await Task.Delay(100);
            await c.NotifyAsync("$/cancelRequest", new { id });
            var r = await t;
            Assert.Equal(-32800, r.GetProperty("error").GetProperty("code").GetInt32());
        }
        Assert.Equal(0, session.PendingBarrierCount);

        var waiting = c.RawRequestAsync("workspace/snapshotBarrier", new { traceId = "t", workspaceId = c.WorkspaceId, sequence = 5000 }, null, TimeSpan.FromSeconds(20));
        await Task.Delay(200);
        await c.RequestAsync("workspace/close", new { traceId = "t", workspaceId = c.WorkspaceId });
        var closed = await waiting;
        Assert.Equal(-33006, closed.GetProperty("error").GetProperty("code").GetInt32());
        Assert.Equal("WorkspaceNotLoaded", closed.GetProperty("error").GetProperty("data").GetProperty("reasonCode").GetString());
    }

    // ------------------------------------------------------------------ R5 (host part) barrier timeout code

    [Fact]
    public async Task R5_BarrierTimeoutHasItsOwnContractErrorCode()
    {
        var (c, _, _) = await OpenCopyAsync("Renames", "Renames.sln");
        await using var _c = c;
        c.Engine!.BarrierTimeout = TimeSpan.FromMilliseconds(300);
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.RequestAsync("workspace/snapshotBarrier", new { traceId = "t", workspaceId = c.WorkspaceId, sequence = 77 }));
        Assert.Equal(-33008, ex.Code);
        Assert.Equal("BarrierTimeout", ex.ReasonCode);
        Assert.Equal(0, c.Engine.FindSession(c.WorkspaceId)!.PendingBarrierCount);
    }

    // ------------------------------------------------------------------ R4 didClose of a missing file

    [Fact]
    public async Task R4_DidCloseOfADeletedFileDropsTheOverlayAndTheDocument()
    {
        var (c, dir, _) = await OpenCopyAsync("Shop", "Shop.sln");
        await using var _c = c;
        var file = Path.Combine(dir, "Shop.Api", "Services", "OrderMetricsUser.cs");
        var text = await File.ReadAllTextAsync(file);
        await c.DidOpenAsync(file, text + "\nnamespace Shop.Api.Services { public sealed class OverlayOnlyType { } }\n");
        Assert.Contains("OverlayOnlyType", await SearchAsync(c, "OverlayOnlyType"));
        File.Delete(file);
        await c.DidCloseAsync(file);
        Assert.DoesNotContain("OverlayOnlyType", await SearchAsync(c, "OverlayOnlyType"));
        Assert.DoesNotContain("OrderMetricsUser", await SearchAsync(c, "OrderMetricsUser"));
        // Re-creating the file and opening it again brings the document back.
        await File.WriteAllTextAsync(file, text);
        await c.DidOpenAsync(file, text);
        Assert.Contains("OrderMetricsUser", await SearchAsync(c, "OrderMetricsUser"));
    }

    // ------------------------------------------------------------------ R7 composition roots of two apps

    [Fact]
    public async Task R7_TopLevelProgramsOfTwoAppsAreDifferentCompositionRoots()
    {
        var (c, dir, _) = await OpenCopyAsync("Shop", "Shop.sln", async d =>
        {
            var sln = Path.Combine(d, "Shop.sln");
            await File.WriteAllTextAsync(Path.Combine(d, "Shop.Contracts", "Pinger.cs"), "namespace Shop.Contracts;\npublic interface IPinger { }\npublic sealed class Pinger : IPinger { }\npublic sealed class OtherPinger : IPinger { }\n");
            var program = Path.Combine(d, "Shop.Api", "Program.cs");
            await File.WriteAllTextAsync(program, (await File.ReadAllTextAsync(program)).Replace("var app = builder.Build();", "builder.Services.AddSingleton<Shop.Contracts.IPinger, Shop.Contracts.Pinger>();\n\nvar app = builder.Build();"));
            await AddProjectAsync(d, sln, "Shop.Worker",
                "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>"
                + "<ItemGroup><ProjectReference Include=\"..\\Shop.Contracts\\Shop.Contracts.csproj\" /></ItemGroup></Project>",
                ("Program.cs", "using Shop.Contracts;\nvar b = WebApplication.CreateBuilder(args);\nb.Services.AddSingleton<IPinger, OtherPinger>();\nb.Build().Run();\n"));
        });
        await using var _c = c;
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, Path.Combine(dir, "Shop.Contracts", "Pinger.cs"), "interface IPinger", 10);
        var related = await c.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
        var regs = related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == "di.registration").ToList();
        Assert.True(regs.Count == 2, related.ToString());
        var roots = regs.Select(r => r.GetProperty("target").GetProperty("registration").GetProperty("compositionRoot").GetString()!).ToList();
        Assert.Equal(2, roots.Distinct().Count());
        Assert.Contains(roots, r => r.Contains("Shop.Api", StringComparison.Ordinal));
        Assert.Contains(roots, r => r.Contains("Shop.Worker", StringComparison.Ordinal));
        var impls = related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == "di.implementation")
            .Select(r => r.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()!).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "OtherPinger", "Pinger" }, impls);
    }

    // ------------------------------------------------------------------ R8 compilation delta per location

    [Fact]
    public async Task R8_ANewErrorThatReplacesAFixedOneOfTheSameIdIsDetected()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", d => File.WriteAllTextAsync(Path.Combine(d, "Renames.Lib", "Dupes.cs"),
            "namespace Renames.Lib;\npublic class Dupes\n{\n    public void Alpha() { }\n    public void Beta() { }\n    public void Beta() { }\n}\n"));
        await using var _c = c;
        // Before: one CS0111 (the second Beta). After renaming the first Beta to Alpha: Beta is fixed, Alpha is a new CS0111.
        var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Dupes.cs"), "void Beta", 5, "Alpha");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("RenameConflict", r.GetProperty("reasonCode").GetString());
    }

    // ------------------------------------------------------------------ S2 projects outside the closure

    [Fact]
    public async Task S2_AProjectOutsideTheClosureThatStartsReferencingTheOwnerMakesThePlanStale()
    {
        string? other = null;
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", async d =>
        {
            await AddProjectAsync(d, Path.Combine(d, "Renames.sln"), "Renames.Other",
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>",
                ("Other.cs", "namespace Renames.Other;\npublic class Other { }\n"));
            other = Path.Combine(d, "Renames.Other");
        });
        await using var _c = c;
        var planId = await PreparedPlanIdAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("valid", (await RevalidateAsync(c, planId)).GetProperty("status").GetString());
        var csproj = Path.Combine(other!, "Renames.Other.csproj");
        await File.WriteAllTextAsync(csproj, (await File.ReadAllTextAsync(csproj)).Replace("</Project>",
            "<ItemGroup><ProjectReference Include=\"..\\Renames.Lib\\Renames.Lib.csproj\" /></ItemGroup></Project>"));
        await File.WriteAllTextAsync(Path.Combine(other!, "UsesWidget.cs"), "namespace Renames.Other;\npublic class UsesWidget { public Renames.Lib.Widget W = new(); }\n");
        var r = await RevalidateAsync(c, planId);
        Assert.Equal("stale", r.GetProperty("status").GetString());
        Assert.Equal("ReadSetChanged", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task S2_ProjectOnlyWorkspaceFingerprintsSiblingProjectFiles()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", openPath: Path.Combine("{dir}", "Renames.Lib", "Renames.Lib.csproj"));
        await using var _c = c;
        var planId = await PreparedPlanIdAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("valid", (await RevalidateAsync(c, planId)).GetProperty("status").GetString());
        Directory.CreateDirectory(Path.Combine(dir, "Renames.Other"));
        await File.WriteAllTextAsync(Path.Combine(dir, "Renames.Other", "Renames.Other.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include=\"..\\Renames.Lib\\Renames.Lib.csproj\" /></ItemGroup></Project>");
        Assert.Equal("stale", (await RevalidateAsync(c, planId)).GetProperty("status").GetString());
    }

    // ------------------------------------------------------------------ S3 limited never becomes valid

    [Fact]
    public async Task S3_ALimitedPlanRevalidatesAsLimitedWithTheSameLimitations()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", d =>
        {
            var csproj = Path.Combine(d, "Renames.Lib", "Renames.Lib.csproj");
            return File.WriteAllTextAsync(csproj, File.ReadAllText(csproj).Replace("</Project>",
                "  <Import Project=\"$(SomeUnknownDir)x.props\" Condition=\"Exists('$(SomeUnknownDir)x.props')\" />\n</Project>"));
        });
        await using var _c = c;
        var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        var plan = r.GetProperty("plan");
        Assert.Equal("limited", plan.GetProperty("validation").GetProperty("status").GetString());
        var v = await RevalidateAsync(c, plan.GetProperty("planId").GetString()!);
        Assert.Equal("limited", v.GetProperty("status").GetString());
        var limits = v.GetProperty("limitations").EnumerateArray().Select(x => x.GetString()).ToList();
        Assert.Equal(plan.GetProperty("limitations").EnumerateArray().Select(x => x.GetString()).ToList(), limits);
        Assert.Contains(limits, l => l!.Contains("$(SomeUnknownDir)x.props"));
    }

    // ------------------------------------------------------------------ S4 reload during prepare

    [Fact]
    public async Task S4_APlanPreparedAcrossAReloadIsNeverUsable()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln");
        await using var _c = c;
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6);
        var prepare = c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "Thing");
        var reload = c.RequestAsync("workspace/reload", new { traceId = "t", workspaceId = c.WorkspaceId }, TimeSpan.FromMinutes(5));
        var r = await prepare;
        await reload;
        if (r.GetProperty("kind").GetString() == "prepared")
        {
            var v = await RevalidateAsync(c, r.GetProperty("plan").GetProperty("planId").GetString()!);
            Assert.NotEqual("valid", v.GetProperty("status").GetString());
        }
        else
        {
            Assert.Equal("WorkspaceReloaded", r.GetProperty("reasonCode").GetString());
        }
        Assert.Equal(0, c.Engine!.Plans.Count);
    }

    // ------------------------------------------------------------------ S5 encodings

    private static readonly byte[] Cp1251Comment = { 0x2f, 0x2f, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a };

    [Fact]
    public async Task S5_PrepareRefusesANonUtf8TargetNamingTheFile()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", d => File.WriteAllBytesAsync(Path.Combine(d, "Renames.App", "Legacy1251.cs"),
            Cp1251Comment.Concat(Encoding.ASCII.GetBytes("namespace Renames.App;\r\npublic static class Legacy1251 { public static Renames.Lib.Widget Make() => new(); }\r\n")).ToArray()));
        await using var _c = c;
        var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("UnsupportedEncoding", r.GetProperty("reasonCode").GetString());
        Assert.Contains("Legacy1251.cs", r.GetProperty("message").GetString());
    }

    [Fact]
    public async Task S5_ALegacyEncodedFileOutsideTheWriteSetDoesNotMakeEveryPlanStale()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", d => File.WriteAllBytesAsync(Path.Combine(d, "Renames.App", "Legacy1251.cs"),
            Cp1251Comment.Concat(Encoding.ASCII.GetBytes("namespace Renames.App;\r\npublic static class Legacy1251 { }\r\n")).ToArray()));
        await using var _c = c;
        var planId = await PreparedPlanIdAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("valid", (await RevalidateAsync(c, planId)).GetProperty("status").GetString());
        // A real change of that file is still detected.
        await File.WriteAllBytesAsync(Path.Combine(dir, "Renames.App", "Legacy1251.cs"),
            Cp1251Comment.Concat(Encoding.ASCII.GetBytes("namespace Renames.App;\r\npublic static class Legacy1251 { int x; }\r\n")).ToArray());
        Assert.Equal("stale", (await RevalidateAsync(c, planId)).GetProperty("status").GetString());
    }

    // ------------------------------------------------------------------ S6 mixed line endings

    [Fact]
    public async Task S6_PrepareRefusesATargetWithMixedLineEndings()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln", d =>
        {
            var program = Path.Combine(d, "Renames.App", "Program.cs");
            var text = File.ReadAllText(program).Replace("\r\n", "\n");
            var lines = text.Split('\n');
            // CRLF on the first lines, LF on the rest.
            return File.WriteAllTextAsync(program, string.Join("\r\n", lines.Take(3)) + "\r\n" + string.Join("\n", lines.Skip(3)));
        });
        await using var _c = c;
        var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("MixedLineEndings", r.GetProperty("reasonCode").GetString());
        Assert.Contains("Program.cs", r.GetProperty("message").GetString());
    }

    // ------------------------------------------------------------------ C1 / C3 capability catalogue and guarantees

    public static readonly string[] Catalogue = { "csharp.find", "csharp.related", "csharp.rename", "csharp.references" };

    [Fact]
    public async Task C1_CapabilityQueryAndInitializeUseTheCatalogueAndRelatedIsAvailableWithoutFrameworks()
    {
        var (c, dir, _) = await OpenCopyAsync("Renames", "Renames.sln");
        await using var _c = c;
        var snap = await c.BarrierAsync();
        var text = await File.ReadAllTextAsync(Path.Combine(dir, "Renames.Lib", "Widget.cs"));
        var (line, ch) = TestClient.Position(text, "class Widget", 6);
        var caps = await c.RequestAsync("capability/query", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Path.Combine(dir, "Renames.Lib", "Widget.cs")), position = new { line, character = ch } });
        var byId = caps.EnumerateArray().ToDictionary(a => a.GetProperty("capabilityId").GetString()!);
        Assert.Equal(Catalogue.OrderBy(x => x), byId.Keys.OrderBy(x => x));
        foreach (var id in Catalogue)
        {
            Assert.Equal("available", byId[id].GetProperty("state").GetString());
            Assert.Equal("owned-semantic", byId[id].GetProperty("guarantee").GetString());
        }
        // No MediatR / ASP.NET Core in this solution: Related is still available; the missing frameworks are limitations.
        Assert.Contains(byId["csharp.related"].GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("MediatR"));

        await using var fresh = TestClient.InProcess();
        var init = await fresh.InitializeAsync();
        Assert.Equal(Catalogue, init.GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()).ToArray());
    }
}
