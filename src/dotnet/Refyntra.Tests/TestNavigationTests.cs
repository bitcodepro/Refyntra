using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>Code ↔ tests in Related (DiRules.Tests is an xUnit project, identified by attribute identity).</summary>
[Collection("DiRules")]
public sealed class TestNavigationTests
{
    private readonly DiRulesFixture _f;
    private TestClient C => _f.Client;

    public TestNavigationTests(DiRulesFixture f) => _f = f;

    private string Direct => _f.File("DiRules.App", "Direct.cs");
    private string Tests => _f.File("DiRules.Tests", "OrderServiceTests.cs");

    private async Task<(string snap, JsonElement related)> RelatedAsync(string path, string needle, int offset)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return (snap, await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!));
    }

    private static List<JsonElement> Group(JsonElement related, string group) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("group").GetString() == group).ToList();

    private static string Label(JsonElement r) => r.GetProperty("target").GetProperty("label").GetString()!;

    [Fact]
    public async Task ProductionTypeListsTheTestsThatReferenceIt()
    {
        var (_, rel) = await RelatedAsync(Direct, "class OrderService", "class ".Length + 1);
        var tests = Group(rel, "tests");
        var t = Assert.Single(tests);
        Assert.Equal("test", t.GetProperty("relationKind").GetString());
        Assert.Equal("proven", t.GetProperty("confidence").GetString());
        Assert.Equal("OrderServiceTests.TotalIsZeroForAnEmptyRepository — references the symbol — not coverage", Label(t));
        Assert.Equal("TotalIsZeroForAnEmptyRepository", t.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        Assert.Contains(t.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("not coverage"));
        // The helper (not a test) and the method marked with a same-name foreign [Fact] are not tests.
        Assert.DoesNotContain(tests, x => Label(x).Contains("OrderBuilders") || Label(x).Contains("NotRealTests"));
    }

    [Fact]
    public async Task NameMatchIsHeuristicAndProvenReferencesAreKept()
    {
        var (_, rel) = await RelatedAsync(Direct, "class PriceCache", "class ".Length + 1);
        var tests = Group(rel, "tests");
        Assert.Contains(tests, t => Label(t).StartsWith("OrderServiceTests.PriceUsesTheRepository") && t.GetProperty("confidence").GetString() == "proven");
        var h = Assert.Single(tests, t => t.GetProperty("confidence").GetString() == "heuristic");
        Assert.Equal("PriceCacheTests — name match only (heuristic)", Label(h));
    }

    [Fact]
    public async Task TestMethodListsTheProductionSymbolsItReferences()
    {
        var (_, rel) = await RelatedAsync(Tests, "TotalIsZeroForAnEmptyRepository", 1);
        var subjects = Group(rel, "tests").Where(r => r.GetProperty("relationKind").GetString() == "test.subject").ToList();
        var names = subjects.Select(s => s.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()).ToList();
        Assert.Contains("OrderService", names);
        Assert.Contains("OrderRepository", names);
        Assert.Contains("Total", names);
        Assert.DoesNotContain("Assert", names); // framework symbols are not production code of the solution
        Assert.All(subjects, s => Assert.Equal("proven", s.GetProperty("confidence").GetString()));
    }

    [Fact]
    public async Task ActionsExplainThatRunningATestIsUnavailable()
    {
        var snap = await C.BarrierAsync();
        var text = await File.ReadAllTextAsync(Tests);
        var (line, ch) = TestClient.Position(text, "TotalIsZeroForAnEmptyRepository", 1);
        var list = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = Refyntra.Workspaces.UriPaths.ToUri(Tests), position = new { line, character = ch } });
        var run = Assert.Single(list.EnumerateArray(), a => a.GetProperty("capabilityId").GetString() == "tests.run");
        Assert.Equal("unavailable", run.GetProperty("state").GetString());
        Assert.Equal("NoPublicTestIntegration", run.GetProperty("reasonCode").GetString());
        Assert.StartsWith("Run test: unavailable — no supported public test integration", run.GetProperty("message").GetString());

        // Not offered on production code, nor on a method marked with a foreign [Fact].
        var directText = await File.ReadAllTextAsync(Direct);
        var (l2, c2) = TestClient.Position(directText, "class OrderService", "class ".Length + 1);
        var prod = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = Refyntra.Workspaces.UriPaths.ToUri(Direct), position = new { line = l2, character = c2 } });
        Assert.DoesNotContain(prod.EnumerateArray(), a => a.GetProperty("capabilityId").GetString() == "tests.run");
        var fake = _f.File("DiRules.Tests", "FakeFrameworkTests.cs");
        var (l3, c3) = TestClient.Position(await File.ReadAllTextAsync(fake), "LooksLikeATest", 1);
        var fakeList = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = Refyntra.Workspaces.UriPaths.ToUri(fake), position = new { line = l3, character = c3 } });
        Assert.DoesNotContain(fakeList.EnumerateArray(), a => a.GetProperty("capabilityId").GetString() == "tests.run");
    }
}
