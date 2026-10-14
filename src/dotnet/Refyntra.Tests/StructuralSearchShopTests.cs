using System.Diagnostics;
using System.Text.Json;
using Refyntra.Workspaces;
using Xunit.Abstractions;

namespace Refyntra.Tests;

/// <summary>
/// Structural search on the (unmodified) Shop fixture: the matches the visual baselines rely on, and the timings recorded
/// in docs/performance/structural-search-2026-10-14.md (written to the test output; no timing is asserted).
/// </summary>
[Collection("Shop")]
public sealed class StructuralSearchShopTests
{
    private readonly ShopFixture _f;
    private readonly ITestOutputHelper _out;

    public StructuralSearchShopTests(ShopFixture f, ITestOutputHelper output)
    {
        _f = f;
        _out = output;
    }

    private async Task<JsonElement> SearchAsync(object pattern, string scope = "solution", string? uri = null)
    {
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/structuralSearch", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, pattern, scope, uri, limit = 200 });
    }

    private static readonly (string Name, object Pattern, int Expected)[] Patterns =
    {
        ("await of a Task", new { text = "await $call$", placeholders = new[] { new { name = "call", kind = "expression", type = "System.Threading.Tasks.Task" } } }, 4),
        ("any await", new { text = "await $x$", placeholders = Array.Empty<object>() }, 4),
        ("Send(new $T$($args$))", new { text = "$s$.Send(new $T$($args$))", placeholders = new object[] { new { name = "args", kind = "argument", minCount = 0, maxCount = 3 } } }, 3),
        ("every expression", new { text = "$x$", placeholders = Array.Empty<object>() }, -1),
        ("statements: return $x$;", new { text = "return $x$;", placeholders = Array.Empty<object>() }, -1),
    };

    [Fact]
    public async Task MatchesAndTimingsOnShop()
    {
        foreach (var (name, pattern, expected) in Patterns)
        {
            var sw = Stopwatch.StartNew();
            var first = await SearchAsync(pattern);
            var cold = sw.ElapsedMilliseconds;
            Assert.False(first.TryGetProperty("reasonCode", out var rc) && rc.ValueKind != JsonValueKind.Null, first.ToString());
            var count = first.GetProperty("matches").GetArrayLength();
            if (expected >= 0) Assert.Equal(expected, count);
            var warm = new List<long>();
            for (var i = 0; i < 5; i++)
            {
                sw.Restart();
                await SearchAsync(pattern);
                warm.Add(sw.ElapsedMilliseconds);
            }
            warm.Sort();
            _out.WriteLine($"{name}: {count} match(es), {first.GetProperty("filesSearched").GetInt32()} files; first {cold} ms (host {first.GetProperty("elapsedMs").GetInt64()} ms), warm median {warm[2]} ms, max {warm[^1]} ms");
        }
        // Document scope on the largest file.
        var doc = await SearchAsync(new { text = "await $x$", placeholders = Array.Empty<object>() }, "document", UriPaths.ToUri(_f.File("Shop.Api", "Program.cs")));
        Assert.Equal(3, doc.GetProperty("matches").GetArrayLength());
    }
}
