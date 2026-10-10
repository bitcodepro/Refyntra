using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// The endpoint listing used by frontend ↔ backend HTTP linking (TS side): code/search with an empty route filter lists
/// every Minimal API and MVC endpoint of the FullStack fixture with its methods, route, location and handler.
/// Read-only: no file is written.
/// </summary>
public sealed class FullStackFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("FullStack", "FullStack.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

public sealed class FullStackTests : IClassFixture<FullStackFixture>
{
    private readonly FullStackFixture _f;
    private TestClient C => _f.Client;

    public FullStackTests(FullStackFixture f) => _f = f;

    private async Task<List<JsonElement>> EndpointsAsync()
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query = "", filters = new { route = "" }, limit = 5000 });
        Assert.False(r.GetProperty("truncated").GetBoolean());
        return r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("endpoint")).ToList();
    }

    private static string Key(JsonElement e) =>
        string.Join(",", e.GetProperty("httpMethods").EnumerateArray().Select(m => m.GetString())) + " " + e.GetProperty("route").GetString();

    [Fact]
    public async Task EmptyRouteFilterListsEveryEndpointWithMethodsRouteAndKind()
    {
        var keys = (await EndpointsAsync()).Select(Key).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(new[]
        {
            "GET /api/Orders/recent",
            "GET /api/Orders/{id:int}",
            "GET /api/products",
            "GET /api/products/{id:int}",
            "GET /api/tags/{name}",
            "GET /api/tags/{slug}",
            "POST /api/Orders",
            "POST /api/Orders/{id:int}/cancel",
            "POST /api/products",
        }, keys);
    }

    [Fact]
    public async Task EveryListedEndpointHasALocationAndItsHandler()
    {
        foreach (var e in await EndpointsAsync())
        {
            var loc = e.GetProperty("location");
            Assert.EndsWith(".cs", loc.GetProperty("uri").GetString());
            Assert.False(e.GetProperty("routeIsDynamic").GetBoolean());
            var handler = e.GetProperty("handler");
            Assert.Equal("method", handler.GetProperty("kind").GetString());
            Assert.Equal(JsonValueKind.Object, handler.GetProperty("location").ValueKind);
        }
        var cancel = (await EndpointsAsync()).Single(e => Key(e) == "POST /api/Orders/{id:int}/cancel");
        Assert.Equal("mvc", cancel.GetProperty("kind").GetString());
        Assert.Equal("Cancel", cancel.GetProperty("handler").GetProperty("name").GetString());
        var get = (await EndpointsAsync()).Single(e => Key(e) == "GET /api/products/{id:int}");
        Assert.Equal("minimal-api", get.GetProperty("kind").GetString());
        Assert.Equal("Get", get.GetProperty("handler").GetProperty("name").GetString());
    }
}
