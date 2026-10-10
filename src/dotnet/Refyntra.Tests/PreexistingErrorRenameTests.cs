using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// Real-code finding (quality corpus, 2026-10): the compilation delta mapped errors back through
/// <c>SourceText.GetTextChanges</c>, which for Renamer output is one change spanning the whole document. Every error that
/// already existed in an edited file then mapped to a different key and counted as new, so the rename was refused with
/// RenameConflict (seen with TreatWarningsAsErrors + nullable CS8618 in an OSS test project).
/// </summary>
public sealed class PreexistingErrorRenameTests
{
    [Fact]
    public async Task An_error_that_existed_before_the_rename_in_an_edited_file_is_not_a_conflict()
    {
        var sln = await Fixtures.CopyAsync("PreexistingErrors", "PreexistingErrors.sln");
        var file = Path.Combine(Path.GetDirectoryName(sln)!, "PreexistingErrors.App", "Holder.cs");
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, "class Factory", 6);
        var r = await c.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "WidgetFactory");
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());

        // A genuinely new error in the same file is still a conflict.
        var store = await c.SymbolAtTextAsync(snap, file, "interface IStore", 10);
        var clash = await c.PrepareRenameAsync(snap, store.GetProperty("symbolId").GetString()!, "Factory");
        Assert.Equal("unavailable", clash.GetProperty("kind").GetString());
    }
}
