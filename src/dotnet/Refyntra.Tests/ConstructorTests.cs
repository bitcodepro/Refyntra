using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>One opened copy of the Ctor fixture (two projects, two composition roots) for the constructor / DI / fix-all tests.</summary>
public sealed class CtorFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("Ctor", "Ctor.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Dir = Path.GetDirectoryName(sln)!;
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();

    public string App(string rel) => Path.GetFullPath(Path.Combine(Dir, "Ctor.App", rel.Replace('/', Path.DirectorySeparatorChar)));
    public string Lib(string rel) => Path.GetFullPath(Path.Combine(Dir, "Ctor.Lib", rel.Replace('/', Path.DirectorySeparatorChar)));
}

/// <summary>
/// code/constructorActions (protocol 1.11): constructor and DI helpers computed by Roslyn — fields / properties from
/// parameters, initialising members (partial types across files), creating injected fields with inferred types,
/// naming styles, generic types, records, primary constructors, call-site refusals — and csharp.registerDi plans.
/// </summary>
public sealed class ConstructorTests : IClassFixture<CtorFixture>
{
    private readonly CtorFixture _f;
    public ConstructorTests(CtorFixture f) => _f = f;

    private TestClient C => _f.Client;

    private async Task<JsonElement> RequestAsync(string file, string needle, int offset, object? extra, string? text = null)
    {
        text ??= await File.ReadAllTextAsync(file);
        var (line, ch) = TestClient.Position(text, needle, offset);
        var snap = await C.BarrierAsync();
        var p = new Dictionary<string, object?>
        {
            ["traceId"] = "t", ["workspaceId"] = C.WorkspaceId, ["snapshotId"] = snap, ["uri"] = UriPaths.ToUri(file), ["position"] = new { line, character = ch },
        };
        if (extra != null) foreach (var pr in extra.GetType().GetProperties()) p[pr.Name] = pr.GetValue(extra);
        return await C.RequestAsync("code/constructorActions", p);
    }

    private async Task<List<(string Id, string Title, JsonElement Item)>> ListAsync(string file, string needle, int offset = 1, string? text = null)
    {
        var r = await RequestAsync(file, needle, offset, null, text);
        return r.GetProperty("items").EnumerateArray().Select(i => (i.GetProperty("actionId").GetString()!, i.GetProperty("title").GetString()!, i)).ToList();
    }

