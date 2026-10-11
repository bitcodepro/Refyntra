using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>
/// Extract Method: parameters, return value, out/ref parameters, returns, async/await, static, generics and expressions
/// from Roslyn's data/control-flow analysis; honest refusals for jumps, mixed exits, yield, partial selections,
/// assignment targets and name collisions. Results are applied to the copied fixture and built.
/// </summary>
public sealed class ExtractMethodTests
{
    private const string Action = "csharp.extractMethod";

    private static async Task<JsonElement> ExtractAsync(TestClient c, string file, string from, string to, string name, int occurrence = 0)
    {
        var text = await File.ReadAllTextAsync(file);
        var start = text.IndexOf(from, StringComparison.Ordinal);
        for (var i = 0; i < occurrence; i++) start = text.IndexOf(from, start + 1, StringComparison.Ordinal);
        Assert.True(start >= 0, from);
        var endAt = text.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(endAt >= 0, to);
        var end = endAt + to.Length;
        (int line, int ch) Pos(int offset)
        {
            var line = 0; var ls = 0;
            for (var i = 0; i < offset; i++) if (text[i] == '\n') { line++; ls = i + 1; }
            return (line, offset - ls);
        }
        var (sl, sc) = Pos(start);
        var (el, ec) = Pos(end);
        var snap = await c.BarrierAsync();
        return await c.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = Action, symbolId = "", newName = name,
            documentUri = UriPaths.ToUri(file), range = new { start = new { line = sl, character = sc }, end = new { line = el, character = ec } },
        });
    }

    private static string Norm(string s) => s.Replace("\r\n", "\n");

    [Fact]
    public async Task StatementsWithParametersAndAReturnedVariableBecomeAStaticMethod()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "var total = a + b;", "total *= 2;", "Double"));
        Assert.Equal(Action, plan.GetProperty("actionId").GetString());
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        var after = Norm(After(plan, file));
        Assert.Contains("        var total = Double(a, b);\n        Console.WriteLine(total);", after);
        Assert.Contains("    private static int Double(int a, int b)\n    {\n        var total = a + b;\n        total *= 2;\n        return total;\n    }", after);
        Assert.Contains("returns total", plan.GetProperty("evidence")[0].GetProperty("description").GetString());
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task InstanceUseKeepsTheMethodAnInstanceMethod()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var after = Norm(After(Prepared(await ExtractAsync(c, file, "var shifted = a + _offset;", "var shifted = a + _offset;", "ShiftBy")), file));
        Assert.Contains("    private int ShiftBy(int a)\n", after);
        Assert.Contains("var shifted = ShiftBy(a);", after);
    }

    [Fact]
    public async Task ExpressionBecomesAMethodReturningItsValue()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "a * b + 1", "a * b + 1", "Combine"));
        var after = Norm(After(plan, file));
        Assert.Contains("return Combine(a, b);", after);
        Assert.Contains("    private static int Combine(int a, int b)\n    {\n        return a * b + 1;\n    }", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task SeveralVariablesFlowingOutBecomeOutParameters()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "int lo = x - 1;", "int hi = x + 1;", "Bounds"));
        var after = Norm(After(plan, file));
        Assert.Contains("Bounds(x, out var lo, out var hi);", after);
        Assert.Contains("private static void Bounds(int x, out int lo, out int hi)\n    {\n        lo = x - 1;\n        hi = x + 1;\n    }", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task VariableReadAndWrittenIsPassedAndReturned()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "acc += 5;", "acc *= 3;", "Step"));
        var after = Norm(After(plan, file));
        Assert.Contains("acc = Step(acc);", after);
        Assert.Contains("private static int Step(int acc)", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task SelectionThatAlwaysReturnsIsReturned()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "if (n == 0) return \"zero\";", "\"big\" : \"small\";", "ClassifyCore"));
        var after = Norm(After(plan, file));
        Assert.Contains("return ClassifyCore(n);", after);
        Assert.Contains("private static string ClassifyCore(int n)", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task AwaitMakesTheMethodAsync()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "await Task.Delay(1);", "var value = id * 2;", "Prepare"));
        var after = Norm(After(plan, file));
        Assert.Contains("var value = await Prepare(id);", after);
        Assert.Contains("private static async Task<int> Prepare(int id)", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task MethodTypeParametersAndConstraintsAreCarried()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        var plan = Prepared(await ExtractAsync(c, file, "var head = items[0];", "var head = items[0];", "Head"));
        var after = Norm(After(plan, file));
        Assert.Contains("var head = Head<T>(items);", after);
        Assert.True(after.Contains("private static T Head<T>(List<T> items)\n        where T : class\n"), after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task UnsupportedSelectionsAreRefused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ExtractMethod/Calculator.cs");
        Unavailable(await ExtractAsync(c, file, "if (n == 0) return \"zero\";", "if (n == 0) return \"zero\";", "M"), "MultipleExits");
        Unavailable(await ExtractAsync(c, file, "index = i;", "break;", "M"), "JumpOutOfSelection");
        Unavailable(await ExtractAsync(c, file, "yield return 1;", "yield return 2;", "M"), "Yield");
        Unavailable(await ExtractAsync(c, file, "total = a + b;", "total *= 2", "M"), "InvalidSelection");
        Unavailable(await ExtractAsync(c, file, "total *= 2", "total", "M"), "AssignmentTarget");
        Unavailable(await ExtractAsync(c, file, "var total = a + b;", "total *= 2;", "Sum"), "NameInUse");
        Unavailable(await ExtractAsync(c, file, "var total = a + b;", "total *= 2;", "class"), "InvalidIdentifier");
        Unavailable(await ExtractAsync(c, file, "private int _offset = 10;", "private int _offset = 10;", "M"), "NotInMethodBody");
    }
}
