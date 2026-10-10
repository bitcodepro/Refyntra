using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>A copy of the EfCore fixture (DbContexts, configurations, conventions, queries, migrations), read-only tests.</summary>
public sealed class EfCoreFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public JsonElement Status { get; private set; }
    public string File(params string[] parts) => Path.Combine(new[] { Path.GetDirectoryName(Sln)! }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("EfCore", "EfCore.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        Status = await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

[CollectionDefinition("EfCore")]
public sealed class EfCoreCollection : ICollectionFixture<EfCoreFixture>
{
}

[Collection("EfCore")]
public sealed class EfCoreTests
{
    private readonly EfCoreFixture _f;
    private TestClient C => _f.Client;

    public EfCoreTests(EfCoreFixture f) => _f = f;

    private string Entities => _f.File("EfCore.Domain", "Entities.cs");
    private string Shop => _f.File("EfCore.Api", "Data", "ShopDbContext.cs");
    private string Reporting => _f.File("EfCore.Api", "Data", "ReportingDbContext.cs");
    private string Config => _f.File("EfCore.Api", "Data", "OrderConfiguration.cs");
    private string Legacy => _f.File("EfCore.Api", "Legacy", "Foreign.cs");

    private static List<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind).ToList();

    private static string Label(JsonElement r) => r.GetProperty("target").GetProperty("label").GetString()!;
    private static string Confidence(JsonElement r) => r.GetProperty("confidence").GetString()!;
    private static string Group(JsonElement r) => r.GetProperty("group").GetString()!;
    private static IEnumerable<string> Limits(JsonElement r) => r.GetProperty("limitations").EnumerateArray().Select(l => l.GetString()!);

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

    private static string? SymbolName(JsonElement item) =>
        item.TryGetProperty("symbol", out var s) && s.ValueKind == JsonValueKind.Object ? s.GetProperty("name").GetString() : null;

    [Fact]
    public void FixtureLoadsReady() => Assert.Equal("Ready", _f.Status.GetProperty("state").GetString());

    // ------------------------------------------------------------------ DbContext

    [Fact]
    public async Task DbContextListsItsEntitiesFromDbSetsEntityCallsAndConfigurations()
    {
        var related = await RelatedAsync(Shop, "class ShopDbContext", "class ".Length + 1);
        var entities = Relations(related, "efcore.entity");
        var names = entities.Select(e => e.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()!).ToList();
        foreach (var want in new[] { "Customer", "Order", "Product", "OrderLine" }) Assert.Contains(want, names);
        Assert.DoesNotContain("OrderSummary", names);
        Assert.DoesNotContain("Address", names); // owned, not an entity of its own
        Assert.All(entities, e => Assert.Equal("data", Group(e)));
        Assert.Equal("proven", Confidence(entities.Single(e => Label(e).StartsWith("Order ", StringComparison.Ordinal) || Label(e) == "Order")));
        // Supplier is reachable from Product.Supplier: discovered by convention (likely).
        var supplier = entities.Single(e => Label(e).StartsWith("Supplier", StringComparison.Ordinal));
        Assert.Equal("likely", Confidence(supplier));
        Assert.Contains("convention", Label(supplier));
        // ApplyConfiguration(new OrderConfiguration()).
        Assert.Contains(Relations(related, "efcore.configuration"), r => Label(r).Contains("OrderConfiguration"));
        // AddDbContext<ShopDbContext>() registration comes from the DI module.
        Assert.Contains(Relations(related, "di.registration"), r => Label(r).Contains("AddDbContext"));
        // Migrations with [DbContext(typeof(ShopDbContext))]: read-only.
        var migrations = Relations(related, "efcore.migration");
        Assert.Contains(migrations, m => Label(m).Contains("Initial") && Label(m).Contains("read-only"));
        Assert.Contains(migrations, m => Label(m).Contains("ShopDbContextModelSnapshot"));
    }

    [Fact]
    public async Task AssemblyScanIsLikelyAndDynamicModelBuildingIsUnknown()
    {
        var related = await RelatedAsync(Reporting, "class ReportingDbContext", "class ".Length + 1);
        var entities = Relations(related, "efcore.entity");
        var audit = entities.Single(e => Label(e).StartsWith("AuditEntry", StringComparison.Ordinal));
        Assert.Equal("likely", Confidence(audit));
        Assert.Contains("ApplyConfigurationsFromAssembly", Label(audit));
        var order = entities.Single(e => Label(e).StartsWith("Order ", StringComparison.Ordinal));
        Assert.Equal("proven", Confidence(order)); // DbSet<Order> Orders
        var unknown = entities.Single(e => Label(e).StartsWith("Unknown", StringComparison.Ordinal));
        Assert.Equal("heuristic", Confidence(unknown));
        Assert.Contains(Limits(unknown), l => l.Contains("unknown") && l.Contains("no database"));
    }

    // ------------------------------------------------------------------ entity

    [Fact]
    public async Task EntityRelatesToContextsConfigurationTableNavigationsQueriesAndMigrations()
    {
        var related = await RelatedAsync(Entities, "class Order", "class ".Length + 1);
        var contexts = Relations(related, "efcore.dbContext").Select(Label).ToList();
        Assert.Contains(contexts, l => l.StartsWith("ShopDbContext", StringComparison.Ordinal));
        Assert.Contains(contexts, l => l.StartsWith("ReportingDbContext", StringComparison.Ordinal));

        Assert.Contains(Relations(related, "efcore.configuration"), r => Label(r).Contains("OrderConfiguration") && Confidence(r) == "proven");

        var table = Assert.Single(Relations(related, "efcore.table"));
        Assert.Equal("orders", Label(table));
        Assert.Equal("proven", Confidence(table));

        var navs = Relations(related, "efcore.navigation").Select(Label).ToList();
        Assert.Contains(navs, l => l.Contains("Customer") && l.Contains("CustomerId"));
        Assert.Contains(navs, l => l.Contains("Lines") && l.Contains("OrderLine"));
        Assert.Contains(navs, l => l.Contains("ShippingAddress") && l.Contains("owned"));

        var queries = Relations(related, "efcore.query");
        Assert.All(queries, q => Assert.Equal("callers", Group(q)));
        Assert.Contains(queries, q => Label(q).Contains("OrderQueries.Open"));
        Assert.Contains(queries, q => Label(q).Contains("OrderQueries.CountWithLines"));
        // The query inside the Minimal API handler links the entity to that endpoint.
        Assert.Contains(Relations(related, "aspnet.endpoint"), e => e.GetProperty("target").GetProperty("endpoint").GetProperty("route").GetString() == "/orders/{id}");

        var migrations = Relations(related, "efcore.migration");
        Assert.Contains(migrations, m => Label(m).Contains("Initial") && Label(m).Contains("orders"));
        Assert.All(migrations, m => Assert.Contains("read-only", Label(m)));
    }

    [Fact]
    public async Task ConventionTableNameIsLikelyAndAttributeTableIsProven()
    {
        var line = await RelatedAsync(Entities, "class OrderLine", "class ".Length + 1);
        var t = Assert.Single(Relations(line, "efcore.table"));
        Assert.Equal("OrderLine (convention)", Label(t));
        Assert.Equal("likely", Confidence(t));

        var customer = await RelatedAsync(Entities, "class Customer", "class ".Length + 1);
        Assert.Equal("customers", Label(Assert.Single(Relations(customer, "efcore.table"))));
        Assert.Contains(Relations(customer, "efcore.configuration"), r => Label(r).Contains("Entity<Customer>()"));

        var product = await RelatedAsync(Entities, "class Product", "class ".Length + 1);
        var pt = Assert.Single(Relations(product, "efcore.table"));
        Assert.Equal("catalog.catalog_products", Label(pt));
        Assert.Equal("proven", Confidence(pt));
        // [NotMapped] Suggested is no navigation; Supplier is one by convention (likely).
        var navs = Relations(product, "efcore.navigation");
        Assert.DoesNotContain(navs, n => Label(n).Contains("Suggested"));
        Assert.Contains(navs, n => Label(n).Contains("Supplier") && Confidence(n) == "likely");
    }

    [Fact]
    public async Task InverseNavigationAndOwnedTypeAreRelated()
    {
        var customer = await RelatedAsync(Entities, "class Customer", "class ".Length + 1);
        Assert.Contains(Relations(customer, "efcore.navigation"), n => Label(n).Contains("Orders") && Confidence(n) == "proven");
        var address = await RelatedAsync(Entities, "class Address", "class ".Length + 1);
        Assert.Contains(Relations(address, "efcore.navigation"), n => Label(n).Contains("owned") && Label(n).Contains("Order"));
    }

    [Fact]
    public async Task ConfigurationClassRelatesToItsEntityAndContexts()
    {
        var related = await RelatedAsync(Config, "class OrderConfiguration", "class ".Length + 1);
        Assert.Contains(Relations(related, "efcore.entity"), r => Label(r).StartsWith("Order", StringComparison.Ordinal));
        Assert.Contains(Relations(related, "efcore.dbContext"), r => Label(r).StartsWith("ShopDbContext", StringComparison.Ordinal));
    }

    [Fact]
    public async Task NonEntityHasNoEfRelations()
    {
        var related = await RelatedAsync(Entities, "class OrderSummary", "class ".Length + 1);
        Assert.Empty(related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString()!.StartsWith("efcore.", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ForeignSameNameDbContextAndDbSetAreNotEfCore()
    {
        var ctx = await RelatedAsync(Legacy, "class LegacyContext", "class ".Length + 1);
        Assert.Empty(ctx.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString()!.StartsWith("efcore.", StringComparison.Ordinal)));
        var widget = await RelatedAsync(Legacy, "class Widget", "class ".Length + 1);
        Assert.Empty(widget.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString()!.StartsWith("efcore.", StringComparison.Ordinal)));
        Assert.DoesNotContain(await SearchAsync("entity:", new { }), i => SymbolName(i) == "Widget");
    }

    // ------------------------------------------------------------------ find filters

    [Fact]
    public async Task EntityFilterFindsOnlyEfEntities()
    {
        var all = (await SearchAsync("entity:", new { })).Select(SymbolName).ToList();
        foreach (var want in new[] { "Customer", "Order", "OrderLine", "Product", "AuditEntry" }) Assert.Contains(want, all);
        Assert.DoesNotContain("OrderSummary", all);
        Assert.DoesNotContain("ShopDbContext", all);
        var named = (await SearchAsync("Order", new { entity = true })).Select(SymbolName).ToList();
        Assert.Contains("Order", named);
        Assert.Contains("OrderLine", named);
        Assert.DoesNotContain("OrderSummary", named);
        Assert.DoesNotContain("OrderQueries", named);
    }

    [Fact]
    public async Task TableFilterFindsEntitiesByMappedTableName()
    {
        var items = await SearchAsync("table:catalog_products", new { });
        Assert.Equal("Product", SymbolName(Assert.Single(items)));
        var conv = await SearchAsync("", new { table = "OrderLine" });
        Assert.Equal("OrderLine", SymbolName(Assert.Single(conv)));
        var partial = (await SearchAsync("table:order", new { })).Select(SymbolName).ToList();
        Assert.Contains("Order", partial);
        Assert.Contains("OrderLine", partial);
    }

    [Fact]
    public async Task CapabilityReportsEfCoreDetection()
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap });
        var related = r.EnumerateArray().Single(c => c.GetProperty("capabilityId").GetString() == "csharp.related");
        Assert.Contains("EF Core", related.GetProperty("message").GetString());
    }
}