    /// <summary>Computes and returns the new text of every changed file (path → text, LF).</summary>
    private async Task<Dictionary<string, string>> ComputeAsync(string file, string needle, int offset, object request, string? text = null, Dictionary<string, string>? overlays = null)
    {
        var r = await RequestAsync(file, needle, offset, request, text);
        Assert.True(r.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array, r.ToString());
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in files.EnumerateArray())
        {
            var path = Path.GetFullPath(UriPaths.ToPath(f.GetProperty("uri").GetString()!));
            var before = overlays != null && overlays.TryGetValue(path, out var o) ? o : path == file && text != null ? text : await File.ReadAllTextAsync(path);
            result[path] = MoveTypeTests.ApplyEdits(before, f).Replace("\r\n", "\n");
        }
        return result;
    }

    private async Task<JsonElement> RefusedAsync(string file, string needle, int offset, object request, string reason, string? text = null)
    {
        var r = await RequestAsync(file, needle, offset, request, text);
        Assert.False(r.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
        return r;
    }

    private static void Has(string expected, string actual) =>
        Assert.True(actual.Contains(expected, StringComparison.Ordinal), $"expected:\n{expected}\n---- actual:\n{actual}");

    private string OrderService => _f.App("Services/OrderService.cs");
    private string Formatter => _f.App("Services/ReportFormatter.cs");

    [Fact]
    public async Task ParameterActionsAreListedWithTheirTitles()
    {
        var titles = (await ListAsync(OrderService, "orders,")).Select(x => x.Title).ToList();
        Assert.Contains("Create and initialize field '_orders'", titles);
        Assert.Contains("Create and initialize property 'Orders'", titles);
        Assert.Contains("Initialize all unassigned parameters from constructor", titles);
        Assert.Contains("Register 'IOrderRepository' in DI…", titles);
        // The used parameter offers no field, the framework-free registration stays.
        var used = (await ListAsync(OrderService, "audit,")).Select(x => x.Title).ToList();
        Assert.DoesNotContain(used, t => t.StartsWith("Create and initialize field", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreatesFieldNextToTheOthersAndAssignsIt()
    {
        var after = (await ComputeAsync(OrderService, "orders,", 1, new { actionId = "csharp.ctor.introduceField" }))[OrderService];
        Has("    private readonly IAuditTrail _audit;\n    private readonly IOrderRepository _orders;\n", after);
        Has("        _audit = audit;\n        _orders = orders;\n    }", after);
    }

    [Fact]
    public async Task CreatesPropertyAndInitializesAllParameters()
    {
        var prop = (await ComputeAsync(OrderService, "orders,", 1, new { actionId = "csharp.ctor.introduceProperty" }))[OrderService];
        Has("public IOrderRepository Orders { get; }", prop);
        Has("        Orders = orders;\n", prop);
        var all = (await ComputeAsync(OrderService, "orders,", 1, new { actionId = "csharp.ctor.initializeAllParameters" }))[OrderService];
        Has("    private readonly IOrderRepository _orders;\n    private readonly INotifier _notifier;\n", all);
        Has("        _orders = orders;\n        _notifier = notifier;\n", all);
    }

    [Fact]
    public async Task FullyQualifiedParameterTypeGetsAUsing()
    {
        var after = (await ComputeAsync(Formatter, "repository)", 1, new { actionId = "csharp.ctor.introduceField" }))[Formatter];
        Has("using Ctor.Lib.Data;", after);
        Has("    private readonly SqlOrderRepository _repository;", after);
        Has("        _repository = repository;", after);
    }

    [Fact]
    public async Task GenericTypesRecordsAndPrimaryConstructors()
    {
        var generic = (await ComputeAsync(Formatter, "repo)", 1, new { actionId = "csharp.ctor.introduceField" }))[Formatter];
        Has("    private readonly IRepo<Order> _repo;", generic);
        Assert.Empty(await ListAsync(Formatter, "int Id)", 5)); // positional record parameter
        var bill = (await ComputeAsync(Formatter, "IClock clock)\n    {", 8, new { actionId = "csharp.ctor.introduceField" }))[Formatter];
        Has("public record Bill\n{\n    private readonly IClock _clock;\n", bill);
        var titles = (await ListAsync(Formatter, "clock)\n{\n    public int Size")).Select(x => x.Title).ToList();
        Assert.Contains("Create field '_clock' from primary constructor parameter", titles);
        var cache = (await ComputeAsync(Formatter, "clock)\n{\n    public int Size", 1, new { actionId = "csharp.ctor.introduceField" }))[Formatter];
        Has("    private readonly IClock _clock = clock;", cache);
    }

    [Fact]
    public async Task NamingFollowsEditorConfigThenExistingFields()
    {
        var billing = _f.App("Naming/Billing.cs");
        var titles = (await ListAsync(billing, "orders)")).Select(x => x.Title).ToList();
        Assert.Contains("Create and initialize field 'm_Orders'", titles);
        var after = (await ComputeAsync(billing, "orders)", 1, new { actionId = "csharp.ctor.introduceField" }))[billing];
        Has("    private readonly IOrderRepository m_Orders;", after);
        Has("        m_Orders = orders;", after);
        // camelCase fields: the same name as the parameter, so the assignment keeps 'this.'.
        var camel = (await ComputeAsync(Formatter, "clock)\n    {\n        this.audit", 1, new { actionId = "csharp.ctor.introduceField" }))[Formatter];
        Has("    private readonly IClock clock;", camel);
        Has("        this.clock = clock;", camel);
    }

    [Fact]
    public async Task InitializesUnassignedFieldsAndCreatesTheConstructor()
    {
        var items = await ListAsync(Formatter, "_orders;");
        Assert.Contains(items, x => x.Title == "Initialize '_orders' from constructor");
        Assert.Contains(items, x => x.Title == "Initialize all readonly fields from constructor");
        var after = (await ComputeAsync(Formatter, "_orders;", 1, new { actionId = "csharp.ctor.initializeMembers", members = new[] { "_orders", "_clock" } }))[Formatter];
        Has("    public ReportFormatter(IOrderRepository orders, IClock clock)\n    {\n        _orders = orders;\n        _clock = clock;\n    }", after);
    }

    [Fact]
    public async Task PartialTypeAcrossFilesEditsThePartWithTheConstructor()
    {
        var part1 = _f.App("Services/Ledger.Part1.cs");
        var part2 = _f.App("Services/Ledger.Part2.cs");
        var titles = (await ListAsync(part1, "_clock;")).Select(x => x.Title).ToList();
        Assert.Contains("Initialize '_clock' from constructor", titles);
        var files = await ComputeAsync(part1, "_clock;", 1, new { actionId = "csharp.ctor.initializeMembers", members = new[] { "_clock" } });
        Assert.False(files.ContainsKey(part1));
        Has("    public Ledger(IAuditTrail audit, IClock clock)\n    {\n        _audit = audit;\n        _clock = clock;\n    }", files[part2]);
    }

    [Fact]
    public async Task RefusesWhenTheConstructorIsCalled()
    {
        var r = await RefusedAsync(Formatter, "_clock;\n\n    public Created", 1, new { actionId = "csharp.ctor.initializeMembers", members = new[] { "_clock" } }, "CallSites");
        Assert.Contains("Change Signature", r.GetProperty("message").GetString());
        // Asking: no members given → the candidates with the unassigned ones picked.
        var ask = await RequestAsync(Formatter, "class ReportFormatter", 8, new { actionId = "csharp.ctor.addParameters" });
        Assert.Equal("members", ask.GetProperty("need").GetString());
    }

    [Fact]
    public async Task CreatesInjectedFieldWithInferredTypes()
    {
        var text = (await File.ReadAllTextAsync(OrderService)).Replace("public void Place(int id) => _audit.Record(\"place\", id);",
            "public void Place(int id) { _audit.Record(\"place\", id); _sender.Notify(\"placed\"); _logger.LogInformation(\"x\"); _thing.ToString(); }").Replace("\r\n", "\n");
        await C.DidOpenAsync(OrderService, text);
        try
        {
            var items = await ListAsync(OrderService, "_sender.", 2, text);
            Assert.Contains(items, x => x.Title == "Create field '_sender' and inject via constructor");
            // Only INotifier has Notify(string): inferred; it is not registered in DI, so the client offers to register it.
            var r = await RequestAsync(OrderService, "_sender.", 2, new { actionId = "csharp.ctor.createInjectedField" }, text);
            Assert.Equal("T:Ctor.Lib.Contracts.INotifier", r.GetProperty("registerTypeId").GetString());
            var after = MoveTypeTests.ApplyEdits(text, r.GetProperty("files")[0]).Replace("\r\n", "\n");
            Has("    private readonly INotifier _sender;", after);
            // The unused 'notifier' parameter has that type: it is reused instead of adding a parameter.
            Has("INotifier notifier)", after);
            Has("        _sender = notifier;", after);
            // _logger → ILogger<OrderService> with the logging using added.
            var log = (await ComputeAsync(OrderService, "_logger.", 2, new { actionId = "csharp.ctor.createInjectedField" }, text))[OrderService];
            Has("using Microsoft.Extensions.Logging;", log);
            Has("    private readonly ILogger<OrderService> _logger;", log);
            // Nothing to go by: the client asks for the type; a typed name is resolved.
            var ask = await RequestAsync(OrderService, "_thing.", 2, new { actionId = "csharp.ctor.createInjectedField" }, text);
            Assert.Equal("type", ask.GetProperty("need").GetString());
            var typed = (await ComputeAsync(OrderService, "_thing.", 2, new { actionId = "csharp.ctor.createInjectedField", type = "IClock" }, text))[OrderService];
            Has("    private readonly IClock _thing;", typed);
            await RefusedAsync(OrderService, "_thing.", 2, new { actionId = "csharp.ctor.createInjectedField", type = "NoSuchType" }, "UnknownType", text);
        }
        finally
        {
            await C.DidCloseAsync(OrderService);
        }
    }

    // ------------------------------------------------------------------ Register in DI

    private async Task<JsonElement> PrepareRegisterAsync(string file, string needle, object registration)
    {
        var text = await File.ReadAllTextAsync(file);
        var (line, ch) = TestClient.Position(text, needle, 1);
        var snap = await C.BarrierAsync();
        return await C.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, actionId = "csharp.registerDi", symbolId = "", newName = "",
            documentUri = UriPaths.ToUri(file), range = new { start = new { line, character = ch }, end = new { line, character = ch } }, registration,
        });
    }

    [Fact]
    public async Task RegisterInDiOffersRootsAndImplementationsAndPreparesAPlan()
    {
        var d = await RequestAsync(OrderService, "orders,", 1, new { actionId = "csharp.ctor.registerDi" });
        var reg = d.GetProperty("registration");
        Assert.Equal("IOrderRepository", reg.GetProperty("service").GetString());
        Assert.Equal(new[] { "SqlOrderRepository" }, reg.GetProperty("implementations").EnumerateArray().Select(x => x.GetProperty("label").GetString()).ToArray());
        var roots = reg.GetProperty("roots").EnumerateArray().ToList();
        Assert.Equal(2, roots.Count);
        Assert.Equal("builder.Services in Program.cs", roots[0].GetProperty("label").GetString());
        Assert.Equal("AddInfrastructure(services) in ServiceCollectionExtensions.cs", roots[1].GetProperty("label").GetString());

        // Two composition roots: one must be chosen.
        RefactoringFixture.Unavailable(await PrepareRegisterAsync(OrderService, "orders,", new { lifetime = "Scoped" }), "ChooseCompositionRoot");
        var plan = RefactoringFixture.Prepared(await PrepareRegisterAsync(OrderService, "orders,", new { lifetime = "Scoped", rootId = roots[0].GetProperty("id").GetString() }));
        var program = RefactoringFixture.After(plan, _f.App("Program.cs")).Replace("\r\n", "\n");
        Has("builder.Services.AddInfrastructure();\nbuilder.Services.AddScoped<IOrderRepository, SqlOrderRepository>();\n", program);
        Has("using Ctor.Lib.Contracts;", program);
        Has("using Ctor.Lib.Data;", program);
        var ext = RefactoringFixture.Prepared(await PrepareRegisterAsync(OrderService, "orders,", new { lifetime = "Singleton", rootId = roots[1].GetProperty("id").GetString() }));
        Has("        services.AddTransient<Services.ReportFormatter>();\n        services.AddSingleton<IOrderRepository, SqlOrderRepository>();\n        return services;",
            RefactoringFixture.After(ext, _f.App("ServiceCollectionExtensions.cs")).Replace("\r\n", "\n"));
    }

    [Fact]
    public async Task RegisterInDiRefusals()
    {
        var registered = await RequestAsync(OrderService, "audit,", 1, new { actionId = "csharp.ctor.registerDi" });
        Assert.Equal("AlreadyRegistered", registered.GetProperty("reasonCode").GetString());
        var two = await RequestAsync(OrderService, "notifier)", 1, new { actionId = "csharp.ctor.registerDi" });
        Assert.Equal(2, two.GetProperty("registration").GetProperty("implementations").GetArrayLength());
        RefactoringFixture.Unavailable(await PrepareRegisterAsync(OrderService, "notifier)", new { lifetime = "Scoped", rootId = "x" }), "ChooseImplementation");
        var none = await RequestAsync(Formatter, "clock)\n    {\n    }\n}\n\npublic class Generic", 1, new { actionId = "csharp.ctor.registerDi" });
        Assert.Equal("NoImplementation", none.GetProperty("reasonCode").GetString());
    }
}

/// <summary>Register in DI without a composition root (the Refactorings fixture has no DI registrations).</summary>
public sealed class RegisterWithoutRootTests : IClassFixture<GenerateFixture>
{
    private readonly GenerateFixture _f;
    public RegisterWithoutRootTests(GenerateFixture f) => _f = f;

    [Fact]
    public async Task NoCompositionRootIsRefused()
    {
        var file = RefactoringFixture.Lib(_f.Dir, "Generate/Samples.cs");
        var text = (await File.ReadAllTextAsync(file)) + "\nnamespace NoRoot { public interface IStore { } public sealed class Store : IStore { } public sealed class UsesStore { public UsesStore(IStore store) { } } }\n";
        await _f.Client.DidOpenAsync(file, text);
        try
        {
            var (line, ch) = TestClient.Position(text, "store) { }", 1);
            var snap = await _f.Client.BarrierAsync();
            var r = await _f.Client.RequestAsync("code/constructorActions", new
            {
                traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file), position = new { line, character = ch }, actionId = "csharp.ctor.registerDi",
            });
            Assert.Equal("NoCompositionRoot", r.GetProperty("reasonCode").GetString());
        }
        finally
        {
            await _f.Client.DidCloseAsync(file);
        }
    }
}

