using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>
/// Introduce Field / Constant (code/editActions) and Introduce Parameter (refactor/prepare csharp.introduceParameter):
/// positive results and refusals (EditActions/IntroduceSamples.cs and IntroduceCallers.cs of the Refactorings fixture).
/// </summary>
public sealed class IntroduceMembersTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public IntroduceMembersTests(EditActionsFixture f) => _f = f;

    private string File => Lib(_f.Dir, "EditActions/IntroduceSamples.cs");
    private string Callers => Lib(_f.Dir, "EditActions/IntroduceCallers.cs");
    private const string P = "csharp.edit.";

    private async Task<object> RangeAsync(string within, string selected)
    {
        var text = await System.IO.File.ReadAllTextAsync(File);
        var at = text.IndexOf(within, StringComparison.Ordinal);
        Assert.True(at >= 0, within);
        var start = text.IndexOf(selected, at, StringComparison.Ordinal);
        Assert.True(start >= 0, selected);
        object Pos(int o)
        {
            int line = 0, ls = 0;
            for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
            return new { line, character = o - ls };
        }
        return new { start = Pos(start), end = Pos(start + selected.Length) };
    }

    private async Task<JsonElement> EditAsync(string within, string selected, string? actionId)
    {
        var range = await RangeAsync(within, selected);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/editActions", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(File), range, actionId });
    }

    private async Task<List<string>> ListAsync(string within, string selected) =>
        (await EditAsync(within, selected, null)).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("actionId").GetString()!).ToList();

    private async Task<string> ComputeAsync(string within, string selected, string actionId)
    {
        var r = await EditAsync(within, selected, actionId);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        var text = await System.IO.File.ReadAllTextAsync(File);
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    private async Task<JsonElement> ParameterAsync(string within, string selected)
    {
        var range = await RangeAsync(within, selected);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.introduceParameter", symbolId = "",
            documentUri = UriPaths.ToUri(File), range,
        });
    }

    // ------------------------------------------------------------------ Introduce Field

    [Fact]
    public async Task AConstantFreeExpressionOffersEveryFieldChoiceAndTheConstantAndParameter()
    {
        var ids = await ListAsync("return width * (60 * 60);", "60 * 60");
        foreach (var id in new[] { "introduceField.initializer", "introduceField.initializerAll", "introduceField.constructor", "introduceField.constructorAll", "introduceField.member",
                     "introduceConstant.local", "introduceConstant.class", "introduceParameter" })
            Assert.Contains(P + id, ids);
    }

    [Fact]
    public async Task FieldInitializedInTheConstructorsSkipsChainedConstructors()
    {
        var after = await ComputeAsync("return width * (60 * 60);", "60 * 60", P + "introduceField.constructor");
        Assert.Contains("    private readonly int _value;\n", after);
        Assert.Contains("    public IntroduceSamples()\n    {\n        _value = 60 * 60;\n        _counter = 1;\n    }", after);
        Assert.Contains("    public IntroduceSamples(int start) : this()\n    {\n        _counter = start;\n    }", after);
        Assert.Contains("return width * (_value);", after);
        Assert.Contains("public int Seconds() => 60 * 60 + Math.Max(1, 2);", after);
    }

    [Fact]
    public async Task FieldInitializerReplacingAllOccurrencesInTheType()
    {
        var after = await ComputeAsync("return width * (60 * 60);", "60 * 60", P + "introduceField.initializerAll");
        Assert.Contains("    private readonly int _value = 60 * 60;\n", after);
        Assert.Contains("return width * (_value);", after);
        Assert.Contains("public int Seconds() => _value + Math.Max(1, 2);", after);
    }

    [Fact]
    public async Task ExpressionWithLocalsCanOnlyBeInitializedInTheCurrentMember()
    {
        var ids = await ListAsync("return v * _scale + _counter;", "v * _scale");
        Assert.Contains(P + "introduceField.member", ids);
        Assert.DoesNotContain(P + "introduceField.initializer", ids);
        Assert.DoesNotContain(P + "introduceField.constructor", ids);
        var after = await ComputeAsync("return v * _scale + _counter;", "v * _scale", P + "introduceField.member");
        Assert.Contains("    private int _value;\n", after);
        Assert.Contains("        _value = v * _scale;\n        return _value + _counter;", after);
    }

    [Fact]
    public async Task InstanceDependencyOffersNoFieldInitializerAndChangingValuesNoReplaceAll()
    {
        var ids = await ListAsync("return _counter + DateTime.Now.Second;", "_counter + DateTime.Now.Second");
        Assert.DoesNotContain(P + "introduceField.initializer", ids);
        Assert.DoesNotContain(P + "introduceField.constructorAll", ids);
        Assert.Contains(P + "introduceField.constructor", ids);
        Assert.DoesNotContain(P + "introduceConstant.class", ids);
    }

    [Fact]
    public async Task StaticContextGivesAStaticReadonlyField()
    {
        var after = await ComputeAsync("public static string Banner()", "string.Join(\", \", new List<string> { \"a\", \"b\" })", P + "introduceField.initializer");
        Assert.Contains("    private static readonly string _join = string.Join(\", \", new List<string> { \"a\", \"b\" });\n", after);
        Assert.Contains("return _join;", after);
    }

    // ------------------------------------------------------------------ Introduce Constant

    [Fact]
    public async Task LocalConstantInTheMember()
    {
        var after = await ComputeAsync("return width * (60 * 60);", "60 * 60", P + "introduceConstant.local");
        Assert.Contains("        const int value = 60 * 60;\n        return width * (value);", after);
    }

    [Fact]
    public async Task ClassConstantReplacesEveryOccurrenceInTheType()
    {
        var after = await ComputeAsync("return width * (60 * 60);", "60 * 60", P + "introduceConstant.class");
        Assert.Contains("    private const int Value = 60 * 60;\n", after);
        Assert.Contains("return width * (Value);", after);
        Assert.Contains("public int Seconds() => Value + Math.Max(1, 2);", after);
    }

    [Fact]
    public async Task NonConstantExpressionOffersNoConstant()
    {
        var ids = await ListAsync("var prefix = ", "\"Hello, \" + Environment.NewLine");
        Assert.DoesNotContain(P + "introduceConstant.local", ids);
        Assert.DoesNotContain(P + "introduceConstant.class", ids);
        Assert.Contains(P + "introduceField.initializer", ids);
        Assert.DoesNotContain(P + "introduceField.initializerAll", ids);
    }

    // ------------------------------------------------------------------ Introduce Parameter

    [Fact]
    public async Task ParameterIsPassedAtCallSitesInOtherFiles()
    {
        var plan = Prepared(await ParameterAsync("return net * (1 + TaxRate) + Fee();", "1 + TaxRate"));
        Assert.Equal("csharp.introduceParameter", plan.GetProperty("actionId").GetString());
        var inFile = After(plan, File).Replace("\r\n", "\n");
        Assert.Contains("internal decimal Gross(decimal net, decimal value)", inFile);
        Assert.Contains("return net * (value) + Fee();", inFile);
        var callers = After(plan, Callers).Replace("\r\n", "\n");
        Assert.Contains("calc.Gross(10m, 1 + PriceCalculator.TaxRate) + calc.Gross(20m, 1 + PriceCalculator.TaxRate)", callers);
    }

    [Fact]
    public async Task ParameterUpdatesTheInterfaceHierarchy()
    {
        var plan = Prepared(await ParameterAsync("public double Size(double unit) => unit * Math.Sqrt(16);", "Math.Sqrt(16)"));
        var inFile = After(plan, File).Replace("\r\n", "\n");
        Assert.Contains("double Size(double unit, double sqrt);", inFile);
        Assert.Contains("public double Size(double unit, double sqrt) => unit * sqrt;", inFile);
        Assert.Contains("shape.Size(2.0, Math.Sqrt(16))", After(plan, Callers));
    }

    [Theory]
    [InlineData("return net * (1 + TaxRate) + Fee();", "Fee()", "NotAccessible")]
    [InlineData("var doubled = v * 2;", "v * 2", "UsesLocals")]
    [InlineData("internal int Count(int x) => x + Seed * 2;", "Seed * 2", "InstanceDependency")]
    [InlineData("internal decimal Net(decimal net)", "Math.Round(10m / 3, 2)", "MethodGroupUse")]
    [InlineData("return width * (60 * 60);", "60 * 60", "ExternalCallers")]
    public async Task ParameterRefusals(string within, string selected, string reason) =>
        Unavailable(await ParameterAsync(within, selected), reason);
}
