using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Move Type to File: the new file (namespace style, usings the moved code needs, banner, comments, attributes), the
/// removal from the original file, refusals (partial, file-local, generated, directives, nested, layout, meaning),
/// collisions, Compile-membership refusals, revalidation and the host resync after the client created the file.
/// Every test works on its own copy of the MoveType fixture; nothing here writes a file except the test setup.
/// </summary>
public sealed class MoveTypeTests
{
    private const string Action = "csharp.moveTypeToFile";

    private static async Task<(TestClient c, string dir)> OpenAsync(Action<string>? beforeOpen = null)
    {
        var path = await Fixtures.CopyAsync("MoveType", "MoveType.sln");
        var dir = Path.GetDirectoryName(path)!;
        beforeOpen?.Invoke(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, dir);
    }

    private static string Lib(string dir, string rel) => Path.GetFullPath(Path.Combine(dir, "MoveType.Lib", rel.Replace('/', Path.DirectorySeparatorChar)));

    internal static string Eol(string text) => text.Contains("\r\n") ? "\r\n" : "\n";

    private static async Task<JsonElement> PrepareAsync(TestClient c, string file, string needle, int offset)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        return await c.RequestAsync("refactor/prepare", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = Action, symbolId = s.GetProperty("symbolId").GetString(), newName = "", documentUri = UriPaths.ToUri(file) });
    }

    private static async Task<JsonElement> PreparedAsync(TestClient c, string file, string needle, int offset)
    {
        var r = await PrepareAsync(c, file, needle, offset);
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan");
    }

    internal static async Task<JsonElement?> AvailabilityAsync(TestClient c, string file, string needle, int offset, string capability)
    {
        var snap = await c.BarrierAsync();
        var (line, ch) = TestClient.Position(await File.ReadAllTextAsync(file), needle, offset);
        var list = await c.RequestAsync("capability/query", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file), position = new { line, character = ch } });
        foreach (var a in list.EnumerateArray())
            if (a.GetProperty("capabilityId").GetString() == capability) return a;
        return null;
    }

    /// <summary>Applies the plan's text edits (sorted, non-overlapping) to <paramref name="text"/>.</summary>
    internal static string ApplyEdits(string text, JsonElement change)
    {
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Offset(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        var edits = change.GetProperty("edits").EnumerateArray().ToList();
        for (var i = edits.Count - 1; i >= 0; i--)
        {
            var range = edits[i].GetProperty("range");
            var s = Offset(range.GetProperty("start"));
            var e = Offset(range.GetProperty("end"));
            text = text.Substring(0, s) + edits[i].GetProperty("newText").GetString() + text.Substring(e);
        }
        return text;
    }

    private static (JsonElement create, JsonElement text) Shape(JsonElement plan)
    {
        var writeSet = plan.GetProperty("writeSet").EnumerateArray().ToList();
        Assert.Equal(2, writeSet.Count);
        Assert.Equal("create", writeSet[0].GetProperty("kind").GetString()); // the create comes first
        Assert.Equal("text", writeSet[1].GetProperty("kind").GetString());
        Assert.Equal(Action, plan.GetProperty("actionId").GetString());
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        var create = writeSet[0];
        Assert.Equal(Hashing.Sha256Text(create.GetProperty("text").GetString()!), create.GetProperty("resultHash").GetString());
        Assert.Contains(plan.GetProperty("readSet").EnumerateArray(), r => r.GetProperty("input").GetString() == "absent:" + UriPaths.ToPath(create.GetProperty("uri").GetString()!));
        Assert.Equal(create.GetProperty("uri").GetString(), plan.GetProperty("fileCreate").GetProperty("files")[0].GetString());
        return (create, writeSet[1]);
    }

    private static async Task AssertMovedAsync(string dir, JsonElement plan, string source, string newFile, string expectedNew, string expectedOld)
    {
        var (create, text) = Shape(plan);
        var original = await File.ReadAllTextAsync(source);
        var eol = Eol(original);
        Assert.Equal(UriPaths.ToUri(newFile), create.GetProperty("uri").GetString());
        Assert.Equal(expectedNew.Replace("\n", eol), create.GetProperty("text").GetString());
        Assert.Equal(UriPaths.ToUri(source), text.GetProperty("uri").GetString());
        Assert.Equal(Hashing.Sha256Text(original), text.GetProperty("expectedHash").GetString());
        var result = ApplyEdits(original, text);
        Assert.Equal(expectedOld.Replace("\n", eol), result);
        Assert.Equal(Hashing.Sha256Text(result), text.GetProperty("resultHash").GetString());
        Assert.False(File.Exists(newFile), "prepare never writes files");
    }

    // ------------------------------------------------------------------ the moved file

    [Fact]
    public async Task FileScopedTypeMovesWithBannerCommentsAttributesAndOnlyTheUsingsItNeeds()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Geometry/Shapes.cs");
        var plan = await PreparedAsync(c, source, "class Circle", 6);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "Geometry/Circle.cs"),
            "// Fixture banner: shapes for the Move Type to File tests.\n\nusing System;\nusing System.Text;\nusing static System.Math;\n\nnamespace MoveType.Lib.Geometry;\n\n/// <summary>A circle.</summary>\n[Serializable]\npublic sealed class Circle\n{\n    // radius in units\n    public double Radius { get; init; }\n\n    public double Area() => PI * Pow(Radius, 2);\n\n    public string Describe() => new StringBuilder().Append(\"circle \").Append(Radius).ToString();\n}\n",
            "// Fixture banner: shapes for the Move Type to File tests.\n\nusing System;\nusing System.Collections.Generic;\nusing System.Text;\nusing static System.Math;\n\nnamespace MoveType.Lib.Geometry;\n\npublic sealed class Square\n{\n    public List<int> Sides { get; } = new() { 1, 1, 1, 1 };\n}\n\ninternal enum Kind\n{\n    Round,\n    Angular,\n}\n");
        Assert.Contains(plan.GetProperty("evidence").EnumerateArray(), e => e.GetProperty("description").GetString()!.Contains("3 of 4 using(s) kept"));
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("valid", verdict.GetProperty("status").GetString());
    }

    [Fact]
    public async Task LastTypeMovesWithoutUsingsAndTheSeparatingBlankLineGoes()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Geometry/Shapes.cs");
        var plan = await PreparedAsync(c, source, "enum Kind", 5);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "Geometry/Kind.cs"),
            "// Fixture banner: shapes for the Move Type to File tests.\n\nnamespace MoveType.Lib.Geometry;\n\ninternal enum Kind\n{\n    Round,\n    Angular,\n}\n",
            "// Fixture banner: shapes for the Move Type to File tests.\n\nusing System;\nusing System.Collections.Generic;\nusing System.Text;\nusing static System.Math;\n\nnamespace MoveType.Lib.Geometry;\n\n/// <summary>A circle.</summary>\n[Serializable]\npublic sealed class Circle\n{\n    // radius in units\n    public double Radius { get; init; }\n\n    public double Area() => PI * Pow(Radius, 2);\n\n    public string Describe() => new StringBuilder().Append(\"circle \").Append(Radius).ToString();\n}\n\npublic sealed class Square\n{\n    public List<int> Sides { get; } = new() { 1, 1, 1, 1 };\n}\n");
    }

    [Fact]
    public async Task BlockNamespaceTypeKeepsTheNamespaceLevelUsingItNeedsAndDropsTheOthers()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Blocks/Blocks.cs");
        var plan = await PreparedAsync(c, source, "class Alpha", 6);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "Blocks/Alpha.cs"),
            "namespace MoveType.Lib.Blocks\n{\n    using System.Text;\n\n    public class Alpha\n    {\n        public string Name() => new StringBuilder(\"alpha\").ToString();\n    }\n}\n",
            "using System;\n\nnamespace MoveType.Lib.Blocks\n{\n    using System.Text;\n\n    public class Beta\n    {\n        public Guid Id { get; } = Guid.NewGuid();\n    }\n}\n");
    }

    [Fact]
    public async Task BlockNamespaceLastTypeKeepsTheTopLevelUsingItNeeds()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Blocks/Blocks.cs");
        var plan = await PreparedAsync(c, source, "class Beta", 6);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "Blocks/Beta.cs"),
            "using System;\n\nnamespace MoveType.Lib.Blocks\n{\n    public class Beta\n    {\n        public Guid Id { get; } = Guid.NewGuid();\n    }\n}\n",
            "using System;\n\nnamespace MoveType.Lib.Blocks\n{\n    using System.Text;\n\n    public class Alpha\n    {\n        public string Name() => new StringBuilder(\"alpha\").ToString();\n    }\n}\n");
    }

    [Fact]
    public async Task GlobalNamespaceTypeMovesWithoutANamespace()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Global.cs");
        var plan = await PreparedAsync(c, source, "class GlobalTwo", 6);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "GlobalTwo.cs"),
            "public class GlobalTwo\n{\n    public GlobalOne One { get; } = new();\n}\n",
            "public class GlobalOne\n{\n}\n");
    }

    [Fact]
    public async Task ARegionAroundAnotherTypeStaysAndTheTypeMoves()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Regions.cs");
        var plan = await PreparedAsync(c, source, "class AfterRegion", 6);
        await AssertMovedAsync(dir, plan, source, Lib(dir, "AfterRegion.cs"),
            "namespace MoveType.Lib;\n\npublic sealed class AfterRegion\n{\n}\n",
            "namespace MoveType.Lib;\n\n#region Types\npublic sealed class InRegion\n{\n}\n#endregion\n");
    }

    // ------------------------------------------------------------------ refusals

    [Theory]
    [InlineData("Partials.cs", "class PartOne", 6, "PartialType")]
    [InlineData("Locals.cs", "class Hidden", 6, "FileLocalType")]
    [InlineData("Generated/Auto.g.cs", "class AutoOne", 6, "GeneratedCode")]
    [InlineData("Conditional.cs", "class Always", 6, "PreprocessorDirectives")]
    [InlineData("Layout.cs", "class SameLine", 6, "UnsupportedLayout")]
    public async Task RefusedWithTheReasonInActionsAndPrepare(string file, string needle, int offset, string reason)
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var a = await AvailabilityAsync(c, Lib(dir, file), needle, offset, Action);
        Assert.True(a.HasValue, "shown in Actions with its reason");
        Assert.Equal("unavailable", a!.Value.GetProperty("state").GetString());
        Assert.Equal(reason, a.Value.GetProperty("reasonCode").GetString());
        var r = await PrepareAsync(c, Lib(dir, file), needle, offset);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task ATypeThatNeedsTheRestOfItsFileIsRefusedBecauseItsMeaningWouldChange()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var r = await PrepareAsync(c, Lib(dir, "Locals.cs"), "class UsesHidden", 6);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("MeaningChanges", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task NestedTypesAreNotOfferedTheirTopLevelSiblingIs()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        Assert.Null(await AvailabilityAsync(c, Lib(dir, "Nested.cs"), "class Inner", 6, Action));
        var available = await AvailabilityAsync(c, Lib(dir, "Nested.cs"), "class Sibling", 6, Action);
        Assert.Equal("available", available!.Value.GetProperty("state").GetString());
    }

    [Fact]
    public async Task NotOfferedAwayFromTheDeclarationOrForATypeAloneInItsFile()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        Assert.Null(await AvailabilityAsync(c, Path.Combine(dir, "MoveType.App", "Uses.cs"), "new Circle", 4, Action));
        Assert.Null(await AvailabilityAsync(c, Lib(dir, "PartOne.Extra.cs"), "class PartOne", 6, Action));
    }

    [Fact]
    public async Task ATargetThatExistsIgnoringCaseIsACollision()
    {
        var (c, dir) = await OpenAsync(d => File.WriteAllText(Path.Combine(d, "MoveType.Lib", "Geometry", "CIRCLE.cs"), "// another file\n"));
        await using var _ = c;
        var r = await PrepareAsync(c, Lib(dir, "Geometry/Shapes.cs"), "class Circle", 6);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("TargetExists", r.GetProperty("reasonCode").GetString());
    }

    [Theory]
    [InlineData("<ItemGroup><Compile Remove=\"Geometry\\Circle.cs\" /></ItemGroup>", "ExplicitCompileItem")]
    [InlineData("<ItemGroup><Compile Update=\"Geometry\\*.cs\" /></ItemGroup>", "CompilePattern")]
    [InlineData("<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include=\"**\\*.cs\" Exclude=\"bin\\**;obj\\**\" /></ItemGroup>", "DefaultCompileItemsDisabled")]
    [InlineData("<PropertyGroup><DefaultItemExcludes>$(DefaultItemExcludes);Geometry\\C*.cs</DefaultItemExcludes></PropertyGroup>", "CustomItemExcludes")]
    public async Task UnprovenCompileMembershipRefuses(string insert, string reason)
    {
        var (c, dir) = await OpenAsync(d =>
        {
            var csproj = Path.Combine(d, "MoveType.Lib", "MoveType.Lib.csproj");
            File.WriteAllText(csproj, File.ReadAllText(csproj).Replace("</Project>", insert + "\n</Project>"));
        });
        await using var _ = c;
        var r = await PrepareAsync(c, Lib(dir, "Geometry/Shapes.cs"), "class Circle", 6);
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
        Assert.Contains("the file is not created", r.GetProperty("message").GetString(), StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------ revalidation and resync

    [Fact]
    public async Task ATargetCreatedAfterThePreviewMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, Lib(dir, "Geometry/Shapes.cs"), "class Circle", 6);
        File.WriteAllText(Lib(dir, "Geometry/circle.cs"), "// raced in\n");
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("stale", verdict.GetProperty("status").GetString());
        Assert.Equal("TargetExists", verdict.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task AfterTheClientCreatedTheFileTheHostSeesTheTypeThereWithoutReload()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var source = Lib(dir, "Geometry/Shapes.cs");
        var newFile = Lib(dir, "Geometry/Circle.cs");
        var plan = await PreparedAsync(c, source, "class Circle", 6);
        var (create, text) = Shape(plan);
        var epoch = c.Engine!.Epoch;
        // What the extension does on apply: create the file, edit the original (open, unsaved), then didCreateFiles.
        await File.WriteAllTextAsync(newFile, create.GetProperty("text").GetString()!);
        await c.DidOpenAsync(source, ApplyEdits(await File.ReadAllTextAsync(source), text));
        await c.NotifyAsync("workspace/didCreateFiles", new { workspaceId = c.WorkspaceId, sequence = c.NextSequence(), workspaceRevision = 1000, files = new[] { new { uri = UriPaths.ToUri(newFile) } } });
        var snap = await c.BarrierAsync();
        var uses = Path.Combine(dir, "MoveType.App", "Uses.cs");
        var s = await c.SymbolAtTextAsync(snap, uses, "new Circle", 4);
        Assert.Equal(UriPaths.ToUri(newFile), s.GetProperty("location").GetProperty("uri").GetString());
        Assert.Equal(epoch, c.Engine!.Epoch);
        // The host compiles the moved state without new errors: Rename of Circle still passes its compilation delta.
        var rename = await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "Ring");
        Assert.Equal("prepared", rename.GetProperty("kind").GetString());
    }
}
