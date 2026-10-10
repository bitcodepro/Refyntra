using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>A project whose global.json asks for an SDK that is not installed gets an exact explanation.</summary>
public class SdkMessageTests
{
    [Fact]
    public void MissingFeatureBandNamesTheFileThePolicyAndTheInstalledSdks()
    {
        var (message, recovery) = MsBuildBootstrap.DescribeMissingSdk(@"E:\Repo\global.json", "10.0.401", "latestPatch", new[] { "10.0.300" });
        Assert.Equal(@"E:\Repo\global.json asks for .NET SDK 10.0.401 (rollForward: latestPatch, accepts 10.0.4xx at or above 10.0.401). Installed SDKs: 10.0.300.", message);
        Assert.Contains("Install a .NET SDK that matches (10.0.4xx at or above 10.0.401)", recovery);
        Assert.Contains("https://dotnet.microsoft.com/download/dotnet", recovery);
        Assert.Contains("Restart Backend", recovery);
    }

    [Theory]
    [InlineData("10.0.401", null, "10.0.4xx at or above 10.0.401")] // global.json default policy
    [InlineData("10.0.401", "disable", "exactly 10.0.401")]
    [InlineData("10.0.300", "latestFeature", "10.0.x at or above 10.0.300")]
    [InlineData("8.0.100", "latestMinor", "8.x at or above 8.0.100")]
    [InlineData("8.0.100", "latestMajor", "any version at or above 8.0.100")]
    public void RollForwardPolicies(string requested, string? policy, string accepts)
    {
        var (message, _) = MsBuildBootstrap.DescribeMissingSdk("g.json", requested, policy, Array.Empty<string>());
        Assert.Contains($"accepts {accepts}", message);
        Assert.Contains("none found", message);
    }

    [Fact]
    public void NoGlobalJson()
    {
        var (message, recovery) = MsBuildBootstrap.DescribeMissingSdk(null, null, null, new[] { "9.0.100" });
        Assert.Equal("No .NET SDK was found. Installed SDKs: 9.0.100.", message);
        Assert.Contains("Install a .NET SDK", recovery);
    }
}
