using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Real-code finding (quality corpus, 2026-10): MSBuildWorkspace reports every MSBuild log item, warnings included, as a
/// failure. A NuGet audit advisory ("has a known ... severity vulnerability") made whole solutions Partial, so OR1001
/// abstained with PartialLoad and rename refused with IncompleteProjectClosure. Advisories do not change the compilation.
/// </summary>
public sealed class AdvisoryLoadTests
{
    private static string AdvisorySln => Path.Combine(Fixtures.FixturesDir, "Advisory", "Advisory.sln");

    [Theory]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: Package 'X' 1.0.0 has a known high severity vulnerability, https://example.invalid", true)]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: Warning As Error: Package 'X' 1.0.0 has a known low severity vulnerability, https://example.invalid", true)]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: Package 'X' 1.0.0 is deprecated because it is legacy and is no longer maintained", true)]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: The target framework 'net6.0' is out of support and will not receive security updates in the future.", true)]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: Some other build message", false)]
    [InlineData("Msbuild failed when processing the file 'C:/s/A.csproj' with message: The referenced project 'B.csproj' does not exist.", false)]
    public void Advisories_are_recognised_and_nothing_else(string message, bool advisory) =>
        Assert.Equal(advisory, RestoreDiagnostics.IsAdvisory(message));

    [Fact]
    public async Task A_NuGet_audit_advisory_does_not_make_the_project_partial_but_another_MSBuild_message_does()
    {
        await Fixtures.EnsureRestoredAsync(AdvisorySln);
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(AdvisorySln);
        var projects = status.GetProperty("projects").EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);

        var app = projects["Advisory.App"];
        Assert.Equal("loaded", app.GetProperty("state").GetString());
        var diags = app.GetProperty("diagnostics").EnumerateArray().ToList();
        Assert.Equal(2, diags.Count);
        Assert.All(diags, d => Assert.Equal("warning", d.GetProperty("severity").GetString()));

        // Unknown MSBuild messages stay conservative: MSBuildWorkspace does not say warning or error.
        Assert.Equal("partial", projects["Advisory.Other"].GetProperty("state").GetString());
        Assert.Equal("Partial", status.GetProperty("state").GetString());
    }
}
