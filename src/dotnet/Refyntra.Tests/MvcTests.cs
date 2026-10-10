using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>A copy of the Mvc fixture (MVC controllers, MediatR behaviors/streams/notifications, DI forms), read-only tests.</summary>
public sealed class MvcFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public JsonElement Status { get; private set; }
    public string File(params string[] parts) => Path.Combine(new[] { Path.GetDirectoryName(Sln)!, "Mvc.Api" }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("Mvc", "Mvc.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        Status = await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

[CollectionDefinition("Mvc")]
public sealed class MvcCollection : ICollectionFixture<MvcFixture>
{
}

[Collection("Mvc")]
public sealed class MvcTests
{
    private readonly MvcFixture _f;
    private TestClient C => _f.Client;

    public MvcTests(MvcFixture f) => _f = f;

    private string Orders => _f.File("Controllers", "OrdersController.cs");
    private string Bases => _f.File("Controllers", "BaseControllers.cs");
    private string Negatives => _f.File("Controllers", "Negatives.cs");
    private string Features => _f.File("Features", "Orders.cs");
    private string Di => _f.File("Di", "DiForms.cs");

    private static List<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind).ToList();

    private static string Route(JsonElement r) => r.GetProperty("target").GetProperty("endpoint").GetProperty("route").GetString()!;
    private static string[] Verbs(JsonElement r) =>
        r.GetProperty("target").GetProperty("endpoint").GetProperty("httpMethods").EnumerateArray().Select(x => x.GetString()!).ToArray();

    private async Task<JsonElement> RelatedAsync(string path, string needle, int offset = 0)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
    }

    private async Task<List<JsonElement>> SearchAsync(string query, object filters)
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query, filters, limit = 200 });
        return r.GetProperty("items").EnumerateArray().ToList();
    }

    [Fact]
    public void FixtureLoadsReady() => Assert.Equal("Ready", _f.Status.GetProperty("state").GetString());

    // ------------------------------------------------------------------ MVC

    [Fact]
    public async Task ActionWithTemplateIsAnMvcEndpointWithTokenReplacedAndConstraintKept()
    {
        var related = await RelatedAsync(Orders, "GetOrder(int id)");
        var e = Assert.Single(Relations(related, "aspnet.endpoint"));
        Assert.Equal("/api/Orders/{id:int}", Route(e));
        Assert.Equal(new[] { "GET" }, Verbs(e));
        Assert.Equal("mvc", e.GetProperty("target").GetProperty("endpoint").GetProperty("kind").GetString());
        Assert.False(e.GetProperty("target").GetProperty("endpoint").GetProperty("routeIsDynamic").GetBoolean());
        Assert.Equal("proven", e.GetProperty("confidence").GetString());
        Assert.Equal("GetOrder", e.GetProperty("target").GetProperty("endpoint").GetProperty("handler").GetProperty("name").GetString());
    }

    [Fact]
    public async Task MultipleVerbAttributesAbsoluteTemplatesAndAcceptVerbs()
    {
        var update = Relations(await RelatedAsync(Orders, "Update(int id)"), "aspnet.endpoint");
        Assert.Equal(new[] { "PATCH /api/Orders/{id:int}/partial", "PUT /api/Orders/{id:int}" },
            update.Select(e => Verbs(e)[0] + " " + Route(e)).OrderBy(x => x, StringComparer.Ordinal));

        var remove = Assert.Single(Relations(await RelatedAsync(Orders, "Remove(int id)"), "aspnet.endpoint"));
        Assert.Equal("/api/legacy/orders/{id}", Route(remove));

        var create = Assert.Single(Relations(await RelatedAsync(Orders, "Create()"), "aspnet.endpoint"));
        Assert.Equal("/api/Orders", Route(create));
        Assert.Equal(new[] { "POST" }, Verbs(create));

        var probe = Assert.Single(Relations(await RelatedAsync(Orders, "Probe()"), "aspnet.endpoint"));
        Assert.Equal("/api/Orders/probe", Route(probe));
        Assert.Equal(new[] { "HEAD", "OPTIONS" }, Verbs(probe));

        var hidden = Assert.Single(Relations(await RelatedAsync(Orders, "Internal()"), "aspnet.endpoint"));
        Assert.Equal("/api/Orders/Internal", Route(hidden));

        Assert.Empty(Relations(await RelatedAsync(Orders, "Helper()"), "aspnet.endpoint"));
    }

    [Fact]
    public async Task ControllerShowsAllItsEndpoints()
    {
        var related = await RelatedAsync(Orders, "class OrdersController", 6);
        var routes = Relations(related, "aspnet.endpoint").Select(e => string.Join(",", Verbs(e)) + " " + Route(e)).ToList();
        Assert.Contains("GET /api/Orders/{id:int}", routes);
        Assert.Contains("POST /api/Orders", routes);
        Assert.Contains("DELETE /api/legacy/orders/{id}", routes);
        Assert.Contains("HEAD,OPTIONS /api/Orders/probe", routes);
        Assert.Equal(7, routes.Count); // GetOrder, Create, Update x2, Remove, Probe, Internal; nothing for Helper
    }

    [Fact]
    public async Task InheritedRouteAndActionsAndAbstractController()
    {
        var customers = Relations(await RelatedAsync(Bases, "class CustomersController", 6), "aspnet.endpoint").Select(Route).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(new[] { "/api/v1/Customers/ping", "/api/v1/Customers/{id:guid}" }.OrderBy(x => x, StringComparer.Ordinal), customers);
        // The abstract base itself has no endpoint; its action relates to the derived controller's endpoint.
        Assert.Empty(Relations(await RelatedAsync(Bases, "class ApiBaseController", 6), "aspnet.endpoint"));
        var ping = Assert.Single(Relations(await RelatedAsync(Bases, "Ping()"), "aspnet.endpoint"));
        Assert.Equal("/api/v1/Customers/ping", Route(ping));
    }

    [Fact]
    public async Task AreaTokenPlainControllerAndConventionalAction()
    {
        var dash = Assert.Single(Relations(await RelatedAsync(Bases, "class DashboardController", 6), "aspnet.endpoint"));
        Assert.Equal("/Admin/Dashboard/Index", Route(dash));
        Assert.Empty(Verbs(dash));

        var plain = Assert.Single(Relations(await RelatedAsync(Bases, "class PlainApi", 6), "aspnet.endpoint"));
        Assert.Equal("/plain", Route(plain));

        var home = Assert.Single(Relations(await RelatedAsync(Bases, "class HomeController", 6), "aspnet.endpoint"));
        Assert.True(home.GetProperty("target").GetProperty("endpoint").GetProperty("routeIsDynamic").GetBoolean());
        Assert.Contains(home.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("conventional route, not resolved"));
    }

    [Fact]
    public async Task NegativesHaveNoEndpoints()
    {
        Assert.Empty(Relations(await RelatedAsync(Negatives, "GetReport()"), "aspnet.endpoint"));
        Assert.Empty(Relations(await RelatedAsync(Negatives, "class ReportService", 6), "aspnet.endpoint"));
        Assert.Empty(await SearchAsync("", new { route = "/foreign" }));
    }

    [Fact]
    public async Task SendInsideActionLinksTheRequestToTheMvcEndpoint()
    {
        var related = await RelatedAsync(Features, "record GetOrderQuery", 7);
        var e = Assert.Single(Relations(related, "aspnet.endpoint"));
        Assert.Equal("/api/Orders/{id:int}", Route(e));
        Assert.Equal("mvc", e.GetProperty("target").GetProperty("endpoint").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task FindRouteAndMethodCoverMvcAndConventionalEndpoints()
    {
        var api = await SearchAsync("", new { route = "/api/Orders" });
        Assert.Equal(6, api.Count); // OrdersController routes under /api/Orders (Remove is absolute)
        Assert.All(api, i => Assert.Equal("mvc", i.GetProperty("endpoint").GetProperty("kind").GetString()));
        var deletes = await SearchAsync("route:/api method:DELETE", new { });
        Assert.Equal("/api/legacy/orders/{id}", Assert.Single(deletes).GetProperty("endpoint").GetProperty("route").GetString());
        var conventional = await SearchAsync("", new { route = "{controller=Home}" });
        var c = Assert.Single(conventional).GetProperty("endpoint");
        Assert.True(c.GetProperty("routeIsDynamic").GetBoolean());
        Assert.Equal("mvc", c.GetProperty("kind").GetString());
    }

    // ------------------------------------------------------------------ MediatR

    [Fact]
    public async Task RequestShowsClosedAndOpenGenericBehaviors()
    {
        var related = await RelatedAsync(Features, "record GetOrderQuery", 7);
        var behaviors = Relations(related, "mediatr.behavior");
        var closed = Assert.Single(behaviors, b => b.GetProperty("target").GetProperty("label").GetString()!.StartsWith("GetOrderCachingBehavior"));
        Assert.Equal("proven", closed.GetProperty("confidence").GetString());
        var open = Assert.Single(behaviors, b => b.GetProperty("target").GetProperty("label").GetString()!.StartsWith("LoggingBehavior"));
        Assert.Equal("likely", open.GetProperty("confidence").GetString());
        Assert.Contains("applies to every request (open generic)", open.GetProperty("target").GetProperty("label").GetString());
        Assert.DoesNotContain(behaviors, b => b.GetProperty("target").GetProperty("label").GetString()!.StartsWith("CommandOnlyBehavior"));
        Assert.All(behaviors, b => Assert.Equal("handlers", b.GetProperty("group").GetString()));
        Assert.All(behaviors, b => Assert.Contains(b.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("order")));
    }

    [Fact]
    public async Task StreamRequestHasHandlerAndCreateStreamCaller()
    {
        var related = await RelatedAsync(Features, "record CountdownStream", 7);
        var h = Assert.Single(Relations(related, "mediatr.handler"));
        Assert.Equal("CountdownStreamHandler", h.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        Assert.Single(Relations(related, "mediatr.send"));
    }

    [Fact]
    public async Task NotificationHandlerOfBaseAppliesToDerivedAsLikely()
    {
        var related = await RelatedAsync(Features, "class OrderShipped", 6);
        var handlers = Relations(related, "mediatr.notificationHandler");
        Assert.Equal("proven", Assert.Single(handlers, h => h.GetProperty("target").GetProperty("label").GetString() == "OrderShippedHandler").GetProperty("confidence").GetString());
        var baseHandler = Assert.Single(handlers, h => h.GetProperty("target").GetProperty("label").GetString()!.StartsWith("AnyOrderEventHandler"));
        Assert.Equal("likely", baseHandler.GetProperty("confidence").GetString());
    }

    // ------------------------------------------------------------------ DI

    private static JsonElement Reg(JsonElement r) => r.GetProperty("target").GetProperty("registration");

    [Fact]
    public async Task KeyedRegistrationsShowTheKey()
    {
        var regs = Relations(await RelatedAsync(Di, "interface ICache", 10), "di.registration");
        Assert.Equal(new[] { "memory", "redis" }, regs.Select(r => Reg(r).GetProperty("key").GetString()).OrderBy(x => x));
        Assert.Contains(regs, r => Reg(r).GetProperty("form").GetString() == "AddKeyedScoped<ICache, RedisCache>(\"redis\")");
        // A [FromKeyedServices] parameter relates to the registration with the same key.
        var param = Relations(await RelatedAsync(Di, "ICache cache", 7), "di.registration");
        Assert.Equal("redis", Reg(Assert.Single(param)).GetProperty("key").GetString());
    }

    [Fact]
    public async Task FactoryAndInstanceRegistrations()
    {
        var clock = Assert.Single(Relations(await RelatedAsync(Di, "interface IClock", 10), "di.registration"));
        Assert.Equal("factory", Reg(clock).GetProperty("implementationKind").GetString());
        Assert.Equal("likely", clock.GetProperty("confidence").GetString());
        Assert.True(Reg(clock).TryGetProperty("factoryLocation", out var fl));
        var text = await System.IO.File.ReadAllTextAsync(Di);
        var (line, _) = TestClient.Position(text, "sp => new SystemClock()");
        Assert.Equal(line, fl.GetProperty("range").GetProperty("start").GetProperty("line").GetInt32());

        var settings = Assert.Single(Relations(await RelatedAsync(Di, "class Settings", 6), "di.registration"));
        Assert.Equal("instance", Reg(settings).GetProperty("implementationKind").GetString());
    }

    [Fact]
    public async Task OpenGenericRegistrationMatchesClosedUsagesAsLikely()
    {
        var related = await RelatedAsync(Di, "interface IRepo<T>", 10);
        var reg = Assert.Single(Relations(related, "di.registration"));
        Assert.Equal("type", Reg(reg).GetProperty("implementationKind").GetString());
        var usage = Assert.Single(Relations(related, "di.openGenericUsage"));
        Assert.Equal("likely", usage.GetProperty("confidence").GetString());
        Assert.Contains("IRepo<Widget>", usage.GetProperty("target").GetProperty("label").GetString());
    }
}
