using System.Text.Json;
using Refyntra.Refactorings;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Generate handler (MediatR): the generated file (interface, Handle placeholder, namespace from folders, namespace style
/// of the project, minimal usings), folder choices (most handlers first), refusals (generic request, existing handler,
/// not a MediatR request), collisions, Compile-membership refusals and revalidation. Copy-based fixture per test.
/// </summary>
public sealed class GenerateHandlerTests
{
    private const string Action = "csharp.generateHandler";

    private static async Task<(TestClient c, string dir)> OpenAsync(Action<string>? beforeOpen = null)
    {
        var path = await Fixtures.CopyAsync("GenerateHandler", "GenerateHandler.sln");
        var dir = Path.GetDirectoryName(path)!;
        beforeOpen?.Invoke(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, dir);
    }

    private static string Requests(string dir) => Path.Combine(dir, "GenerateHandler.Contracts", "Requests", "ThingRequests.cs");
    private static string AppDir(string dir, string folder) => Path.GetFullPath(Path.Combine(dir, "GenerateHandler.App", folder));

    private static async Task<JsonElement> PrepareAsync(TestClient c, string file, string needle, int offset, string? folder = null)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        return await c.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = Action, symbolId = s.GetProperty("symbolId").GetString(), newName = "",
            targetFolderUri = folder != null ? UriPaths.ToUri(folder) : null,
        });
    }

    private static async Task<JsonElement> PreparedAsync(TestClient c, string file, string needle, int offset, string? folder = null)
    {
        var r = await PrepareAsync(c, file, needle, offset, folder);
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan");
    }

    private static JsonElement Created(JsonElement plan, string expectedPath, string expectedText, string eol)
    {
        var writeSet = plan.GetProperty("writeSet").EnumerateArray().ToList();
        var create = Assert.Single(writeSet);
        Assert.Equal("create", create.GetProperty("kind").GetString());
        Assert.Equal(UriPaths.ToUri(expectedPath), create.GetProperty("uri").GetString());
        Assert.Equal(expectedText.Replace("\n", eol), create.GetProperty("text").GetString());
        Assert.Equal(Hashing.Sha256Text(create.GetProperty("text").GetString()!), create.GetProperty("resultHash").GetString());
        Assert.Equal(Action, plan.GetProperty("actionId").GetString());
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.StartsWith("No DI registration is generated"));
        Assert.False(File.Exists(expectedPath), "prepare never writes files");
        return create;
    }

    private static async Task<string> EolOfAsync(string file) => MoveTypeTests.Eol(await File.ReadAllTextAsync(file));

    [Fact]
    public async Task DefaultsToTheFolderWithMostHandlersFileScopedAsInThatProjectWithMinimalUsings()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Requests(dir), "record GetThing", 7);
        var eol = await EolOfAsync(Path.Combine(AppDir(dir, "Handlers"), "HandledHandler.cs"));
        Created(plan, Path.Combine(AppDir(dir, "Handlers"), "GetThingHandler.cs"),
            "using GenerateHandler.Contracts.Dtos;\nusing GenerateHandler.Contracts.Requests;\nusing MediatR;\n\nnamespace GenerateHandler.App.Handlers;\n\npublic sealed class GetThingHandler : IRequestHandler<GetThing, ThingDto>\n{\n    public Task<ThingDto> Handle(GetThing request, CancellationToken cancellationToken)\n    {\n        throw new NotImplementedException();\n    }\n}\n", eol);
        var offer = plan.GetProperty("fileCreate");
        var folders = offer.GetProperty("folderChoices").EnumerateArray().Select(f => (UriPaths.ToPath(f.GetProperty("folderUri").GetString()!), f.GetProperty("handlerCount").GetInt32())).ToList();
        Assert.Equal(new[] { (AppDir(dir, "Handlers"), 2), (AppDir(dir, "Features"), 1), (Path.GetDirectoryName(Requests(dir))!, 0) }, folders);
        Assert.Equal(UriPaths.ToUri(AppDir(dir, "Handlers")), offer.GetProperty("selectedFolderUri").GetString());
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("valid", verdict.GetProperty("status").GetString());
    }

    [Fact]
    public async Task AVoidRequestGetsTheOneArgumentHandlerAndAPickedFolderItsNamespace()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Requests(dir), "record DoThing", 7, AppDir(dir, "Features"));
        var eol = await EolOfAsync(Path.Combine(AppDir(dir, "Features"), "Pong.cs"));
        Created(plan, Path.Combine(AppDir(dir, "Features"), "DoThingHandler.cs"),
            "using GenerateHandler.Contracts.Requests;\nusing MediatR;\n\nnamespace GenerateHandler.App.Features;\n\npublic sealed class DoThingHandler : IRequestHandler<DoThing>\n{\n    public Task Handle(DoThing request, CancellationToken cancellationToken)\n    {\n        throw new NotImplementedException();\n    }\n}\n", eol);
    }

    [Fact]
    public async Task AGenericResponseNeedsItsNamespaces()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Requests(dir), "record ListThings", 7);
        var text = plan.GetProperty("writeSet")[0].GetProperty("text").GetString()!;
        Assert.Contains("IRequestHandler<ListThings, List<ThingDto>>", text);
        Assert.Contains("public Task<List<ThingDto>> Handle(ListThings request", text);
        Assert.DoesNotContain("using System.Collections.Generic;", text); // implicit usings of the App project cover it
    }

    [Fact]
    public async Task AnInternalRequestIsHandledInItsOwnProjectWithBlockNamespacesAndExplicitUsings()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Requests(dir), "record Secret", 7);
        Created(plan, Path.Combine(Path.GetDirectoryName(Requests(dir))!, "SecretHandler.cs"),
            "using MediatR;\nusing System;\nusing System.Threading;\nusing System.Threading.Tasks;\n\nnamespace GenerateHandler.Contracts.Requests\n{\n    internal sealed class SecretHandler : IRequestHandler<Secret, string?>\n    {\n        public Task<string?> Handle(Secret request, CancellationToken cancellationToken)\n        {\n            throw new NotImplementedException();\n        }\n    }\n}\n",
            await EolOfAsync(Requests(dir)));
        Assert.Single(plan.GetProperty("fileCreate").GetProperty("folderChoices").EnumerateArray());
    }

    [Theory]
    [InlineData("record Generic", 7, "GenericRequest")]
    [InlineData("record Handled", 7, "HandlerExists")]
    public async Task RefusedWithTheReasonInActionsAndPrepare(string needle, int offset, string reason)
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var a = await MoveTypeTests.AvailabilityAsync(c, Requests(dir), needle, offset, Action);
        Assert.True(a.HasValue, "shown in Actions with its reason");
        Assert.Equal("unavailable", a!.Value.GetProperty("state").GetString());
        Assert.Equal(reason, a.Value.GetProperty("reasonCode").GetString());
        var r = await PrepareAsync(c, Requests(dir), needle, offset);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task OfferedOnRequestsOnlyNeverOnASameNameInterfaceFromAnotherAssembly()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var imposter = Path.Combine(dir, "GenerateHandler.Contracts", "Fake", "Imposter.cs");
        Assert.Null(await MoveTypeTests.AvailabilityAsync(c, imposter, "class Imposter", 6, Action));
        var dto = Path.Combine(dir, "GenerateHandler.Contracts", "Dtos", "ThingDto.cs");
        Assert.Null(await MoveTypeTests.AvailabilityAsync(c, dto, "record ThingDto", 7, Action));
        var a = await MoveTypeTests.AvailabilityAsync(c, Requests(dir), "record GetThing", 7, Action);
        Assert.Equal("available", a!.Value.GetProperty("state").GetString());
    }

    [Fact]
    public async Task AFolderThatIsNotOfferedIsRefused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var r = await PrepareAsync(c, Requests(dir), "record GetThing", 7, Path.Combine(dir, "GenerateHandler.App"));
        Assert.Equal("UnknownFolder", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task AnExistingFileIgnoringCaseIsACollision()
    {
        var (c, dir) = await OpenAsync(d => File.WriteAllText(Path.Combine(d, "GenerateHandler.App", "Handlers", "getthinghandler.CS"), "// another file\n"));
        await using var _ = c;
        var r = await PrepareAsync(c, Requests(dir), "record GetThing", 7);
        Assert.Equal("TargetExists", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task AnExplicitCompileItemForTheNewNameRefuses()
    {
        var (c, dir) = await OpenAsync(d =>
        {
            var csproj = Path.Combine(d, "GenerateHandler.App", "GenerateHandler.App.csproj");
            File.WriteAllText(csproj, File.ReadAllText(csproj).Replace("</Project>", "<ItemGroup><Compile Remove=\"Handlers\\GetThingHandler.cs\" /></ItemGroup>\n</Project>"));
        });
        await using var _ = c;
        var r = await PrepareAsync(c, Requests(dir), "record GetThing", 7);
        Assert.Equal("ExplicitCompileItem", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task ATargetCreatedAfterThePreviewMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Requests(dir), "record GetThing", 7);
        File.WriteAllText(Path.Combine(AppDir(dir, "Handlers"), "GetThingHandler.cs"), "// raced in\n");
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("stale", verdict.GetProperty("status").GetString());
        Assert.Equal("TargetExists", verdict.GetProperty("reasonCode").GetString());
    }

    [Theory]
    [InlineData("Handlers", "Handlers")]
    [InlineData("2024 Features", "_2024_Features")]
    [InlineData("class", "@class")]
    [InlineData("My-Folder", "My_Folder")]
    public void FolderNamesBecomeIdentifiers(string folder, string expected) => Assert.Equal(expected, GenerateHandlerPlanner.Identifier(folder));
}
