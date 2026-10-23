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

    // ------------------------------------------------------------------ own handler interfaces (no MediatR)

    private string Archive => _f.File("Orders.Api", "Controllers", "ArchiveController.cs");
    private string CustomHandlers => _f.File("Orders.Application", "Custom", "Archive.cs");
    private string CustomContracts => _f.File("Orders.Application", "Custom", "Contracts.cs");
    private string CustomQueries => _f.File("Orders.Application", "Custom", "Queries.cs");

    [Fact]
    public async Task OwnHandlerInterfacesConnectControllerActionsAndHandlers()
    {
        var archive = Assert.Single(Relations(await RelatedAsync(Archive, "Archive(int id"), "handler.handler"));
        Assert.Equal("ArchiveOrderCommand → ArchiveOrderHandler", Label(archive));
        Assert.Equal("likely", archive.GetProperty("confidence").GetString());
        Assert.Equal("CountArchivedQuery → CountArchivedHandler", Label(Assert.Single(Relations(await RelatedAsync(Archive, "Count(CancellationToken"), "handler.handler"))));
        // Through the project's own dispatcher.
        Assert.Equal("ShipOrderCommand → ShipOrderHandler", Label(Assert.Single(Relations(await RelatedAsync(Archive, "Ship(int id"), "handler.handler"))));
        var all = Relations(await RelatedAsync(Archive, "class ArchiveController", 6), "handler.handler").Select(Label).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "ArchiveOrderCommand → ArchiveOrderHandler", "CountArchivedQuery → CountArchivedHandler", "ShipOrderCommand → ShipOrderHandler" }, all);
    }

    [Fact]
    public async Task OwnHandlersShowWhereTheyAreReachedFrom()
    {
        var archive = Relations(await RelatedAsync(CustomHandlers, "class ArchiveOrderHandler", 6), "handler.dispatch").Select(Label).ToList();
        Assert.Contains(archive, l => l.StartsWith("HandleAsync(ArchiveOrderCommand) in") && l.Contains("ArchiveController.Archive"));
        var ship = Relations(await RelatedAsync(CustomHandlers, "class ShipOrderHandler", 6), "handler.dispatch").Select(Label).ToList();
        Assert.Contains(ship, l => l.StartsWith("DispatchAsync(ShipOrderCommand) in") && l.Contains("ArchiveController.Ship"));
        // The generic call inside the dispatcher is not a dispatch of one request.
        Assert.DoesNotContain(ship, l => l.Contains("CommandDispatcher"));
        // A MediatR handler is not reported twice by the pattern module.
        Assert.Single(Relations(await RelatedAsync(Controller, "GetOrder(int id)"), "mediatr.handler"));
        Assert.Empty(Relations(await RelatedAsync(Controller, "GetOrder(int id)"), "handler.handler"));
    }

    [Fact]
    public async Task AnActionThatCallsABaseControllerHelperShowsTheHandler()
    {
        // SettingsController.RefreshSettings → HandleRequest(new RefreshSettingsCommand()) → Sender.Send(request).
        var settings = _f.File("Orders.Api", "Controllers", "SettingsController.cs");
        var h = Assert.Single(Relations(await RelatedAsync(settings, "RefreshSettings(bool"), "mediatr.handler"));
        Assert.Equal("RefreshSettingsCommand → RefreshSettingsCommandHandler", Label(h));
        var refresh = _f.File("Orders.Application", "Features", "RefreshSettings.cs");
        var callers = Relations(await RelatedAsync(refresh, "class RefreshSettingsCommandHandler", 6), "mediatr.send").Select(Label).ToList();
        Assert.Contains(callers, l => l.StartsWith("HandleRequest(RefreshSettingsCommand) in") && l.Contains("SettingsController.RefreshSettings"));
        // The helper itself sends no particular request.
        var helper = _f.File("Orders.Api", "Controllers", "AppBaseController.cs");
        Assert.Empty(Relations(await RelatedAsync(helper, "HandleRequest<TResponse>("), "mediatr.handler"));
    }

    [Fact]
    public async Task FindWithACSharpFileNameShowsTheTypesOfThatFile()
    {
        // Pasted from the explorer: "CreateOrder.cs" (a file with five types), also with a path.
        foreach (var query in new[] { "CreateOrder.cs", @"Orders.Application\Features\CreateOrder.cs" })
        {
            var snap = await C.BarrierAsync();
            var r = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query, filters = new { }, limit = 50 });
            var names = r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("symbol").GetProperty("name").GetString()).ToList();
            foreach (var n in new[] { "CreateOrderCommand", "OrderCreated", "CreateOrderCommandHandler", "SendConfirmationEmailHandler", "WriteAuditEntryHandler" })
                Assert.Contains(n, names);
            // Each type once, although "CreateOrder" also finds CreateOrderCommand by name.
            Assert.Single(names, n => n == "CreateOrderCommand");
        }
    }

    [Fact]
    public async Task CqrsOverMediatRQueriesAndCommandsReachTheirHandlers()
    {
        var products = _f.File("Orders.Api", "Controllers", "ProductsController.cs");
        Assert.Equal("GetProductPricesQuery → GetProductPricesQueryHandler", Label(Assert.Single(Relations(await RelatedAsync(products, "GetProductPrices(string"), "mediatr.handler"))));
        Assert.Equal("ArchiveProductCommand → ArchiveProductCommandHandler", Label(Assert.Single(Relations(await RelatedAsync(products, "Archive(string"), "mediatr.handler"))));
        // Not twice: the CQRS interfaces derive from MediatR's, which MediatR's module already relates.
        Assert.Empty(Relations(await RelatedAsync(products, "GetProductPrices(string"), "handler.handler"));
        var cqrs = _f.File("Orders.Application", "Cqrs", "Abstractions.cs");
        var callers = Relations(await RelatedAsync(cqrs, "class GetProductPricesQueryHandler", 6), "mediatr.send").Select(Label).ToList();
        Assert.Contains(callers, l => l.Contains("ProductsController.GetProductPrices"));
    }

    [Fact]
    public async Task OwnQueryHandedToAMethodOfAnyNameShowsItsHandler()
    {
        var rates = _f.File("Orders.Api", "Controllers", "RatesController.cs");
        var h = Assert.Single(Relations(await RelatedAsync(rates, "GetRates(string"), "handler.handler"));
        Assert.Equal("GetRatesQuery → GetRatesQueryHandler", Label(h));
        var callers = Relations(await RelatedAsync(CustomQueries, "class GetRatesQueryHandler", 6), "handler.dispatch").Select(Label).ToList();
        Assert.Contains(callers, l => l.StartsWith("QueryAsync(GetRatesQuery) in") && l.Contains("RatesController.GetRates"));
    }

    [Fact]
    public async Task AHelperOfABaseClassInAnotherProjectIsAWrapper()
    {
        var reports = _f.File("Orders.Api", "Controllers", "ReportsController.cs");
        var h = Assert.Single(Relations(await RelatedAsync(reports, "CreateReportOrder()"), "mediatr.handler"));
        Assert.Equal("CreateOrderCommand → CreateOrderCommandHandler", Label(h));
        // Found as a wrapper (Send in source), not merely as a request passed somewhere: proven.
        Assert.Equal("proven", h.GetProperty("confidence").GetString());
    }

    [Fact]
    public async Task ARequestHandedToAnythingWithoutSourceIsALikelyDispatch()
    {
        // InvoicesController.Get passes new GetOrderQuery(id) to IRequestRunner.Run (no Send in source).
        var invoices = _f.File("Orders.Api", "Controllers", "InvoicesController.cs");
        var h = Assert.Single(Relations(await RelatedAsync(invoices, "Get(int id)"), "mediatr.handler"));
        Assert.Equal("GetOrderQuery → GetOrderQueryHandler", Label(h));
        Assert.Equal("likely", h.GetProperty("confidence").GetString());
        Assert.Contains(h.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Run"));
        // The handler lists it among its callers; the direct Send stays proven.
        var callers = Relations(await RelatedAsync(GetOrder, "class GetOrderQueryHandler", 6), "mediatr.send").Select(Label).ToList();
        Assert.Contains(callers, l => l.StartsWith("Run(GetOrderQuery) in") && l.Contains("InvoicesController.Get"));
        Assert.Equal("proven", Assert.Single(Relations(await RelatedAsync(Controller, "GetOrder(int id)"), "mediatr.handler")).GetProperty("confidence").GetString());
        // A method without a request: nothing.
        Assert.Empty(Relations(await RelatedAsync(invoices, "Log(int id)"), "mediatr.handler"));
    }

    [Fact]
    public async Task AServiceThatSendsShowsTheHandler()
    {
        Assert.Equal("GetOrderQuery → GetOrderQueryHandler", Label(Assert.Single(Relations(await RelatedAsync(Pricing, "TotalWithTaxAsync("), "mediatr.handler"))));
    }
}
