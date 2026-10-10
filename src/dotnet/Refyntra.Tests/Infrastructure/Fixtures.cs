using System.Diagnostics;

namespace Refyntra.Tests.Infrastructure;

/// <summary>Locates and restores the C# fixture solutions under tests/fixtures.</summary>
public static class Fixtures
{
    private static readonly SemaphoreSlim RestoreLock = new(1, 1);
    private static readonly HashSet<string> Restored = new(StringComparer.OrdinalIgnoreCase);

    public static string RepoRoot { get; } = FindRepoRoot();

    public static string FixturesDir => Path.Combine(RepoRoot, "tests", "fixtures");
    public static string ShopSln => Path.Combine(FixturesDir, "Shop", "Shop.sln");
    public static string BrokenSln => Path.Combine(FixturesDir, "Broken", "Broken.sln");

    private static string FindRepoRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "global.json")) && Directory.Exists(Path.Combine(d.FullName, "tests", "fixtures", "Shop")))
                return d.FullName;
        throw new InvalidOperationException("Repository root (global.json + tests/fixtures) not found above " + AppContext.BaseDirectory);
    }

    /// <summary>Runs "dotnet restore" once per solution (skipped when every project already has project.assets.json).</summary>
    public static async Task EnsureRestoredAsync(string sln, bool allowFailure = false)
    {
        await RestoreLock.WaitAsync();
        try
        {
            if (Restored.Contains(sln)) return;
            var dir = Path.GetDirectoryName(sln)!;
            var projects = Directory.EnumerateFiles(dir, "*.csproj", SearchOption.AllDirectories).ToList();
            var upToDate = projects.All(p =>
            {
                var assets = Path.Combine(Path.GetDirectoryName(p)!, "obj", "project.assets.json");
                return File.Exists(assets) && File.GetLastWriteTimeUtc(assets) >= File.GetLastWriteTimeUtc(p);
            });
            if (!upToDate)
            {
                var (code, output) = await RunAsync("dotnet", new[] { "restore", sln, "--nologo" }, dir, TimeSpan.FromMinutes(5));
                if (code != 0 && !allowFailure)
                    throw new InvalidOperationException($"dotnet restore {Path.GetFileName(sln)} failed ({code}):\n{output}");
            }
            Restored.Add(sln);
        }
        finally
        {
            RestoreLock.Release();
        }
    }

    /// <summary>Copies a fixture (with the shielding Directory.* files) into a fresh work directory and restores it.</summary>
    public static async Task<string> CopyAsync(string fixtureName, string slnFile)
    {
        var work = Path.Combine(AppContext.BaseDirectory, "work", Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(work);
        foreach (var f in Directory.EnumerateFiles(FixturesDir, "Directory.*"))
            File.Copy(f, Path.Combine(work, Path.GetFileName(f)));
        CopyDir(Path.Combine(FixturesDir, fixtureName), Path.Combine(work, fixtureName));
        var sln = Path.Combine(work, fixtureName, slnFile);
        await EnsureRestoredAsync(sln);
        return sln;
    }

    private static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.EnumerateFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.EnumerateDirectories(from))
        {
            var name = Path.GetFileName(d);
            if (name is "bin" or "obj") continue;
            CopyDir(d, Path.Combine(to, name));
        }
    }

    /// <summary>
    /// Runs a tool and returns its exit code and output. Bounded: a timeout kills the process tree and throws
    /// TimeoutException; once the process has exited, the output is read for at most a few seconds more, because a
    /// grandchild that inherited the pipes (MSBuild worker nodes, build servers) can keep them open for a long time.
    /// MSBuild node reuse and the MSBuild server are disabled for these tool runs for the same reason.
    /// </summary>
    public static async Task<(int code, string output)> RunAsync(string exe, string[] args, string cwd, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        psi.Environment["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0";
        using var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        // Process exit itself, not end-of-output: WaitForExitAsync would also wait for the pipes to close.
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        p.Exited += (_, _) => exited.TrySetResult();
        p.Start();
        var stdout = new System.Text.StringBuilder();
        var stderr = new System.Text.StringBuilder();
        p.OutputDataReceived += (_, e) => { if (e.Data != null) lock (stdout) stdout.AppendLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (stderr) stderr.AppendLine(e.Data); };
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            await exited.Task.WaitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw new TimeoutException($"{Path.GetFileName(exe)} {string.Join(' ', args)} did not finish within {timeout}");
        }
        // The process has exited; give the asynchronous readers a short, bounded time to drain what it wrote.
        await Task.Delay(200);
        string Text(System.Text.StringBuilder sb) { lock (sb) return sb.ToString(); }
        return (p.ExitCode, Text(stdout) + Text(stderr));
    }

    public static string HostDll()
    {
        // Same configuration as the running tests: .../Refyntra.Tests/bin/<Configuration>/net10.0/
        var tfmDir = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
        var configuration = tfmDir.Parent!.Name;
        var dll = Path.Combine(RepoRoot, "src", "dotnet", "Refyntra.Host", "bin", configuration, tfmDir.Name, "Refyntra.Host.dll");
        if (!File.Exists(dll)) throw new FileNotFoundException("Build Refyntra.Host first", dll);
        return dll;
    }
}
