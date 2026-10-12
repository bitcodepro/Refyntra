using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>workspace/runnableProjects (protocol 1.8) on a copy of the Runnable fixture (loaded with MSBuild).</summary>
public sealed class RunnableFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var sln = await Fixtures.CopyAsync("Runnable", "Runnable.sln");
        Dir = Path.GetDirectoryName(sln)!;
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        var status = await Client.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

public sealed class RunnableProjectTests : IClassFixture<RunnableFixture>
{
    private readonly RunnableFixture _f;

    public RunnableProjectTests(RunnableFixture f) => _f = f;

    private async Task<Dictionary<string, JsonElement>> ProjectsAsync()
    {
        var r = await _f.Client.RequestAsync("workspace/runnableProjects", new { traceId = "t", workspaceId = _f.Client.WorkspaceId });
        Assert.Equal("Ready", r.GetProperty("state").GetString());
        return r.GetProperty("projects").EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);
    }

    private static List<string> Tfms(JsonElement p) => p.GetProperty("targetFrameworks").EnumerateArray().Select(t => t.GetString()!).ToList();

    [Fact]
    public async Task ClassifiesEveryProjectOfTheSolution()
    {
        var all = await ProjectsAsync();
        Assert.Equal(new[] { "AppTests", "ConsoleApp", "Lib", "MultiApp", "WebApp", "WorkerApp" }, all.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("console", all["ConsoleApp"].GetProperty("kind").GetString());
        Assert.Equal("web", all["WebApp"].GetProperty("kind").GetString());
        Assert.Equal("worker", all["WorkerApp"].GetProperty("kind").GetString());
        Assert.Equal("library", all["Lib"].GetProperty("kind").GetString());
        Assert.Equal("test", all["AppTests"].GetProperty("kind").GetString());
        Assert.True(all["ConsoleApp"].GetProperty("runnable").GetBoolean());
        Assert.False(all["Lib"].GetProperty("runnable").GetBoolean());
        Assert.False(all["AppTests"].GetProperty("runnable").GetBoolean());
        Assert.Contains("Test project", all["AppTests"].GetProperty("reason").GetString());
    }

    [Fact]
    public async Task ReportsOutputsAndTheLaunchSettingsOfWebProjects()
    {
        var all = await ProjectsAsync();
        var console = all["ConsoleApp"];
        Assert.Equal(new[] { "net10.0" }, Tfms(console));
        var output = Assert.Single(console.GetProperty("outputs").EnumerateArray());
        Assert.EndsWith("/ConsoleApp.dll", output.GetProperty("outputUri").GetString());
        Assert.Equal("ConsoleApp", console.GetProperty("assemblyName").GetString());
        Assert.False(console.TryGetProperty("launchSettingsUri", out _));
        var web = all["WebApp"];
        Assert.Equal(UriPaths.ToUri(Path.Combine(_f.Dir, "WebApp", "Properties", "launchSettings.json")), web.GetProperty("launchSettingsUri").GetString());
    }

    [Fact]
    public async Task FoldsMultiTargetingIntoOneEntry()
    {
        var multi = (await ProjectsAsync())["MultiApp"];
        Assert.Equal(new[] { "net10.0", "net8.0" }, Tfms(multi).OrderBy(t => t, StringComparer.Ordinal));
        Assert.Equal(2, multi.GetProperty("outputs").GetArrayLength());
        Assert.Equal("console", multi.GetProperty("kind").GetString());
    }
}

/// <summary>The classifier from project files only (desktop, MAUI and Blazor WebAssembly projects need workloads to load).</summary>
public sealed class RunnableClassifierTests
{
    private static RunnableProject Classify(string rel) =>
        RunnableProjectDetector.Classify(RunnableProjectDetector.FromProjectFile(Path.Combine(Fixtures.FixturesDir, "Runnable", rel.Replace('/', Path.DirectorySeparatorChar))));

    [Fact]
    public void WindowsFormsAndWpfAreRunnableOnWindowsOnly()
    {
        var wf = Classify("Desktop/WinFormsApp/WinFormsApp.csproj");
        Assert.Equal(RunnableKinds.WinForms, wf.Kind);
        Assert.True(wf.Runnable);
        Assert.True(wf.WindowsOnly);
        Assert.Equal(new[] { "net10.0-windows" }, wf.TargetFrameworks);
        var wpf = Classify("Desktop/WpfApp/WpfApp.csproj");
        Assert.Equal(RunnableKinds.Wpf, wpf.Kind);
        Assert.True(wpf.WindowsOnly);
    }

    [Fact]
    public void MauiAndBlazorWebAssemblyAreReportedAsUnsupported()
    {
        var maui = Classify("Desktop/MauiApp/MauiApp.csproj");
        Assert.Equal(RunnableKinds.Maui, maui.Kind);
        Assert.False(maui.Runnable);
        Assert.Contains("MAUI", maui.Reason);
        var wasm = Classify("Desktop/BlazorClient/BlazorClient.csproj");
        Assert.Equal(RunnableKinds.BlazorWasm, wasm.Kind);
        Assert.False(wasm.Runnable);
    }

    [Fact]
    public void ProjectFilesAloneGiveKindsAndFrameworks()
    {
        Assert.Equal(RunnableKinds.Console, Classify("ConsoleApp/ConsoleApp.csproj").Kind);
        Assert.Equal(RunnableKinds.Web, Classify("WebApp/WebApp.csproj").Kind);
        Assert.NotNull(Classify("WebApp/WebApp.csproj").LaunchSettingsPath);
        Assert.Equal(RunnableKinds.Worker, Classify("WorkerApp/WorkerApp.csproj").Kind);
        Assert.Equal(RunnableKinds.Library, Classify("Lib/Lib.csproj").Kind);
        Assert.Equal(RunnableKinds.Test, Classify("AppTests/AppTests.csproj").Kind);
        Assert.Equal(new[] { "net8.0", "net10.0" }, Classify("MultiApp/MultiApp.csproj").TargetFrameworks);
    }

    [Fact]
    public void TestPackagesAndEvaluatedOutputKindWin()
    {
        var facts = new ProjectFacts
        {
            ProjectPath = Path.Combine(Path.GetTempPath(), "X", "X.csproj"),
            Name = "X",
            // Microsoft.NET.Test.Sdk makes a test project an Exe; it is still a test project.
            OutputKind = Microsoft.CodeAnalysis.OutputKind.ConsoleApplication,
            Packages = new HashSet<string> { "microsoft.net.test.sdk" },
        };
        Assert.Equal(RunnableKinds.Test, RunnableProjectDetector.Classify(facts).Kind);
        // OutputType from a Directory.Build.props (seen by the evaluation, not in the project file) makes it runnable.
        var exe = facts with { Packages = new HashSet<string>() };
        Assert.Equal(RunnableKinds.Console, RunnableProjectDetector.Classify(exe).Kind);
        var lib = facts with { Packages = new HashSet<string>(), OutputKind = Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary };
        Assert.Equal(RunnableKinds.Library, RunnableProjectDetector.Classify(lib).Kind);
    }
}
