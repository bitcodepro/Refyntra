using System.Text.Json;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>code/changeImpact (protocol 1.27) on Shop: what a change of the order services reaches.</summary>
[Collection("Shop")]
public sealed class ChangeImpactTests
{
    private readonly ShopFixture _f;
    public ChangeImpactTests(ShopFixture f) => _f = f;

    [Fact]
    public async Task AChangedFileReachesItsRegistrationsAndTheCodeThatUsesIt()
    {
        var snap = await _f.Client.BarrierAsync();
        var services = _f.File("Shop.Api", "Services", "OrderServices.cs");
        var r = await _f.Client.RequestAsync("code/changeImpact", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uris = new[] { UriPaths.ToUri(services) } });
        var changed = r.GetProperty("changed").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToList();
        Assert.Contains("OrderService", changed);
        Assert.Contains("IOrderService", changed);
        var relations = r.GetProperty("relations").EnumerateArray().ToList();
        Assert.Contains(relations, x => x.GetProperty("relation").GetProperty("group").GetString() == "registrations"
            && x.GetProperty("relation").GetProperty("target").GetProperty("label").GetString()!.Contains("AddScoped"));
        Assert.Contains(relations, x => x.GetProperty("relation").GetProperty("group").GetString() == "references"
            && x.GetProperty("relation").GetProperty("target").GetProperty("location").GetProperty("uri").GetString()!.EndsWith("OrderHandlers.cs"));
        // Uses inside the changed file itself are not its impact.
        Assert.DoesNotContain(relations, x => x.GetProperty("relation").GetProperty("group").GetString() == "references"
            && x.GetProperty("relation").GetProperty("target").GetProperty("location").GetProperty("uri").GetString()!.EndsWith("OrderServices.cs"));
        Assert.All(relations, x => Assert.False(string.IsNullOrEmpty(x.GetProperty("via").GetString())));
    }

    [Fact]
    public async Task OneSymbolAtAPosition()
    {
        var snap = await _f.Client.BarrierAsync();
        var services = _f.File("Shop.Api", "Services", "OrderServices.cs");
        var text = await File.ReadAllTextAsync(services);
        var at = text.IndexOf("interface IOrderService", StringComparison.Ordinal) + "interface ".Length;
        int line = 0, ls = 0;
        for (var i = 0; i < at; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var r = await _f.Client.RequestAsync("code/changeImpact", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(services), position = new { line, character = at - ls } });
        Assert.Equal(new[] { "IOrderService" }, r.GetProperty("changed").EnumerateArray().Select(c => c.GetProperty("name").GetString()).ToArray());
        Assert.Contains(r.GetProperty("relations").EnumerateArray(), x => x.GetProperty("relation").GetProperty("group").GetString() == "implementations");
    }
}
