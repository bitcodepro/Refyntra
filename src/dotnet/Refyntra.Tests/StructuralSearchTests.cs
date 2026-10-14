using System.Text.Json;
using System.Text.RegularExpressions;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

public sealed class StructuralSearchFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("StructuralSearch", "StructuralSearch.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Dir = Path.GetDirectoryName(sln)!;
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();

    public string File(string rel) => Path.GetFullPath(Path.Combine(Dir, "Ssr.App", rel.Replace('/', Path.DirectorySeparatorChar)));
}

/// <summary>
/// Structural search and replace (protocol 1.19, ADR-012) on tests/fixtures/StructuralSearch: every line marked
/// "// m: tag" is a match of the tag's pattern and nothing else is (the unmarked lines are the false-match guards).
/// </summary>
public sealed class StructuralSearchTests : IClassFixture<StructuralSearchFixture>
{
    private readonly StructuralSearchFixture _f;
    public StructuralSearchTests(StructuralSearchFixture f) => _f = f;

    private static object Ph(string name, string? kind = null, string? type = null, int? min = null, int? max = null, string? regex = null, bool exact = false) =>
        new { name, kind, type, minCount = min, maxCount = max, regex, exactType = exact };

    private static object Pattern(string text, string? replacement = null, params object[] placeholders) => new { text, replacement, placeholders };

