using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

public sealed class RazorFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var path = await Fixtures.CopyAsync("Blazor", "Blazor.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Dir = Path.GetDirectoryName(path)!;
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>Blazor / Razor: C# symbols used in .razor and .cshtml files (Blazor fixture).</summary>
public sealed class RazorTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _f;
    public RazorTests(RazorFixture f) => _f = f;

    private string Service => Path.Combine(_f.Dir, "BlazorApp", "Services", "CounterService.cs");

    private async Task<List<string>> ReferencesAsync(string needle)
    {
        var snap = await _f.Client.BarrierAsync();
        var s = await _f.Client.SymbolAtTextAsync(snap, Service, needle);
        var refs = await _f.Client.RequestAsync("code/references", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        return refs.GetProperty("locations").EnumerateArray()
            .Select(l => $"{Path.GetFileName(UriPaths.ToPath(l.GetProperty("uri").GetString()!))}:{l.GetProperty("range").GetProperty("start").GetProperty("line").GetInt32() + 1}:{l.GetProperty("range").GetProperty("start").GetProperty("character").GetInt32() + 1}")
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    [Fact]
    public async Task ReferencesInRazorAndCshtmlAreFound()
    {
        var refs = await ReferencesAsync("Describe(int step)");
        Assert.Equal(new[] { "About.cshtml:3:13", "Counter.razor:7:13" }, refs);
    }

    [Fact]
    public async Task RenameUpdatesRazorAndCshtml()
    {
        var snap = await _f.Client.BarrierAsync();
        var s = await _f.Client.SymbolAtTextAsync(snap, Service, "Describe(int step)");
        var r = await _f.Client.RequestAsync("refactor/prepare", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.rename", symbolId = s.GetProperty("symbolId").GetString(), newName = "Explain" });
        var plan = RefactoringFixture.Prepared(r);
        var razor = Path.Combine(_f.Dir, "BlazorApp", "Components", "Pages", "Counter.razor");
        var cshtml = Path.Combine(_f.Dir, "BlazorApp", "Pages", "About.cshtml");
        Assert.Contains("<p>@Service.Explain(1)</p>", RefactoringFixture.After(plan, razor));
        Assert.Contains("<p>@Counter.Explain(2)</p>", RefactoringFixture.After(plan, cshtml));
        Assert.Contains("public string Explain(int step)", RefactoringFixture.After(plan, Service));
    }

    [Fact]
    public async Task FindUsagesShowsTheMarkupLines()
    {
        var snap = await _f.Client.BarrierAsync();
        var s = await _f.Client.SymbolAtTextAsync(snap, Service, "Increment()");
        var r = await _f.Client.RequestAsync("code/usages", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        var item = Assert.Single(r.GetProperty("items").EnumerateArray());
        Assert.EndsWith("Counter.razor", UriPaths.ToPath(item.GetProperty("uri").GetString()!));
        Assert.Equal("<button @onclick=\"Service.Increment\">Add</button>", item.GetProperty("lineText").GetString());
    }

    [Fact]
    public async Task RenameAMemberDeclaredInACodeBlock()
    {
        var razor = Path.Combine(_f.Dir, "BlazorApp", "Components", "Pages", "Counter.razor");
        var snap = await _f.Client.BarrierAsync();
        var s = await _f.Client.SymbolAtTextAsync(snap, razor, "Title { get", 0);
        var r = await _f.Client.RequestAsync("refactor/prepare", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId = "csharp.rename", symbolId = s.GetProperty("symbolId").GetString(), newName = "Heading" });
        var after = RefactoringFixture.After(RefactoringFixture.Prepared(r), razor);
        Assert.Contains("<h1>@Heading</h1>", after);
        Assert.Contains("private string Heading { get; set; }", after);
    }

    [Fact]
    public async Task UnsavedMarkupIsSeen()
    {
        var razor = Path.Combine(_f.Dir, "BlazorApp", "Components", "Pages", "Counter.razor");
        var text = await File.ReadAllTextAsync(razor);
        await _f.Client.DidOpenAsync(razor, text);
        await _f.Client.DidChangeAsync(razor, text.Replace("@code", "<p>@Service.Describe(3)</p>\n@code"));
        try
        {
            var snap = await _f.Client.BarrierAsync();
            var s = await _f.Client.SymbolAtTextAsync(snap, Service, "Describe(int step)");
            var r = await _f.Client.RequestAsync("code/usages", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
            Assert.Contains(r.GetProperty("items").EnumerateArray(), i => i.GetProperty("lineText").GetString() == "<p>@Service.Describe(3)</p>");
        }
        finally
        {
            await _f.Client.DidChangeAsync(razor, text, 3);
        }
    }
}
