using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>code/hover and code/signatureHelp (protocol 1.23).</summary>
public sealed class EditorInfoTests : IClassFixture<EditActionsFixture>
{
    private readonly EditActionsFixture _f;
    public EditorInfoTests(EditActionsFixture f) => _f = f;

    private string Greeter => Lib(_f.Dir, "ChangeSignature/Greeter.cs");

    private async Task<JsonElement> AtAsync(string method, string file, string needle, int offset, string? edited = null)
    {
        var text = edited ?? await File.ReadAllTextAsync(file);
        var o = text.IndexOf(needle, StringComparison.Ordinal) + offset;
        int line = 0, ls = 0;
        for (var i = 0; i < o; i++) if (text[i] == '\n') { line++; ls = i + 1; }
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync(method, new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file), position = new { line, character = o - ls } });
    }

    [Fact]
    public async Task HoverShowsTheSignatureAndTheDocumentation()
    {
        var r = await AtAsync("code/hover", Greeter, "new Greeter().Greet", "new Greeter().".Length + 1);
        Assert.Contains("Greet(string name, int times)", r.GetProperty("signature").GetString());
        Assert.Contains(r.GetProperty("sections").EnumerateArray(), s => s.GetString()!.Contains("Greets someone."));
    }

    [Fact]
    public async Task SignatureHelpListsTheParametersAndTheActiveOne()
    {
        var original = await File.ReadAllTextAsync(Greeter);
        var edited = original.Replace("new Greeter().Greet(\"c\", 1)", "new Greeter().Greet(\"c\", ");
        await _f.Client.DidOpenAsync(Greeter, original);
        await _f.Client.DidChangeAsync(Greeter, edited);
        try
        {
            var r = await AtAsync("code/signatureHelp", Greeter, "new Greeter().Greet(\"c\", ", "new Greeter().Greet(\"c\", ".Length, edited);
            var sig = r.GetProperty("signatures")[r.GetProperty("activeSignature").GetInt32()];
            Assert.Contains("Greet(string name, int times)", sig.GetProperty("label").GetString());
            Assert.Equal(1, r.GetProperty("activeParameter").GetInt32());
            Assert.Equal("How often.", sig.GetProperty("parameters")[1].GetProperty("documentation").GetString());
        }
        finally
        {
            await _f.Client.DidChangeAsync(Greeter, original, 3);
        }
    }
}
