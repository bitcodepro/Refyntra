using System.Text.Json;
using System.Text.RegularExpressions;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>One in-process host with the (unmodified) Shop fixture loaded, shared by read-only tests.</summary>
public sealed class ShopFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public JsonElement Status { get; private set; }
    public string Dir => Path.GetDirectoryName(Fixtures.ShopSln)!;
    public string File(params string[] parts) => Path.Combine(new[] { Dir }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        await Fixtures.EnsureRestoredAsync(Fixtures.ShopSln);
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        Status = await Client.OpenAsync(Fixtures.ShopSln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

[CollectionDefinition("Shop")]
public sealed class ShopCollection : ICollectionFixture<ShopFixture>
{
}

[Collection("Shop")]
public sealed class ShopTests
{
    private readonly ShopFixture _f;
    private TestClient C => _f.Client;

    public ShopTests(ShopFixture f) => _f = f;

    private string Contracts => _f.File("Shop.Contracts", "Orders", "OrderRequests.cs");
    private string Notifications => _f.File("Shop.Contracts", "Orders", "OrderNotifications.cs");
    private string Handlers => _f.File("Shop.Api", "Handlers", "OrderHandlers.cs");
    private string Services => _f.File("Shop.Api", "Services", "OrderServices.cs");
    private string Program => _f.File("Shop.Api", "Program.cs");
    private string Legacy => _f.File("Shop.Api", "Legacy", "LegacyMessaging.cs");

    private static IEnumerable<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind);

    private async Task<(string snap, JsonElement symbol)> SymbolAsync(string path, string needle, int offset = 0)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return (snap, s);
    }

    private async Task<(string snap, JsonElement related)> RelatedAsync(string path, string needle, int offset = 0)
    {
        var (snap, s) = await SymbolAsync(path, needle, offset);
        return (snap, await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!));
    }

    [Fact]
    public void ShopLoadsReadyWithBothProjects()
    {
        var st = _f.Status;
        Assert.Equal("Ready", st.GetProperty("state").GetString());
        Assert.False(st.TryGetProperty("reasonCode", out _));
        Assert.EndsWith("Shop.sln", st.GetProperty("solutionPath").GetString());
        Assert.False(string.IsNullOrEmpty(st.GetProperty("sdk").GetProperty("version").GetString()));
        var projects = st.GetProperty("projects").EnumerateArray().ToList();
        Assert.Equal(new[] { "Shop.Api", "Shop.Contracts" }, projects.Select(p => p.GetProperty("name").GetString()).OrderBy(x => x));
        Assert.All(projects, p =>
        {
            Assert.Equal("loaded", p.GetProperty("state").GetString());
            Assert.Equal("net10.0", p.GetProperty("targetFramework").GetString());
            Assert.StartsWith("pc_", p.GetProperty("projectContextId").GetString());
        });
    }

    [Fact]
    public async Task SymbolAtReturnsOwnedSemanticSymbolRef()
    {
        var (snap, s) = await SymbolAsync(Contracts, "record GetOrderQuery", 7);
        Assert.Equal("GetOrderQuery", s.GetProperty("name").GetString());
        Assert.Equal("Shop.Contracts.Orders.GetOrderQuery", s.GetProperty("displayName").GetString());
        Assert.Equal("record", s.GetProperty("kind").GetString());
        Assert.Equal("Shop.Contracts.Orders", s.GetProperty("containerName").GetString());
        Assert.Equal("Shop.Contracts", s.GetProperty("projectName").GetString());
        Assert.Equal("source", s.GetProperty("origin").GetString());
        Assert.Equal(UriPaths.ToUri(Contracts), s.GetProperty("location").GetProperty("uri").GetString());
        var prov = s.GetProperty("provenance");
        Assert.Equal("owned-semantic", prov.GetProperty("kind").GetString());
        Assert.Equal(snap, prov.GetProperty("snapshotId").GetString());
        Assert.False(prov.TryGetProperty("observationId", out _)); // optional fields are omitted, not null
    }

    [Fact]
    public async Task SymbolAtOnWhitespaceReturnsNull()
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtAsync(snap, Contracts, 1, 0);
        Assert.Equal(JsonValueKind.Null, s.ValueKind);
    }

    [Fact]
    public async Task RequestRelatesToHandlerSendSiteAndEndpoint()
    {
        var (_, related) = await RelatedAsync(Contracts, "record GetOrderQuery", 7);
        Assert.Equal("GetOrderQuery", related.GetProperty("subject").GetProperty("name").GetString());
        Assert.Equal("complete", related.GetProperty("completeness").GetString());
        var details = related.GetProperty("scopeDetails");
        Assert.Equal(details.GetProperty("projectsTotal").GetInt32(), details.GetProperty("projectsComplete").GetInt32());
        Assert.False(details.GetProperty("restoreRecommended").GetBoolean());
        // Detected frameworks: evidence only; MediatR 12 is a verified version, so nothing limits confidence.
        var frameworks = details.GetProperty("frameworks").EnumerateArray().ToList();
        Assert.Contains(frameworks, f => f.GetProperty("id").GetString() == "mediatr" && f.GetProperty("versionVerified").GetBoolean());
        Assert.All(frameworks, f => Assert.True(f.GetProperty("versionVerified").GetBoolean()));
        Assert.All(frameworks, f => Assert.False(string.IsNullOrEmpty(f.GetProperty("evidence").GetString())));

        var handler = Assert.Single(Relations(related, "mediatr.handler"));
        Assert.Equal("handlers", handler.GetProperty("group").GetString());
        Assert.Equal("proven", handler.GetProperty("confidence").GetString());
        Assert.Equal("GetOrderQueryHandler", handler.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        Assert.Contains(handler.GetProperty("evidence").EnumerateArray(), e => e.GetProperty("description").GetString()!.Contains("MediatR"));

        var send = Assert.Single(Relations(related, "mediatr.send"));
        Assert.Equal("callers", send.GetProperty("group").GetString());
        Assert.Equal(UriPaths.ToUri(Program), send.GetProperty("target").GetProperty("location").GetProperty("uri").GetString());
        var programText = await File.ReadAllTextAsync(Program);
        var (line, ch) = TestClient.Position(programText, "Send(new GetOrderQuery");
        Assert.Equal(line, send.GetProperty("target").GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("line").GetInt32());
        Assert.Equal(ch, send.GetProperty("target").GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("character").GetInt32());

        var endpoint = Assert.Single(Relations(related, "aspnet.endpoint"));
        Assert.Equal("endpoints", endpoint.GetProperty("group").GetString());
        var info = endpoint.GetProperty("target").GetProperty("endpoint");
        Assert.Equal("/api/orders/{id:int}", info.GetProperty("route").GetString());
        Assert.Equal(new[] { "GET" }, info.GetProperty("httpMethods").EnumerateArray().Select(x => x.GetString()));
        Assert.False(info.GetProperty("routeIsDynamic").GetBoolean());
        Assert.Equal("minimal-api", info.GetProperty("kind").GetString());

        // Groups come in the contract order.
        var order = new[] { "declarations", "handlers", "callers", "endpoints", "registrations", "implementations", "references", "tests" };
        var groups = related.GetProperty("relations").EnumerateArray().Select(r => Array.IndexOf(order, r.GetProperty("group").GetString())).ToList();
        Assert.Equal(groups.OrderBy(x => x), groups);
    }

    [Fact]
    public async Task NotificationRelatesToEveryHandlerAndPublishSite()
    {
        var (_, related) = await RelatedAsync(Notifications, "record OrderPlaced", 7);
        var handlers = Relations(related, "mediatr.notificationHandler")
            .Select(r => r.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "OrderPlacedAuditHandler", "OrderPlacedEmailHandler" }, handlers);
        var publish = Assert.Single(Relations(related, "mediatr.send"));
        Assert.StartsWith("Publish", publish.GetProperty("target").GetProperty("label").GetString());
        Assert.Empty(Relations(related, "mediatr.handler"));
    }

    [Fact]
    public async Task HandlerRelatesToRequestAndResponse()
    {
        var (_, related) = await RelatedAsync(Handlers, "class GetOrderQueryHandler", 6);
        Assert.Equal("GetOrderQuery", Assert.Single(Relations(related, "mediatr.request")).GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        Assert.Equal("OrderDto", Assert.Single(Relations(related, "mediatr.response")).GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
    }

    [Fact]
    public async Task VoidRequestRelatesToHandlerAndSendInsideDeleteEndpoint()
    {
        var (_, related) = await RelatedAsync(Contracts, "record CancelOrderCommand", 7);
        Assert.Equal("CancelOrderCommandHandler", Assert.Single(Relations(related, "mediatr.handler")).GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        var endpoint = Assert.Single(Relations(related, "aspnet.endpoint")).GetProperty("target").GetProperty("endpoint");
        Assert.Equal("DELETE", Assert.Single(endpoint.GetProperty("httpMethods").EnumerateArray()).GetString());
        Assert.Equal("/api/orders/{id:int}", endpoint.GetProperty("route").GetString());
    }

    [Fact]
    public async Task ForeignSameNameRequestInterfaceIsNotMediatR()
    {
        var (_, related) = await RelatedAsync(Legacy, "class LegacyPing ", 6);
        Assert.DoesNotContain(related.GetProperty("relations").EnumerateArray(), r => r.GetProperty("relationKind").GetString()!.StartsWith("mediatr."));
        var (_, handlerRelated) = await RelatedAsync(Legacy, "class LegacyPingHandler", 6);
        Assert.DoesNotContain(handlerRelated.GetProperty("relations").EnumerateArray(), r => r.GetProperty("relationKind").GetString()!.StartsWith("mediatr."));
        // The legacy Send call inside an endpoint does not create a MediatR link either.
        Assert.DoesNotContain(related.GetProperty("relations").EnumerateArray(), r => r.GetProperty("relationKind").GetString() == "aspnet.endpoint");
    }

    [Fact]
    public async Task ServiceInterfaceRelatesToRegistrationsPerCompositionRootAndImplementations()
    {
        var (_, related) = await RelatedAsync(Services, "interface IOrderService", 10);
        var regs = Relations(related, "di.registration").Select(r => r.GetProperty("target").GetProperty("registration")).ToList();
        Assert.Equal(2, regs.Count);
        var byRoot = regs.ToDictionary(r => r.GetProperty("compositionRoot").GetString()!);
        Assert.Equal(new[] { "Program.<Main>$ (Shop.Api)", "Shop.Api.Infrastructure.InfrastructureServiceCollectionExtensions.AddShopInfrastructure (Shop.Api)" },
            byRoot.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("scoped", byRoot["Program.<Main>$ (Shop.Api)"].GetProperty("lifetime").GetString());
        Assert.Equal("AddScoped<IOrderService, OrderService>()", byRoot["Program.<Main>$ (Shop.Api)"].GetProperty("form").GetString());
        Assert.Equal("OrderService", byRoot["Program.<Main>$ (Shop.Api)"].GetProperty("implementationType").GetProperty("name").GetString());
        Assert.Equal("CachedOrderService", byRoot["Shop.Api.Infrastructure.InfrastructureServiceCollectionExtensions.AddShopInfrastructure (Shop.Api)"]
            .GetProperty("implementationType").GetProperty("name").GetString());

        var diImpls = Relations(related, "di.implementation").Select(r => r.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()).OrderBy(x => x);
        Assert.Equal(new[] { "CachedOrderService", "OrderService" }, diImpls);
        var impls = Relations(related, "implementation").Select(r => r.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString()).OrderBy(x => x);
        Assert.Equal(new[] { "CachedOrderService", "OrderService" }, impls);
    }

    [Fact]
    public async Task EachRegistrationIsReportedOnceForAnInterfaceSubject()
    {
        var (_, related) = await RelatedAsync(Services, "interface IOrderService", 10);
        var withRegistration = related.GetProperty("relations").EnumerateArray()
            .Where(r => r.GetProperty("target").TryGetProperty("registration", out _)).ToList();
        Assert.All(withRegistration, r => Assert.Equal("di.registration", r.GetProperty("relationKind").GetString()));
        var keys = withRegistration.Select(r => r.GetProperty("target").GetProperty("registration").GetProperty("location").ToString()).ToList();
        Assert.Equal(keys.Count, keys.Distinct().Count());
        Assert.Equal(2, Relations(related, "di.implementation").Count());
    }

    [Fact]
    public async Task TypeofAndTryAddRegistrationsAreRecognised()
    {
        var (_, clock) = await RelatedAsync(Services, "interface IClock", 10);
        var clockRegs = Relations(clock, "di.registration").Select(r => r.GetProperty("target").GetProperty("registration")).ToList();
        Assert.Contains(clockRegs, r => r.GetProperty("form").GetString() == "AddSingleton(typeof(IClock), typeof(SystemClock))"
            && r.GetProperty("lifetime").GetString() == "singleton" && r.GetProperty("compositionRoot").GetString() == "Program.<Main>$ (Shop.Api)");
        Assert.Contains(clockRegs, r => r.GetProperty("form").GetString() == "AddSingleton<IClock, SystemClock>()");

        var (_, audit) = await RelatedAsync(Services, "interface IAuditLog", 10);
        var auditReg = Assert.Single(Relations(audit, "di.registration"));
        Assert.Equal("TryAddTransient<IAuditLog, AuditLog>()", auditReg.GetProperty("target").GetProperty("registration").GetProperty("form").GetString());
        Assert.Equal("transient", auditReg.GetProperty("target").GetProperty("registration").GetProperty("lifetime").GetString());

        // Implementation → the service it is registered for.
        var (_, impl) = await RelatedAsync(Services, "class AuditLog ", 6);
        var service = Assert.Single(Relations(impl, "di.service"));
        Assert.Equal("IAuditLog", service.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
    }

    [Fact]
    public async Task SearchFindsTypesMembersAndEndpoints()
    {
        var snap = await C.BarrierAsync();
        async Task<List<JsonElement>> Search(string query, object filters, int limit = 50)
        {
            var r = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query, filters, limit });
            Assert.Equal(snap, r.GetProperty("snapshotId").GetString());
            return r.GetProperty("items").EnumerateArray().ToList();
        }

        var items = await Search("GetOrderQuery", new { });
        Assert.Equal("Shop.Contracts.Orders.GetOrderQuery", items[0].GetProperty("symbol").GetProperty("displayName").GetString());

        var types = await Search("Order", new { type = true });
        Assert.NotEmpty(types);
        Assert.All(types, i => Assert.Contains(i.GetProperty("symbol").GetProperty("kind").GetString(), new[] { "class", "record", "interface", "struct", "enum" }));

        var members = await Search("Find", new { member = true });
        Assert.All(members, i => Assert.Contains(i.GetProperty("symbol").GetProperty("kind").GetString(), new[] { "method", "property", "field", "event", "constructor" }));

        var api = await Search("", new { project = "Shop.Contracts" });
        Assert.Empty(api);
        var inContracts = await Search("Order", new { project = "shop.contracts" });
        Assert.All(inContracts, i => Assert.Equal("Shop.Contracts", i.GetProperty("symbol").GetProperty("projectName").GetString()));

        var routes = await Search("", new { route = "/api/orders" });
        Assert.Equal(3, routes.Count);
        Assert.All(routes, i => Assert.False(i.TryGetProperty("symbol", out _)));
        var gets = await Search("", new { route = "/api/orders", method = "GET" });
        Assert.Equal("/api/orders/{id:int}", Assert.Single(gets).GetProperty("endpoint").GetProperty("route").GetString());

        var dynamicRoute = (await Search("route:/api", new { })).Select(i => i.GetProperty("endpoint")).Single(e => e.GetProperty("routeIsDynamic").GetBoolean());
        Assert.Equal("/api/", dynamicRoute.GetProperty("route").GetString());

        var limited = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query = "Order", filters = new { }, limit = 2 });
        Assert.True(limited.GetProperty("truncated").GetBoolean());
        Assert.Equal(2, limited.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task ReferencesAndImplementationsAreCrossProject()
    {
        var (snap, s) = await SymbolAsync(Contracts, "record GetOrderQuery", 7);
        var refs = await C.RequestAsync("code/references", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        var uris = refs.GetProperty("locations").EnumerateArray().Select(l => l.GetProperty("uri").GetString()).ToHashSet();
        Assert.Contains(UriPaths.ToUri(Program), uris);
        Assert.Contains(UriPaths.ToUri(Handlers), uris);
        Assert.All(refs.GetProperty("locations").EnumerateArray(), l => Assert.Contains("GetOrderQuery", l.GetProperty("preview").GetString()));

        var (snap2, svc) = await SymbolAsync(Services, "interface IOrderService", 10);
        var impls = await C.RequestAsync("code/implementations", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap2, symbolId = svc.GetProperty("symbolId").GetString() });
        Assert.Equal(2, impls.GetProperty("locations").GetArrayLength());
        Assert.Equal("complete", impls.GetProperty("completeness").GetString());
    }

    [Fact]
    public async Task CapabilityQueryReportsFrameworksAndRename()
    {
        var snap = await C.BarrierAsync();
        var text = await File.ReadAllTextAsync(Contracts);
        var (line, ch) = TestClient.Position(text, "record GetOrderQuery", 7);
        var caps = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Contracts), position = new { line, character = ch } });
        var byId = caps.EnumerateArray().ToDictionary(a => a.GetProperty("capabilityId").GetString()!);
        // The catalogue, plus the create-file and code refactoring actions that apply here (outside the catalogue, like
        // tests.run). Change Signature and Extract Method do not apply to a record declaration.
        Assert.Equal(ReviewFindingsTests.Catalogue.Concat(new[] { "csharp.moveTypeToFile", "csharp.generateHandler", "csharp.safeDelete" }).OrderBy(x => x), byId.Keys.OrderBy(x => x));
        // Safe Delete is offered by kind (the uses are checked when it is prepared).
        Assert.Equal("available", byId["csharp.safeDelete"].GetProperty("state").GetString());
        Assert.Equal("HandlerExists", byId["csharp.generateHandler"].GetProperty("reasonCode").GetString());
        Assert.Equal("available", byId["csharp.find"].GetProperty("state").GetString());
        Assert.Equal("available", byId["csharp.rename"].GetProperty("state").GetString());
        Assert.Equal("available", byId["csharp.related"].GetProperty("state").GetString());
        Assert.Equal("available", byId["csharp.references"].GetProperty("state").GetString());
        foreach (var fw in new[] { "MediatR", "ASP.NET Core", "Microsoft.Extensions.DependencyInjection" })
            Assert.Contains(fw, byId["csharp.related"].GetProperty("message").GetString());
        Assert.DoesNotContain(byId["csharp.related"].GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("not referenced") && !l.GetString()!.StartsWith("EF Core", StringComparison.Ordinal)); // Shop has no EF Core
        Assert.Equal("workspace", byId["csharp.rename"].GetProperty("requiredTrust").GetString());

        var meta = await C.RequestAsync("capability/query", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Contracts),
            position = new { line = TestClient.Position(text, ": IRequest<OrderDto>", 2).line, character = TestClient.Position(text, ": IRequest<OrderDto>", 2).character } });
        var rename = meta.EnumerateArray().Single(a => a.GetProperty("capabilityId").GetString() == "csharp.rename");
        Assert.Equal("unavailable", rename.GetProperty("state").GetString());
        Assert.Equal("MetadataSymbol", rename.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task StaleSnapshotIsRejected()
    {
        await C.BarrierAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => C.SymbolAtAsync("snap-0", Contracts, 0, 0));
        Assert.Equal(-33004, ex.Code);
        Assert.Equal("StaleSnapshot", ex.ReasonCode);
    }

    [Fact]
    public async Task UnknownSymbolIdIsRejected()
    {
        var snap = await C.BarrierAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => C.RelatedAsync(snap, "not-a-symbol-id"));
        Assert.Equal(-33005, ex.Code);
    }

    [Fact]
    public async Task BarrierWaitingForAnUnsentSequenceCanBeCancelled()
    {
        var id = C.NextId();
        var pending = C.RawRequestAsync("workspace/snapshotBarrier", new { traceId = "t", workspaceId = C.WorkspaceId, sequence = 1_000_000_000 }, id);
        await Task.Delay(200);
        await C.NotifyAsync("$/cancelRequest", new { id });
        var response = await pending.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(-32800, response.GetProperty("error").GetProperty("code").GetInt32());
    }

    [Fact]
    public async Task ConcurrentRequestsAreServed()
    {
        var snap = await C.BarrierAsync();
        var text = await File.ReadAllTextAsync(Contracts);
        var (line, ch) = TestClient.Position(text, "record GetOrderQuery", 7);
        var tasks = Enumerable.Range(0, 8).Select(_ => C.SymbolAtAsync(snap, Contracts, line, ch)).ToList();
        var results = await Task.WhenAll(tasks);
        Assert.All(results, r => Assert.Equal("GetOrderQuery", r.GetProperty("name").GetString()));
    }

    // ------------------------------------------------------------------ rename (preview only)

    [Fact]
    public async Task RenamePrepareProducesCrossProjectGoldenEdits()
    {
        var (snap, s) = await SymbolAsync(Contracts, "record GetOrderQuery", 7);
        var result = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "FetchOrderQuery");
        Assert.Equal("prepared", result.GetProperty("kind").GetString());
        var plan = result.GetProperty("plan");
        Assert.Equal("csharp.rename", plan.GetProperty("actionId").GetString());
        Assert.Equal("owned-semantic", plan.GetProperty("kind").GetString());
        Assert.Equal(snap, plan.GetProperty("baseSnapshotId").GetString());
        Assert.Equal(1, plan.GetProperty("protocolMajor").GetInt32());
        Assert.Equal("Rename GetOrderQuery to FetchOrderQuery", plan.GetProperty("title").GetString());
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
        Assert.Equal(2, plan.GetProperty("projectContextIds").GetArrayLength());

        var writeSet = plan.GetProperty("writeSet").EnumerateArray().ToList();
        var expectedFiles = new[] { Contracts, Handlers, Program }.Select(UriPaths.ToUri).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(expectedFiles, writeSet.Select(w => w.GetProperty("uri").GetString()!).OrderBy(x => x, StringComparer.Ordinal).ToList());
        foreach (var change in writeSet)
        {
            Assert.Equal("text", change.GetProperty("kind").GetString());
            var path = UriPaths.ToPath(change.GetProperty("uri").GetString()!);
            var original = await File.ReadAllTextAsync(path);
            Assert.Equal(Hashing.Sha256Text(original), change.GetProperty("expectedHash").GetString());
            var applied = Apply(original, change.GetProperty("edits"));
            var golden = Regex.Replace(original, @"\bGetOrderQuery\b", "FetchOrderQuery");
            Assert.Equal(golden, applied);
            Assert.Equal(Hashing.Sha256Text(applied), change.GetProperty("resultHash").GetString());
        }

        var inputs = plan.GetProperty("readSet").EnumerateArray().Select(r => r.GetProperty("input").GetString()!).ToList();
        Assert.Contains(inputs, i => i.EndsWith("Shop.Contracts.csproj"));
        Assert.Contains(inputs, i => i.EndsWith("Shop.Api.csproj"));
        Assert.Contains(inputs, i => i.EndsWith(Path.Combine("Shop.Api", "obj", "project.assets.json")));
        Assert.Contains(inputs, i => i.EndsWith("global.json"));
        Assert.Contains(inputs, i => i.EndsWith("Directory.Build.props"));
        Assert.Contains(inputs, i => i.EndsWith(".editorconfig"));
        Assert.Contains(Services, inputs); // a source file that is not edited is still part of the read set

        var revalidated = await C.RevalidateAsync(snap, plan.GetProperty("planId").GetString()!);
        Assert.Equal("valid", revalidated.GetProperty("status").GetString());
        await C.NotifyAsync("refactor/discard", new { workspaceId = C.WorkspaceId, planId = plan.GetProperty("planId").GetString() });
        await Task.Delay(100);
        var discarded = await C.RevalidateAsync(snap, plan.GetProperty("planId").GetString()!);
        Assert.Equal("invalid", discarded.GetProperty("status").GetString());
    }

    public static string Apply(string text, JsonElement edits)
    {
        var lineStarts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lineStarts.Add(i + 1);
        int Offset(JsonElement p) => lineStarts[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        var list = edits.EnumerateArray().Select(e => (start: Offset(e.GetProperty("range").GetProperty("start")), end: Offset(e.GetProperty("range").GetProperty("end")),
            text: e.GetProperty("newText").GetString()!)).ToList();
        for (var i = 1; i < list.Count; i++) Assert.True(list[i].start >= list[i - 1].end, "edits must be sorted and non-overlapping");
        foreach (var e in list.AsEnumerable().Reverse()) text = text.Substring(0, e.start) + e.text + text.Substring(e.end);
        return text;
    }

    [Fact]
    public async Task RenameOfGeneratedCodeIsRefused()
    {
        var (snap, s) = await SymbolAsync(_f.File("Shop.Api", "Services", "OrderMetricsUser.cs"), "OrderMetrics.Requests", 2);
        Assert.Equal("generated", s.GetProperty("origin").GetString());
        var r = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "OrderCounters");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("GeneratedCode", r.GetProperty("reasonCode").GetString());
        Assert.False(r.TryGetProperty("plan", out _));
    }

    [Fact]
    public async Task RenameOfMetadataSymbolIsRefused()
    {
        var (snap, s) = await SymbolAsync(Contracts, ": IRequest<OrderDto>", 2);
        Assert.Equal("metadata", s.GetProperty("origin").GetString());
        Assert.False(s.TryGetProperty("location", out _));
        var r = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "IQuery");
        Assert.Equal("MetadataSymbol", r.GetProperty("reasonCode").GetString());
    }

    [Theory]
    [InlineData("class", "InvalidIdentifier")]
    [InlineData("1Order", "InvalidIdentifier")]
    [InlineData("Get Order", "InvalidIdentifier")]
    [InlineData("GetOrderQuery", "SameName")]
    [InlineData("CreateOrderCommand", "RenameConflict")]
    public async Task RenameGuardsRefuse(string newName, string reason)
    {
        var (snap, s) = await SymbolAsync(Contracts, "record GetOrderQuery", 7);
        var r = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, newName);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task RenameOfMemberImplementingMetadataInterfaceIsRefused()
    {
        var (snap, s) = await SymbolAsync(Handlers, "Task<OrderDto> Handle", 15);
        Assert.Equal("Handle", s.GetProperty("name").GetString());
        var r = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "Run");
        Assert.Equal("ImplementsMetadataMember", r.GetProperty("reasonCode").GetString());
    }
}
