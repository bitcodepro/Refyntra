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

/// <summary>
/// Packages not restored (no obj/project.assets.json): the test project is recognised from its project file and the
/// tests from the written attribute names, so the Test Explorer is not empty before the first restore.
/// </summary>
public sealed class UnrestoredTestDiscoveryTests
{
    [Fact]
    public async Task XunitV3AndNunitTestsAreFoundWithoutARestore()
    {
        var dir = Directory.CreateTempSubdirectory("refyntra-unrestored-").FullName;
        try
        {
            void Project(string name, string package, string code)
            {
                Directory.CreateDirectory(Path.Combine(dir, name));
                File.WriteAllText(Path.Combine(dir, name, name + ".csproj"),
                    $"<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup>\n" +
                    $"  <ItemGroup><PackageReference Include=\"{package}\" Version=\"1.0.0\" /></ItemGroup>\n</Project>\n");
                File.WriteAllText(Path.Combine(dir, name, "Tests.cs"), code);
            }
            Project("V3Tests", "xunit.v3.mtp-off",
                "using Xunit;\nnamespace V3;\npublic class CalcTests\n{\n    [Fact]\n    public void Adds() { }\n\n    [Theory]\n    [InlineData(1, 2)]\n    [InlineData(3, 4)]\n    public void Pairs(int a, int b) { }\n\n    public void NotATest() { }\n}\n");
            Project("NTests", "NUnit",
                "using NUnit.Framework;\nnamespace N;\npublic class MathTests\n{\n    [Test]\n    public void Works() { }\n\n    [TestCase(5)]\n    public void Cases(int x) { }\n}\n");
            Project("Plain", "Newtonsoft.Json", "namespace P;\npublic class C { [System.Obsolete] public void M() { } }\n");
            var sln = Path.Combine(dir, "Unrestored.slnx");
            File.WriteAllText(sln, "<Solution>\n  <Project Path=\"V3Tests/V3Tests.csproj\" />\n  <Project Path=\"NTests/NTests.csproj\" />\n  <Project Path=\"Plain/Plain.csproj\" />\n</Solution>\n");

            await using var client = TestClient.InProcess();
            await client.InitializeAsync();
            await client.OpenAsync(sln);
            var snap = await client.BarrierAsync();
            var r = await client.RequestAsync("code/tests", new { traceId = "t", workspaceId = client.WorkspaceId, snapshotId = snap, uris = (string[]?)null });
            var projects = r.GetProperty("projects").EnumerateArray().Select(p => p.GetProperty("name").GetString()!).OrderBy(x => x, StringComparer.Ordinal).ToList();
            Assert.Equal(new[] { "NTests", "V3Tests" }, projects);
            var tests = r.GetProperty("tests").EnumerateArray().ToDictionary(t => t.GetProperty("fullyQualifiedName").GetString()!);
            Assert.Equal(new[] { "N.MathTests.Cases", "N.MathTests.Works", "V3.CalcTests.Adds", "V3.CalcTests.Pairs" }, tests.Keys.OrderBy(k => k, StringComparer.Ordinal));
            Assert.Equal("xUnit", tests["V3.CalcTests.Adds"].GetProperty("framework").GetString());
            Assert.Equal("NUnit", tests["N.MathTests.Works"].GetProperty("framework").GetString());
            Assert.Equal(2, tests["V3.CalcTests.Pairs"].GetProperty("cases").GetArrayLength());
            Assert.Equal(1, tests["N.MathTests.Cases"].GetProperty("cases").GetArrayLength());
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch (IOException) { }
        }
    }
}

/// <summary>Tests inherited from abstract and generic base classes are listed under each concrete derived class.</summary>
public sealed class InheritedTestDiscoveryTests
{
    [Fact]
    public async Task AbstractAndGenericBaseTestsAppearUnderEachConcreteClass()
    {
        var sln = await Fixtures.CopyAsync("TestMatrix", "TestMatrix.slnx");
        await using var client = TestClient.InProcess();
        await client.InitializeAsync();
        await client.OpenAsync(sln);
        var snap = await client.BarrierAsync();
        var r = await client.RequestAsync("code/tests", new { traceId = "t", workspaceId = client.WorkspaceId, snapshotId = snap, uris = (string[]?)null });
        var tests = r.GetProperty("tests").EnumerateArray().ToDictionary(t => t.GetProperty("fullyQualifiedName").GetString()!);
        foreach (var fqn in new[]
        {
            "XUnit3.SqlStoreTests.Opens", "XUnit3.SqlStoreTests.Counts", "XUnit3.SqlStoreTests.OwnTest",
            "XUnit3.MemoryStoreTests.Opens", "XUnit3.MemoryStoreTests.Counts",
            "XUnit3.IntRepositoryTests.Creates", "NUnit4.JsonParserTests.Parses",
        })
            Assert.True(tests.ContainsKey(fqn), fqn);
        Assert.Equal(2, tests["XUnit3.MemoryStoreTests.Counts"].GetProperty("cases").GetArrayLength());
        // The abstract and generic classes themselves are not listed.
        Assert.DoesNotContain(tests.Keys, k => k.Contains("StoreTestsBase", StringComparison.Ordinal) || k.Contains("RepositoryTests`1", StringComparison.Ordinal) || k.Contains("ParserTestsBase", StringComparison.Ordinal));
    }
}
