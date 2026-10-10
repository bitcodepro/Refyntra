using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Stage C: read-set invalidation sources, epoch/reload, golden diffs for nameof/aliases/partial/
/// overloads, guards and the compilation baseline delta. Every test works on its own copy of a fixture.
/// </summary>
public sealed class SafeRenameTests
{
    private static async Task<(TestClient c, string dir)> OpenAsync(string fixture, string sln, Action<string>? beforeOpen = null)
    {
        var path = await Fixtures.CopyAsync(fixture, sln);
        var dir = Path.GetDirectoryName(path)!;
        beforeOpen?.Invoke(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, dir);
    }

    private static async Task<JsonElement> PrepareAsync(TestClient c, string file, string needle, int offset, string newName)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        return await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, newName);
    }

    private static async Task<(JsonElement plan, string planId)> PreparedAsync(TestClient c, string file, string needle, int offset, string newName)
    {
        var r = await PrepareAsync(c, file, needle, offset, newName);
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        var plan = r.GetProperty("plan");
        return (plan, plan.GetProperty("planId").GetString()!);
    }

    private static async Task<string> StatusAsync(TestClient c, string planId) =>
        (await c.RevalidateAsync(await c.BarrierAsync(), planId)).GetProperty("status").GetString()!;

    private static Dictionary<string, string> Snapshot(string dir) =>
        Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar) && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar))
            .ToDictionary(f => f, f => Hashing.FileBytes(f));

    // ------------------------------------------------------------------ read set

    [Fact]
    public async Task ReadSetCoversReverseDependentsNonEditedSourcesAndBuildInputs()
    {
        var (c, dir) = await OpenAsync("Shop", "Shop.sln");
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs"), "record GetOrderQuery", 7, "FetchOrderQuery");
        var inputs = plan.GetProperty("readSet").EnumerateArray().Select(e => e.GetProperty("input").GetString()!).ToList();
        bool Has(params string[] parts) => inputs.Contains(Path.Combine(new[] { dir }.Concat(parts).ToArray()), StringComparer.OrdinalIgnoreCase);
        // Reverse dependent (Shop.Api uses Shop.Contracts) incl. a source the rename does not edit.
        Assert.True(Has("Shop.Api", "Services", "OrderServices.cs"));
        Assert.True(Has("Shop.Api", "Shop.Api.csproj"));
        Assert.True(Has("Shop.Contracts", "Shop.Contracts.csproj"));
        Assert.True(Has("Shop.sln"));
        Assert.True(Has("Shop.Api", "obj", "project.assets.json"));
        Assert.True(Has("global.json") || inputs.Any(i => i.EndsWith("global.json", StringComparison.OrdinalIgnoreCase)));
        Assert.Contains(inputs, i => i.EndsWith(".editorconfig", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(inputs, i => i.EndsWith("Directory.Packages.props", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(inputs, i => i.StartsWith("membership:", StringComparison.Ordinal) && i.EndsWith("Shop.Api", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(inputs, i => i.StartsWith("documents:", StringComparison.Ordinal));
        Assert.Equal(2, plan.GetProperty("projectContextIds").GetArrayLength());
    }

    [Theory]
    [InlineData("assets")]
    [InlineData("sln")]
    [InlineData("global.json")]
    [InlineData("editorconfig")]
    [InlineData("packages.props")]
    [InlineData("new-file-in-reverse-dependent")]
    [InlineData("deleted-file")]
    public async Task EachInvalidationSourceMakesThePlanStale(string source)
    {
        var (c, dir) = await OpenAsync("Shop", "Shop.sln");
        await using var _ = c;
        var (_, planId) = await PreparedAsync(c, Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs"), "record GetOrderQuery", 7, "FetchOrderQuery");
        Assert.Equal("valid", await StatusAsync(c, planId));
        switch (source)
        {
            case "assets":
                await File.AppendAllTextAsync(Path.Combine(dir, "Shop.Api", "obj", "project.assets.json"), " ");
                break;
            case "sln":
                await File.AppendAllTextAsync(Path.Combine(dir, "Shop.sln"), "\r\n");
                break;
            case "global.json":
                await File.WriteAllTextAsync(Path.Combine(dir, "global.json"), "{ }");
                break;
            case "editorconfig":
                await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Api", ".editorconfig"), "root = false\n");
                break;
            case "packages.props":
                await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Contracts", "Directory.Packages.props"), "<Project />");
                break;
            case "new-file-in-reverse-dependent":
                Directory.CreateDirectory(Path.Combine(dir, "Shop.Api", "Deep", "Er"));
                await File.WriteAllTextAsync(Path.Combine(dir, "Shop.Api", "Deep", "Er", "FetchOrderQuery.cs"), "namespace Shop.Api; class FetchOrderQuery { }");
                break;
            case "deleted-file":
                File.Delete(Path.Combine(dir, "Shop.Api", "Legacy", "LegacyMessaging.cs"));
                break;
        }
        var r = await c.RevalidateAsync(await c.BarrierAsync(), planId);
        Assert.Equal("stale", r.GetProperty("status").GetString());
        Assert.Equal("ReadSetChanged", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task ExplicitImportsAreFingerprintedAndComputedImportsMakeThePlanLimited()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln", d =>
        {
            File.WriteAllText(Path.Combine(d, "Renames.Lib", "Shared.props"), "<Project />");
            var csproj = Path.Combine(d, "Renames.Lib", "Renames.Lib.csproj");
            File.WriteAllText(csproj, File.ReadAllText(csproj).Replace("</Project>",
                "  <Import Project=\"Shared.props\" />\n  <Import Project=\"$(SomeUnknownDir)x.props\" Condition=\"Exists('$(SomeUnknownDir)x.props')\" />\n</Project>"));
        });
        await using var _ = c;
        var (plan, planId) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Contains(plan.GetProperty("readSet").EnumerateArray(), e => e.GetProperty("input").GetString()!.EndsWith("Shared.props", StringComparison.Ordinal));
        Assert.Equal("limited", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("$(SomeUnknownDir)x.props"));
        Assert.Equal("limited", await StatusAsync(c, planId)); // never upgraded to valid (review S3)
        await File.WriteAllTextAsync(Path.Combine(dir, "Renames.Lib", "Shared.props"), "<Project><PropertyGroup /></Project>");
        Assert.Equal("stale", await StatusAsync(c, planId));
    }

    [Fact]
    public async Task AfterReloadThePlanIsStaleAndAnotherHostDoesNotKnowIt()
    {
        var (c, dir) = await OpenAsync("Shop", "Shop.sln");
        await using var _ = c;
        var contracts = Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs");
        var (plan, planId) = await PreparedAsync(c, contracts, "record GetOrderQuery", 7, "FetchOrderQuery");
        var epoch = plan.GetProperty("sessionEpoch").GetString();

        await c.RequestAsync("workspace/reload", new { traceId = "t", workspaceId = c.WorkspaceId }, TimeSpan.FromMinutes(5));
        var r = await c.RevalidateAsync(await c.BarrierAsync(), planId);
        // Reload drops the plans of the workspace: never "valid" (stale/WorkspaceReloaded or invalid/UnknownPlan).
        Assert.NotEqual("valid", r.GetProperty("status").GetString());
        Assert.Contains(r.GetProperty("reasonCode").GetString(), new[] { "WorkspaceReloaded", "UnknownPlan" });

        // A new host process (= new epoch, e.g. after a crash) never accepts a plan from the old one.
        await using var other = TestClient.InProcess();
        var init = await other.InitializeAsync();
        Assert.NotEqual(epoch, init.GetProperty("sessionEpoch").GetString());
        await other.OpenAsync(Path.Combine(dir, "Shop.sln"));
        var r2 = await other.RequestAsync("refactor/revalidate", new { traceId = "t", workspaceId = other.WorkspaceId, snapshotId = await other.BarrierAsync(), planId });
        Assert.Equal("invalid", r2.GetProperty("status").GetString());
        Assert.Equal("UnknownPlan", r2.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task PrepareRevalidateAndDiscardNeverWriteFiles()
    {
        var (c, dir) = await OpenAsync("Shop", "Shop.sln");
        await using var _ = c;
        var before = Snapshot(dir);
        var (_, planId) = await PreparedAsync(c, Path.Combine(dir, "Shop.Contracts", "Orders", "OrderRequests.cs"), "record GetOrderQuery", 7, "FetchOrderQuery");
        Assert.Equal("valid", await StatusAsync(c, planId));
        await c.NotifyAsync("refactor/discard", new { workspaceId = c.WorkspaceId, planId });
        var r = await c.RevalidateAsync(await c.BarrierAsync(), planId);
        Assert.Equal("invalid", r.GetProperty("status").GetString());
        Assert.Equal(before, Snapshot(dir));
    }

    // ------------------------------------------------------------------ golden diffs

    private static string GoldenDir => Path.Combine(Fixtures.FixturesDir, "Renames.golden");

    private static async Task AssertGoldenAsync(string caseName, string dir, JsonElement plan)
    {
        var actual = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var change in plan.GetProperty("writeSet").EnumerateArray())
        {
            var path = UriPaths.ToPath(change.GetProperty("uri").GetString()!);
            var text = await File.ReadAllTextAsync(path);
            Assert.Equal(Hashing.Sha256Text(text), change.GetProperty("expectedHash").GetString());
            var result = ShopTests.Apply(text, change.GetProperty("edits"));
            Assert.Equal(Hashing.Sha256Text(result), change.GetProperty("resultHash").GetString());
            actual[Path.GetRelativePath(dir, path).Replace('\\', '/')] = result;
        }
        var caseDir = Path.Combine(GoldenDir, caseName);
        if (Environment.GetEnvironmentVariable("REFYNTRA_UPDATE_GOLDEN") == "1")
        {
            if (Directory.Exists(caseDir)) Directory.Delete(caseDir, true);
            foreach (var (rel, text) in actual)
            {
                var f = Path.Combine(caseDir, rel + ".golden");
                Directory.CreateDirectory(Path.GetDirectoryName(f)!);
                await File.WriteAllTextAsync(f, text);
            }
        }
        var expected = Directory.EnumerateFiles(caseDir, "*.golden", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(caseDir, f).Replace('\\', '/')[..^".golden".Length], f => File.ReadAllText(f).Replace("\r\n", "\n"));
        Assert.Equal(expected.Keys.OrderBy(k => k, StringComparer.Ordinal), actual.Keys);
        foreach (var (rel, text) in actual) Assert.Equal(expected[rel], text.Replace("\r\n", "\n"));
    }

    [Fact]
    public async Task GoldenTypeRenameAcrossProjectsUpdatesNameofAndAliasTargetButNotStrings()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        await AssertGoldenAsync("type-nameof-alias", dir, plan);
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Widget.cs keeps its name"));
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
        Assert.Equal(2, plan.GetProperty("projectContextIds").GetArrayLength());
    }

    [Fact]
    public async Task GoldenPartialTypeRenamesEveryPart()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Gadget.Part1.cs"), "class Gadget", 6, "Device");
        await AssertGoldenAsync("partial", dir, plan);
    }

    [Fact]
    public async Task GoldenOverloadRenameLeavesTheOtherOverload()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "Run(int", 0, "Start");
        await AssertGoldenAsync("overload", dir, plan);
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Overloads are not renamed together"));
    }

    [Fact]
    public async Task RenameAtAnAliasUsageRenamesTheAliasedTypeAndKeepsTheAliasName()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        // The cursor on the alias resolves to the aliased type (aliases themselves are not renamed in this version).
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.App", "Program.cs"), "new W()", 4, "Thing");
        await AssertGoldenAsync("type-nameof-alias", dir, plan);
    }

    [Fact]
    public async Task CaseOnlyTypeRenameIsAllowedButTheFileKeepsItsName()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "WIDGET");
        Assert.All(plan.GetProperty("writeSet").EnumerateArray(), w => Assert.Equal("text", w.GetProperty("kind").GetString()));
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Widget.cs keeps its name"));
        Assert.True(File.Exists(Path.Combine(dir, "Renames.Lib", "Widget.cs")));
    }

    // ------------------------------------------------------------------ guards and compilation delta

    [Fact]
    public async Task ConflictingNameIsRefusedByTheCompilationDelta()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Gadget.Part1.cs"), "class Gadget", 6, "Widget");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("RenameConflict", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task PreExistingErrorsAreABaselineNotABlocker()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln", d =>
            File.WriteAllText(Path.Combine(d, "Renames.App", "AlreadyBroken.cs"), "namespace Renames.App; class AlreadyBroken { int x = \"not an int\"; }\n"));
        await using var _ = c;
        var (plan, _) = await PreparedAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
    }

    [Fact]
    public async Task ReadOnlyTargetIsRefused()
    {
        var (c, dir) = await OpenAsync("Renames", "Renames.sln");
        await using var _ = c;
        var program = Path.Combine(dir, "Renames.App", "Program.cs");
        File.SetAttributes(program, FileAttributes.ReadOnly);
        try
        {
            var r = await PrepareAsync(c, Path.Combine(dir, "Renames.Lib", "Widget.cs"), "class Widget", 6, "Thing");
            Assert.Equal("unavailable", r.GetProperty("kind").GetString());
            Assert.Equal("ReadOnlyFile", r.GetProperty("reasonCode").GetString());
        }
        finally
        {
            File.SetAttributes(program, FileAttributes.Normal);
        }
    }
}

