using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Build.Locator;

namespace Refyntra.Workspaces;

public sealed record SdkInfo(string? Version, string? Path, string? GlobalJsonPath, string? RequestedVersion);

/// <summary>
/// Registers MSBuild through Microsoft.Build.Locator before any Microsoft.Build type can load.
/// Kept in its own non-inlined method so the JIT never pulls MSBuild types into the caller first.
/// </summary>
public static class MsBuildBootstrap
{
    private static readonly object Gate = new();
    private static SdkInfo? _registered;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static SdkInfo EnsureRegistered(string workingDirectory)
    {
        lock (Gate)
        {
            var (globalJson, requested) = FindGlobalJson(workingDirectory);
            if (_registered != null)
                return _registered with { GlobalJsonPath = globalJson, RequestedVersion = requested };
            VisualStudioInstance? instance = null;
            try
            {
                instance = MSBuildLocator.QueryVisualStudioInstances(new VisualStudioInstanceQueryOptions
                {
                    DiscoveryTypes = DiscoveryType.DotNetSdk,
                    WorkingDirectory = workingDirectory,
                }).OrderByDescending(i => i.Version).FirstOrDefault();
            }
            catch (Exception ex)
            {
                Log.Warn("msbuild", "SDK query failed: " + ex.GetType().Name);
            }
            if (instance == null)
            {
                var (message, recovery) = DescribeMissingSdk(globalJson, requested, ReadRollForward(globalJson), InstalledSdks());
                throw new EngineException(ErrorCodes.SdkNotFound, "SdkNotFound", message, recovery);
            }
            if (!MSBuildLocator.IsRegistered && MSBuildLocator.CanRegister)
                MSBuildLocator.RegisterInstance(instance);
            _registered = new SdkInfo(instance.Version?.ToString(), instance.MSBuildPath, globalJson, requested);
            Log.Info("msbuild", $"MSBuild registered: SDK {instance.Version}");
            return _registered;
        }
    }

    /// <summary>
    /// Explains a missing SDK precisely: which global.json asks for what, which versions its rollForward policy accepts,
    /// what is installed, and what to do. Pure, for tests.
    /// </summary>
    public static (string message, string recovery) DescribeMissingSdk(string? globalJson, string? requested, string? rollForward, IReadOnlyList<string> installed)
    {
        var have = installed.Count == 0 ? "none found (is dotnet on PATH?)" : string.Join(", ", installed);
        const string download = "https://dotnet.microsoft.com/download/dotnet";
        if (globalJson == null || requested == null)
            return ($"No .NET SDK was found. Installed SDKs: {have}.",
                $"Install a .NET SDK ({download}), then run Refyntra: Restart Backend.");
        var policy = string.IsNullOrEmpty(rollForward) ? "latestPatch" : rollForward;
        var accepts = Accepts(requested, policy);
        return ($"{globalJson} asks for .NET SDK {requested} (rollForward: {policy}, accepts {accepts}). Installed SDKs: {have}.",
            $"Install a .NET SDK that matches ({accepts}) from {download}, or change the SDK version or rollForward in that global.json; then run Refyntra: Restart Backend.");
    }

    /// <summary>Human description of the versions a global.json rollForward policy accepts for a requested version.</summary>
    public static string Accepts(string requested, string policy)
    {
        var p = requested.Split('.');
        if (p.Length < 3 || !int.TryParse(p[2].Split('-')[0], out var patch)) return $"{requested} or compatible";
        var band = $"{p[0]}.{p[1]}.{patch / 100}xx";
        return policy.ToLowerInvariant() switch
        {
            "disable" => $"exactly {requested}",
            "patch" or "latestpatch" => $"{band} at or above {requested}",
            "feature" or "latestfeature" => $"{p[0]}.{p[1]}.x at or above {requested}",
            "minor" or "latestminor" => $"{p[0]}.x at or above {requested}",
            "major" or "latestmajor" => $"any version at or above {requested}",
            _ => $"{requested} or compatible",
        };
    }

    private static string? ReadRollForward(string? globalJson)
    {
        if (globalJson == null) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(globalJson),
                new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            return doc.RootElement.TryGetProperty("sdk", out var sdk) && sdk.TryGetProperty("rollForward", out var r) ? r.GetString() : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Installed SDK versions from `dotnet --list-sdks` (no shell; empty when dotnet is not found).</summary>
    private static IReadOnlyList<string> InstalledSdks()
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            psi.ArgumentList.Add("--list-sdks");
            // Run outside any project so a global.json cannot make the listing itself fail.
            psi.WorkingDirectory = System.IO.Path.GetTempPath();
            using var p = System.Diagnostics.Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(10_000);
            return output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(l => l.Split(' ')[0]).Where(v => v.Length > 0).ToList();
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    public static (string? path, string? version) FindGlobalJson(string dir)
    {
        var d = new DirectoryInfo(dir);
        while (d != null)
        {
            var f = System.IO.Path.Combine(d.FullName, "global.json");
            if (File.Exists(f))
            {
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(f),
                        new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                    if (doc.RootElement.TryGetProperty("sdk", out var sdk) && sdk.TryGetProperty("version", out var v))
                        return (f, v.GetString());
                }
                catch (JsonException)
                {
                }
                return (f, null);
            }
            d = d.Parent;
        }
        return (null, null);
    }
}
