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

    [Fact]
    public async Task DiagnosticsAreTheCompilersErrorsOfTheDocument()
    {
        var original = await File.ReadAllTextAsync(Greeter);
        var edited = original.Replace("new Greeter().Greet(\"c\", 1)", "new Greeter().Greet(\"c\", \"x\")");
        await _f.Client.DidOpenAsync(Greeter, original);
        await _f.Client.DidChangeAsync(Greeter, edited);
        try
        {
            var snap = await _f.Client.BarrierAsync();
            var r = await _f.Client.RequestAsync("code/diagnostics", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Greeter) });
            var d = Assert.Single(r.GetProperty("diagnostics").EnumerateArray(), x => x.GetProperty("severity").GetString() == "error");
            Assert.Equal("CS1503", d.GetProperty("code").GetString());
        }
        finally
        {
            await _f.Client.DidChangeAsync(Greeter, original, 3);
        }
    }

    [Fact]
    public async Task FormatFixesTheLayoutOfTheDocument()
    {
        var original = await File.ReadAllTextAsync(Greeter);
        var edited = original.Replace("public static string UseConcrete() => new Greeter().Greet(\"c\", 1);", "public static string UseConcrete()=>new Greeter( ).Greet( \"c\",1 );");
        await _f.Client.DidOpenAsync(Greeter, original);
        await _f.Client.DidChangeAsync(Greeter, edited);
        try
        {
            var snap = await _f.Client.BarrierAsync();
            var r = await _f.Client.RequestAsync("code/format", new { traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(Greeter) });
            var lines = edited.Replace("\r\n", "\n").Split('\n').ToList();
            var text = edited.Replace("\r\n", "\n");
            var starts = new List<int> { 0 };
            for (var i = 0; i < text.Length; i++) if (text[i] == '\n') starts.Add(i + 1);
            int Off(JsonElement p) => starts[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
            foreach (var e in r.GetProperty("edits").EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
                text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
            Assert.Contains("public static string UseConcrete() => new Greeter().Greet(\"c\", 1);", text);
        }
        finally
        {
            await _f.Client.DidChangeAsync(Greeter, original, 3);
        }
    }
}
