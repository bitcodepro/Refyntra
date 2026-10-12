using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// code/editActions: Inline Method (call site / all call sites), Inline Field / Constant and Inline Parameter,
/// positive results and refusals (EditActions/InlineSamples.cs of the Refactorings fixture).
/// </summary>
public sealed class InlineMembersTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public InlineMembersTests(EditActionsFixture f) => _f = f;

    private string File => RefactoringFixture.Lib(_f.Dir, "EditActions/InlineSamples.cs");
    private const string P = "csharp.edit.";

    private async Task<JsonElement> RequestAsync(string needle, int offset, string? actionId)
    {
        var text = await System.IO.File.ReadAllTextAsync(File);
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var o = at + offset;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        var pos = new { line, character = o - ls };
        return await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(File),
            range = new { start = pos, end = pos }, actionId,
        });
    }

    private async Task<List<string>> ListAsync(string needle, int offset) =>
        (await RequestAsync(needle, offset, null)).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("actionId").GetString()!).ToList();

    private async Task<string> ComputeAsync(string needle, int offset, string actionId)
    {
        var r = await RequestAsync(needle, offset, actionId);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        var text = await System.IO.File.ReadAllTextAsync(File);
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    private async Task RefusedAsync(string needle, int offset, string actionId, string reason)
    {
        var r = await RequestAsync(needle, offset, actionId);
        Assert.False(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task InlineMethodAtOneCallSiteKeepsTheDeclaration()
    {
        Assert.Contains(P + "inlineMethod", await ListAsync("var x = Add(", 8));
        var after = await ComputeAsync("var x = Add(", 8, P + "inlineMethod");
        Assert.Contains("        var x = 1 + 2;\n", after);
        Assert.Contains("return x + Add(3, 4);", after);
        Assert.Contains("private int Add(int a, int b) => a + b;", after);
    }

    [Fact]
    public async Task InlineMethodEverywhereRemovesTheDeclaration()
    {
        Assert.Contains(P + "inlineMethodAll", await ListAsync("private int Add(", 12));
        var after = await ComputeAsync("private int Add(", 12, P + "inlineMethodAll");
        Assert.Contains("        var x = 1 + 2;\n", after);
        Assert.Contains("return x + 3 + 4;", after);
        Assert.DoesNotContain("int Add(", after);

        var once = await ComputeAsync("private int Once(", 12, P + "inlineMethodAll");
        Assert.Contains("var a = 2 * 4;", once);
        Assert.Contains("var b = 5 * 4;", once);
        Assert.DoesNotContain("int Once(", once);
    }

    [Fact]
    public async Task ArgumentsWithSideEffectsUsedTwiceGoIntoATemporary()
    {
        var after = await ComputeAsync("var r = Doubled(", 8, P + "inlineMethod");
        Assert.True(after.Contains("        int v = Next();\n        var r = v + v;\n"), after[after.IndexOf("public int UseDoubled")..][..200]);
        var report = await ComputeAsync("Report(\"n=\"", 0, P + "inlineMethod");
        Assert.Contains("public void UseReport(int n) => Console.WriteLine(\"n=\" + n);", report);
    }

    [Fact]
    public async Task InlineMethodRefusals()
    {
        await RefusedAsync("=> Fact(4)", 3, P + "inlineMethod", "Recursive");
        await RefusedAsync("=> Sign(-2)", 3, P + "inlineMethod", "MultipleReturns");
        await RefusedAsync("Bump(ref v);", 0, P + "inlineMethod", "RefParameter");
        await RefusedAsync("=> Hook(1)", 3, P + "inlineMethod", "Virtual");
        await RefusedAsync("private int Grouped(", 12, P + "inlineMethodAll", "MethodGroup");
        Assert.Contains("=> 2 * 3;", await ComputeAsync("=> Grouped(2)", 3, P + "inlineMethod"));
    }

    [Fact]
    public async Task ConstantsAndReadonlyFieldsInline()
    {
        Assert.Contains(P + "inlineField", await ListAsync("private const int Limit", 18));
        var limit = await ComputeAsync("private const int Limit", 18, P + "inlineField");
        Assert.Contains("=> v > 10 ? 10 : v;", limit);
        Assert.DoesNotContain("const int Limit", limit);
        Assert.Contains("=> (long)5 * 2;", await ComputeAsync("=> Wide * 2", 3, P + "inlineField"));
        var greeting = await ComputeAsync("=> Greeting +", 3, P + "inlineField");
        Assert.Contains("=> \"hi\" + \"!\";", greeting);
        Assert.DoesNotContain("readonly string Greeting", greeting);
        Assert.Contains("=> 7 + 1;", await ComputeAsync("private readonly int _seed", 21, P + "inlineField"));
    }

    [Fact]
    public async Task InlineFieldRefusals()
    {
        await RefusedAsync("private readonly List<int> _items", 27, P + "inlineField", "SideEffects");
        Assert.DoesNotContain(P + "inlineField", await ListAsync("=> _state;", 3));
        await RefusedAsync("private int _state", 12, P + "inlineField", "NotReadOnly");
    }

    [Fact]
    public async Task ParameterPassedTheSameEverywhereInlines()
    {
        Assert.Contains(P + "inlineParameter", await ListAsync("int v, int factor", 11));
        var after = await ComputeAsync("int v, int factor", 11, P + "inlineParameter");
        Assert.Contains("private int Scaled(int v) => v * 10;", after);
        Assert.Contains("=> Scaled(2) + Scaled(3);", after);
        Assert.Contains("=> Scaled(k);", after);
        await RefusedAsync("int v, int factor", 4, P + "inlineParameter", "DifferentArguments");
    }
}
