using System.Diagnostics;

namespace Refyntra.Tests.Infrastructure;

/// <summary>
/// Fixtures.RunAsync must return when the started process exits, even if a grandchild it left behind keeps the
/// inherited stdout/stderr pipes open (MSBuild worker nodes and build servers started by `dotnet restore` do that).
/// Before the fix the output reads had no bound and a whole test run hung at 0 % CPU.
/// </summary>
public sealed class FixturesRunTests
{
    [Fact]
    public async Task ReturnsWhenTheProcessExitsAlthoughAGrandchildHoldsItsOutputPipe()
    {
        var (exe, args) = OperatingSystem.IsWindows()
            ? ("cmd.exe", new[] { "/c", "echo started & start /b ping -n 60 127.0.0.1 >nul" })
            : ("/bin/sh", new[] { "-c", "echo started; sleep 60 &" });
        var sw = Stopwatch.StartNew();
        var (code, output) = await Fixtures.RunAsync(exe, args, Path.GetTempPath(), TimeSpan.FromSeconds(30));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(20), $"RunAsync took {sw.Elapsed}");
        Assert.Equal(0, code);
        Assert.Contains("started", output);
    }

    [Fact]
    public async Task ATimeoutKillsTheProcessTreeAndThrows()
    {
        var (exe, args) = OperatingSystem.IsWindows() ? ("ping.exe", new[] { "-n", "60", "127.0.0.1" }) : ("/bin/sleep", new[] { "60" });
        var sw = Stopwatch.StartNew();
        await Assert.ThrowsAsync<TimeoutException>(() => Fixtures.RunAsync(exe, args, Path.GetTempPath(), TimeSpan.FromSeconds(2)));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(20), $"RunAsync took {sw.Elapsed}");
    }
}
