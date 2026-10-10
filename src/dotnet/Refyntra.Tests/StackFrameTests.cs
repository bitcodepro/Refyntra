using System.Text.Json;
using Refyntra.Semantics;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// code/resolveFrame on the StackTraces fixture: exact metadata name + parameter types = proven, name only = likely,
/// async/lambda/local-function frames (decoded by the client) map to the user method, generics, overloads, nested
/// types, constructors; metadata-only and missing symbols return nothing. Read-only: no file is written.
/// </summary>
public sealed class StackFrameFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var project = await Fixtures.CopyAsync("StackTraces", "StackTraces.csproj");
        Dir = Path.GetDirectoryName(project)!;
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(project);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

public sealed class StackFrameTests : IClassFixture<StackFrameFixture>
{
    private readonly StackFrameFixture _f;
    private TestClient C => _f.Client;
    private string _dir => _f.Dir;

    public StackFrameTests(StackFrameFixture f) => _f = f;

    private async Task<List<JsonElement>> ResolveAsync(string typeName, string methodName, string[]? parameterTypes = null, int? methodArity = null, string? localFunctionName = null)
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("code/resolveFrame", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, typeName, methodName, parameterTypes, methodArity, localFunctionName });
        Assert.Equal(snap, r.GetProperty("snapshotId").GetString());
        return r.GetProperty("candidates").EnumerateArray().ToList();
    }

    private (int line, int character) At(string rel, string needle, int offset = 0) =>
        TestClient.Position(File.ReadAllText(Path.Combine(_dir, rel.Replace('/', Path.DirectorySeparatorChar))), needle, offset);

    private static int Line(JsonElement c) => c.GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("line").GetInt32();
    private static string Confidence(JsonElement c) => c.GetProperty("confidence").GetString()!;

    [Fact]
    public async Task Exact_type_and_parameter_types_are_proven_and_pick_the_overload()
    {
        var c = Assert.Single(await ResolveAsync("Sample.Orders.OrderService", "Load", new[] { "Int32" }));
        Assert.Equal("proven", Confidence(c));
        Assert.Equal(At("Orders/OrderService.cs", "public int Load(int id)").line, Line(c));
        Assert.Equal("Load", c.GetProperty("symbol").GetProperty("name").GetString());
        // C# keyword spelling (Mono prints "int") means the same type.
        Assert.Equal("proven", Confidence(Assert.Single(await ResolveAsync("Sample.Orders.OrderService", "Load", new[] { "string" }))));
    }

    [Fact]
    public async Task Overloads_without_parameters_are_likely_and_all_listed()
    {
        var all = await ResolveAsync("Sample.Orders.OrderService", "Load");
        Assert.Equal(2, all.Count);
        Assert.All(all, c => Assert.Equal("likely", Confidence(c)));
        // Printed parameter types that match no overload (the code changed): every overload, likely, with the reason.
        var changed = await ResolveAsync("Sample.Orders.OrderService", "Load", new[] { "Double" });
        Assert.Equal(2, changed.Count);
        Assert.All(changed, c => Assert.Contains("differ", c.GetProperty("reason").GetString()));
    }

    [Fact]
    public async Task Async_and_lambda_frames_resolve_to_the_user_method_by_name()
    {
        var c = Assert.Single(await ResolveAsync("Sample.Orders.OrderService", "LoadAllAsync"));
        Assert.Equal("likely", Confidence(c));
        Assert.Equal(At("Orders/OrderService.cs", "public async Task<int> LoadAllAsync").line, Line(c));
    }

    [Fact]
    public async Task Local_function_opens_at_its_declaration()
    {
        var c = Assert.Single(await ResolveAsync("Sample.Orders.OrderService", "Run", localFunctionName: "Validate"));
        Assert.Equal(At("Orders/OrderService.cs", "static int Validate").line, Line(c));
        Assert.Contains("Local function Validate", c.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Generic_types_and_methods_constructors_arrays_and_nested_types()
    {
        var get = Assert.Single(await ResolveAsync("Sample.Orders.Repository`1", "Get", new[] { "TKey", "Boolean" }, methodArity: 1));
        Assert.Equal("proven", Confidence(get));
        Assert.DoesNotContain(await ResolveAsync("Sample.Orders.Repository`1", "Get", new[] { "TKey", "Boolean" }, methodArity: 2), c => Confidence(c) == "proven");
        var all = Assert.Single(await ResolveAsync("Sample.Orders.Repository`1", "All", new[] { "List`1", "String[]" }));
        Assert.Equal("proven", Confidence(all));
        var ctor = Assert.Single(await ResolveAsync("Sample.Orders.Repository`1", ".ctor", Array.Empty<string>()));
        Assert.Equal(At("Orders/Repository.cs", "public Repository()").line, Line(ctor));
        // A trace prints nested types with dots ("Outer.Nested"); reflection uses '+'.
        Assert.Equal("proven", Confidence(Assert.Single(await ResolveAsync("Sample.Orders.OrderService.Nested", "Inner", Array.Empty<string>()))));
        Assert.Equal("proven", Confidence(Assert.Single(await ResolveAsync("Sample.Orders.OrderService+Nested", "Inner", Array.Empty<string>()))));
    }

    [Fact]
    public async Task Type_found_by_simple_name_only_is_likely_and_same_named_types_are_all_offered()
    {
        var moved = Assert.Single(await ResolveAsync("Old.Namespace.OrderService", "Load", new[] { "Int32" }));
        Assert.Equal("likely", Confidence(moved));
        var helpers = await ResolveAsync("Elsewhere.Helpers", "Describe");
        Assert.Equal(2, helpers.Count);
    }

    [Fact]
    public async Task Metadata_only_and_missing_symbols_return_no_candidates()
    {
        Assert.Empty(await ResolveAsync("System.String", "Concat", new[] { "String", "String" }));
        Assert.Empty(await ResolveAsync("Sample.Orders.Gone", "Nothing"));
        // A removed method on an existing type: the type itself, likely.
        var type = Assert.Single(await ResolveAsync("Sample.Orders.OrderService", "Removed"));
        Assert.Equal("likely", Confidence(type));
    }

    [Theory]
    [InlineData("Int32", "Int32")]
    [InlineData("System.Int32", "Int32")]
    [InlineData("int", "Int32")]
    [InlineData("Int32&", "Int32")]
    [InlineData("ref int", "Int32")]
    [InlineData("String[]", "String[]")]
    [InlineData("System.Collections.Generic.List`1[System.Int32]", "List`1")]
    [InlineData("List<int>", "List`1")]
    [InlineData("Dictionary<string, int>", "Dictionary`2")]
    [InlineData("int?", "Nullable`1")]
    [InlineData("Int32[,]", "Int32[,]")]
    public void Printed_parameter_types_normalise(string printed, string expected) =>
        Assert.Equal(expected, StackFrameResolver.NormalizePrinted(printed));
}
