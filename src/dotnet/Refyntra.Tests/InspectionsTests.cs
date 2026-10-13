using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

public sealed class InspectionsFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("Inspections", "Inspections.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Dir = Path.GetDirectoryName(sln)!;
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();

    public string File(string rel) => Path.GetFullPath(Path.Combine(Dir, "Inspections.App", rel.Replace('/', Path.DirectorySeparatorChar)));
}

/// <summary>
/// Inspections OR1002–OR1010 (CodeInspections) on tests/fixtures/Inspections: every "// expect: ORxxxx" line is
/// reported and nothing else (the unmarked code of each file is the rule's false-positive guards); suppressions; the
/// quick fixes (code/editActions csharp.edit.fix.*) and Fix in scope.
/// </summary>
public sealed class InspectionsTests : IClassFixture<InspectionsFixture>
{
    private readonly InspectionsFixture _f;
    public InspectionsTests(InspectionsFixture f) => _f = f;

    private static readonly string[] CaseFiles =
    {
        "Cases/SyncOverAsync.cs", "Cases/AsyncVoid.cs", "Cases/DiscardedTask.cs", "Cases/Undisposed.cs", "Cases/MultipleEnumeration.cs",
        "Cases/ConcatInLoop.cs", "Cases/Linq.cs", "Cases/Format.cs", "Cases/Suppressed.cs", "Fixes/FixSamples.cs",
    };

