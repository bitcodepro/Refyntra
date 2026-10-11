using System.Text.Json;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>
/// Safe Delete: deletes only what nothing else uses (types with their file, members, fields of a multi-variable
/// declaration, locals, parameters with their call-site arguments), cascades interface/virtual members to their
/// implementations, deletes every partial declaration, refuses implementations/overrides, remaining uses and side
/// effects, and makes the plan limited for framework relations and string uses the compiler cannot see.
/// </summary>
public sealed class SafeDeleteTests
{
    private const string Action = "csharp.safeDelete";

    [Fact]
    public async Task UnusedTypeAloneInItsFileDeletesTheFile()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Unused.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "class UnusedType", 6));
        Assert.Equal(new[] { "delete" }, Kinds(plan));
        Assert.Equal(Action, plan.GetProperty("actionId").GetString());
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        var delete = plan.GetProperty("writeSet")[0];
        Assert.Equal(UriPaths.ToUri(file), delete.GetProperty("uri").GetString());
        Assert.Equal(64, delete.GetProperty("expectedHash").GetString()!.Length);
        Assert.Equal(UriPaths.ToUri(file), plan.GetProperty("fileDelete").GetProperty("files")[0].GetString());
        Assert.Contains("deleted after the text edits", Limitations(plan));

        // Revalidation holds while nothing changed; after the delete, the host drops the document (didDeleteFiles).
        Assert.Equal("valid", (await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!)).GetProperty("status").GetString());
        await ApplyToDiskAsync(c, plan);
        var snap = await c.BarrierAsync();
        var search = await c.RequestAsync("code/search", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, query = "UnusedType", limit = 10 });
        Assert.DoesNotContain(search.GetProperty("items").EnumerateArray(), i => i.GetProperty("symbol").ValueKind == JsonValueKind.Object && i.GetProperty("symbol").GetProperty("name").GetString() == "UnusedType");
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task UnusedMethodIsRemovedWithItsDocumentation()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "void UnusedMethod", 5));
        Assert.Equal(new[] { "text" }, Kinds(plan));
        var after = After(plan, file);
        Assert.DoesNotContain("UnusedMethod", after);
        Assert.DoesNotContain("Nothing calls this method", after);
        Assert.Contains("public void UsedMethod()", after);
        Assert.Equal("Safe delete method UnusedMethod", plan.GetProperty("title").GetString());
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task UsedMemberIsRefusedWithItsUsesAcrossProjects()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var r = await PrepareAtAsync(c, Action, Lib(dir, "SafeDelete/Members.cs"), "void UsedMethod", 5);
        Unavailable(r, "ReferencesRemain");
        var message = r.GetProperty("message").GetString()!;
        Assert.Contains("Members.cs:", message);
        Assert.Contains("Program.cs:", message);
        Assert.Contains("2 place(s)", message);
    }

    [Fact]
    public async Task SelfReferencesDoNotCountAsUses()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "int Recursive", 4));
        Assert.DoesNotContain("Recursive", After(plan, file));
    }

    [Fact]
    public async Task OneFieldOfAMultiVariableDeclarationIsRemoved()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "_unusedField"));
        var after = After(plan, file);
        Assert.DoesNotContain("_unusedField", after);
        Assert.Contains("private int _usedField = 2;", after);
    }

    [Fact]
    public async Task LocalsAreDeletedOnlyWithoutSideEffects()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "unusedLocal"));
        Assert.DoesNotContain("unusedLocal", After(plan, file));
        Unavailable(await PrepareAtAsync(c, Action, file, "sideEffect"), "InitializerHasSideEffects");
    }

    [Fact]
    public async Task UnusedParameterIsRemovedWithItsArguments()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "int unusedParam", 4));
        var after = After(plan, file);
        Assert.Contains("public void WithParam(int keep)", after);
        Assert.Contains("WithParam(1);", after);
        Assert.Contains("WithParam(keep: 3);", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task ParameterRefusals()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var effect = await PrepareAtAsync(c, Action, file, "int drop", 4);
        Unavailable(effect, "ArgumentHasSideEffects");
        Assert.Contains("Compute()", effect.GetProperty("message").GetString());
        Unavailable(await PrepareAtAsync(c, Action, file, "int b)", 4), "ReferencesRemain");
    }

    [Fact]
    public async Task InterfaceMemberIsDeletedWithItsImplementations()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Shapes.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "string Describe", 7));
        var after = After(plan, file);
        Assert.DoesNotContain("Describe", after);
        Assert.Contains("public double Area() => 3;", after);
        Assert.Contains(plan.GetProperty("evidence").EnumerateArray(), e => e.GetProperty("description").GetString()!.Contains("Circle.Describe"));
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task ImplementationsAndOverridesAreRefused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Shapes.cs");
        var impl = await PrepareAtAsync(c, Action, file, "double Area() => 3", 7);
        Unavailable(impl, "ImplementsMember");
        Assert.Contains("IShape.Area", impl.GetProperty("message").GetString());
        Unavailable(await PrepareAtAsync(c, Action, file, "override string Sound", 16), "ImplementsMember");
        // The interface member itself is still used.
        Unavailable(await PrepareAtAsync(c, Action, file, "double Area();", 7), "ReferencesRemain");
    }

    [Fact]
    public async Task PartialTypeDeletesEveryPartAndEmptyFiles()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var a = Lib(dir, "SafeDelete/PartialA.cs");
        var b = Lib(dir, "SafeDelete/PartialB.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, a, "class PartialThing", 6));
        Assert.Equal(new[] { "text", "delete" }, Kinds(plan));
        Assert.Equal(UriPaths.ToUri(a), plan.GetProperty("writeSet")[1].GetProperty("uri").GetString());
        var afterB = After(plan, b);
        Assert.DoesNotContain("PartialThing", afterB);
        Assert.Contains("class Neighbour", afterB);
        await ApplyToDiskAsync(c, plan);
        Assert.False(File.Exists(a));
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task FrameworkRelationsMakeThePlanLimited()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = Prepared(await PrepareAtAsync(c, Action, Lib(dir, "SafeDelete/PingHandler.cs"), "class PingHandler", 6));
        Assert.Equal("limited", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Contains("Framework relation (mediatr.", Limitations(plan));
        Assert.Equal(new[] { "delete" }, Kinds(plan));
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("limited", verdict.GetProperty("status").GetString());
    }

    [Fact]
    public async Task StringUsesMakeThePlanLimited()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = Prepared(await PrepareAtAsync(c, Action, Lib(dir, "SafeDelete/Members.cs"), "void ReflectedMethod", 5));
        Assert.Equal("limited", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Contains("string \"ReflectedMethod\" in Members.cs", Limitations(plan));
    }

    [Fact]
    public async Task EditAfterPrepareMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "void UnusedMethod", 5));
        await c.DidOpenAsync(file, File.ReadAllText(file) + "\n// edited\n");
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("stale", verdict.GetProperty("status").GetString());
    }

    [Fact]
    public async Task DeletedFileThatChangedOnDiskMakesThePlanStale()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Unused.cs");
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "class UnusedType", 6));
        File.Delete(file);
        var verdict = await c.RevalidateAsync(await c.BarrierAsync(), plan.GetProperty("planId").GetString()!);
        Assert.Equal("stale", verdict.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ActionsOfferSafeDeleteAndChangeSignature()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "SafeDelete/Members.cs");
        var del = await MoveTypeTests.AvailabilityAsync(c, file, "void UnusedMethod", 5, Action);
        Assert.Equal("available", del!.Value.GetProperty("state").GetString());
        var sig = await MoveTypeTests.AvailabilityAsync(c, file, "void UnusedMethod", 5, "csharp.changeSignature");
        Assert.Equal("available", sig!.Value.GetProperty("state").GetString());
        var impl = await MoveTypeTests.AvailabilityAsync(c, Lib(dir, "SafeDelete/Shapes.cs"), "double Area() => 3", 7, Action);
        Assert.Equal("unavailable", impl!.Value.GetProperty("state").GetString());
        Assert.Equal("ImplementsMember", impl.Value.GetProperty("reasonCode").GetString());
        var extract = await MoveTypeTests.AvailabilityAsync(c, file, "Console.WriteLine(\"unused\")", 0, "csharp.extractMethod");
        Assert.Equal("available", extract!.Value.GetProperty("state").GetString());
        Assert.Null(await MoveTypeTests.AvailabilityAsync(c, file, "public class Members", 0, "csharp.extractMethod"));
    }
}