/// <summary>Framework extension registrations (EF Core, hosting, HttpClient, options), search and restore advice.</summary>
public sealed class FrameworkExtensionTests
{
    private static async Task<(TestClient c, string dir)> OpenDiExtAsync()
    {
        await Fixtures.EnsureRestoredAsync(DiExtSln);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(DiExtSln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, Path.GetDirectoryName(DiExtSln)!);
    }

    private static string DiExtSln => Path.Combine(Fixtures.FixturesDir, "DiExt", "DiExt.sln");

    private static async Task<List<JsonElement>> RegistrationsAsync(TestClient c, string file, string needle, int offset)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        var related = await c.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
        return related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == "di.registration").ToList();
    }

    [Fact]
    public async Task FrameworkExtensionRegistrationsAreLikelyWithLifetime()
    {
        var (c, dir) = await OpenDiExtAsync();
        await using var _ = c;
        var types = Path.Combine(dir, "DiExt.App", "Types.cs");

        var app = Assert.Single(await RegistrationsAsync(c, types, "class AppDbContext", 6));
        var reg = app.GetProperty("target").GetProperty("registration");
        Assert.Equal("transient", reg.GetProperty("lifetime").GetString());
        Assert.Equal("likely", app.GetProperty("confidence").GetString());
        Assert.StartsWith("AddDbContext<AppDbContext>", reg.GetProperty("form").GetString());
        Assert.Contains(app.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Framework extension method"));

        Assert.Equal("scoped", Assert.Single(await RegistrationsAsync(c, types, "class ReportsDbContext", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());
        Assert.Equal("scoped", Assert.Single(await RegistrationsAsync(c, types, "class PooledDbContext", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());
        Assert.Equal("singleton", Assert.Single(await RegistrationsAsync(c, types, "class FactoryDbContext", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());
        Assert.Equal("singleton", Assert.Single(await RegistrationsAsync(c, types, "class PollingWorker", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());
        Assert.Equal("transient", Assert.Single(await RegistrationsAsync(c, types, "class WeatherClient", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());
        Assert.Equal("singleton", Assert.Single(await RegistrationsAsync(c, types, "class BotOptions", 6)).GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());

        // AddHttpClient<IGeoClient, GeoClient> (likely) + AddScoped<IGeoClient, GeoClient> (proven).
        var geo = await RegistrationsAsync(c, types, "interface IGeoClient", 10);
        Assert.Equal(2, geo.Count);
        Assert.Contains(geo, g => g.GetProperty("confidence").GetString() == "likely" && g.GetProperty("target").GetProperty("registration").GetProperty("implementationType").GetProperty("name").GetString() == "GeoClient");
        Assert.Contains(geo, g => g.GetProperty("confidence").GetString() == "proven");

        // Foreign same-name AddDbContext<T>(services): not a registration.
        Assert.Empty(await RegistrationsAsync(c, types, "class LocalOnlyContext", 6));
    }

    [Fact]
    public async Task EmptyQueryWithTypeFilterListsTypesSortedAndLimited()
    {
        var (c, _) = await OpenDiExtAsync();
        await using var __ = c;
        var snap = await c.BarrierAsync();
        var r = await c.RequestAsync("code/search", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, query = "", filters = new { type = true }, limit = 5 });
        var items = r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("symbol").GetProperty("displayName").GetString()!).ToList();
        Assert.Equal(5, items.Count);
        Assert.True(r.GetProperty("truncated").GetBoolean());
        Assert.Equal(items.OrderBy(x => x, StringComparer.Ordinal), items);
        var none = await c.RequestAsync("code/search", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, query = "", filters = new { }, limit = 5 });
        Assert.Empty(none.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task MissingPackageFolderGivesARestoreRecoveryAction()
    {
        var sln = await Fixtures.CopyAsync("DiExt", "DiExt.sln");
        var assets = Path.Combine(Path.GetDirectoryName(sln)!, "DiExt.App", "obj", "project.assets.json");
        var empty = Path.Combine(Path.GetDirectoryName(sln)!, "empty-packages");
        Directory.CreateDirectory(empty);
        var json = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(assets))!;
        var folders = new System.Text.Json.Nodes.JsonObject { [empty + Path.DirectorySeparatorChar] = new System.Text.Json.Nodes.JsonObject() };
        json["packageFolders"] = folders;
        await File.WriteAllTextAsync(assets, json.ToJsonString());

        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(sln);
        var project = Assert.Single(status.GetProperty("projects").EnumerateArray());
        var diag = project.GetProperty("diagnostics").EnumerateArray().First(d => d.TryGetProperty("recoveryActions", out _));
        Assert.Contains("Run dotnet restore", diag.GetProperty("message").GetString());
        var action = diag.GetProperty("recoveryActions")[0];
        Assert.Equal("refyntra.runRestore", action.GetProperty("command").GetString());
        Assert.Equal(sln, action.GetProperty("args")[0].GetString());
        Assert.Equal("partial", project.GetProperty("state").GetString());
    }
}
