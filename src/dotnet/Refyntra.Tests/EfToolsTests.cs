using System.Text.Json;
using System.Text.RegularExpressions;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>A copy of the EfTools fixture (two DbContexts, migrations in the default and in a custom folder/namespace, OR1011 cases).</summary>
public sealed class EfToolsFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("EfTools", "EfTools.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Dir = Path.GetDirectoryName(sln)!;
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();

    public string File(string rel) => Path.GetFullPath(Path.Combine(Dir, "EfTools.App", rel.Replace('/', Path.DirectorySeparatorChar)));
}

/// <summary>
/// EF Core tools on the host: efcore/migrations (protocol 1.18) discovers contexts, migrations in order, snapshots and
/// configurations from source; OR1011 (possible N+1) reports exactly the marked cases and its "Add .Include" fix.
/// </summary>
public sealed class EfToolsTests : IClassFixture<EfToolsFixture>
{
    private readonly EfToolsFixture _f;
    public EfToolsTests(EfToolsFixture f) => _f = f;

    private async Task<JsonElement> MigrationsAsync(TestClient c)
    {
        var snap = await c.BarrierAsync();
        return await c.RequestAsync("efcore/migrations", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap });
    }

    private static string FileName(JsonElement loc) => Path.GetFileName(UriPaths.ToPath(loc.GetProperty("uri").GetString()!));

    [Fact]
    public async Task MigrationsOfEveryContextInOrderWithSnapshots()
    {
        var r = await MigrationsAsync(_f.Client);
        var contexts = r.GetProperty("contexts").EnumerateArray().ToList();
        Assert.Equal(new[] { "AuditContext", "BloggingContext" }, contexts.Select(c => c.GetProperty("name").GetString()).ToArray());

        var blogging = contexts[1];
        Assert.Equal("EfTools.App.Data.BloggingContext", blogging.GetProperty("fullName").GetString());
        Assert.Equal("EfTools.App", blogging.GetProperty("projectName").GetString());
        Assert.EndsWith("EfTools.App.csproj", blogging.GetProperty("migrationsProjectUri").GetString());
        Assert.Equal("EfTools.App.Migrations", blogging.GetProperty("migrationsNamespace").GetString());
        var ms = blogging.GetProperty("migrations").EnumerateArray().ToList();
        Assert.Equal(new[] { "20250301000000_InitialCreate", "20250315000000_AddBlogs" }, ms.Select(m => m.GetProperty("id").GetString()).ToArray());
        Assert.Equal(new[] { "InitialCreate", "AddBlogs" }, ms.Select(m => m.GetProperty("name").GetString()).ToArray());
        // The main file (Up/Down) and the designer file are told apart.
        Assert.Equal("20250301000000_InitialCreate.cs", FileName(ms[0].GetProperty("location")));
        Assert.Equal("20250301000000_InitialCreate.Designer.cs", FileName(ms[0].GetProperty("designerLocation")));
        Assert.Equal("BloggingContextModelSnapshot", blogging.GetProperty("snapshot").GetProperty("name").GetString());
        Assert.Equal("BloggingContext.cs", FileName(blogging.GetProperty("onModelCreating")));

        // Custom folder and namespace; no designer file.
        var audit = contexts[0];
        Assert.Equal("EfTools.App.Audit.Schema", audit.GetProperty("migrationsNamespace").GetString());
        var am = audit.GetProperty("migrations").EnumerateArray().Single();
        Assert.Equal("AuditStart", am.GetProperty("name").GetString());
        Assert.Contains("Schema", UriPaths.ToPath(am.GetProperty("location").GetProperty("uri").GetString()!));
        Assert.False(am.TryGetProperty("designerLocation", out _));
        Assert.Equal("AuditContextModelSnapshot", audit.GetProperty("snapshot").GetProperty("name").GetString());
        Assert.False(audit.TryGetProperty("onModelCreating", out _));
    }

    [Fact]
    public async Task EfCoreFixtureContextsAndConfigurations()
    {
        var sln = await Fixtures.CopyAsync("EfCore", "EfCore.sln");
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        await c.OpenAsync(sln);
        var r = await MigrationsAsync(c);
        var contexts = r.GetProperty("contexts").EnumerateArray().ToList();
        Assert.Equal(new[] { "ReportingDbContext", "ShopDbContext" }, contexts.Select(x => x.GetProperty("name").GetString()).ToArray());
        Assert.Empty(contexts[0].GetProperty("migrations").EnumerateArray());
        Assert.False(contexts[0].TryGetProperty("snapshot", out _));
        var shop = contexts[1];
        Assert.Equal("Initial", shop.GetProperty("migrations").EnumerateArray().Single().GetProperty("name").GetString());
        Assert.Equal("OrderConfiguration", shop.GetProperty("configurations").EnumerateArray().Single().GetProperty("name").GetString());
    }

    [Fact]
    public void MigrationNames()
    {
        Assert.Equal("Initial", Frameworks.EfCore.EfMigrations.NameOf("20250101000000_Initial"));
        Assert.Equal("Add_Index", Frameworks.EfCore.EfMigrations.NameOf("20250101000000_Add_Index"));
        Assert.Equal("Custom", Frameworks.EfCore.EfMigrations.NameOf("Custom"));
        Assert.Equal("2025_Short", Frameworks.EfCore.EfMigrations.NameOf("2025_Short"));
    }

    // ---------------------------------------------------------------- OR1011

    private async Task<List<JsonElement>> AnalyzeAsync(string file)
    {
        var snap = await _f.Client.BarrierAsync();
        var r = await _f.Client.RequestAsync("analysis/run", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, documents = new[] { UriPaths.ToUri(_f.File(file)) } });
        return r.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("id").GetString() != "OR1001").ToList();
    }

    private static int Line(JsonElement d) => d.GetProperty("location").GetProperty("range").GetProperty("start").GetProperty("line").GetInt32();

    [Fact]
    public async Task NPlusOneReportsExactlyTheMarkedCases()
    {
        var lines = (await File.ReadAllTextAsync(_f.File("Cases/NPlusOne.cs"))).Replace("\r\n", "\n").Split('\n');
        var expected = new SortedSet<int>(Enumerable.Range(0, lines.Length).Where(i => Regex.IsMatch(lines[i], "expect: OR1011")).Select(i => i + 1));
        var ds = await AnalyzeAsync("Cases/NPlusOne.cs");
        Assert.All(ds, d => Assert.Equal("OR1011", d.GetProperty("id").GetString()));
        var actual = new SortedSet<int>(ds.Select(d => Line(d) + 1));
        Assert.True(expected.SetEquals(actual), $"missing: {string.Join(",", expected.Except(actual))}; unexpected: {string.Join(",", actual.Except(expected))}");
        Assert.Equal(expected.Count, ds.Count);
        var first = ds.OrderBy(Line).First();
        Assert.Contains("Possible N+1: 'blog.Owner'", first.GetProperty("message").GetString());
        Assert.EndsWith("docs/rules/OR1011.md", first.GetProperty("helpUri").GetString());
        Assert.Equal("The query", first.GetProperty("relatedLocations")[0].GetProperty("message").GetString());
        Assert.Equal("csharp.edit.fix.addInclude", first.GetProperty("fixes")[0].GetProperty("actionId").GetString());
        Assert.Equal("Add .Include(x => x.Owner)", first.GetProperty("fixes")[0].GetProperty("title").GetString());
    }

    [Fact]
    public async Task OtherFilesHaveNoNPlusOne()
    {
        Assert.Empty(await AnalyzeAsync("Program.cs"));
        Assert.Empty(await AnalyzeAsync("Data/BloggingContext.cs"));
    }

    private async Task<string> FixAsync(string needle, string file = "Cases/NPlusOne.cs")
    {
        var path = _f.File(file);
        var text = await File.ReadAllTextAsync(path);
        var o = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(o >= 0, needle);
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        var pos = new { line, character = o - ls };
        var r = await _f.Client.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(path), range = new { start = pos, end = pos }, actionId = "csharp.edit.fix.addInclude",
        });
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        var starts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') starts.Add(i + 1);
        int Off(JsonElement p) => starts[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    [Fact]
    public async Task AddIncludeFixesTheQuery()
    {
        var first = await FixAsync("blog.Owner!.Name); // expect");
        Assert.True(first.Contains("foreach (var blog in _db.Blogs.Include(x => x.Owner).Where(b => b.Rating > 1).ToList())", StringComparison.Ordinal), first);
        Assert.Contains("foreach (var blog in _db.Blogs.Include(x => x.Owner).Where(b => b.Rating > 1).ToList())", await FixAsync("blog.Owner!.Name); // expect"));
        Assert.Contains("var posts = _db.Posts.Include(p => p.Blog).AsNoTracking().ToList();", await FixAsync("post.Blog?.Name); // expect"));
        Assert.Contains("await _db.Blogs.Include(x => x.Posts).OrderBy(b => b.Name).ToListAsync();", await FixAsync("b.Posts.Count); // expect"));
        Assert.Contains("_db.Blogs.Include(x => x.Owner).ToList().Select(b => b.Owner?.Name)", await FixAsync("b.Owner?.Name).ToList(); // expect"));
        Assert.Contains("foreach (var blog in _db.Set<Blog>().Include(b => b.Owner).ToList())", await FixAsync("blog.Owner?.Name); // expect: OR1011\n            Console.WriteLine(blog.Owner?.Id)"));
        Assert.Contains("_db.Blogs.Include(x => x.Owner).Include(b => b.Posts).ToList()", await FixAsync("blog.Owner?.Name); // expect: OR1011\n    }\n\n    // ---"));
    }

    [Fact]
    public async Task AddIncludeAddsTheUsing()
    {
        var after = await FixAsync("blog.Owner?.Name", "Cases/NoEfUsing.cs");
        Assert.True(after.Contains("using EfTools.App.Data;\nusing Microsoft.EntityFrameworkCore;\n", StringComparison.Ordinal), after);
        Assert.Contains("foreach (var blog in db.Blogs.Include(b => b.Owner).ToList())", after);
    }
}
