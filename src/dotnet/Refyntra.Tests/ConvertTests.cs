using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// code/editActions Convert actions: if ↔ switch, foreach ↔ LINQ, interpolated string ↔ string.Format, primary
/// constructors, class ↔ record, auto-property ↔ backing field, object initializer, using, async; positive results and
/// refusals (EditActions/ConvertSamples.cs and ConvertLinqSamples.cs of the Refactorings fixture).
/// </summary>
public sealed class ConvertTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public ConvertTests(EditActionsFixture f) => _f = f;

    private const string P = "csharp.edit.";
    private const string Samples = "EditActions/ConvertSamples.cs";
    private const string Linq = "EditActions/ConvertLinqSamples.cs";

    private string PathOf(string file) => RefactoringFixture.Lib(_f.Dir, file);

    private async Task<JsonElement> RequestAsync(string file, string needle, int offset, string? actionId)
    {
        var text = await File.ReadAllTextAsync(PathOf(file));
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var o = at + offset;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        var pos = new { line, character = o - ls };
        return await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(PathOf(file)),
            range = new { start = pos, end = pos }, actionId,
        });
    }

    private async Task<List<string>> ListAsync(string file, string needle, int offset) =>
        (await RequestAsync(file, needle, offset, null)).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("actionId").GetString()!).ToList();

    private async Task<string> ComputeAsync(string file, string needle, int offset, string actionId)
    {
        var r = await RequestAsync(file, needle, offset, actionId);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        var text = await File.ReadAllTextAsync(PathOf(file));
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    private async Task RefusedAsync(string file, string needle, int offset, string actionId, string reason)
    {
        var r = await RequestAsync(file, needle, offset, actionId);
        Assert.False(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    /// <summary>The text of the member starting at <paramref name="header"/> up to the next blank line (for messages and checks).</summary>
    private static string Member(string text, string header)
    {
        var at = text.IndexOf(header, StringComparison.Ordinal);
        Assert.True(at >= 0, header + "\n" + text);
        var end = text.IndexOf("\n\n", at, StringComparison.Ordinal);
        return text[at..(end < 0 ? text.Length : end)];
    }

    private static void Has(string member, params string[] parts)
    {
        foreach (var p in parts) Assert.True(member.Contains(p, StringComparison.Ordinal), $"missing «{p}» in:\n{member}");
    }

    // ---------------------------------------------------------------- 1. if ↔ switch

    [Fact]
    public async Task IfChainBecomesSwitchStatementAndExpression()
    {
        var offered = await ListAsync(Samples, "if (code == 1) return", 1);
        Assert.Contains(P + "ifToSwitch", offered);
        Assert.Contains(P + "ifToSwitchExpression", offered);

        var stmt = Member(await ComputeAsync(Samples, "if (code == 1) return", 1, P + "ifToSwitch"), "public string Describe");
        Has(stmt, "switch (code)", "case 1:\n                return \"one\";", "case 2:\n            case 3:", "case > 10:", "default:\n                return \"other\";");
        Assert.DoesNotContain("break;", stmt);

        var expr = Member(await ComputeAsync(Samples, "if (code == 1) return", 1, P + "ifToSwitchExpression"), "public string Describe");
        Has(expr, "return code switch", "1 => \"one\",", "2 or 3 => \"few\",", "> 10 => \"many\",", "_ => \"other\",");

        var assign = Member(await ComputeAsync(Samples, "if (s == ConvShade.Red)", 1, P + "ifToSwitchExpression"), "public int Weight");
        Has(assign, "w = s switch", "ConvShade.Red => 1,", "_ => 3,", "return w;");

        var blocks = Member(await ComputeAsync(Samples, "if (code == 1)\n", 1, P + "ifToSwitch"), "public void Log");
        Has(blocks, "case 2:\n                log.Add(\"two\");\n                log.Add(\"again\");\n                break;", "default:\n                log.Add(\"other\");\n                break;");
        Assert.DoesNotContain(P + "ifToSwitchExpression", await ListAsync(Samples, "if (code == 1)\n", 1));
    }

    [Fact]
    public async Task IfChainOverDifferentValuesIsNotOffered()
    {
        var offered = await ListAsync(Samples, "if (a == 1)", 1);
        Assert.DoesNotContain(P + "ifToSwitch", offered);
        Assert.DoesNotContain(P + "ifToSwitchExpression", offered);
    }

    [Fact]
    public async Task SwitchStatementAndExpressionConvertBothWays()
    {
        var expr = Member(await ComputeAsync(Samples, "switch (code)\n        {\n            case 1:\n                return \"one\";", 1, P + "switchToExpression"), "public string Named");
        Has(expr, "return code switch", "1 => \"one\",", "2 or 3 => \"few\",", "_ => \"other\",");
        Assert.DoesNotContain(P + "switchToExpression", await ListAsync(Samples, "switch (code)\n        {\n            case 1:\n                log", 1));

        var back = Member(await ComputeAsync(Samples, "=> s switch", 6, P + "switchToStatement"), "public string Arms");
        Has(back, "switch (s)", "case ConvShade.Red:\n                return \"red\";", "case ConvShade.Green or ConvShade.Blue:", "default:\n                return \"?\";");
        await RefusedAsync(Samples, "return s switch {", 10, P + "switchToStatement", "NoDefaultArm");
    }

    // ---------------------------------------------------------------- 2. foreach ↔ LINQ

    [Fact]
    public async Task ForEachBecomesLinqAndAddsTheUsing()
    {
        var names = await ComputeAsync(Samples, "foreach (var item in items)\n        {\n            if (item.Length > 2)", 1, P + "foreachToLinq");
        Has(Member(names, "public List<string> Names"), "var result = items.Where(item => item.Length > 2).Select(item => item.ToUpperInvariant()).ToList();\n        return result;");
        Assert.Contains("using System.IO;\nusing System.Linq;\nusing System.Threading.Tasks;", names);

        Has(Member(await ComputeAsync(Samples, "foreach (var v in values)\n        {\n            if (v < 0)", 1, P + "foreachToLinq"), "public bool HasNegative"), "return values.Any(v => v < 0);\n    }");
        Has(Member(await ComputeAsync(Samples, "foreach (var v in values)\n            if (v <= 0)", 1, P + "foreachToLinq"), "public bool AllPositive"), "return values.All(v => v > 0);\n    }");
        Has(Member(await ComputeAsync(Samples, "foreach (var item in items)\n        {\n            if (item.Length > 5)", 1, P + "foreachToLinq"), "public string? FirstLong"), "return items.FirstOrDefault(item => item.Length > 5);\n    }");
        Has(Member(await ComputeAsync(Samples, "foreach (var v in values)\n        {\n            if (v % 2", 1, P + "foreachToLinq"), "public int CountEven"), "var count = values.Count(v => v % 2 == 0);\n        return count;");
        Has(Member(await ComputeAsync(Samples, "foreach (var v in values) total", 1, P + "foreachToLinq"), "public int Total"), "var total = values.Sum(v => v * 2);\n        return total;");
    }

    [Fact]
    public async Task ForEachWithSeveralStatementsIsNotOffered()
    {
        Assert.DoesNotContain(P + "foreachToLinq", await ListAsync(Samples, "foreach (var v in values)\n        {\n            log.Add(v);", 1));
    }

    [Fact]
    public async Task LinqBecomesForEach()
    {
        Has(Member(await ComputeAsync(Linq, "values.Any(", 8, P + "linqToForeach"), "public bool AnyBig"),
            "foreach (var v in values)\n        {\n            if (v > 100)\n            {\n                return true;\n            }\n        }\n        return false;");
        Has(Member(await ComputeAsync(Linq, "values.All(", 8, P + "linqToForeach"), "public bool AllSmall"), "if (v >= 100)", "return false;", "return true;");
        Has(Member(await ComputeAsync(Linq, "items.FirstOrDefault(", 8, P + "linqToForeach"), "public string? FirstShort"), "if (s.Length < 3)", "return s;", "return default;");
        Has(Member(await ComputeAsync(Linq, "values.Count(", 8, P + "linqToForeach"), "public int CountOdd"), "var odd = 0;", "odd++;");
        Has(Member(await ComputeAsync(Linq, "values.Sum(", 8, P + "linqToForeach"), "public double Doubled"), "double sum = 0;", "sum += v * 2;");
        Has(Member(await ComputeAsync(Linq, "items.Where(", 8, P + "linqToForeach"), "public List<string> Upper"),
            "var upper = new List<string>();", "foreach (var s in items)", "if (s.Length > 1)", "upper.Add(s.ToUpperInvariant());");
        Assert.DoesNotContain(P + "linqToForeach", await ListAsync(Linq, "items.OrderBy(", 8));
    }

    // ---------------------------------------------------------------- 3. interpolated string ↔ string.Format

    [Fact]
    public async Task InterpolatedStringAndStringFormatConvertBothWays()
    {
        Has(Member(await ComputeAsync(Samples, "$\"{name,-10}", 4, P + "toStringFormat"), "public string Price"),
            "=> string.Format(\"{0,-10}: {1:C2} x{2}\", name, price, qty);");
        Has(Member(await ComputeAsync(Samples, "string.Format(\"{0} has", 8, P + "stringFormatToInterpolated"), "public string Formatted"),
            "=> $\"{name} has {qty,5:D3} items ({name})\";");
        await RefusedAsync(Samples, "string.Format(\"{1} {0}\"", 8, P + "stringFormatToInterpolated", "EvaluationOrder");
    }

    // ---------------------------------------------------------------- 4. primary constructors

    [Fact]
    public async Task ConstructorBecomesPrimaryConstructorAndBack()
    {
        var primary = Member(await ComputeAsync(Samples, "public ConvAccount(string", 8, P + "toPrimaryConstructor"), "public class ConvAccount");
        Has(primary, "public class ConvAccount(string owner, int limit)\n{", "private readonly string _owner = owner;", "public int Limit { get; } = limit;");
        Assert.DoesNotContain("public ConvAccount(", primary);

        var after = await ComputeAsync(Samples, "public class ConvLedger(", 13, P + "fromPrimaryConstructor");
        var ledger = after[after.IndexOf("public class ConvLedger", StringComparison.Ordinal)..after.IndexOf("public class ConvTwoCtors", StringComparison.Ordinal)];
        Has(ledger, "public class ConvLedger\n{", "private readonly string _title;", "private readonly int _size;",
            "public ConvLedger(string title, int size)\n    {\n        _title = title;\n        _size = size;\n    }", "public string Title => _title.ToUpperInvariant();");

        await RefusedAsync(Samples, "public ConvTwoCtors(int", 8, P + "toPrimaryConstructor", "OtherConstructors");
    }

    // ---------------------------------------------------------------- 5. class ↔ record

    [Fact]
    public async Task ClassAndRecordConvertWhenSafe()
    {
        Has(await ComputeAsync(Samples, "public class ConvPoint", 13, P + "classToRecord"), "public record ConvPoint\n{");
        await RefusedAsync(Samples, "public class ConvCounter", 13, P + "classToRecord", "MutableState");
        await RefusedAsync(Samples, "public class ConvCustom", 13, P + "classToRecord", "CustomEquality");
        Has(await ComputeAsync(Samples, "public record ConvTag", 14, P + "recordToClass"), "public class ConvTag\n{");
        await RefusedAsync(Samples, "public record ConvLabel", 14, P + "recordToClass", "RecordFeatures");
    }

    // ---------------------------------------------------------------- 6. auto-property ↔ backing field

    [Fact]
    public async Task AutoPropertyAndBackingFieldConvertBothWays()
    {
        var full = Member(await ComputeAsync(Samples, "public string Name { get; set; } = \"n\"", 14, P + "toFullProperty"), "public class ConvProps");
        Has(full, "private string _name = \"n\";\n    public string Name { get => _name; set => _name = value; }");

        var id = await ComputeAsync(Samples, "public int Id { get; }", 11, P + "toFullProperty");
        Has(Member(id, "public class ConvProps"), "private readonly int _id;\n    public int Id { get => _id; }");
        Has(id, "        _id = id;\n");

        var auto = await ComputeAsync(Samples, "public int Age {", 11, P + "toAutoProperty");
        Has(auto, "public int Age { get; set; }");
        Assert.DoesNotContain("_age", auto);
        await RefusedAsync(Samples, "public int Level {", 11, P + "toAutoProperty", "FieldWritten");
    }

    // ---------------------------------------------------------------- 7. object initializer

    [Fact]
    public async Task ObjectInitializerFromAssignmentsAndBack()
    {
        Has(Member(await ComputeAsync(Samples, "var o = new ConvOptions();", 4, P + "toObjectInitializer"), "public ConvOptions MakeOptions"),
            "var o = new ConvOptions\n        {\n            Name = \"a\",\n            Size = 2,\n            On = true,\n        };\n        return o;");
        Has(Member(await ComputeAsync(Samples, "var p = new ConvOptions {", 4, P + "splitObjectInitializer"), "public ConvOptions SplitOptions"),
            "var p = new ConvOptions();\n        p.Name = \"b\";\n        p.Size = 3;\n        return p;");
        Assert.DoesNotContain(P + "toObjectInitializer", await ListAsync(Samples, "var q = new ConvOptions();", 4));
    }

    // ---------------------------------------------------------------- 8. using

    [Fact]
    public async Task UsingStatementAndDeclarationConvertBothWays()
    {
        Has(Member(await ComputeAsync(Samples, "using (var reader = new StringReader(path))\n        {\n            return", 1, P + "usingToDeclaration"), "public string ReadAll"),
            "using var reader = new StringReader(path);\n        return reader.ReadToEnd();\n    }");
        await RefusedAsync(Samples, "using (var reader = new StringReader(path))\n        {\n            reader.Read", 1, P + "usingToDeclaration", "DisposalOrder");
        Has(Member(await ComputeAsync(Samples, "using var r =", 1, P + "usingToStatement"), "public int Declared"),
            "using (var r = new StringReader(path))\n        {\n            var line = r.ReadLine();\n            return line?.Length ?? 0;\n        }");
    }

    // ---------------------------------------------------------------- 9. async

    [Fact]
    public async Task MakeAsyncAndRemoveAsync()
    {
        Has(Member(await ComputeAsync(Samples, "public int Compute(", 11, P + "makeAsync"), "public async Task<int> Compute"), "return v * 2;");
        Has(Member(await ComputeAsync(Samples, "public void Fire(", 12, P + "makeAsync"), "public async Task Fire()"), "Console.WriteLine(\"fire\");");
        Has(Member(await ComputeAsync(Samples, "public async Task<int> Forward(", 23, P + "removeAsync"), "public Task<int> Forward()"), "return Fetch();");
        Has(Member(await ComputeAsync(Samples, "public async Task Wait(", 18, P + "removeAsync"), "public Task Wait()"), "return Task.Delay(1);");
        await RefusedAsync(Samples, "public async Task<int> Guarded(", 23, P + "removeAsync", "AwaitNotLast");
    }
}
