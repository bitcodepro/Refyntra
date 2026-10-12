using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>One opened copy of the Refactorings fixture for all edit-action tests (they never write files).</summary>
public sealed class EditActionsFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync() => (Client, Dir) = await RefactoringFixture.OpenAsync();

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>
/// code/editActions (protocol 1.9): Convert / Inline / Introduce actions computed by Roslyn, listed at a position and
/// computed with a compile check; positive results and honest refusals.
/// </summary>
public sealed class EditActionsTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public EditActionsTests(EditActionsFixture f) => _f = f;

    private string File => RefactoringFixture.Lib(_f.Dir, "EditActions/Samples.cs");

    private static (int line, int ch) Pos(string text, int offset)
    {
        var line = 0; var ls = 0;
        for (var i = 0; i < offset; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        return (line, offset - ls);
    }

    private async Task<JsonElement> RequestAsync(string needle, int offset, int length, string? actionId)
    {
        var text = await System.IO.File.ReadAllTextAsync(File);
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var (sl, sc) = Pos(text, at + offset);
        var (el, ec) = Pos(text, at + offset + length);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(File),
            range = new { start = new { line = sl, character = sc }, end = new { line = el, character = ec } }, actionId,
        });
    }

    private async Task<List<string>> ListAsync(string needle, int offset = 0, int length = 0)
    {
        var r = await RequestAsync(needle, offset, length, null);
        return r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("actionId").GetString()!).ToList();
    }

    private static string Apply(string text, JsonElement edits)
    {
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
        {
            var s = Off(e.GetProperty("range").GetProperty("start"));
            var en = Off(e.GetProperty("range").GetProperty("end"));
            text = text[..s] + e.GetProperty("newText").GetString() + text[en..];
        }
        return text;
    }

    private async Task<string> ComputeAsync(string needle, string actionId, int offset = 0, int length = 0)
    {
        var r = await RequestAsync(needle, offset, length, actionId);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.False(string.IsNullOrEmpty(r.GetProperty("documentHash").GetString()));
        return Apply(await System.IO.File.ReadAllTextAsync(File), r.GetProperty("edits")).Replace("\r\n", "\n");
    }

    private async Task RefusedAsync(string needle, string actionId, string reason, int offset = 0, int length = 0)
    {
        var r = await RequestAsync(needle, offset, length, actionId);
        Assert.False(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    private const string P = "csharp.edit.";

    [Fact]
    public async Task ExpressionBodyBecomesBlockBodyAndBack()
    {
        Assert.Contains(P + "toBlockBody", await ListAsync("public int Twice", 11));
        var after = await ComputeAsync("public int Twice", P + "toBlockBody", 11);
        Assert.Contains("    public int Twice(int x)\n    {\n        return x * 2;\n    }", after);
        var log = await ComputeAsync("public void Log", P + "toBlockBody", 12);
        Assert.Contains("    public void Log(string m)\n    {\n        Console.WriteLine(m);\n    }", log);
        var prop = await ComputeAsync("public string Name", P + "toBlockBody", 14);
        Assert.Contains("public string Name\n    {\n        get\n        {\n            return \"samples\";\n        }\n    }", prop);

        var square = await ComputeAsync("public int Square", P + "toExpressionBody", 11);
        Assert.Contains("    public int Square(int x) => x * x;\n", square);
        var count = await ComputeAsync("public int Count", P + "toExpressionBody", 11);
        Assert.Contains("    public int Count => _counter;\n", count);
        Assert.DoesNotContain(P + "toExpressionBody", await ListAsync("public int Twice", 11));
    }

    [Fact]
    public async Task VarAndExplicitTypesConvert()
    {
        Assert.Contains("        List<string> list = new List<string>();", await ComputeAsync("var list", P + "varToExplicit", 1));
        Assert.Contains("        var map = new Dictionary<string, int>();", await ComputeAsync("Dictionary<string, int> map", P + "explicitToVar", 2));
        Assert.Contains("foreach (int item in items)", await ComputeAsync("foreach (var item", P + "varToExplicit", 10));
        // long big = a; would change meaning with var (int): not offered.
        Assert.DoesNotContain(P + "explicitToVar", await ListAsync("long big = a", 1));
    }

    [Fact]
    public async Task IfStatementsInvertMergeSplitAndBecomeConditionals()
    {
        var inverted = await ComputeAsync("if (value > 0)", P + "invertIf", 1);
        Assert.Contains("if (value <= 0)\n        {\n            return -1;\n        }\n        else\n        {\n            return 1;\n        }", inverted);
        // double: NaN makes !(d < 0) differ from d >= 0, so the condition is negated with '!'.
        Assert.Contains("if (!(d < 0))", await ComputeAsync("if (d < 0)", P + "invertIf", 1));

        Assert.Contains("        return value > 0 ? 1 : -1;\n", await ComputeAsync("if (value > 0)", P + "ifToTernary", 1));
        // int and double branches would make the conditional double: not offered.
        Assert.DoesNotContain(P + "ifToTernary", await ListAsync("if (flag) return 1;", 1));

        var asIf = await ComputeAsync("flag ? \"yes\"", P + "ternaryToIf", 0);
        Assert.Contains("if (flag)\n        {\n            return \"yes\";\n        }\n        else\n        {\n            return \"no\";\n        }", asIf);

        var merged = await ComputeAsync("if (a)\n", P + "mergeNestedIf", 1);
        Assert.Contains("if (a && b)\n        {\n            Console.WriteLine(\"both\");\n        }", merged.Replace("\r\n", "\n"));
        var split = await ComputeAsync("if (a && b)", P + "splitIf", 1);
        var expected = "        if (a)\n        {\n            if (b)\n                Console.WriteLine(\"and\");\n        }\n    }";
        Assert.True(split.Contains(expected), split[split.IndexOf("public void Nested", StringComparison.Ordinal)..split.IndexOf("public string Greet", StringComparison.Ordinal)]);
    }

    [Fact]
    public async Task ConcatenationBecomesAnInterpolatedString()
    {
        var after = await ComputeAsync("\"Hello \"", P + "toInterpolatedString", 2);
        Assert.Contains("return $\"Hello {name}, age {age} {{ok}}\";", after);
    }

    [Fact]
    public async Task InlineVariableReplacesUsesAndRemovesTheDeclaration()
    {
        var after = await ComputeAsync("var sum", P + "inlineVariable", 4);
        Assert.Contains("    public int InlineMe(int a, int b)\n    {\n        return (a + b) * (a + b);\n    }", after);
        // Explicit wider type keeps its meaning with a cast.
        var widened = await ComputeAsync("long big", P + "inlineVariable", 5);
        Assert.Contains("return (long)a * 1000000;", widened);
    }

    [Fact]
    public async Task InlineVariableRefusesWritesAndMovedSideEffects()
    {
        await RefusedAsync("var w", P + "inlineVariable", "VariableWritten", 4);
        await RefusedAsync("var n = Next()", P + "inlineVariable", "SideEffects", 4);
    }

    [Fact]
    public async Task IntroduceVariableFromASelectedExpression()
    {
        Assert.Contains(P + "introduceVariable", await ListAsync("a * b + _factor", 0, 5));
        var one = await ComputeAsync("a * b + _factor", P + "introduceVariable", 0, 5);
        Assert.Contains("        var value = a * b;\n        Console.WriteLine(value + _factor);\n        return a * b - 1;", one);
        var all = await ComputeAsync("a * b + _factor", P + "introduceVariableAll", 0, 5);
        Assert.Contains("        var value = a * b;\n        Console.WriteLine(value + _factor);\n        return value - 1;", all);
        // The second Next() would run before the first one.
        await RefusedAsync("Next() + Next()", P + "introduceVariable", "EvaluationOrder", 9, 6);
    }

    [Fact]
    public async Task UnknownActionsAreRefused()
    {
        await RefusedAsync("public int Twice", P + "invertIf", "NotApplicable", 11);
    }
}
