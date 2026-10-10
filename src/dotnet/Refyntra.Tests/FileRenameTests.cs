using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// File rename: renaming the file together with a top-level type. Compile membership proofs, file
/// system guards, the absence precondition on revalidation and the host resync after the client renamed the file.
/// Every test works on its own copy of the Renames fixture; nothing here renames a file except the resync tests.
/// </summary>
public sealed class FileRenameTests
{
    private static async Task<(TestClient c, string dir)> OpenAsync(Action<string>? beforeOpen = null)
    {
        var path = await Fixtures.CopyAsync("Renames", "Renames.sln");
        var dir = Path.GetDirectoryName(path)!;
        beforeOpen?.Invoke(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, dir);
    }

    private static string Lib(string dir, string file) => Path.GetFullPath(Path.Combine(dir, "Renames.Lib", file));

    private static void EditCsproj(string dir, string insert) =>
        File.WriteAllText(Lib(dir, "Renames.Lib.csproj"), File.ReadAllText(Lib(dir, "Renames.Lib.csproj")).Replace("</Project>", insert + "\n</Project>"));

    private static async Task<JsonElement> PrepareAsync(TestClient c, string file, string needle, int offset, string newName, bool renameFile = true)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        var r = await c.RequestAsync("refactor/prepare", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = "csharp.rename", symbolId = s.GetProperty("symbolId").GetString(), newName, renameFile });
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan");
    }

    private static List<JsonElement> Renames(JsonElement plan) =>
        plan.GetProperty("writeSet").EnumerateArray().Where(w => w.GetProperty("kind").GetString() == "rename").ToList();

    private static JsonElement Offer(JsonElement plan) => plan.GetProperty("fileRename");

    private static async Task<JsonElement> RevalidateAsync(TestClient c, JsonElement plan) =>
        await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);

    private static async Task AssertRefusedAsync(string reasonCode, Action<string> setup, string file = "Widget.cs", string needle = "class Widget", int offset = 6, string newName = "Thing")
    {
        var (c, dir) = await OpenAsync(setup);
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, file), needle, offset, newName);
        var offer = Offer(plan);
        Assert.False(offer.GetProperty("available").GetBoolean(), offer.ToString());
        Assert.False(offer.GetProperty("included").GetBoolean());
        Assert.Equal(reasonCode, offer.GetProperty("reasonCode").GetString());
        Assert.Empty(Renames(plan));
        // The text rename is still offered, with the reason as a limitation.
        Assert.All(plan.GetProperty("writeSet").EnumerateArray(), w => Assert.Equal("text", w.GetProperty("kind").GetString()));
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains($"{Path.GetFileName(file)} keeps its name:"));
    }

    // ------------------------------------------------------------------ plan shape

    [Fact]
    public async Task TypeRenameIncludesTheFileRenameAfterEveryTextEditWithAbsencePrecondition()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var before = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("obj")).OrderBy(f => f).ToList();
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing");
        var writeSet = plan.GetProperty("writeSet").EnumerateArray().ToList();
        var rename = Assert.Single(Renames(plan));
        Assert.Equal("rename", writeSet[^1].GetProperty("kind").GetString()); // resource operations come last
        Assert.Equal(UriPaths.ToUri(Lib(dir, "Widget.cs")), rename.GetProperty("oldUri").GetString());
        Assert.Equal(UriPaths.ToUri(Lib(dir, "Thing.cs")), rename.GetProperty("newUri").GetString());
        var text = writeSet.Single(w => w.GetProperty("kind").GetString() == "text" && w.GetProperty("uri").GetString() == rename.GetProperty("oldUri").GetString());
        Assert.Equal(text.GetProperty("resultHash").GetString(), rename.GetProperty("resultHash").GetString());
        var offer = Offer(plan);
        Assert.True(offer.GetProperty("available").GetBoolean());
        Assert.True(offer.GetProperty("included").GetBoolean());
        Assert.Contains(plan.GetProperty("readSet").EnumerateArray(), e => e.GetProperty("input").GetString() == "absent:" + Lib(dir, "Thing.cs") && e.GetProperty("hash").GetString() == "absent");
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Widget.cs is renamed to Thing.cs after the text edits"));
        Assert.DoesNotContain(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString() == "The file name is not changed.");
        Assert.Contains(plan.GetProperty("evidence").EnumerateArray(), e => e.GetProperty("description").GetString()!.Contains("same Compile items"));
        Assert.Equal("valid", (await RevalidateAsync(c, plan)).GetProperty("status").GetString());
        // Prepare and revalidate never write: no file was renamed.
        Assert.Equal(before, Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("obj")).OrderBy(f => f).ToList());
    }

    [Fact]
    public async Task WithoutTheRequestTheOfferIsReportedButNotIncluded()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing", renameFile: false);
        Assert.Empty(Renames(plan));
        Assert.True(Offer(plan).GetProperty("available").GetBoolean());
        Assert.False(Offer(plan).GetProperty("included").GetBoolean());
        Assert.Contains(plan.GetProperty("limitations").EnumerateArray(), l => l.GetString()!.Contains("Widget.cs keeps its name (renaming the file was not requested)"));
    }

    [Fact]
    public async Task PartialTypeRenamesEveryPartFile()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Gadget.Part1.cs"), "class Gadget", 6, "Device");
        var pairs = Renames(plan).Select(r => (Path.GetFileName(UriPaths.ToPath(r.GetProperty("oldUri").GetString()!)), Path.GetFileName(UriPaths.ToPath(r.GetProperty("newUri").GetString()!)))).ToList();
        Assert.Equal(new[] { ("Gadget.Part1.cs", "Device.Part1.cs"), ("Gadget.Part2.cs", "Device.Part2.cs") }, pairs);
    }

    [Fact]
    public async Task MemberAndNestedTypeRenamesHaveNoFileOffer()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "Run(int", 0, "Start");
        Assert.False(plan.TryGetProperty("fileRename", out var _));
        Assert.Empty(Renames(plan));
    }

    // ------------------------------------------------------------------ Compile membership proofs

    [Fact]
    public Task CompileRemovePatternRefuses() => AssertRefusedAsync("CompilePattern", d => EditCsproj(d, "  <ItemGroup><Compile Remove=\"Legacy/**\" /></ItemGroup>"));

    [Fact]
    public Task CompileRemoveOfTheNewNameRefuses() => AssertRefusedAsync("ExplicitCompileItem", d => EditCsproj(d, "  <ItemGroup><Compile Remove=\"Thing.cs\" /></ItemGroup>"));

    [Fact]
    public Task ExplicitCompileItemOfTheFileRefuses() => AssertRefusedAsync("ExplicitCompileItem", d => EditCsproj(d, "  <ItemGroup><Compile Update=\"Widget.cs\" /></ItemGroup>"));

    [Fact]
    public Task DisabledDefaultCompileItemsRefuse() => AssertRefusedAsync("DefaultCompileItemsDisabled", d => EditCsproj(d,
        "  <PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>\n  <ItemGroup><Compile Include=\"Widget.cs;Gadget.Part1.cs;Gadget.Part2.cs\" /></ItemGroup>"));

    [Fact]
    public Task CompilePatternInDirectoryBuildPropsRefuses() => AssertRefusedAsync("CompilePattern", d =>
        File.WriteAllText(Path.Combine(d, "Renames.Lib", "Directory.Build.props"), "<Project>\n  <ItemGroup><Compile Remove=\"**/*.Old.cs\" /></ItemGroup>\n</Project>"));

    [Fact]
    public Task CustomDefaultItemExcludesRefuse() => AssertRefusedAsync("CustomItemExcludes", d => EditCsproj(d, "  <PropertyGroup><DefaultItemExcludes>$(DefaultItemExcludes);Th*.cs</DefaultItemExcludes></PropertyGroup>"));

    [Fact]
    public Task LinkedFileRefuses() => AssertRefusedAsync("LinkedFile", d =>
    {
        Directory.CreateDirectory(Path.Combine(d, "Shared"));
        File.WriteAllText(Path.Combine(d, "Shared", "Gizmo.cs"), "namespace Renames.Lib;\n\npublic sealed class Gizmo\n{\n}\n");
        EditCsproj(d, "  <ItemGroup><Compile Include=\"..\\Shared\\Gizmo.cs\" Link=\"Gizmo.cs\" /></ItemGroup>");
    }, file: "..\\Shared\\Gizmo.cs".Replace('\\', Path.DirectorySeparatorChar), needle: "class Gizmo", newName: "Gear");

    // ------------------------------------------------------------------ file system and content guards

    [Fact]
    public Task CaseOnlyRenameIsRefusedWithAReason() => AssertRefusedAsync("CaseOnlyFileRename", _ => { }, newName: "WIDGET");

    [Fact]
    public Task ExistingTargetIgnoringCaseRefuses() => AssertRefusedAsync("TargetExists", d => File.WriteAllText(Lib(d, "thing.cs"), "// an unrelated file\n"));

    [Fact]
    public Task OtherTopLevelTypeInTheFileRefuses() => AssertRefusedAsync("OtherTypesInFile", d => File.AppendAllText(Lib(d, "Widget.cs"), "\npublic sealed class Extra { }\n"));

    [Fact]
    public Task FileLocalTypeRefuses() => AssertRefusedAsync("FileLocalType", d => File.WriteAllText(Lib(d, "Hidden.cs"), "namespace Renames.Lib;\n\nfile sealed class Hidden\n{\n}\n"), file: "Hidden.cs", needle: "class Hidden", newName: "Secret");

    [Fact]
    public Task ReservedTargetNameRefuses() => AssertRefusedAsync("ReservedFileName", _ => { }, newName: "Con");

    [Fact]
    public Task PartialPartInAFileNotNamedAfterTheTypeRefuses() => AssertRefusedAsync("FileNameDoesNotMatch",
        d => File.WriteAllText(Lib(d, "Extras.cs"), "namespace Renames.Lib;\n\npublic partial class Gadget\n{\n    public int Extra => 1;\n}\n"),
        file: "Gadget.Part1.cs", needle: "class Gadget", newName: "Device");

    // ------------------------------------------------------------------ revalidation (absence precondition)

    [Theory]
    [InlineData("Thing.cs")]
    [InlineData("THING.CS")]
    public async Task TargetCreatedAfterThePreviewMakesThePlanStale(string created)
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing");
        Assert.Single(Renames(plan));
        // Also ignoring case (THING.CS), on every platform.
        await File.WriteAllTextAsync(Lib(dir, created), "// created after the preview\n");
        var r = await RevalidateAsync(c, plan);
        Assert.Equal("stale", r.GetProperty("status").GetString());
    }

    [Fact]
    public async Task TargetFolderCreatedAfterThePreviewIsCaughtByTheAbsencePrecondition()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing");
        Directory.CreateDirectory(Lib(dir, "Thing.cs")); // not a *.cs file: the membership hash does not see it
        var r = await RevalidateAsync(c, plan);
        Assert.Equal("stale", r.GetProperty("status").GetString());
        Assert.Equal("TargetExists", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task ProjectFileChangeAfterThePreviewMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing");
        EditCsproj(dir, "  <ItemGroup><Compile Remove=\"Thing.cs\" /></ItemGroup>");
        Assert.Equal("stale", (await RevalidateAsync(c, plan)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task ReadOnlySourceAfterThePreviewMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PrepareAsync(c, Lib(dir, "Widget.cs"), "class Widget", 6, "Thing");
        File.SetAttributes(Lib(dir, "Widget.cs"), FileAttributes.ReadOnly);
        try
        {
            var r = await RevalidateAsync(c, plan);
            Assert.Equal("stale", r.GetProperty("status").GetString());
            Assert.Equal("FileRenameUnsafe", r.GetProperty("reasonCode").GetString());
        }
        finally
        {
            File.SetAttributes(Lib(dir, "Widget.cs"), FileAttributes.Normal);
        }
    }

    // ------------------------------------------------------------------ host resync after the client renamed the file

    private static Task DidRenameAsync(TestClient c, string oldPath, string newPath) => c.NotifyAsync("workspace/didRenameFiles", new
    {
        workspaceId = c.WorkspaceId,
        sequence = c.NextSequence(),
        workspaceRevision = 1000,
        files = new[] { new { oldUri = UriPaths.ToUri(oldPath), newUri = UriPaths.ToUri(newPath) } },
    });

    private static async Task<string?> DeclarationUriAsync(TestClient c, string needle)
    {
        var snap = await c.BarrierAsync();
        var program = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(needle)!)!, "Renames.App", "Program.cs");
        var s = await c.SymbolAtTextAsync(snap, program, "new W()", 4);
        return s.GetProperty("location").GetProperty("uri").GetString();
    }

    [Theory]
    [InlineData("editor-events-first")]
    [InlineData("rename-first")]
    [InlineData("closed-file")]
    public async Task AfterTheClientRenamedTheFileTheDocumentMovesWithoutReload(string order)
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var oldPath = Lib(dir, "Widget.cs");
        var newPath = Lib(dir, "Thing.cs");
        var dirty = (await File.ReadAllTextAsync(oldPath)).Replace("public void Run(int count) { }", "public void Run(int count) { } // unsaved");
        var stalePlan = await PrepareAsync(c, oldPath, "class Widget", 6, "Thing");
        if (order != "closed-file") await c.DidOpenAsync(oldPath, dirty);
        File.Move(oldPath, newPath);
        switch (order)
        {
            case "editor-events-first":
                await c.DidCloseAsync(oldPath);
                await c.DidOpenAsync(newPath, dirty);
                await DidRenameAsync(c, oldPath, newPath);
                break;
            case "rename-first":
                await DidRenameAsync(c, oldPath, newPath);
                await c.DidCloseAsync(oldPath);
                await c.DidOpenAsync(newPath, dirty);
                break;
            default:
                await DidRenameAsync(c, oldPath, newPath);
                break;
        }
        Assert.Equal(UriPaths.ToUri(newPath), await DeclarationUriAsync(c, newPath));
        var snap = await c.BarrierAsync();
        // The text at the new path is the overlay (dirty buffer kept) or the disk text.
        var s = await c.SymbolAtTextAsync(snap, newPath, "Run(int", 0, order == "closed-file" ? null : dirty);
        Assert.Equal("Run", s.GetProperty("name").GetString());
        // Exactly one document per project for the new path: no duplicate, nothing left at the old path.
        var refs = await c.RequestAsync("code/references", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        Assert.DoesNotContain(refs.GetProperty("locations").EnumerateArray(), l => l.GetProperty("uri").GetString() == UriPaths.ToUri(oldPath));
        // A plan prepared before the rename is stale now.
        Assert.Equal("stale", (await RevalidateAsync(c, stalePlan)).GetProperty("status").GetString());
        // A new rename on the moved document works (and offers renaming Thing.cs).
        var again = await PrepareAsync(c, newPath, "class Widget", 6, "Gear", renameFile: order != "closed-file");
        Assert.Contains(again.GetProperty("writeSet").EnumerateArray(), w => w.GetProperty("kind").GetString() == "text" && w.GetProperty("uri").GetString() == UriPaths.ToUri(newPath));
    }
}
