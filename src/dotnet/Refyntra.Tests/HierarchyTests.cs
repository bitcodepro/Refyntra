using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>code/hierarchy (protocol 1.7): incoming and outgoing calls, supertypes and subtypes on the Shop fixture.</summary>
[Collection("Shop")]
public sealed class HierarchyTests
{
    private readonly ShopFixture _f;
    private TestClient C => _f.Client;

    public HierarchyTests(ShopFixture f) => _f = f;

    private string Handlers => _f.File("Shop.Api", "Handlers", "OrderHandlers.cs");
    private string Services => _f.File("Shop.Api", "Services", "OrderServices.cs");

    private async Task<JsonElement> HierarchyAsync(string path, string needle, int offset, string direction)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return await C.RequestAsync("code/hierarchy", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString(), direction });
    }

    private static List<string> Names(JsonElement r) => r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("symbol").GetProperty("name").GetString()!).ToList();

    [Fact]
    public async Task IncomingCallsListTheCallersWithCallSites()
    {
        var r = await HierarchyAsync(Services, "OrderDto? Find(int id);", 11, "incoming");
        var item = Assert.Single(r.GetProperty("items").EnumerateArray());
        Assert.Equal("Handle", item.GetProperty("symbol").GetProperty("name").GetString());
        Assert.Equal(UriPaths.ToUri(Handlers), item.GetProperty("fromUri").GetString());
        var range = Assert.Single(item.GetProperty("fromRanges").EnumerateArray());
        var text = await File.ReadAllTextAsync(Handlers);
        var (line, _) = TestClient.Position(text, "_orders.Find(request.Id)");
        Assert.Equal(line, range.GetProperty("start").GetProperty("line").GetInt32());
        Assert.Equal("complete", r.GetProperty("completeness").GetString());
        Assert.False(r.GetProperty("truncated").GetBoolean());
    }

    [Fact]
    public async Task OutgoingCallsListSourceTargetsOnly()
    {
        var r = await HierarchyAsync(Handlers, "public async Task<int> Handle", 23, "outgoing");
        var names = Names(r);
        Assert.Contains("Create", names);
        // IPublisher.Publish is metadata: no document to open, so it is not an item.
        Assert.DoesNotContain("Publish", names);
        Assert.All(r.GetProperty("items").EnumerateArray(), i => Assert.Equal(UriPaths.ToUri(Handlers), i.GetProperty("fromUri").GetString()));
    }

    [Fact]
    public async Task TypeHierarchyListsSupertypesAndSubtypes()
    {
        var sub = await HierarchyAsync(Services, "interface IOrderService", 10, "subtypes");
        Assert.Equal(new[] { "CachedOrderService", "OrderService" }, Names(sub).OrderBy(x => x, StringComparer.Ordinal));
        var sup = await HierarchyAsync(Services, "class OrderService", 6, "supertypes");
        Assert.Equal(new[] { "IOrderService" }, Names(sup));
        Assert.Empty(sup.GetProperty("items")[0].GetProperty("fromRanges").EnumerateArray());
    }

    [Fact]
    public async Task UnknownDirectionIsRejected()
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, Services, "interface IOrderService", 10);
        await Assert.ThrowsAnyAsync<Exception>(() => C.RequestAsync("code/hierarchy", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString(), direction = "sideways" }));
    }
}
