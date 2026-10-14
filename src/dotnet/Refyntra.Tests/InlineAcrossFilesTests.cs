using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>
/// Inline Method across files: the edit action is refused with CrossFile, the plan (refactor/prepare csharp.inlineMethod /
/// csharp.inlineMethodAll) rewrites the calls in every file and project (EditActions/InlineAcross.cs, InlineAcrossCallers.cs
/// and the App project of the Refactorings fixture).
/// </summary>
public sealed class InlineAcrossFilesTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public InlineAcrossFilesTests(EditActionsFixture f) => _f = f;

    private string Decl => Lib(_f.Dir, "EditActions/InlineAcross.cs");
    private string Callers => Lib(_f.Dir, "EditActions/InlineAcrossCallers.cs");
    private string Program => App(_f.Dir, "Program.cs");

    private static async Task<object> PosAsync(string file, string needle, int offset)
    {
        var text = await File.ReadAllTextAsync(file);
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var o = at + offset;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var pos = new { line, character = o - ls };
        return new { start = pos, end = pos };
    }

    private async Task<JsonElement> EditAsync(string file, string needle, int offset, string actionId)
    {
        var range = await PosAsync(file, needle, offset);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/editActions", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file), range, actionId });
    }

    private async Task<JsonElement> PlanAsync(string file, string needle, int offset, string actionId)
    {
        var range = await PosAsync(file, needle, offset);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, actionId, symbolId = "", newName = "",
            documentUri = UriPaths.ToUri(file), range,
        });
    }

    [Fact]
    public async Task TheEditActionIsRefusedWithCrossFile()
    {
        var r = await EditAsync(Callers, "Pricing.WithTax(a)", 8, "csharp.edit.inlineMethod");
        Assert.Equal("CrossFile", r.GetProperty("reasonCode").GetString());
        r = await EditAsync(Decl, "WithTax(decimal net)", 0, "csharp.edit.inlineMethodAll");
        Assert.Equal("CrossFile", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task OneCallSiteInAnotherFileIsInlinedAndTheDeclarationStays()
    {
        var plan = Prepared(await PlanAsync(Callers, "Pricing.Doubled(a)", 8, "csharp.inlineMethod"));
        Assert.Contains("public static decimal Twice(decimal a) => a * 2;", After(plan, Callers).Replace("\r\n", "\n"));
        Assert.Contains("public static decimal Doubled(decimal x) => x * 2;", After(plan, Decl));
    }

    [Fact]
    public async Task AllCallSitesInEveryFileAndProjectAreInlinedAndTheDeclarationIsRemoved()
    {
        var plan = Prepared(await PlanAsync(Decl, "WithTax(decimal net)", 0, "csharp.inlineMethodAll"));
        Assert.Equal("csharp.inlineMethodAll", plan.GetProperty("actionId").GetString());
        var callers = After(plan, Callers).Replace("\r\n", "\n");
        Assert.Contains("a * (1 + Pricing.Rate) + b * (1 + Pricing.Rate)", callers);
        Assert.Contains("Console.WriteLine(10m * (1 + Refactorings.Lib.EditActions.Pricing.Rate));", After(plan, Program).Replace("\r\n", "\n"));
        var decl = After(plan, Decl);
        Assert.DoesNotContain("WithTax", decl);
        Assert.Contains("Doubled", decl);
    }

    [Fact]
    public async Task ABodyThatUsesAPrivateMemberIsRefusedByTheCompileCheck()
    {
        var r = await PlanAsync(Callers, "Pricing.Hidden(a)", 8, "csharp.inlineMethod");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("CompilationErrors", r.GetProperty("reasonCode").GetString());
    }
}
