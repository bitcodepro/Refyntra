using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// A copy of the MediatRApp fixture: a controller that dispatches through ISender, IMediator and an injected
/// IRequestHandler&lt;,&gt;, handlers, a service that sends, a notification with two handlers. Related must connect
/// controller actions and handlers both ways, although no handler is ever called by name.
/// </summary>
public sealed class MediatRAppFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public string File(params string[] parts) => Path.Combine(new[] { Path.GetDirectoryName(Sln)! }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("MediatRApp", "MediatRApp.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

public sealed class MediatRAppTests : IClassFixture<MediatRAppFixture>
{
    private readonly MediatRAppFixture _f;
    private TestClient C => _f.Client;

    public MediatRAppTests(MediatRAppFixture f) => _f = f;

    private string Controller => _f.File("Orders.Api", "Controllers", "OrdersController.cs");
    private string GetOrder => _f.File("Orders.Application", "Features", "GetOrder.cs");
    private string CreateOrder => _f.File("Orders.Application", "Features", "CreateOrder.cs");
    private string CancelOrder => _f.File("Orders.Application", "Features", "CancelOrder.cs");
    private string Pricing => _f.File("Orders.Application", "Services", "PricingService.cs");

    private static List<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind).ToList();

    private static string Label(JsonElement r) => r.GetProperty("target").GetProperty("label").GetString()!;

    private async Task<JsonElement> RelatedAsync(string path, string needle, int offset = 0)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
    }

    [Fact]
    public async Task EachControllerActionShowsTheHandlerItReaches()
    {
        Assert.Equal("GetOrderQuery → GetOrderQueryHandler", Label(Assert.Single(Relations(await RelatedAsync(Controller, "GetOrder(int id)"), "mediatr.handler"))));
        Assert.Equal("CreateOrderCommand → CreateOrderCommandHandler", Label(Assert.Single(Relations(await RelatedAsync(Controller, "CreateOrder(string"), "mediatr.handler"))));
        // The handler interface injected and called directly: DI picks the implementation.
        Assert.Equal("CancelOrderCommand → CancelOrderCommandHandler", Label(Assert.Single(Relations(await RelatedAsync(Controller, "CancelOrder(int"), "mediatr.handler"))));
        // An action that only calls a service relates to no handler itself.
        Assert.Empty(Relations(await RelatedAsync(Controller, "Total(int"), "mediatr.handler"));
    }

    [Fact]
    public async Task TheControllerClassShowsAllItsHandlers()
    {
        var handlers = Relations(await RelatedAsync(Controller, "class OrdersController", 6), "mediatr.handler").Select(Label).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "CancelOrderCommand → CancelOrderCommandHandler", "CreateOrderCommand → CreateOrderCommandHandler", "GetOrderQuery → GetOrderQueryHandler" }, handlers);
    }

    [Fact]
    public async Task EachHandlerShowsTheControllerActionsAndServicesThatCallIt()
    {
        var get = Relations(await RelatedAsync(GetOrder, "class GetOrderQueryHandler", 6), "mediatr.send").Select(Label).ToList();
        Assert.Contains(get, l => l.StartsWith("Send(GetOrderQuery) in") && l.Contains("OrdersController.GetOrder"));
        Assert.Contains(get, l => l.Contains("PricingService.TotalWithTaxAsync"));
        var cancel = Relations(await RelatedAsync(CancelOrder, "class CancelOrderCommandHandler", 6), "mediatr.send").Select(Label).ToList();
        Assert.Contains(cancel, l => l.StartsWith("Handle(CancelOrderCommand) in") && l.Contains("OrdersController.CancelOrder"));
        // From the Handle method too (the cursor is usually there).
        var create = Relations(await RelatedAsync(CreateOrder, "Handle(CreateOrderCommand"), "mediatr.send").Select(Label).ToList();
        Assert.Contains(create, l => l.Contains("OrdersController.CreateOrder"));
    }

    [Fact]
    public async Task AHandlerThatPublishesShowsTheNotificationHandlers()
    {
        var related = await RelatedAsync(CreateOrder, "class CreateOrderCommandHandler", 6);
        var handlers = Relations(related, "mediatr.notificationHandler").Select(Label).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "OrderCreated → SendConfirmationEmailHandler", "OrderCreated → WriteAuditEntryHandler" }, handlers);
    }

    [Fact]
    public async Task AServiceThatSendsShowsTheHandler()
    {
        Assert.Equal("GetOrderQuery → GetOrderQueryHandler", Label(Assert.Single(Relations(await RelatedAsync(Pricing, "TotalWithTaxAsync("), "mediatr.handler"))));
    }
}
