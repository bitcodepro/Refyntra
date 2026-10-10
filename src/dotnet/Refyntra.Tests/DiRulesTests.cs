using System.Text.Json;
using Refyntra.Semantics.Rules;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>A copy of the DiRules fixture (OR1001 corpus + an xUnit test project) loaded once, read-only tests.</summary>
public sealed class DiRulesFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public string Dir => Path.GetDirectoryName(Sln)!;
    public string File(params string[] parts) => Path.Combine(new[] { Dir }.Concat(parts).ToArray());
    public JsonElement Status { get; private set; }

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("DiRules", "DiRules.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        Status = await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

[CollectionDefinition("DiRules")]
public sealed class DiRulesCollection : ICollectionFixture<DiRulesFixture>
{
}

public static class Analysis
{
    public static async Task<JsonElement> RunAsync(TestClient c, string? path = null)
    {
        var snap = await c.BarrierAsync();
        return await c.RequestAsync("analysis/run", path == null
            ? new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap }
            : new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(path) });
    }

    public static List<JsonElement> Diagnostics(JsonElement r) => r.GetProperty("diagnostics").EnumerateArray().ToList();
    public static List<JsonElement> Abstentions(JsonElement r) => r.GetProperty("abstentions").EnumerateArray().ToList();
    public static string Message(JsonElement e) => e.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
}

[Collection("DiRules")]
public sealed class DiRulesTests
{
    private readonly DiRulesFixture _f;
    private TestClient C => _f.Client;

    public DiRulesTests(DiRulesFixture f) => _f = f;

    private static string Quote(string name) => $"'{name}'";

    [Fact]
    public void FixtureLoadsReady() => Assert.Equal("Ready", _f.Status.GetProperty("state").GetString());

    [Fact]
    public async Task CorpusMatchesTheManualLabels()
    {
        var r = await Analysis.RunAsync(C);
        var diags = Analysis.Diagnostics(r);
        var abst = Analysis.Abstentions(r);
        var manifest = JsonDocument.Parse(await System.IO.File.ReadAllTextAsync(_f.File("expected-OR1001.json"))).RootElement;
        var failures = new List<string>();
        foreach (var c in manifest.GetProperty("cases").EnumerateArray())
        {
            var name = Quote(c.GetProperty("singleton").GetString()!);
            var expected = c.GetProperty("expected").GetString();
            var warned = diags.Count(d => Analysis.Message(d).Contains(name, StringComparison.Ordinal));
            var abstained = abst.Count(a => Analysis.Message(a).Contains("singleton " + name, StringComparison.Ordinal)
                                          || Analysis.Message(a).Contains("(implementation " + name, StringComparison.Ordinal));
            var actual = warned > 0 ? "warning" : abstained > 0 ? "abstain" : "clean";
            if (actual != expected) failures.Add($"{c.GetProperty("case").GetString()}: expected {expected}, got {actual}");
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures) + "\n" + r);
        Assert.Equal(3, diags.Count);
    }

    [Fact]
    public async Task DirectWarningCarriesTheWholePathWithLocations()
    {
        var program = _f.File("DiRules.App", "Program.cs");
        var r = await Analysis.RunAsync(C, program);
        var d = Assert.Single(Analysis.Diagnostics(r));
        Assert.Equal("OR1001", d.GetProperty("id").GetString());
        Assert.Equal("warning", d.GetProperty("severity").GetString());
        Assert.Equal("proven", d.GetProperty("confidence").GetString());
        Assert.Equal("complete", d.GetProperty("completeness").GetString());
        Assert.Contains("'IPriceCache'", Analysis.Message(d));
        Assert.Contains("'IOrderRepository'", Analysis.Message(d));
        Assert.EndsWith("Program.cs", d.GetProperty("location").GetProperty("uri").GetString());
        var related = d.GetProperty("relatedLocations").EnumerateArray().ToList();
        Assert.Equal(3, related.Count); // singleton registration, constructor parameter, scoped registration
        Assert.Contains("Singleton registration AddSingleton<IPriceCache, PriceCache>", related[0].GetProperty("message").GetString());
        Assert.Contains("Constructor parameter 'orders' of PriceCache(IOrderRepository orders)", related[1].GetProperty("message").GetString());
        Assert.EndsWith("Direct.cs", related[1].GetProperty("location").GetProperty("uri").GetString());
        Assert.Contains("Scoped registration AddScoped<IOrderRepository, OrderRepository>", related[2].GetProperty("message").GetString());
        Assert.EndsWith(".md", d.GetProperty("helpUri").GetString());
        // Program.cs has no abstention of its own (the identical registration in AddSameNameCase does not block it).
        Assert.Empty(Analysis.Abstentions(r));
    }

    [Fact]
    public async Task TransitivePathGoesThroughTheTransientRegistration()
    {
        var r = await Analysis.RunAsync(C, _f.File("DiRules.App", "Cases", "Transitive.cs"));
        var d = Assert.Single(Analysis.Diagnostics(r));
        var steps = d.GetProperty("relatedLocations").EnumerateArray().Select(x => x.GetProperty("message").GetString()!).ToList();
        Assert.Equal(5, steps.Count);
        Assert.StartsWith("Singleton registration AddSingleton<ReportScheduler>", steps[0]);
        Assert.Contains("'builder' of ReportScheduler(IReportBuilder builder, ILogger<ReportScheduler> logger)", steps[1]);
        Assert.StartsWith("Transient registration AddTransient<IReportBuilder, ReportBuilder>", steps[2]);
        Assert.Contains("'uow' of ReportBuilder(IUnitOfWork uow)", steps[3]);
        Assert.StartsWith("Scoped registration AddScoped<IUnitOfWork, UnitOfWork>", steps[4]);
        Assert.Contains("TransitiveCase.AddTransitiveCase", d.GetProperty("compositionRoot").GetString());
        Assert.Contains("via ReportScheduler(IReportBuilder builder) → ReportBuilder(IUnitOfWork uow)", Analysis.Message(d));
    }

    [Theory]
    [InlineData("Split.cs", "RegisteredInAnotherRoot")]
    [InlineData("Conditional.cs", "ConditionalRegistration")]
    [InlineData("Enumerable.cs", "EnumerableService")]
    [InlineData("TryAdd.cs", "TryAdd")]
    [InlineData("OpenGeneric.cs", "OpenGeneric")]
    [InlineData("Keyed.cs", "KeyedService")]
    [InlineData("SameName.cs", "UnregisteredService")]
    [InlineData("MultipleConstructors.cs", "MultipleConstructors")]
    [InlineData("Overridden.cs", "MayBeOverridden")]
    [InlineData("Duplicate.cs", "MultipleRegistrations")]
    public async Task AbstentionsNameTheReasonAndNoWarningIsPublished(string file, string reason)
    {
        var r = await Analysis.RunAsync(C, _f.File("DiRules.App", "Cases", file));
        Assert.Empty(Analysis.Diagnostics(r));
        var a = Assert.Single(Analysis.Abstentions(r));
        Assert.Equal(reason, a.GetProperty("reason").GetString());
        Assert.Equal("OR1001", a.GetProperty("ruleId").GetString());
        Assert.EndsWith(file, a.GetProperty("location").GetProperty("uri").GetString());
    }

    [Fact]
    public async Task FactoryRegistrationsAbstainForTheDependencyAndForTheSingleton()
    {
        var r = await Analysis.RunAsync(C, _f.File("DiRules.App", "Cases", "Factory.cs"));
        Assert.Empty(Analysis.Diagnostics(r));
        Assert.Equal(new[] { "FactoryRegistration", "FactoryRegistration" }, Analysis.Abstentions(r).Select(a => a.GetProperty("reason").GetString()));
    }

    [Fact]
    public async Task CleanRootHasNeitherWarningsNorAbstentions()
    {
        var r = await Analysis.RunAsync(C, _f.File("DiRules.App", "Cases", "Clean.cs"));
        Assert.Empty(Analysis.Diagnostics(r));
        Assert.Empty(Analysis.Abstentions(r));
    }

    [Fact]
    public async Task StaleSnapshotIsRefused()
    {
        await C.BarrierAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => C.RequestAsync("analysis/run", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = "snap-old" }));
        Assert.Equal(-33004, ex.Code);
    }
}