    private async Task<List<JsonElement>> AnalyzeAsync(params string[] files)
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("analysis/run", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, documents = files.Select(f => UriPaths.ToUri(_f.File(f))).ToArray(),
        });
        return r.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("id").GetString() != "OR1001").ToList();
    }

    private static int Line(JsonElement d) => d.GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("line").GetInt32();

    private string FileOf(JsonElement d) => Path.GetRelativePath(Path.Combine(_f.Dir, "Inspections.App"), UriPaths.ToPath(d.GetProperty("location").GetProperty("uri").GetString()!)).Replace('\\', '/');

    [Fact]
    public async Task EveryMarkedCaseIsReportedAndNothingElse()
    {
        var expected = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var f in CaseFiles)
        {
            var lines = (await File.ReadAllTextAsync(_f.File(f))).Replace("\r\n", "\n").Split('\n');
            for (var i = 0; i < lines.Length; i++)
                foreach (Match m in Regex.Matches(lines[i], @"expect: (OR\d{4})"))
                    expected.Add($"{f}:{i + 1}:{m.Groups[1].Value}");
        }
        var actual = new SortedSet<string>((await AnalyzeAsync(CaseFiles)).Select(d => $"{FileOf(d)}:{Line(d) + 1}:{d.GetProperty("id").GetString()}"), StringComparer.Ordinal);
        Assert.True(expected.SetEquals(actual),
            $"missing:\n  {string.Join("\n  ", expected.Except(actual))}\nunexpected:\n  {string.Join("\n  ", actual.Except(expected))}");
    }

    [Fact]
    public async Task ResultsCarryHelpFixesAndRelatedLocations()
    {
        var ds = await AnalyzeAsync("Cases/SyncOverAsync.cs", "Cases/MultipleEnumeration.cs");
        Assert.All(ds, d => Assert.Matches(@"docs/rules/OR10\d\d\.md$", d.GetProperty("helpUri").GetString()));
        string[] Fixes(JsonElement d) => d.GetProperty("fixes").EnumerateArray().Select(x => x.GetProperty("actionId").GetString()!).ToArray();
        // Line 11: int Result() => GetAsync().Result — the method returns int: no fix (making it async changes its signature).
        Assert.Empty(Fixes(ds.Single(d => Line(d) == 10)));
        // Line 23: inside an async method: Use 'await'.
        Assert.Equal(new[] { "csharp.edit.fix.awaitSyncCall" }, Fixes(ds.Single(d => Line(d) == 22)));
        // Constructor: reported, never fixed.
        Assert.Empty(Fixes(ds.Single(d => d.GetProperty("id").GetString() == "OR1002" && Line(d) == 29)));
        var multiple = ds.First(d => d.GetProperty("id").GetString() == "OR1006");
        Assert.Equal("first enumeration", multiple.GetProperty("relatedLocations")[0].GetProperty("message").GetString());
    }

    [Fact]
    public async Task UnchangedDocumentsAreNotReanalysed()
    {
        var session = _f.Client.Engine!.FindSession(_f.Client.WorkspaceId)!;
        await AnalyzeAsync("Cases/Linq.cs");
        var (computed, reused) = Semantics.Rules.CodeInspections.Stats(session);
        await AnalyzeAsync("Cases/Linq.cs");
        var (computed2, reused2) = Semantics.Rules.CodeInspections.Stats(session);
        Assert.Equal(computed, computed2);
        Assert.True(reused2 > reused);
    }

    // ---------------------------------------------------------------- quick fixes

    private async Task<JsonElement> EditActionAsync(string file, string needle, int offset, string? actionId)
    {
        var path = _f.File(file);
        var text = await File.ReadAllTextAsync(path);
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var o = at + offset;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        var pos = new { line, character = o - ls };
        return await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(path), range = new { start = pos, end = pos }, actionId,
        });
    }

    private async Task<string> FixAsync(string file, string needle, int offset, string actionId)
    {
        var r = await EditActionAsync(file, needle, offset, actionId);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        var text = await File.ReadAllTextAsync(_f.File(file));
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    private async Task RefusedAsync(string file, string needle, int offset, string actionId, string reason)
    {
        var r = await EditActionAsync(file, needle, offset, actionId);
        Assert.False(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    private static void Has(string text, params string[] parts)
    {
        foreach (var p in parts) Assert.True(text.Contains(p, StringComparison.Ordinal), $"missing «{p}» in:\n{text}");
    }

    private static void Lacks(string text, params string[] parts)
    {
        foreach (var p in parts) Assert.False(text.Contains(p, StringComparison.Ordinal), $"unexpected «{p}» in:\n{text}");
    }

    private const string F = "csharp.edit.fix.";

    [Fact]
    public async Task SyncOverAsyncBecomesAwait()
    {
        var t = await FixAsync("Cases/SyncOverAsync.cs", "return t.Result; // expect", 8, F + "awaitSyncCall");
        Has(t, "return await t; // expect");
        // A Task-returning method that is not async yet: 'async' is added and its returns are awaited.
        var w = await FixAsync("Fixes/FixSamples.cs", "GetAsync().Result; // fix: await-make-async", 10, F + "awaitSyncCall");
        Has(w, "public async Task<int> Wrapped()", "var x = await GetAsync();", "return await Task.FromResult(x + 1);");
        var g = await FixAsync("Fixes/FixSamples.cs", "WorkAsync().GetAwaiter().GetResult(); // fix: getresult", 11, F + "awaitSyncCall");
        Has(g, "await WorkAsync(); // fix: getresult");
        var p = await FixAsync("Fixes/FixSamples.cs", "GetAsync().Result.ToString(); // fix: parenthesized", 10, F + "awaitSyncCall");
        Has(p, "(await GetAsync()).ToString(); // fix: parenthesized");
        // No fix where the method would change its signature.
        await RefusedAsync("Cases/SyncOverAsync.cs", "GetAsync().Result; // expect", 10, F + "awaitSyncCall", "NotApplicable");
    }

    [Fact]
    public async Task AsyncVoidBecomesAsyncTaskUnlessUsedAsDelegate()
    {
        var t = await FixAsync("Cases/AsyncVoid.cs", "Fire() // expect", 0, F + "asyncVoidToTask");
        Has(t, "public async Task Fire() // expect");
        var l = await FixAsync("Cases/AsyncVoid.cs", "Inner() // expect", 0, F + "asyncVoidToTask");
        Has(l, "async Task Inner() // expect");
        await RefusedAsync("Fixes/FixSamples.cs", "UsedAsCallback()", 0, F + "asyncVoidToTask", "UsedAsDelegate");
    }

    [Fact]
    public async Task DiscardedTaskGetsDiscardOrAwait()
    {
        var d = await FixAsync("Cases/DiscardedTask.cs", "SaveAsync(); // expect", 0, F + "discardTask");
        Has(d, "_ = SaveAsync(); // expect");
        // At the compiler's CS4014 (async method): Add 'await'.
        var a = await FixAsync("Cases/DiscardedTask.cs", "SaveAsync(); // the compiler", 0, F + "addAwait");
        Has(a, "await SaveAsync(); // the compiler");
        // Not in a method that is not async.
        await RefusedAsync("Cases/DiscardedTask.cs", "SaveAsync(); // expect", 0, F + "addAwait", "NotApplicable");
    }

    [Fact]
    public async Task UndisposedLocalGetsUsingDeclaration()
    {
        var t = await FixAsync("Cases/Undisposed.cs", "reader = new StreamReader(path); // expect", 0, F + "usingVar");
        Has(t, "        using var reader = new StreamReader(path); // expect");
    }

    [Fact]
    public async Task MultipleEnumerationIsMaterializedOnce()
    {
        var t = await FixAsync("Cases/MultipleEnumeration.cs", "items.Sum(); // expect", 0, F + "materialize");
        Has(t, "var itemsList = items.ToList();", "if (!itemsList.Any()) return 0;", "return itemsList.Sum(); // expect");
        var l = await FixAsync("Cases/MultipleEnumeration.cs", "query.Count(); // expect", 0, F + "materialize");
        Has(l, "IEnumerable<int> query = source.Where(x => x > 1).ToList();");
    }

    [Fact]
    public async Task ConcatenationInLoopUsesStringBuilder()
    {
        var t = await FixAsync("Cases/ConcatInLoop.cs", "s += p; // expect", 0, F + "stringBuilder");
        Has(t, "using System.Text;", "var sBuilder = new StringBuilder();", "sBuilder.Append(p); // expect", "sBuilder.Append(\",\");", "var s = sBuilder.ToString();");
        var n = await FixAsync("Cases/ConcatInLoop.cs", "text += i; // expect", 0, F + "stringBuilder");
        Has(n, "var textBuilder = new StringBuilder(\"x\");", "textBuilder.Append(i); // expect", "string text = textBuilder.ToString();");
        // A loop that reads the string is not reported (and so has no fix).
        await RefusedAsync("Fixes/FixSamples.cs", "acc += item; // not reported", 0, F + "stringBuilder", "NotApplicable");
    }

    [Fact]
    public async Task LinqFixes()
    {
        var w = await FixAsync("Cases/Linq.cs", "Where(x => x > 1).First(); // expect", 0, F + "predicateOverload");
        Has(w, "xs.First(x => x > 1); // expect");
        var a = await FixAsync("Cases/Linq.cs", "ToList().Any(); // expect", 0, F + "removeMaterialization");
        Has(a, "=> xs.Any(); // expect");
        var f = await FixAsync("Cases/Linq.cs", "ToList()) total += i; // expect", 0, F + "removeMaterialization");
        Has(f, "foreach (var i in items) total += i; // expect");
    }

    [Fact]
    public async Task FormatWithoutArgumentsBecomesTheString()
    {
        Has(await FixAsync("Cases/Format.cs", "string.Format(\"hello\")", 0, F + "removeFormat"), "Plain() => \"hello\"; // expect");
        Has(await FixAsync("Cases/Format.cs", "string.Format(\"{{x}}\")", 0, F + "removeFormat"), "Braces() => \"{x}\"; // expect");
        Has(await FixAsync("Cases/Format.cs", "string.Format(Fixed)", 0, F + "removeFormat"), "Constant() => Fixed; // expect");
        // A placeholder without an argument throws: reported, never "fixed".
        await RefusedAsync("Cases/Format.cs", "string.Format(\"{0}\")", 0, F + "removeFormat", "NotApplicable");
    }

    [Fact]
    public async Task QuickFixesAreListedWithTheirRuleKind()
    {
        var r = await EditActionAsync("Cases/Format.cs", "string.Format(\"hello\")", 0, null);
        var item = r.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("actionId").GetString() == F + "removeFormat");
        Assert.Equal("quickfix.refyntra.OR1010", item.GetProperty("kind").GetString());
    }

    [Fact]
    public async Task FixAllInSolutionUsesThePlanPipeline()
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.fixAll", symbolId = "", newName = "",
            documentUri = UriPaths.ToUri(_f.File("Cases/Format.cs")), fixAll = new { actionId = F + "removeFormat", scope = "solution" },
        });
        var plan = RefactoringFixture.Prepared(r);
        var after = RefactoringFixture.After(plan, _f.File("Cases/Format.cs")).Replace("\r\n", "\n");
        Has(after, "Plain() => \"hello\";", "Braces() => \"{x}\";", "Constant() => Fixed;", "string.Format(\"{0}\")");
        // The suppressed one is untouched.
        Has(RefactoringFixture.After(plan, _f.File("Cases/Suppressed.cs")), "string.Format(\"x\")");
        var plainAwait = await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.fixAll", symbolId = "", newName = "",
            documentUri = UriPaths.ToUri(_f.File("Cases/SyncOverAsync.cs")), fixAll = new { actionId = F + "awaitSyncCall", scope = "document" },
        });
        var doc = RefactoringFixture.After(RefactoringFixture.Prepared(plainAwait), _f.File("Cases/SyncOverAsync.cs"));
        Has(doc, "return await t; // expect");
    }

    // ---------------------------------------------------------------- performance (docs/performance/inspections-2026-10-13.md)

    [Fact]
    public async Task ShopDocumentsAreAnalysedQuickly()
    {
        var sln = await Fixtures.CopyAsync("Shop", "Shop.sln");
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        await c.OpenAsync(sln);
        var dir = Path.GetDirectoryName(sln)!;
        var files = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)).ToList();
        var snap = await c.BarrierAsync();
        var sw = Stopwatch.StartNew();
        var coldResult = await c.RequestAsync("analysis/run", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, documents = files.Select(UriPaths.ToUri).ToArray() });
        var cold = sw.Elapsed;
        // Shop has no inspection result (so the Shop-based screenshots and e2e runs stay as they were).
        Assert.Empty(coldResult.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("id").GetString() != "OR1001"));
        var session = c.Engine!.FindSession(c.WorkspaceId)!;
        var (coldComputed, _) = Semantics.Rules.CodeInspections.Stats(session);
        var one = files[0];
        var text = await File.ReadAllTextAsync(one);
        await c.DidOpenAsync(one, text + "\n// edit\n");
        snap = await c.BarrierAsync();
        sw.Restart();
        await c.RequestAsync("analysis/run", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, documents = files.Select(UriPaths.ToUri).ToArray() });
        var warm = sw.Elapsed;
        var (computed, reused) = Semantics.Rules.CodeInspections.Stats(session);
        Console.WriteLine($"[inspections-perf] Shop: {files.Count} documents, cold {cold.TotalMilliseconds:F0} ms, after one edit {warm.TotalMilliseconds:F0} ms (analysed {coldComputed} cold, {computed - coldComputed} after the edit; reused {reused})");
        Assert.Equal(coldComputed + 1, computed); // only the edited document is analysed again
        Assert.True(warm < TimeSpan.FromSeconds(10), $"after one edit: {warm}");
    }
}
