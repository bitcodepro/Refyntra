using System.Text.Json;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>code/affectedTests (protocol 1.26) on the TestRunner fixture.</summary>
public sealed class AffectedTestsTests : IClassFixture<TestRunnerFixture>
{
    private readonly TestRunnerFixture _f;
    public AffectedTestsTests(TestRunnerFixture f) => _f = f;

    [Fact]
    public async Task AChangeOfTheCalculatorSelectsTheTestsThatUseItWithTheReason()
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("code/affectedTests", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uris = new[] { UriPaths.ToUri(_f.File("Calc", "Calculator.cs")) } });
        var tests = r.GetProperty("tests").EnumerateArray().ToDictionary(t => t.GetProperty("fullyQualifiedName").GetString()!, t => t.GetProperty("reason").GetString()!);
        Assert.Contains("XUnitTests.CalculatorTests.AddsTwoNumbers", tests.Keys);
        Assert.Contains(tests.Keys, k => k.StartsWith("MSTestTests.", StringComparison.Ordinal));
        Assert.Contains(tests.Keys, k => k.StartsWith("NUnitTests.", StringComparison.Ordinal));
        Assert.Matches("^references Calculator\\.(Add|Divide) \\(", tests["XUnitTests.CalculatorTests.AddsTwoNumbers"]);
        Assert.False(r.GetProperty("truncated").GetBoolean());
    }

    [Fact]
    public async Task ATestFileItselfSelectsNothing()
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("code/affectedTests", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uris = new[] { UriPaths.ToUri(_f.File("XUnitTests", "CalculatorTests.cs")) } });
        Assert.Empty(r.GetProperty("tests").EnumerateArray());
    }
}