/// <summary>Edits on a separate copy: dependency-based invalidation of OR1001 results.</summary>
public sealed class DiRulesIncrementalTests
{
    [Fact]
    public async Task EditingAConstructorFileRecomputesTheRootAndAnUnrelatedEditReusesIt()
    {
        var sln = await Fixtures.CopyAsync("DiRules", "DiRules.sln");
        var dir = Path.GetDirectoryName(sln)!;
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        await c.OpenAsync(sln);
        var session = c.Engine!.FindSession(c.WorkspaceId)!;

        var first = await Analysis.RunAsync(c);
        Assert.Contains(Analysis.Diagnostics(first), d => Analysis.Message(d).Contains("'IPriceCache'"));
        var (computed0, reused0) = Or1001Rule.Stats(session);
        Assert.True(computed0 >= 1);

        // An edit in the test project (no registration, no involved type): the component result is reused.
        var testFile = Path.Combine(dir, "DiRules.Tests", "OrderServiceTests.cs");
        await c.DidOpenAsync(testFile, await File.ReadAllTextAsync(testFile) + "\n// edited\n");
        var second = await Analysis.RunAsync(c);
        var (computed1, reused1) = Or1001Rule.Stats(session);
        Assert.Equal(computed0, computed1);
        Assert.True(reused1 > reused0);
        Assert.Equal(Analysis.Diagnostics(first).Count, Analysis.Diagnostics(second).Count);
        // Reused results point at the current documents (same spans).
        Assert.Equal(Analysis.Diagnostics(first)[0].GetProperty("location").ToString(), Analysis.Diagnostics(second)[0].GetProperty("location").ToString());

        // An edit in Direct.cs only (not the composition root file): PriceCache no longer takes the scoped repository.
        var direct = Path.Combine(dir, "DiRules.App", "Direct.cs");
        var text = await File.ReadAllTextAsync(direct);
        var edited = text.Replace("public PriceCache(IOrderRepository orders) => _orders = orders;", "public PriceCache() => _orders = new OrderRepository();");
        Assert.NotEqual(text, edited);
        await c.DidOpenAsync(direct, edited);
        var third = await Analysis.RunAsync(c);
        var (computed2, _) = Or1001Rule.Stats(session);
        Assert.True(computed2 > computed1, "the component that depends on Direct.cs is recomputed");
        Assert.DoesNotContain(Analysis.Diagnostics(third), d => Analysis.Message(d).Contains("'IPriceCache'"));
        Assert.Equal(Analysis.Diagnostics(first).Count - 1, Analysis.Diagnostics(third).Count);
    }
}
