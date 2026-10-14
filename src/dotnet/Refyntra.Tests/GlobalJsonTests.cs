using System.Diagnostics;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// A global.json that pins an older SDK (tests/fixtures/CompatPinned: 8.0.426, rollForward disable), against the real
/// host process (MSBuild is registered once per process, so each case needs a fresh host): with that SDK installed the
/// project loads; without it the host fails with SdkNotFound naming the global.json (Health: Open global.json).
/// </summary>
public sealed class GlobalJsonTests
{
    public const string PinnedSdk = "8.0.426";

    /// <summary>Copies CompatPinned (+ the shielding Directory.* files), optionally with another SDK version in its global.json.</summary>
    private static string Copy(string? sdkVersion = null)
    {
        var work = Path.Combine(AppContext.BaseDirectory, "work", Guid.NewGuid().ToString("N").Substring(0, 8));
        var dest = Path.Combine(work, "CompatPinned");
        Directory.CreateDirectory(Path.Combine(dest, "Pinned"));
        foreach (var f in Directory.EnumerateFiles(Fixtures.FixturesDir, "Directory.*")) File.Copy(f, Path.Combine(work, Path.GetFileName(f)));
        var src = Path.Combine(Fixtures.FixturesDir, "CompatPinned");
        File.Copy(Path.Combine(src, "global.json"), Path.Combine(dest, "global.json"));
        foreach (var f in new[] { "Pinned.csproj", "Program.cs" }) File.Copy(Path.Combine(src, "Pinned", f), Path.Combine(dest, "Pinned", f));
        if (sdkVersion != null)
            File.WriteAllText(Path.Combine(dest, "global.json"), "{\n  \"sdk\": { \"version\": \"" + sdkVersion + "\", \"rollForward\": \"disable\" }\n}\n");
        return Path.Combine(dest, "Pinned", "Pinned.csproj");
    }

    private static async Task<JsonElement> OpenInHostAsync(string project, Func<TestClient, JsonElement, Task>? more = null)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(Fixtures.HostDll())!,
        };
        psi.ArgumentList.Add(Fixtures.HostDll());
        // Started as VS Code starts it: without the SDK 10 MSBuild variables of the test host.
        Fixtures.ScrubTestHostEnvironment(psi.Environment);
        using var p = Process.Start(psi)!;
        _ = Task.Run(async () => { while (await p.StandardError.ReadLineAsync() != null) { } });
        var client = new TestClient(p.StandardOutput.BaseStream, p.StandardInput.BaseStream);
        try
        {
            await client.InitializeAsync();
            var status = await client.OpenAsync(project);
            if (more != null) await more(client, status);
            await client.RawRequestAsync("shutdown", new { traceId = "t" });
            await client.NotifyAsync("exit", new { });
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await p.WaitForExitAsync(cts.Token);
            return status;
        }
        finally
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public async Task MissingPinnedSdkFailsWithTheGlobalJsonAndItsPolicy()
    {
        // 8.0.100 with rollForward disable is installed nowhere (not on the test machines, not in the e2e image).
        Assert.DoesNotContain("8.0.100", DotnetInstall.Sdks());
        var project = Copy("8.0.100");
        var globalJson = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(project)!)!, "global.json");
        // workspace/open answers with the SdkNotFound error; the extension shows its message in Health with Open global.json.
        var error = await Assert.ThrowsAsync<RpcError>(() => OpenInHostAsync(project));
        Assert.Equal("SdkNotFound", error.ReasonCode);
        Assert.Equal(-33007, error.Code);
        Assert.Contains(globalJson + " asks for .NET SDK 8.0.100 (rollForward: disable, accepts exactly 8.0.100). Installed SDKs: ", error.Message);
    }

    [SdkFact(PinnedSdk)]
    public async Task InstalledPinnedSdkLoadsTheProjectWithThatSdk()
    {
        var project = Copy();
        var dir = Path.GetDirectoryName(project)!;
        // The pinned SDK restores the project (the same SDK the global.json makes the dotnet CLI use).
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "restore", project, "--nologo" }, dir, TimeSpan.FromMinutes(5), outsideTestHost: true);
        Assert.True(code == 0, output);
        var status = await OpenInHostAsync(project, async (c, s) =>
        {
            var snap = await c.BarrierAsync();
            var program = Path.Combine(dir, "Program.cs");
            var sym = await c.SymbolAtTextAsync(snap, program, "string Describe", 7);
            Assert.Equal("Describe", sym.GetProperty("name").GetString());
        });
        Assert.True(status.GetProperty("state").GetString() == "Ready", status.ToString());
        Assert.True(status.GetProperty("sdk").GetProperty("version").GetString() == PinnedSdk, status.ToString());
        var context = Assert.Single(status.GetProperty("projects").EnumerateArray());
        Assert.Equal("net8.0", context.GetProperty("targetFramework").GetString());
        Assert.Equal("loaded", context.GetProperty("state").GetString());
    }
}
