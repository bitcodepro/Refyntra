using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>code/completion and code/completionResolve (protocol 1.22): editor completion from Roslyn.</summary>
public sealed class EditorCompletionTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public EditorCompletionTests(EditActionsFixture f) => _f = f;

    private string Callers => Lib(_f.Dir, "EditActions/InlineAcrossCallers.cs");

    private async Task<JsonElement> CompleteAsync(string text, string? trigger)
    {
        var original = await File.ReadAllTextAsync(Callers);
        var at = original.IndexOf("Pricing.WithTax(a)", StringComparison.Ordinal);
        var edited = original[..at] + text + original[at..];
        var o = at + text.Length;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (edited[i] == '\n') { line++; ls = i + 1; }
        await _f.Client.DidOpenAsync(Callers, original);
        await _f.Client.DidChangeAsync(Callers, edited);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/completion", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Callers), position = new { line, character = o - ls }, triggerCharacter = trigger });
    }

    [Fact]
    public async Task MembersAfterADotAndTheirDescription()
    {
        var r = await CompleteAsync("Pricing.", ".");
        try
        {
            var items = r.GetProperty("items").EnumerateArray().ToList();
            var withTax = items.Single(i => i.GetProperty("label").GetString() == "WithTax");
            Assert.Equal("method", withTax.GetProperty("kind").GetString());
            Assert.Contains(items, i => i.GetProperty("label").GetString() == "Rate" && i.GetProperty("kind").GetString() == "constant");
            Assert.DoesNotContain(items, i => i.GetProperty("label").GetString() == "Secret");
            var d = await _f.Client.RequestAsync("code/completionResolve", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, listId = r.GetProperty("listId").GetString(), index = withTax.GetProperty("index").GetInt32() });
            Assert.Contains("WithTax(decimal net)", d.GetProperty("detail").GetString());
        }
        finally
        {
            await _f.Client.DidChangeAsync(Callers, await File.ReadAllTextAsync(Callers), 3);
        }
    }

    [Fact]
    public async Task KeywordsAndLocalsWhenInvoked()
    {
        var r = await CompleteAsync("ret", null);
        try
        {
            var labels = r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("label").GetString()).ToList();
            Assert.Contains("await", labels);
            Assert.Contains("a", labels);
            Assert.Contains("Pricing", labels);
        }
        finally
        {
            await _f.Client.DidChangeAsync(Callers, await File.ReadAllTextAsync(Callers), 3);
        }
    }
}