    private async Task<JsonElement> SearchAsync(object pattern, string scope = "solution", string? file = null, int limit = 200)
    {
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/structuralSearch", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, pattern, scope, uri = file == null ? null : UriPaths.ToUri(_f.File(file)), limit,
        });
    }

    private async Task<JsonElement> ReplaceAsync(object pattern, string scope, string? file, object[]? matches = null)
    {
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/structuralReplace", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, pattern, scope, uri = file == null ? null : UriPaths.ToUri(_f.File(file)), matches,
        });
    }

    private string Rel(string uri) => Path.GetRelativePath(Path.Combine(_f.Dir, "Ssr.App"), UriPaths.ToPath(uri)).Replace('\\', '/');

    private SortedSet<string> Lines(JsonElement r) => new(r.GetProperty("matches").EnumerateArray()
        .Select(m => $"{Rel(m.GetProperty("uri").GetString()!)}:{m.GetProperty("range").GetProperty("start").GetProperty("line").GetInt32() + 1}"), StringComparer.Ordinal);

    private SortedSet<string> Expected(string tag)
    {
        var set = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var path in Directory.EnumerateFiles(Path.Combine(_f.Dir, "Ssr.App", "Cases"), "*.cs"))
        {
            var lines = System.IO.File.ReadAllText(path).Replace("\r\n", "\n").Split('\n');
            for (var i = 0; i < lines.Length; i++)
                if (Regex.Match(lines[i], @"// m: (.*)$") is { Success: true } m && m.Groups[1].Value.Split(' ').Contains(tag))
                    set.Add($"Cases/{Path.GetFileName(path)}:{i + 1}");
        }
        return set;
    }

    private void AssertTag(JsonElement r, string tag)
    {
        Assert.False(r.TryGetProperty("reasonCode", out var rc) && rc.ValueKind != JsonValueKind.Null, r.ToString());
        var expected = Expected(tag);
        var actual = Lines(r);
        Assert.True(expected.SetEquals(actual), $"missing:\n  {string.Join("\n  ", expected.Except(actual))}\nunexpected:\n  {string.Join("\n  ", actual.Except(expected))}");
    }

    private static JsonElement Plan(JsonElement r)
    {
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan");
    }

    private string After(JsonElement plan, string file)
    {
        var uri = UriPaths.ToUri(_f.File(file));
        var change = plan.GetProperty("writeSet").EnumerateArray().Single(w => w.GetProperty("uri").GetString() == uri);
        return MoveTypeTests.ApplyEdits(System.IO.File.ReadAllText(_f.File(file)), change).Replace("\r\n", "\n");
    }

    // ------------------------------------------------------------------ matching

    [Fact]
    public async Task TypeConstrainedPlaceholderMatchesTasksOnly()
    {
        var r = await SearchAsync(Pattern("$x$.Result", null, Ph("x", "expression", "System.Threading.Tasks.Task")));
        AssertTag(r, "result");
        Assert.Equal("expression", r.GetProperty("patternKind").GetString());
        Assert.Equal("t", r.GetProperty("matches")[0].GetProperty("values").GetProperty("x").GetString());
        // Without the constraint the field Box.Result matches too.
        var any = await SearchAsync(Pattern("$x$.Result"));
        Assert.Contains("Cases/Tasks.cs:15", Lines(any));
        // Exact type: Task<int> is not exactly Task.
        var exact = await SearchAsync(Pattern("$x$.Result", null, Ph("x", "expression", "System.Threading.Tasks.Task", exact: true)));
        Assert.Empty(exact.GetProperty("matches").EnumerateArray());
        var generic = await SearchAsync(Pattern("$x$.Result", null, Ph("x", type: "System.Threading.Tasks.Task<int>", exact: true)));
        Assert.Equal(new[] { "Cases/Tasks.cs:12", "Cases/Tasks.cs:14", "Cases/Tasks.cs:20" }, Lines(generic));
    }

    [Fact]
    public async Task RepeatedPlaceholderNeedsEquivalentCode()
    {
        AssertTag(await SearchAsync(Pattern("$s$ == null || $s$ == \"\"")), "empty");
        AssertTag(await SearchAsync(Pattern("$a$ + $a$")), "twice");
    }

    [Fact]
    public async Task StatementPatternIgnoresBracesAndTrivia()
    {
        var r = await SearchAsync(Pattern("if ($c$) return true; else return false;"));
        AssertTag(r, "bool");
        Assert.Equal("statements", r.GetProperty("patternKind").GetString());
    }

    [Fact]
    public async Task NamesMatchTheirSymbolInAnySpelling()
    {
        // Qualified, global::, using static and an alias; not Debug.WriteLine, Fake.Console.WriteLine or Console.Write.
        AssertTag(await SearchAsync(Pattern("Console.WriteLine($a$)")), "console");
        AssertTag(await SearchAsync(Pattern("System.Console.WriteLine($a$)")), "console");
    }

    [Fact]
    public async Task NoFalseMatchesAcrossDifferentSymbols()
    {
        // Enumerable.Count(), not Bag.Count(); ICollection<T>.Count (implemented by List and Dictionary), not a field.
        AssertTag(await SearchAsync(Pattern("$list$.Count() > 0", null, Ph("list", type: "System.Collections.Generic.IEnumerable<T>"))), "any");
        AssertTag(await SearchAsync(Pattern("$c$.Count == 0", null, Ph("c", type: "System.Collections.Generic.ICollection<T>"))), "countzero");
    }

    [Fact]
    public async Task ArgumentAndStatementCounts()
    {
        AssertTag(await SearchAsync(Pattern("string.Format($f$, $args$)", null, Ph("args", "argument", min: 1, max: 3))), "format");
        AssertTag(await SearchAsync(Pattern("var $v$ = $init$; $body$; return $v$;", null, Ph("v", "identifier"), Ph("body", "statement", min: 0, max: 5))), "accumulate");
    }

    [Fact]
    public async Task IdentifierRegexAndMemberPatterns()
    {
        var r = await SearchAsync(Pattern("$r$.$name$()", null, Ph("name", "identifier", regex: @"Get[A-Z]\w*")));
        AssertTag(r, "getter");
        Assert.Single(r.GetProperty("matches").EnumerateArray());
        var members = await SearchAsync(Pattern("public int $m$() => 0;", null, Ph("m", "identifier", regex: "Get.*")));
        Assert.Equal("members", members.GetProperty("patternKind").GetString());
        AssertTag(members, "member");
    }

    [Fact]
    public async Task ScopeLimitAndErrors()
    {
        var doc = await SearchAsync(Pattern("Console.WriteLine($a$)"), "document", "Cases/ConsoleStatic.cs");
        Assert.Equal(new[] { "Cases/ConsoleStatic.cs:10", "Cases/ConsoleStatic.cs:11" }, Lines(doc));
        Assert.Equal(1, doc.GetProperty("filesSearched").GetInt32());
        var capped = await SearchAsync(Pattern("$x$"), limit: 3);
        Assert.Equal(3, capped.GetProperty("matches").GetArrayLength());
        Assert.True(capped.GetProperty("truncated").GetBoolean());
        var invalid = await SearchAsync(Pattern("if ($c$"));
        Assert.Equal("InvalidPattern", invalid.GetProperty("reasonCode").GetString());
        var badKind = await SearchAsync(Pattern("$x$", null, Ph("x", "banana")));
        Assert.Equal("InvalidPlaceholder", badKind.GetProperty("reasonCode").GetString());
        var unknownType = await SearchAsync(Pattern("$x$.Result", null, Ph("x", type: "No.Such.Type")));
        Assert.Empty(unknownType.GetProperty("matches").EnumerateArray());
        Assert.Contains(unknownType.GetProperty("notes").EnumerateArray(), n => n.GetString()!.Contains("No.Such.Type"));
    }

    // ------------------------------------------------------------------ replace

    [Fact]
    public async Task ReplacesWithPlaceholderCode()
    {
        var plan = Plan(await ReplaceAsync(Pattern("$s$ == null || $s$ == \"\"", "string.IsNullOrEmpty($s$)"), "document", "Cases/Strings.cs"));
        Assert.Equal("csharp.structuralReplace", plan.GetProperty("actionId").GetString());
        var text = After(plan, "Cases/Strings.cs");
        Assert.Contains("public bool A(string? s) => string.IsNullOrEmpty(s); // m: empty", text);
        Assert.Contains("public bool B(string? s) => string.IsNullOrEmpty(s); // m: empty", text);
        Assert.Contains("public bool D() => string.IsNullOrEmpty(_name); // m: empty", text);
        Assert.Contains("s == null || t == \"\"", text);
    }

    [Fact]
    public async Task ReplacementIsParenthesisedAndCompileChecked()
    {
        var r = await ReplaceAsync(Pattern("$x$.Result", "await $x$", Ph("x", type: "System.Threading.Tasks.Task")), "document", "Cases/Tasks.cs");
        var plan = Plan(r);
        var text = After(plan, "Cases/Tasks.cs");
        Assert.Contains("var n = (await t).ToString().Length; // m: result accumulate", text);
        Assert.Contains("public int Sync(Task<int> t) => t.Result;", text);
        var limitation = plan.GetProperty("limitations").EnumerateArray().Select(l => l.GetString()!).Single(l => l.Contains("not replaced"));
        Assert.Contains("3 match(es)", limitation);
        Assert.Contains("Tasks.cs:12", limitation);
        Assert.Contains("Tasks.cs:14", limitation);
        Assert.Contains("CS4032", limitation);
        // Only refusals: no plan, the list instead.
        var none = await ReplaceAsync(Pattern("$x$.Result", "$x$.NoSuchMember", Ph("x", type: "System.Threading.Tasks.Task")), "document", "Cases/Tasks.cs");
        Assert.Equal("unavailable", none.GetProperty("kind").GetString());
        Assert.Equal("CompilationErrors", none.GetProperty("reasonCode").GetString());
        Assert.Contains("Tasks.cs:20", none.GetProperty("message").GetString());
    }

    [Fact]
    public async Task ReplacedStatementsAreFormatted()
    {
        var text = After(Plan(await ReplaceAsync(Pattern("if ($c$) return true; else return false;", "return $c$;"), "document", "Cases/Bools.cs")), "Cases/Bools.cs");
        Assert.Contains("    public bool Plain(int x)\n    {\n        return x > 0; // m: bool\n    }", text);
        Assert.Contains("    public bool Braced(int x)\n    {\n        return x > 0;\n    }", text);
        Assert.Contains("if (x > 0) return false; else return true;", text);
    }

    [Fact]
    public async Task UsingsAreAddedOnlyWhenNeeded()
    {
        var text = After(Plan(await ReplaceAsync(Pattern("$c$.Count == 0", "!$c$.Any()", Ph("c", type: "System.Collections.Generic.ICollection<T>")), "document", "Cases/Collections.cs")), "Cases/Collections.cs");
        Assert.StartsWith("using System.Collections.Generic;\nusing System.Linq;\n\nnamespace", text);
        Assert.Contains("=> !list.Any(); // m: countzero", text);
        Assert.Contains("=> !map.Any(); // m: countzero", text);
        Assert.Contains("c.Count == 0;", text);
        var linq = After(Plan(await ReplaceAsync(Pattern("$list$.Count() > 0", "$list$.Any()", Ph("list", type: "System.Collections.Generic.IEnumerable<T>")), "document", "Cases/Linq.cs")), "Cases/Linq.cs");
        Assert.Single(Regex.Matches(linq, "using System.Linq;"));
        Assert.Contains("=> list.Any(); // m: any", linq);
        // A replacement that needs no import adds none.
        var strings = After(Plan(await ReplaceAsync(Pattern("$s$ == null || $s$ == \"\"", "string.IsNullOrEmpty($s$)"), "document", "Cases/Strings.cs")), "Cases/Strings.cs");
        Assert.DoesNotContain("using", strings);
    }

    [Fact]
    public async Task ListPlaceholdersAreExpandedInTheReplacement()
    {
        var formats = After(Plan(await ReplaceAsync(Pattern("string.Format($f$, $args$)", "string.Format(System.Globalization.CultureInfo.InvariantCulture, $f$, $args$)",
            Ph("args", "argument", min: 1, max: 3)), "document", "Cases/Formats.cs")), "Cases/Formats.cs");
        Assert.Contains("string.Format(System.Globalization.CultureInfo.InvariantCulture, \"{0}{1}{2}\", a, b, c) // m: format", formats);
        Assert.Contains("string.Format(\"{0}{1}{2}{3}\", a, b, c, d)", formats);
        var blocks = After(Plan(await ReplaceAsync(Pattern("var $v$ = $init$; $body$; return $v$;", "var $v$ = $init$; $body$; return checked($v$);",
            Ph("v", "identifier"), Ph("body", "statement", min: 0, max: 5)), "document", "Cases/Blocks.cs")), "Cases/Blocks.cs");
        Assert.Contains("        var total = 0;\n        total += 1;\n        total += 2;\n        return checked(total);\n", blocks);
        Assert.Contains("        var other = 1;\n        return checked(other);\n", blocks);
    }

    [Fact]
    public async Task OneMatchCanBeReplacedAlone()
    {
        var file = _f.File("Cases/Strings.cs");
        var plan = Plan(await ReplaceAsync(Pattern("$s$ == null || $s$ == \"\"", "string.IsNullOrEmpty($s$)"), "solution", null,
            new object[] { new { uri = UriPaths.ToUri(file), start = new { line = 9, character = 23 } } }));
        var text = After(plan, "Cases/Strings.cs");
        Assert.Contains("public bool D() => string.IsNullOrEmpty(_name);", text);
        Assert.Contains("public bool A(string? s) => s == null || s == \"\";", text);
        Assert.Single(plan.GetProperty("writeSet").EnumerateArray());
    }

    [Fact]
    public async Task InvalidReplacementIsRefused()
    {
        var r = await ReplaceAsync(Pattern("$s$ == null", "$t$ == null"), "solution", null);
        Assert.Equal("InvalidReplacement", r.GetProperty("reasonCode").GetString());
        var r2 = await ReplaceAsync(Pattern("$s$ == null", "return $s$;"), "solution", null);
        Assert.Equal("InvalidReplacement", r2.GetProperty("reasonCode").GetString());
    }

    // ------------------------------------------------------------------ pattern inspections

    [Fact]
    public async Task PatternInspectionWithQuickFixAndFixInScope()
    {
        var file = _f.File("Cases/Strings.cs");
        var snap = await _f.Client.BarrierAsync();
        var pattern = new
        {
            text = "$s$ == null || $s$ == \"\"", replacement = "string.IsNullOrEmpty($s$)", placeholders = Array.Empty<object>(),
            ruleId = "ORS-empty-string", severity = "information", message = "Use string.IsNullOrEmpty", fixTitle = "Use string.IsNullOrEmpty",
        };
        var r = await _f.Client.RequestAsync("analysis/run", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, documents = new[] { UriPaths.ToUri(file) }, structuralPatterns = new[] { pattern } });
        var ds = r.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("id").GetString() == "ORS-empty-string").ToList();
        Assert.Equal(new[] { 7, 8, 10 }, ds.Select(d => d.GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("line").GetInt32() + 1));
        Assert.All(ds, d => Assert.Equal("information", d.GetProperty("severity").GetString()));
        Assert.All(ds, d => Assert.Equal("Use string.IsNullOrEmpty", d.GetProperty("message").GetString()));
        var fix = ds[0].GetProperty("fixes")[0];
        Assert.Equal("csharp.edit.fix.structural.ORS-empty-string", fix.GetProperty("actionId").GetString());
        var start = ds[0].GetProperty("location").GetProperty("range").GetProperty("start");
        var edit = await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file),
            range = new { start = new { line = start.GetProperty("line").GetInt32(), character = start.GetProperty("character").GetInt32() }, end = new { line = start.GetProperty("line").GetInt32(), character = start.GetProperty("character").GetInt32() } },
            actionId = fix.GetProperty("actionId").GetString(),
        });
        Assert.False(edit.TryGetProperty("reasonCode", out var erc) && erc.ValueKind != JsonValueKind.Null, edit.ToString());
        var fixedText = MoveTypeTests.ApplyEdits(System.IO.File.ReadAllText(file), new { edits = edit.GetProperty("edits") }.ToJson()).Replace("\r\n", "\n");
        Assert.Contains("public bool A(string? s) => string.IsNullOrEmpty(s);", fixedText);
        Assert.Contains("public bool B(string? s) => (s == null) || (s == \"\");", fixedText);
        // Fix in scope (csharp.fixAll with the structural fix).
        var all = await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.fixAll", symbolId = "", newName = "", documentUri = UriPaths.ToUri(file),
            fixAll = new { actionId = "csharp.edit.fix.structural.ORS-empty-string", scope = "document" },
        });
        Assert.Contains("string.IsNullOrEmpty(_name)", After(Plan(all), "Cases/Strings.cs"));
        // An invalid inspection pattern is an abstention, not an error.
        var bad = await _f.Client.RequestAsync("analysis/run", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, documents = new[] { UriPaths.ToUri(file) },
            structuralPatterns = new[] { new { text = "if (", ruleId = "ORS-bad" }, new { text = "$x$", ruleId = "no-prefix" } },
        });
        var abst = bad.GetProperty("abstentions").EnumerateArray().Select(a => a.GetProperty("reason").GetString()).ToList();
        Assert.Contains("InvalidPattern", abst);
        Assert.Contains("InvalidRuleId", abst);
    }
}

internal static class JsonTestExtensions
{
    public static JsonElement ToJson(this object o) => JsonSerializer.SerializeToElement(o);
}
