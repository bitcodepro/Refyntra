using System.Text;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Code Cleanup (csharp.cleanup) on copies of the Cleanup fixture: each fix on its own, all together, idempotency (a
/// second run on the result changes nothing), semantic preservation (the compilation has the same diagnostics after the
/// result is written), the skipped files and fixes with their reasons, scope, revalidation. Nothing here writes a file
/// except the test setup and the explicit "write the result" steps on the copy.
/// </summary>
public sealed class CleanupTests
{
    private const string Action = "csharp.cleanup";

    private static async Task<(TestClient c, string dir)> OpenAsync(Action<string>? beforeOpen = null)
    {
        var sln = await Fixtures.CopyAsync("Cleanup", "Cleanup.sln");
        var dir = Path.GetDirectoryName(sln)!;
        beforeOpen?.Invoke(dir);
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var status = await c.OpenAsync(sln);
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        return (c, dir);
    }

    private static string App(string dir, string rel) => Path.GetFullPath(Path.Combine(dir, "Cleanup.App", rel.Replace('/', Path.DirectorySeparatorChar)));

    private static async Task<JsonElement> PrepareAsync(TestClient c, IEnumerable<string> scope, params string[] fixes)
    {
        var snap = await c.BarrierAsync();
        return await c.RequestAsync("refactor/prepare", new
        {
            traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, actionId = Action, symbolId = "", newName = "",
            cleanup = new { scopeUris = scope.Select(UriPaths.ToUri).ToList(), fixes = fixes.ToList() },
        });
    }

    private static async Task<JsonElement> PreparedAsync(TestClient c, IEnumerable<string> scope, params string[] fixes)
    {
        var r = await PrepareAsync(c, scope, fixes);
        Assert.True(r.GetProperty("kind").GetString() == "prepared", r.ToString());
        var plan = r.GetProperty("plan");
        Assert.Equal(Action, plan.GetProperty("actionId").GetString());
        Assert.All(plan.GetProperty("writeSet").EnumerateArray(), w => Assert.Equal("text", w.GetProperty("kind").GetString()));
        return plan;
    }

    private static JsonElement? Change(JsonElement plan, string path)
    {
        foreach (var w in plan.GetProperty("writeSet").EnumerateArray())
            if (w.GetProperty("uri").GetString() == UriPaths.ToUri(path)) return w;
        return null;
    }

    private static string Result(JsonElement plan, string path) => MoveTypeTests.ApplyEdits(File.ReadAllText(path), Change(plan, path) ?? throw new Xunit.Sdk.XunitException("no change for " + path));

    private static int Count(JsonElement plan, string path, string fix)
    {
        foreach (var f in plan.GetProperty("cleanup").GetProperty("files").EnumerateArray())
            if (f.GetProperty("uri").GetString() == UriPaths.ToUri(path))
                foreach (var x in f.GetProperty("fixes").EnumerateArray())
                    if (x.GetProperty("fixId").GetString() == fix) return x.GetProperty("count").GetInt32();
        return 0;
    }

    private static List<(string? uri, string? fix, string code)> Skipped(JsonElement plan) =>
        plan.GetProperty("cleanup").GetProperty("skipped").EnumerateArray()
            .Select(s => (s.TryGetProperty("uri", out var u) ? u.GetString() : null, s.TryGetProperty("fixId", out var f) ? f.GetString() : null, s.GetProperty("reasonCode").GetString()!)).ToList();

    /// <summary>Writes every planned result to disk (as an apply + save would) and reloads the workspace.</summary>
    private static async Task WriteAllAsync(TestClient c, JsonElement plan)
    {
        foreach (var w in plan.GetProperty("writeSet").EnumerateArray())
        {
            var path = UriPaths.ToPath(w.GetProperty("uri").GetString()!);
            var bom = File.ReadAllBytes(path).AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF });
            await File.WriteAllTextAsync(path, MoveTypeTests.ApplyEdits(await File.ReadAllTextAsync(path), w), new UTF8Encoding(bom));
        }
        await c.RequestAsync("workspace/reload", new { traceId = "t", workspaceId = c.WorkspaceId });
    }

    private static async Task<List<string>> BuildDiagnosticsAsync(string dir)
    {
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "build", Path.Combine(dir, "Cleanup.sln"), "--nologo", "-v", "q", "-clp:NoSummary" }, dir, TimeSpan.FromMinutes(5));
        Assert.True(code == 0, output);
        return output.Split('\n').Select(l => l.Trim()).Where(l => l.Contains(": warning ") || l.Contains(": error "))
            .Select(l => l.Substring(l.IndexOf(": ", StringComparison.Ordinal))).OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    // ------------------------------------------------------------------ each fix on its own

    [Fact]
    public async Task RemoveUnnecessaryUsings_removes_only_what_the_compiler_proves_unused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var messy = App(dir, "Services/Messy.cs");
        var documented = App(dir, "Services/Documented.cs");
        var plan = await PreparedAsync(c, new[] { messy, documented }, "removeUnnecessaryUsings");
        var result = Result(plan, messy);
        Assert.DoesNotContain("using System.Text;", result);
        Assert.Contains("using System;", result); // the compiler does not report it unused (extension method lookup)
        Assert.Contains("using System.Linq;", result); // extension method Count()
        Assert.Contains("using Cleanup.App.Models;", result);
        Assert.Equal(1, Count(plan, messy, "removeUnnecessaryUsings"));
        // A using needed only by a cref in a doc comment stays; the unused System.IO goes.
        var doc = Result(plan, documented);
        Assert.Contains("using System.Text;", doc);
        Assert.DoesNotContain("using System.IO;", doc);
        Assert.StartsWith("using System.Text;\n\nnamespace", doc.Replace("\r\n", "\n"));
    }

    [Fact]
    public async Task SortUsings_orders_System_first_and_changes_nothing_else()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var tidy = App(dir, "Services/Tidy.cs");
        var plan = await PreparedAsync(c, new[] { tidy }, "sortUsings");
        var before = File.ReadAllText(tidy);
        var result = Result(plan, tidy);
        Assert.StartsWith("using System;\nusing System.Collections.Generic;\n", result);
        Assert.Equal(before.Length, result.Length);
        Assert.Equal(before.Split('\n').Skip(2), result.Split('\n').Skip(2));
        Assert.Equal(2, Count(plan, tidy, "sortUsings"));
    }

    [Fact]
    public async Task SortUsings_honours_editorconfig_system_first_false()
    {
        var (c, dir) = await OpenAsync(d => File.AppendAllText(Path.Combine(d, ".editorconfig"), "dotnet_sort_system_directives_first = false\n"));
        await using var _ = c;
        var file = App(dir, "Services/Sorted.cs");
        // Without System first, "Cleanup..." sorts before "System...".
        File.WriteAllText(file, "using System;\nusing Cleanup.App.Models;\n\nnamespace Cleanup.App.Services;\n\npublic static class Sorted\n{\n    public static Customer Make() => new Customer(nameof(Math));\n}\n");
        await c.RequestAsync("workspace/reload", new { traceId = "t", workspaceId = c.WorkspaceId });
        var plan = await PreparedAsync(c, new[] { file }, "sortUsings");
        Assert.StartsWith("using Cleanup.App.Models;\nusing System;\n", Result(plan, file));
    }

    [Fact]
    public async Task FileScopedNamespace_converts_and_dedents_when_editorconfig_and_LangVersion_allow()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var messy = App(dir, "Services/Messy.cs");
        var documented = App(dir, "Services/Documented.cs");
        var plan = await PreparedAsync(c, new[] { messy, documented }, "fileScopedNamespace");
        Assert.Equal(
            "using System.Text;\nusing System.Linq;\nusing System;\nusing Cleanup.App.Models;\n\nnamespace Cleanup.App.Services;\n\npublic sealed class Messy   \n{\n    public int Count(int[] xs) => xs.Count();\t\n\n    public Customer Make() => new Customer(\"a\");\n}",
            Result(plan, messy));
        Assert.Equal(1, Count(plan, messy, "fileScopedNamespace"));
        Assert.Contains("namespace Cleanup.App.Services;\n\n/// <summary>", Result(plan, documented));
    }

    [Fact]
    public async Task Whitespace_trims_line_ends_and_adds_the_final_newline_but_never_inside_a_string()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var messy = App(dir, "Services/Messy.cs");
        var verbatim = App(dir, "Services/Verbatim.cs");
        var plan = await PreparedAsync(c, new[] { messy, verbatim }, "whitespace");
        var result = Result(plan, messy);
        Assert.Contains("public sealed class Messy\n", result);
        Assert.Contains("xs.Count();\n", result);
        Assert.EndsWith("}\n}\n", result);
        Assert.Equal(3, Count(plan, messy, "whitespace")); // two lines + the final newline
        var v = Result(plan, verbatim);
        Assert.Contains("@\"first line   \nsecond line\t\n\";\n", v); // inside the string: untouched; after it: trimmed
        Assert.Equal(1, Count(plan, verbatim, "whitespace"));
    }

    [Fact]
    public async Task Whitespace_does_nothing_without_editorconfig_options()
    {
        var (c, dir) = await OpenAsync(d => File.WriteAllText(Path.Combine(d, ".editorconfig"), "root = true\n"));
        await using var _ = c;
        var r = await PrepareAsync(c, new[] { App(dir, "Services/Messy.cs") }, "whitespace");
        Assert.Equal("unavailable", r.GetProperty("kind").GetString());
        Assert.Equal("NoChanges", r.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task The_semantic_fingerprint_rejects_a_change_of_meaning()
    {
        using var ws = new Microsoft.CodeAnalysis.AdhocWorkspace();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(p => Path.GetFileName(p) is "System.Runtime.dll" or "System.Private.CoreLib.dll" or "System.Linq.dll")
            .Select(p => Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(p));
        var project = ws.AddProject("P", Microsoft.CodeAnalysis.LanguageNames.CSharp).AddMetadataReferences(refs);
        const string original = "using X = System.Int32;\nclass C { X F() => 1; string S = \"a  \"; }\n";
        var doc = project.AddDocument("C.cs", original);
        var before = await Refactorings.Cleanup.SemanticFingerprint.ComputeAsync(doc, default);
        var none = new HashSet<string>();
        Assert.Null(before.Compare(await Refactorings.Cleanup.SemanticFingerprint.ComputeAsync(doc.WithText(Microsoft.CodeAnalysis.Text.SourceText.From(original + "\n")), default), none));
        // The alias now means another type; a literal loses its trailing spaces: both are refused.
        var alias = doc.WithText(Microsoft.CodeAnalysis.Text.SourceText.From(original.Replace("System.Int32", "System.Int64")));
        Assert.Contains("bind differently", before.Compare(await Refactorings.Cleanup.SemanticFingerprint.ComputeAsync(alias, default), none));
        var literal = doc.WithText(Microsoft.CodeAnalysis.Text.SourceText.From(original.Replace("\"a  \"", "\"a\"")));
        Assert.Contains("literal value", before.Compare(await Refactorings.Cleanup.SemanticFingerprint.ComputeAsync(literal, default), none));
    }

    // ------------------------------------------------------------------ skipped with reasons

    [Fact]
    public async Task Unsafe_files_and_fixes_are_skipped_with_reasons()
    {
        var (c, dir) = await OpenAsync(d =>
        {
            var services = Path.Combine(d, "Cleanup.App", "Services");
            // Not UTF-8 (Windows-1252 "é" in a comment), mixed line endings, read-only: each has trailing whitespace.
            File.WriteAllBytes(Path.Combine(services, "Latin.cs"), Encoding.Latin1.GetBytes("// café  \nnamespace Cleanup.App.Services;\n\npublic static class Latin { }\n"));
            File.WriteAllText(Path.Combine(services, "Mixed.cs"), "namespace Cleanup.App.Services;  \r\n\npublic static class Mixed { }\n");
            File.WriteAllText(Path.Combine(services, "Locked.cs"), "namespace Cleanup.App.Services;  \n\npublic static class Locked { }\n");
            File.SetAttributes(Path.Combine(services, "Locked.cs"), FileAttributes.ReadOnly);
        });
        await using var _ = c;
        try
        {
            var plan = await PreparedAsync(c, new[] { Path.Combine(dir, "Cleanup.App"), Path.Combine(dir, "Cleanup.Legacy") }, "removeUnnecessaryUsings", "sortUsings", "fileScopedNamespace", "whitespace", "editorConfigCodeStyle");
            var skipped = Skipped(plan);
            bool Has(string rel, string? fix, string code) => skipped.Any(s => s.uri == UriPaths.ToUri(rel) && s.fix == fix && s.code == code);
            Assert.True(Has(App(dir, "Generated/Api.g.cs"), null, "GeneratedCode"), string.Join("\n", skipped));
            Assert.True(Has(App(dir, "Services/Latin.cs"), null, "UnsupportedEncoding"));
            Assert.True(Has(App(dir, "Services/Mixed.cs"), null, "MixedLineEndings"));
            Assert.True(Has(App(dir, "Services/Locked.cs"), null, "ReadOnlyFile"));
            Assert.True(Has(App(dir, "Services/Conditional.cs"), "removeUnnecessaryUsings", "ConditionalCompilation"));
            Assert.True(Has(App(dir, "Services/TwoNamespaces.cs"), "fileScopedNamespace", "NotSingleNamespace"));
            Assert.True(Has(App(dir, "Services/Verbatim.cs"), "fileScopedNamespace", "MultiLineString"));
            Assert.True(Has(Path.Combine(dir, "Cleanup.Legacy", "Old.cs"), "fileScopedNamespace", "LanguageVersion"));
            Assert.Contains(skipped, s => s.uri == null && s.fix == "editorConfigCodeStyle" && s.code == "NotOffered");
            foreach (var f in new[] { "Generated/Api.g.cs", "Services/Latin.cs", "Services/Mixed.cs", "Services/Locked.cs" })
                Assert.Null(Change(plan, App(dir, f)));
            // A skipped fix does not stop the others: the C# 9 file is cleaned except for its namespace.
            var old = Result(plan, Path.Combine(dir, "Cleanup.Legacy", "Old.cs"));
            Assert.StartsWith("using System.Linq;\n\nnamespace Cleanup.Legacy\n{", old);
            Assert.Contains("xs.Sum();\n", old);
        }
        finally
        {
            File.SetAttributes(App(dir, "Services/Locked.cs"), FileAttributes.Normal);
        }
    }

    [Fact]
    public async Task Scope_limits_and_unknown_inputs_are_explained()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var none = await PrepareAsync(c, new[] { Path.Combine(dir, "NoSuchFolder") }, "whitespace");
        Assert.Equal("NoFilesInScope", none.GetProperty("reasonCode").GetString());
        var noFix = await PrepareAsync(c, new[] { dir }, "editorConfigCodeStyle");
        Assert.Equal("NoFixes", noFix.GetProperty("reasonCode").GetString());
        Assert.Contains("public Roslyn APIs only", noFix.GetProperty("message").GetString());
        // A project file as the scope: only that project's files.
        var plan = await PreparedAsync(c, new[] { Path.Combine(dir, "Cleanup.Legacy", "Cleanup.Legacy.csproj") }, "whitespace");
        Assert.All(plan.GetProperty("writeSet").EnumerateArray(), w => Assert.Contains("Cleanup.Legacy", w.GetProperty("uri").GetString()));
        Assert.Equal(1, plan.GetProperty("cleanup").GetProperty("filesInScope").GetInt32());
    }

    // ------------------------------------------------------------------ all fixes: idempotency, semantics, revalidation

    [Fact]
    public async Task All_fixes_together_then_a_second_run_changes_nothing_and_the_build_has_the_same_diagnostics()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var before = await BuildDiagnosticsAsync(dir);
        var fixes = new[] { "removeUnnecessaryUsings", "sortUsings", "fileScopedNamespace", "whitespace" };
        var plan = await PreparedAsync(c, new[] { dir }, fixes);
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        var messy = App(dir, "Services/Messy.cs");
        Assert.Equal(
            "using System;\nusing System.Linq;\nusing Cleanup.App.Models;\n\nnamespace Cleanup.App.Services;\n\npublic sealed class Messy\n{\n    public int Count(int[] xs) => xs.Count();\n\n    public Customer Make() => new Customer(\"a\");\n}\n",
            Result(plan, messy));
        Assert.Null(Change(plan, App(dir, "Models/Customer.cs"))); // already clean
        await WriteAllAsync(c, plan);

        var again = await PrepareAsync(c, new[] { dir }, fixes);
        Assert.Equal("unavailable", again.GetProperty("kind").GetString());
        Assert.Equal("NoChanges", again.GetProperty("reasonCode").GetString());
        Assert.Equal(before, await BuildDiagnosticsAsync(dir));
    }

    [Fact]
    public async Task A_plan_is_stale_after_a_scope_file_changes()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var messy = App(dir, "Services/Messy.cs");
        var plan = await PreparedAsync(c, new[] { messy }, "whitespace");
        await File.AppendAllTextAsync(messy, "\n// edited\n");
        await c.RequestAsync("workspace/reload", new { traceId = "t", workspaceId = c.WorkspaceId });
        var snap = await c.BarrierAsync();
        var v = await c.RequestAsync("refactor/revalidate", new { traceId = "t", workspaceId = c.WorkspaceId, planId = plan.GetProperty("planId").GetString(), snapshotId = snap });
        Assert.NotEqual("valid", v.GetProperty("status").GetString());
    }

    [Fact]
    public async Task A_valid_plan_revalidates_as_valid()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var plan = await PreparedAsync(c, new[] { App(dir, "Services") }, "removeUnnecessaryUsings", "whitespace");
        var snap = await c.BarrierAsync();
        var v = await c.RequestAsync("refactor/revalidate", new { traceId = "t", workspaceId = c.WorkspaceId, planId = plan.GetProperty("planId").GetString(), snapshotId = snap });
        Assert.Equal("valid", v.GetProperty("status").GetString());
    }
}