/// <summary>Fix in scope (csharp.fixAll): one edit action in a document, a project or the whole solution (two projects).</summary>
public sealed class FixAllTests : IClassFixture<CtorFixture>
{
    private readonly CtorFixture _f;
    public FixAllTests(CtorFixture f) => _f = f;

    private async Task<JsonElement> PrepareAsync(string file, string actionId, string scope)
    {
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.fixAll", symbolId = "", newName = "",
            documentUri = UriPaths.ToUri(file), fixAll = new { actionId, scope },
        });
    }

    private static List<string> Files(JsonElement plan) =>
        plan.GetProperty("writeSet").EnumerateArray().Select(c => Path.GetFileName(UriPaths.ToPath(c.GetProperty("uri").GetString()!))).OrderBy(x => x, StringComparer.Ordinal).ToList();

    [Fact]
    public async Task VarToExplicitInSolutionProjectAndDocument()
    {
        var styles = _f.Lib("Fix/Styles.cs");
        var solution = RefactoringFixture.Prepared(await PrepareAsync(styles, "csharp.edit.varToExplicit", "solution"));
        Assert.Equal(new[] { "AppStyles.cs", "Program.cs", "Styles.cs" }, Files(solution));
        var lib = RefactoringFixture.After(solution, styles).Replace("\r\n", "\n");
        Assert.Contains("        int a = 1;\n        string name = \"x\";\n        List<int> list = new List<int>();", lib);
        Assert.Contains("int count = 3;", RefactoringFixture.After(solution, _f.App("Fix/AppStyles.cs")));
        Assert.Equal("csharp.fixAll", solution.GetProperty("actionId").GetString());
        var revalidated = await _f.Client.RevalidateAsync(await _f.Client.BarrierAsync(), solution.GetProperty("planId").GetString()!);
        Assert.Equal("valid", revalidated.GetProperty("status").GetString());
        // Generated code is skipped (and reported).
        Assert.Contains("generated file(s) skipped", RefactoringFixture.Limitations(solution));
        Assert.DoesNotContain("Generated.g.cs", Files(solution));

        var project = RefactoringFixture.Prepared(await PrepareAsync(styles, "csharp.edit.varToExplicit", "project"));
        Assert.Equal(new[] { "Styles.cs" }, Files(project));
        var document = RefactoringFixture.Prepared(await PrepareAsync(_f.App("Fix/AppStyles.cs"), "csharp.edit.varToExplicit", "document"));
        Assert.Equal(new[] { "AppStyles.cs" }, Files(document));
    }

    [Fact]
    public async Task InterpolationInScopeAndRefusals()
    {
        var app = _f.App("Fix/AppStyles.cs");
        var plan = RefactoringFixture.Prepared(await PrepareAsync(app, "csharp.edit.toInterpolatedString", "solution"));
        Assert.Contains("var text = $\"n={count}\";", RefactoringFixture.After(plan, app));
        RefactoringFixture.Unavailable(await PrepareAsync(app, "csharp.edit.invertIf", "solution"), "NotApplicable");
        RefactoringFixture.Unavailable(await PrepareAsync(app, "csharp.edit.usingToDeclaration", "solution"), "NoChanges");
    }
}
