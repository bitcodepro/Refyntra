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
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(timeout);
        await p.WaitForExitAsync(cts.Token);
        return (p.ExitCode, await stdout + await stderr);
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
