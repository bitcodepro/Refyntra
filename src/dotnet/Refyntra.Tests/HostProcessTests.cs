using System.Diagnostics;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>End-to-end: the built Refyntra.Host process over real stdio.</summary>
public sealed class HostProcessTests
{
    private static Process Start()
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(Fixtures.HostDll())!,
        };
        psi.ArgumentList.Add(Fixtures.HostDll());
        return Process.Start(psi)!;
    }

    [Fact]
    public async Task HostServesShopOverStdioAndExitsCleanly()
    {
        await Fixtures.EnsureRestoredAsync(Fixtures.ShopSln);
        using var p = Start();
        var stderrLines = new List<string>();
        var stderrTask = Task.Run(async () =>
        {
            while (await p.StandardError.ReadLineAsync() is { } line) lock (stderrLines) stderrLines.Add(line);
        });
        var client = new TestClient(p.StandardOutput.BaseStream, p.StandardInput.BaseStream);
        try
        {
            var init = await client.InitializeAsync();
            Assert.Equal(1, init.GetProperty("protocolMajor").GetInt32());
            var status = await client.OpenAsync(Fixtures.ShopSln);
            Assert.Equal("Ready", status.GetProperty("state").GetString());

            var contracts = Path.Combine(Path.GetDirectoryName(Fixtures.ShopSln)!, "Shop.Contracts", "Orders", "OrderRequests.cs");
            var snap = await client.BarrierAsync();
            var s = await client.SymbolAtTextAsync(snap, contracts, "record GetOrderQuery", 7);
            var related = await client.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
            Assert.Contains(related.GetProperty("relations").EnumerateArray(), r =>
                r.GetProperty("relationKind").GetString() == "mediatr.handler"
                && r.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString() == "GetOrderQueryHandler");

            var shutdown = await client.RawRequestAsync("shutdown", new { traceId = "t" });
            Assert.Equal(JsonValueKind.Null, shutdown.GetProperty("result").ValueKind);
            await client.NotifyAsync("exit", new { });
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await p.WaitForExitAsync(cts.Token);
            Assert.Equal(0, p.ExitCode);
        }
        finally
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
        }
        await stderrTask.WaitAsync(TimeSpan.FromSeconds(10));
        lock (stderrLines)
        {
            Assert.NotEmpty(stderrLines);
            foreach (var line in stderrLines)
            {
                using var doc = JsonDocument.Parse(line); // every stderr line is a structured JSON log record
                Assert.True(doc.RootElement.TryGetProperty("level", out _));
                Assert.DoesNotContain("record GetOrderQuery", line); // no source text in logs
            }
        }
    }

    [Fact]
    public async Task HostExitsWhenStdinCloses()
    {
        using var p = Start();
        _ = Task.Run(async () => { while (await p.StandardError.ReadLineAsync() != null) { } });
        var client = new TestClient(p.StandardOutput.BaseStream, p.StandardInput.BaseStream);
        await client.InitializeAsync();
        p.StandardInput.Close();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            await p.WaitForExitAsync(cts.Token);
        }
        finally
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
        }
        Assert.True(p.HasExited);
    }

    /// <summary>
    /// No orphan BuildHost. The host is stopped while MSBuild is loading (a BuildHost child is
    /// alive) — once gracefully (stdin closed, what the extension does first) and once abruptly (only the host
    /// process is killed, as when VS Code tears the extension host down) — and every descendant must be gone.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NoChildProcessOutlivesTheHost(bool abrupt)
    {
        // Both platforms, both ways: Windows by the Job Object, POSIX by the watchdog (ChildProcessGuard).
        await Fixtures.EnsureRestoredAsync(Fixtures.ShopSln);
        using var p = Start();
        _ = Task.Run(async () => { while (await p.StandardError.ReadLineAsync() != null) { } });
        var client = new TestClient(p.StandardOutput.BaseStream, p.StandardInput.BaseStream);
        var children = new Dictionary<int, string>();
        try
        {
            await client.InitializeAsync();
            _ = client.OpenAsync(Fixtures.ShopSln).ContinueWith(_ => { }, TaskScheduler.Default);
            var deadline = DateTime.UtcNow.AddMinutes(2);
            // Wait for BuildHost itself (a dotnet process): other children (the POSIX watchdog sh, conhost) start earlier.
            static bool IsBuildHost(string name) => name.StartsWith("dotnet", StringComparison.OrdinalIgnoreCase);
            while (!children.Values.Any(IsBuildHost) && DateTime.UtcNow < deadline && !p.HasExited)
            {
                foreach (var c in ProcessTree.Descendants(p.Id)) children[c.Pid] = c.Name;
                if (!children.Values.Any(IsBuildHost)) await Task.Delay(20);
            }
            Assert.True(children.Values.Any(IsBuildHost), "the host started no BuildHost while loading: " + string.Join(", ", children.Values));
            var observedAt = DateTime.Now;
            if (abrupt) p.Kill(entireProcessTree: false);
            else p.StandardInput.Close();
            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30))) await p.WaitForExitAsync(cts.Token);
            var gone = DateTime.UtcNow.AddSeconds(15);
            List<string> alive;
            do
            {
                alive = children.Where(c => ProcessTree.IsAlive(c.Key, observedAt)).Select(c => $"{c.Value} ({c.Key})").ToList();
                if (alive.Count == 0) break;
                await Task.Delay(100);
            } while (DateTime.UtcNow < gone);
            Assert.True(alive.Count == 0, "orphaned after the host exited: " + string.Join(", ", alive));
        }
        finally
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
            foreach (var pid in children.Keys)
                try { using var c = Process.GetProcessById(pid); c.Kill(entireProcessTree: true); } catch { }
        }
    }
}
