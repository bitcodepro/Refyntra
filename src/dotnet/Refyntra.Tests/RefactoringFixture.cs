using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Shared helpers of the Safe Delete, Extract Method and Change Signature tests: every test opens its own copy of the
/// Refactorings fixture (nothing here writes a file except the test setup and the explicit "apply" steps).
/// </summary>
internal static class RefactoringFixture
{
    public static async Task<(TestClient c, string dir)> OpenAsync()
    {
        var path = await Fixtures.CopyAsync("Refactorings", "Refactorings.sln");
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(path);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, Path.GetDirectoryName(path)!);
    }

    public static string Lib(string dir, string rel) => Path.GetFullPath(Path.Combine(dir, "Refactorings.Lib", rel.Replace('/', Path.DirectorySeparatorChar)));

    public static string App(string dir, string rel) => Path.GetFullPath(Path.Combine(dir, "Refactorings.App", rel.Replace('/', Path.DirectorySeparatorChar)));

    /// <summary>refactor/prepare of a symbol action at the first occurrence of <paramref name="needle"/> (plus offset).</summary>
    public static async Task<JsonElement> PrepareAtAsync(TestClient c, string action, string file, string needle, int offset = 0, object? signature = null)
    {
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, file, needle, offset);
        Assert.True(s.ValueKind == JsonValueKind.Object, $"no symbol at {needle}");
        return await c.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = action,
            symbolId = s.GetProperty("symbolId").GetString(), newName = "", documentUri = UriPaths.ToUri(file), signature,
        });
    }

    public static JsonElement Prepared(JsonElement r)
    {
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        return r.GetProperty("plan");
    }

    public static void Unavailable(JsonElement r, string reason)
    {
        Assert.True(r.GetProperty("kind").GetString() == "unavailable", r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    /// <summary>The text of <paramref name="file"/> after the plan's text change for it (the disk text when there is none).</summary>
    public static string After(JsonElement plan, string file)
    {
        var text = File.ReadAllText(file);
        foreach (var change in plan.GetProperty("writeSet").EnumerateArray())
            if (change.GetProperty("kind").GetString() == "text" && UriPaths.ToPath(change.GetProperty("uri").GetString()!) is var p
                && string.Equals(Path.GetFullPath(p), file, StringComparison.OrdinalIgnoreCase))
                return MoveTypeTests.ApplyEdits(text, change);
        return text;
    }

    /// <summary>Applies the plan's text changes and file deletions to the disk (what the extension does) and resyncs the host.</summary>
    public static async Task ApplyToDiskAsync(TestClient c, JsonElement plan)
    {
        var deleted = new List<string>();
        foreach (var change in plan.GetProperty("writeSet").EnumerateArray())
        {
            var kind = change.GetProperty("kind").GetString();
            if (kind == "text")
            {
                var path = UriPaths.ToPath(change.GetProperty("uri").GetString()!);
                var text = MoveTypeTests.ApplyEdits(File.ReadAllText(path), change);
                await File.WriteAllTextAsync(path, text);
                await c.DidOpenAsync(path, text);
                await c.DidCloseAsync(path);
            }
            else if (kind == "delete")
            {
                var path = UriPaths.ToPath(change.GetProperty("uri").GetString()!);
                File.Delete(path);
                deleted.Add(change.GetProperty("uri").GetString()!);
            }
        }
        if (deleted.Count > 0)
            await c.NotifyAsync("workspace/didDeleteFiles", new { workspaceId = c.WorkspaceId, sequence = c.NextSequence(), workspaceRevision = 1000, files = deleted.Select(u => new { uri = u }).ToArray() });
    }

    /// <summary>The copied fixture builds (dotnet build, no restore) after the plan was applied to the disk.</summary>
    public static async Task AssertBuildsAsync(string dir)
    {
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "build", Path.Combine(dir, "Refactorings.sln"), "--nologo", "-v", "q", "--no-restore" }, dir, TimeSpan.FromMinutes(5));
        Assert.True(code == 0, output);
    }

    public static List<string> Kinds(JsonElement plan) =>
        plan.GetProperty("writeSet").EnumerateArray().Select(c => c.GetProperty("kind").GetString()!).ToList();

    public static string Limitations(JsonElement plan) =>
        string.Join("\n", plan.GetProperty("limitations").EnumerateArray().Select(l => l.GetString()));
}
