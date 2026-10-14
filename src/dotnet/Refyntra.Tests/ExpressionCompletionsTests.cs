using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>code/expressionCompletions (protocol 1.21): Immediate window completions at a stopped position, bound by Roslyn.</summary>
public sealed class ExpressionCompletionsTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public ExpressionCompletionsTests(EditActionsFixture f) => _f = f;

    private string Callers => Lib(_f.Dir, "EditActions/InlineAcrossCallers.cs");

    private async Task<List<string>> CompleteAsync(string text, int? caret = null)
    {
        var source = await File.ReadAllTextAsync(Callers);
        var at = source.IndexOf("Pricing.WithTax(a)", StringComparison.Ordinal);
        int line = 0, ls = 0;
        for (var i = 0; i < at; i++) if (source[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("code/expressionCompletions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Callers),
            position = new { line, character = at - ls }, text, caret = caret ?? text.Length,
        });
        return r.GetProperty("items").EnumerateArray().Select(x => x.GetString()!).ToList();
    }

    [Fact]
    public async Task NamesInScopeStartWithThePrefix()
    {
        var items = await CompleteAsync("Pri");
        Assert.Contains("Pricing", items);
        Assert.All(items, i => Assert.StartsWith("pri", i, StringComparison.OrdinalIgnoreCase));
        Assert.Contains("a", await CompleteAsync("a"));
    }

    [Fact]
    public async Task MembersOfATypeAreItsAccessibleStaticMembers()
    {
        var items = await CompleteAsync("Pricing.");
        Assert.Contains("WithTax", items);
        Assert.Contains("Rate", items);
        Assert.DoesNotContain("Secret", items);
        Assert.Equal(new[] { "WithTax" }, await CompleteAsync("Pricing.Wi"));
    }

    [Fact]
    public async Task MembersOfAnExpressionComeFromItsType()
    {
        var items = await CompleteAsync("1 + a.");
        Assert.Contains("CompareTo", items);
        Assert.Contains("ToString", items);
        Assert.Contains("Length", await CompleteAsync("Pricing.WithTax(a).ToString()."));
    }

    [Fact]
    public async Task AnUnknownFileHasAReason()
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("code/expressionCompletions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Path.Combine(_f.Dir, "Nope.cs")),
            position = new { line = 0, character = 0 }, text = "x", caret = 1,
        });
        Assert.Equal("DocumentNotFound", r.GetProperty("reasonCode").GetString());
    }
}
