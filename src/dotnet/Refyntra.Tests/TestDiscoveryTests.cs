using System.Text.Json;
using Refyntra.Semantics;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>A copy of the TestRunner fixture (xUnit, NUnit and MSTest projects over a Calc library), loaded with MSBuild.</summary>
public sealed class TestRunnerFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("TestRunner", "TestRunner.sln");
        Dir = Path.GetDirectoryName(sln)!;
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
    }

    public string File(string project, string name) => Path.Combine(Dir, project, name);

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>code/tests (protocol 1.15): test discovery for the Test Explorer.</summary>
public sealed class TestDiscoveryTests : IClassFixture<TestRunnerFixture>
{
    private readonly TestRunnerFixture _f;

    public TestDiscoveryTests(TestRunnerFixture f) => _f = f;

    private async Task<JsonElement> TestsAsync(params string[] paths)
    {
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/tests", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap,
            uris = paths.Length == 0 ? null : paths.Select(UriPaths.ToUri).ToArray(),
        });
    }

    private static Dictionary<string, JsonElement> ByFqn(JsonElement r) =>
        r.GetProperty("tests").EnumerateArray().ToDictionary(t => t.GetProperty("fullyQualifiedName").GetString()!);

    private static List<string> Strings(JsonElement a) => a.EnumerateArray().Select(x => x.GetString()!).ToList();

    [Fact]
    public async Task ListsTheTestProjectsWithTheirFrameworks()
    {
        var r = await TestsAsync();
        var projects = r.GetProperty("projects").EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);
        Assert.Equal(new[] { "MSTestTests", "NUnitTests", "XUnitTests" }, projects.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal(new[] { "xUnit" }, Strings(projects["XUnitTests"].GetProperty("frameworks")));
        Assert.Equal(new[] { "NUnit" }, Strings(projects["NUnitTests"].GetProperty("frameworks")));
        Assert.Equal(new[] { "MSTest" }, Strings(projects["MSTestTests"].GetProperty("frameworks")));
        Assert.EndsWith("XUnitTests.csproj", projects["XUnitTests"].GetProperty("projectUri").GetString());
    }

    [Fact]
    public async Task XunitFactsTheoriesNestedClassesAndSkips()
    {
        var all = ByFqn(await TestsAsync());
        var fact = all["XUnitTests.CalculatorTests.AddsTwoNumbers"];
        Assert.Equal("xUnit", fact.GetProperty("framework").GetString());
        Assert.Equal("XUnitTests", fact.GetProperty("namespace").GetString());
        Assert.Equal(new[] { "CalculatorTests" }, fact.GetProperty("classes").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        Assert.Equal(8, fact.GetProperty("nameRange").GetProperty("start").GetProperty("line").GetInt32()); // public void AddsTwoNumbers() (0-based)
        Assert.Equal(0, fact.GetProperty("cases").GetArrayLength());
        Assert.False(fact.GetProperty("dynamicCases").GetBoolean());

        var theory = all["XUnitTests.CalculatorTests.AddTheory"];
        var cases = theory.GetProperty("cases").EnumerateArray().ToList();
        Assert.Equal(new[] { "(1, 2, 3)", "(2, 2, 4)", "(5, 5, 11)" }, cases.Select(c => c.GetProperty("label").GetString()));
        Assert.Equal(new[] { "1", "2", "3" }, Strings(cases[0].GetProperty("arguments")));
        Assert.Equal(27, cases[0].GetProperty("range").GetProperty("start").GetProperty("line").GetInt32());
        Assert.False(theory.GetProperty("dynamicCases").GetBoolean());

        Assert.True(all["XUnitTests.CalculatorTests.DividesByThree"].GetProperty("dynamicCases").GetBoolean());
        Assert.Equal("skipped on purpose", all["XUnitTests.CalculatorTests.SkippedOnPurpose"].GetProperty("skipReason").GetString());

        var nested = all["XUnitTests.CalculatorTests+Nested.NestedPasses"];
        Assert.Equal(new[] { "CalculatorTests", "Nested" }, nested.GetProperty("classes").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        // Helpers and data members are not tests.
        Assert.DoesNotContain(all.Keys, k => k.EndsWith(".Pairs", StringComparison.Ordinal));
    }

    [Fact]
    public async Task NunitAndMstestCases()
    {
        var all = ByFqn(await TestsAsync());
        var cases = all["NUnitTests.Arithmetic.DivideTests.DivideCases"];
        Assert.Equal("NUnit", cases.GetProperty("framework").GetString());
        Assert.Equal("NUnitTests.Arithmetic", cases.GetProperty("namespace").GetString());
        Assert.Equal(new[] { "(8, 2, 4)", "(9, 3, 3)" }, cases.GetProperty("cases").EnumerateArray().Select(c => c.GetProperty("label").GetString()));
        Assert.True(all["NUnitTests.Arithmetic.DivideTests.DivideSource"].GetProperty("dynamicCases").GetBoolean());
        Assert.Equal("ignored on purpose", all["NUnitTests.Arithmetic.DivideTests.IgnoredOnPurpose"].GetProperty("skipReason").GetString());
        Assert.True(all.ContainsKey("NUnitTests.Arithmetic.DivideTests.DividesEvenly"));

        var rows = all["MSTestTests.AddTests.AddRows"];
        Assert.Equal("MSTest", rows.GetProperty("framework").GetString());
        Assert.Equal(new[] { "(1, 1, 2)", "(3, 4, 7)" }, rows.GetProperty("cases").EnumerateArray().Select(c => c.GetProperty("label").GetString()));
        Assert.True(all.ContainsKey("MSTestTests.AddTests.AddsZero"));
        Assert.Equal(12, all.Count);
    }

    [Fact]
    public async Task IncrementalDiscoveryScansOnlyTheChangedDocument()
    {
        var path = _f.File("MSTestTests", "AddTests.cs");
        var text = await System.IO.File.ReadAllTextAsync(path);
        var changed = text.Replace("    [TestMethod]\n    public void AddsZero()", "    [TestMethod]\n    public void AddsOne()\n    {\n    }\n\n    [TestMethod]\n    public void AddsZero()").Replace("\r\n", "\n");
        Assert.NotEqual(text.Replace("\r\n", "\n"), changed);
        await _f.Client.DidOpenAsync(path, text);
        await _f.Client.DidChangeAsync(path, changed);
        try
        {
            var r = await TestsAsync(path);
            Assert.Equal(new[] { UriPaths.ToUri(path) }, Strings(r.GetProperty("documents")));
            var names = ByFqn(r).Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            Assert.Equal(new[] { "MSTestTests.AddTests.AddRows", "MSTestTests.AddTests.AddsOne", "MSTestTests.AddTests.AddsZero" }, names);
            // A production document has no tests (and is not an error).
            var calc = await TestsAsync(_f.File("Calc", "Calculator.cs"));
            Assert.Equal(0, calc.GetProperty("tests").GetArrayLength());
        }
        finally
        {
            await _f.Client.DidChangeAsync(path, text, 3);
            await _f.Client.DidCloseAsync(path);
        }
    }

    [Theory]
    [InlineData("\"abc\"", "abc")]
    [InlineData("1.5d", "1.5")]
    [InlineData("10L", "10")]
    [InlineData("Color.Red", "red")]
    [InlineData("'x'", "x")]
    [InlineData("true", "true")]
    [InlineData("null", "null")]
    [InlineData("-3", "-3")]
    public void NormalizesArgumentsLikeTheClient(string source, string expected) =>
        Assert.Equal(expected, TestDiscovery.NormalizeArgument(source));
}
