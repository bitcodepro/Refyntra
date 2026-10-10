using System.Text.Json;
using Refyntra.Host;
using Refyntra.Host.Protocol;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>The structured load cause reaches the client (Health groups projects by it); raw MSBuild messages carry none.</summary>
public sealed class LoadCauseTests
{
    [Fact]
    public void Cause_is_serialized_and_omitted_when_absent()
    {
        var dtos = Mapper.Diagnostics(new[]
        {
            new LoadDiagnosticModel("error", "project.assets.json is missing", "C:/s/App/App.csproj", RestoreRecommended: true, Cause: LoadCauses.MissingAssets),
            new LoadDiagnosticModel("error", "Msbuild failed when processing the file", "C:/s/App/App.csproj"),
        }, "C:/s/S.sln");
        var json = JsonDocument.Parse(JsonSerializer.Serialize(dtos, Json.Options)).RootElement;
        Assert.Equal("missingAssets", json[0].GetProperty("cause").GetString());
        Assert.Equal("refyntra.runRestore", json[0].GetProperty("recoveryActions")[0].GetProperty("command").GetString());
        Assert.False(json[1].TryGetProperty("cause", out _));
    }
}
