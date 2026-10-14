using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>A copy of the Compat fixture: net8.0 web API, net8.0 console, net9.0 console, netstandard2.0/2.1 libraries, a net8.0;net10.0 library, a net8.0 xUnit project.</summary>
public sealed class CompatFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public JsonElement Status { get; private set; }
    public string File(params string[] parts) => Path.Combine(new[] { Path.GetDirectoryName(Sln)! }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("Compat", "Compat.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        Status = await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>
/// Target framework compatibility (docs/support/matrix.md): the solution loads with one project context per target
/// framework; Find, Related (MediatR, DI), Rename and inspections work across net8.0, net9.0, net10.0 and
/// netstandard2.x; edit actions and postfix templates never produce syntax the project's C# version does not have.
/// Building and loading need only the .NET 10 SDK (targeting packs come from NuGet); running needs the runtimes
/// (<see cref="RuntimeFactAttribute"/>).
/// </summary>
public sealed class CompatTests : IClassFixture<CompatFixture>
{
    private readonly CompatFixture _f;
    private TestClient C => _f.Client;

    public CompatTests(CompatFixture f) => _f = f;

    private string Orders => _f.File("Compat.Contracts", "Orders.cs");
    private string Legacy => _f.File("Compat.Contracts", "Legacy.cs");
    private string Formatter => _f.File("Compat.Shared", "PriceFormatter.cs");
    private string Greeter => _f.File("Compat.Multi", "Greeter.cs");
    private string Handler => _f.File("Compat.Api", "GetOrderHandler.cs");
    private string ApiProgram => _f.File("Compat.Api", "Program.cs");

    private static List<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind).ToList();

    private async Task<(string snap, JsonElement symbol)> SymbolAsync(string path, string needle, int offset)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, path, needle, offset);
        Assert.True(s.ValueKind == JsonValueKind.Object, $"no symbol at {needle}");
        return (snap, s);
    }

    private async Task<JsonElement> RelatedAsync(string path, string needle, int offset)
    {
        var (snap, s) = await SymbolAsync(path, needle, offset);
        return await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
    }

    // ------------------------------------------------------------------ load

    [Fact]
    public void EveryProjectLoadsWithOneContextPerTargetFramework()
    {
        Assert.Equal("Ready", _f.Status.GetProperty("state").GetString());
        var contexts = _f.Status.GetProperty("projects").EnumerateArray()
            .Select(p => Path.GetFileNameWithoutExtension(p.GetProperty("projectPath").GetString()!) + " " + p.GetProperty("targetFramework").GetString())
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(new[]
        {
            "Compat.Api net8.0", "Compat.Cli net8.0", "Compat.Console net9.0", "Compat.Contracts netstandard2.0", "Compat.Multi net10.0",
            "Compat.Multi net8.0", "Compat.Shared netstandard2.1", "Compat.Tests net8.0",
        }, contexts);
        Assert.All(_f.Status.GetProperty("projects").EnumerateArray(), p =>
        {
            Assert.Equal("loaded", p.GetProperty("state").GetString());
            Assert.DoesNotContain(p.GetProperty("diagnostics").EnumerateArray(), d => d.GetProperty("severity").GetString() == "error");
        });
        Assert.DoesNotContain(_f.Status.GetProperty("diagnostics").EnumerateArray(), d => d.GetProperty("severity").GetString() == "error");
    }

    // ------------------------------------------------------------------ Find / Related across target frameworks

    [Fact]
    public async Task FindAndReferencesCrossTargetFrameworks()
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query = "GetOrderQuery", filters = new { }, limit = 20 });
        Assert.Equal("Compat.Contracts.GetOrderQuery", r.GetProperty("items")[0].GetProperty("symbol").GetProperty("displayName").GetString());
        // The multi-target library's type is one result, not one per target framework.
        var greeter = await C.RequestAsync("code/search", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, query = "Greeter", filters = new { }, limit = 20 });
        Assert.Single(greeter.GetProperty("items").EnumerateArray(), i => i.GetProperty("symbol").GetProperty("displayName").GetString() == "Compat.Multi.Greeter");

        var (snap2, discount) = await SymbolAsync(Orders, "public static decimal Discount", 22);
        var refs = await C.RequestAsync("code/references", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap2, symbolId = discount.GetProperty("symbolId").GetString() });
        var files = refs.GetProperty("locations").EnumerateArray().Select(l => Path.GetFileName(UriPaths.ToPath(l.GetProperty("uri").GetString()!))).ToList();
        // netstandard2.1 library, the net8.0;net10.0 library (once, not once per context) and the net8.0 test project.
        Assert.Equal(new[] { "Greeter.cs", "PriceFormatter.cs", "PriceTests.cs" }, files.OrderBy(x => x, StringComparer.Ordinal));
    }

    [Fact]
    public async Task MediatRRequestInNetStandardFindsItsHandlerInTheNet8App()
    {
        var related = await RelatedAsync(Orders, "class GetOrderQuery", 6);
        var handler = Assert.Single(Relations(related, "mediatr.handler"));
        Assert.Equal("GetOrderHandler", handler.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString());
        // From the handler (a C# 12 primary-constructor class) back to the request.
        var back = await RelatedAsync(Handler, "class GetOrderHandler", 6);
        Assert.Contains(back.GetProperty("relations").EnumerateArray(), x => x.GetProperty("relationKind").GetString()!.StartsWith("mediatr.", StringComparison.Ordinal)
            && x.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString() == "GetOrderQuery");
    }

    [Fact]
    public async Task DiRegistrationInTheNet8AppIsFoundFromTheNetStandardInterface()
    {
        var related = await RelatedAsync(Orders, "interface IClock", 10);
        var reg = Assert.Single(Relations(related, "di.registration")).GetProperty("target").GetProperty("registration");
        Assert.Equal("AddSingleton<IClock, SystemClock>()", reg.GetProperty("form").GetString());
        Assert.Equal("singleton", reg.GetProperty("lifetime").GetString());
        Assert.Equal("Program.<Main>$ (Compat.Api)", reg.GetProperty("compositionRoot").GetString());
        Assert.Contains(Relations(related, "di.implementation"), x => x.GetProperty("target").GetProperty("symbol").GetProperty("name").GetString() == "SystemClock");
    }

    [Fact]
    public async Task TestDiscoveryFindsTheNet8XunitProject()
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("code/tests", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uris = (string[]?)null });
        var project = Assert.Single(r.GetProperty("projects").EnumerateArray());
        Assert.Equal("Compat.Tests", project.GetProperty("name").GetString());
        Assert.Equal(new[] { "xUnit" }, project.GetProperty("frameworks").EnumerateArray().Select(x => x.GetString()));
        var names = r.GetProperty("tests").EnumerateArray().Select(t => t.GetProperty("fullyQualifiedName").GetString()!).ToList();
        Assert.Contains("Compat.Tests.PriceTests.DiscountsLargeOrders", names);
        Assert.Contains("Compat.Tests.PriceTests.Sizes", names);
        Assert.Contains("Compat.Tests.PriceTests.RunsOnNet8", names);
    }

    // ------------------------------------------------------------------ Rename across target frameworks

    [Fact]
    public async Task RenameInTheNetStandardLibraryUpdatesNet8Net9AndMultiTargetProjects()
    {
        var (snap, s) = await SymbolAsync(Orders, "class OrderDto", 6);
        var result = await C.PrepareRenameAsync(snap, s.GetProperty("symbolId").GetString()!, "OrderView");
        Assert.Equal("prepared", result.GetProperty("kind").GetString());
        var plan = result.GetProperty("plan");
        Assert.Equal("valid", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Equal("passed", plan.GetProperty("validation").GetProperty("compilationDelta").GetString());
        var expected = new[]
        {
            Orders, Formatter, Greeter, Handler, _f.File("Compat.Cli", "Program.cs"), _f.File("Compat.Console", "Program.cs"),
        }.Select(UriPaths.ToUri).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var writeSet = plan.GetProperty("writeSet").EnumerateArray().ToList();
        Assert.Equal(expected, writeSet.Select(w => w.GetProperty("uri").GetString()!).OrderBy(x => x, StringComparer.Ordinal).ToList());
        foreach (var change in writeSet)
        {
            var original = await System.IO.File.ReadAllTextAsync(UriPaths.ToPath(change.GetProperty("uri").GetString()!));
            Assert.Equal(Regex.Replace(original, @"\bOrderDto\b", "OrderView"), ShopTests.Apply(original, change.GetProperty("edits")));
        }
        // Every context that sees the type was checked: both netstandard libraries, net8.0, net9.0 and both Compat.Multi contexts.
        var checkedContexts = plan.GetProperty("validation").GetProperty("checkedContexts").GetArrayLength();
        Assert.True(checkedContexts >= 7, $"checked contexts: {checkedContexts}");
        Assert.Equal(0, plan.GetProperty("validation").GetProperty("uncheckedContexts").GetArrayLength());
        await C.NotifyAsync("refactor/discard", new { workspaceId = C.WorkspaceId, planId = plan.GetProperty("planId").GetString() });
    }

    // ------------------------------------------------------------------ inspections and language versions

    private async Task<List<JsonElement>> AnalyzeAsync(string file)
    {
        var snap = await C.BarrierAsync();
        var r = await C.RequestAsync("analysis/run", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, documents = new[] { UriPaths.ToUri(file) } });
        return r.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("id").GetString() != "OR1001").ToList();
    }

    private async Task<JsonElement> EditActionsAsync(string file, int start, int end, string? actionId)
    {
        var text = SourceText(file);
        var s = text.Lines.GetLinePosition(start);
        var e = text.Lines.GetLinePosition(end);
        var snap = await C.BarrierAsync();
        return await C.RequestAsync("code/editActions", new
        {
            traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file),
            range = new { start = new { line = s.Line, character = s.Character }, end = new { line = e.Line, character = e.Character } }, actionId,
        });
    }

    private static Microsoft.CodeAnalysis.Text.SourceText SourceText(string file) => Microsoft.CodeAnalysis.Text.SourceText.From(System.IO.File.ReadAllText(file));

    private static List<string> Ids(JsonElement r) => r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("actionId").GetString()!).ToList();

    private async Task<List<string>> ActionsAtAsync(string file, string needle, int offset = 0)
    {
        var at = System.IO.File.ReadAllText(file).IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        return Ids(await EditActionsAsync(file, at + offset, at + offset, null));
    }

    private static bool IsLanguageVersionError(string message) =>
        message.Contains("language version", StringComparison.OrdinalIgnoreCase) || message.Contains("is not available in C#", StringComparison.Ordinal);

    [Fact]
    public async Task InspectionsRunOnNet8AndNetStandardCodeAndTheirFixesFitTheLanguageVersion()
    {
        var net8 = await AnalyzeAsync(Handler);
        Assert.Contains(net8, d => d.GetProperty("id").GetString() == "OR1005");
        var legacy = await AnalyzeAsync(Legacy);
        Assert.Contains(legacy, d => d.GetProperty("id").GetString() == "OR1005");
        // The undisposed local: a 'using var' fix in C# 12, only the 'using' statement in C# 7.3.
        var inNet8 = await ActionsAtAsync(Handler, "var reader = new StreamReader", 4);
        var inLegacy = await ActionsAtAsync(Legacy, "var reader = new StreamReader", 4);
        Assert.Contains(inNet8, a => a.Contains("usingVar", StringComparison.OrdinalIgnoreCase) || a.Contains("UsingDeclaration", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(inLegacy, a => a.Contains("usingVar", StringComparison.OrdinalIgnoreCase) || a.Contains("UsingDeclaration", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ConversionsNeedingANewerCSharpAreNotOfferedInNetStandard20()
    {
        const string P = "csharp.edit.";
        // C# 12 (net8.0): primary constructor offered; C# 7.3 (netstandard2.0 default): not offered.
        Assert.Contains(P + "toPrimaryConstructor", await ActionsAtAsync(Handler, "public OrderNotes(IClock clock)", 7));
        Assert.DoesNotContain(P + "toPrimaryConstructor", await ActionsAtAsync(Legacy, "public LegacyService(IClock clock", 7));
        // 'using' declarations and switch expressions are C# 8, records C# 9.
        Assert.DoesNotContain(P + "usingToDeclaration", await ActionsAtAsync(Legacy, "using (var reader", 1));
        Assert.DoesNotContain(P + "switchToExpression", await ActionsAtAsync(Legacy, "switch (value)", 1));
        Assert.DoesNotContain(P + "ifToSwitchExpression", await ActionsAtAsync(Legacy, "if (code == 1)", 1));
        Assert.Contains(P + "ifToSwitch", await ActionsAtAsync(Legacy, "if (code == 1)", 1));
        Assert.DoesNotContain(P + "classToRecord", await ActionsAtAsync(Legacy, "class LegacyPoint", 6));
        // Invert 'if' on 'is null': 'is not null' is C# 9, so C# 7.3 gets '!(text is null)'.
        var text = await System.IO.File.ReadAllTextAsync(Legacy);
        var at = text.IndexOf("if (text is null)", StringComparison.Ordinal) + 1;
        var inverted = await EditActionsAsync(Legacy, at, at, P + "invertIf");
        Assert.True(inverted.TryGetProperty("edits", out var invEdits), inverted.ToString());
        Assert.Contains("if (!(text is null))", ShopTests.Apply(text, invEdits));
    }

    /// <summary>
    /// Every edit action offered anywhere in a C# 7.3 (netstandard2.0) and a C# 8 (netstandard2.1) file — at every
    /// token and for every selected expression — is computed, and none is refused because it would need a newer C#.
    /// </summary>
    [Theory]
    [InlineData("Compat.Contracts", "Legacy.cs")]
    [InlineData("Compat.Contracts", "Orders.cs")]
    [InlineData("Compat.Shared", "PriceFormatter.cs")]
    public async Task NoOfferedEditActionNeedsANewerLanguageVersion(string project, string fileName)
    {
        var file = _f.File(project, fileName);
        var root = CSharpSyntaxTree.ParseText(System.IO.File.ReadAllText(file)).GetRoot();
        var spans = new HashSet<(int, int)>();
        foreach (var t in root.DescendantTokens()) { spans.Add((t.SpanStart, t.SpanStart)); spans.Add((t.Span.End, t.Span.End)); }
        foreach (var e in root.DescendantNodes().OfType<ExpressionSyntax>()) spans.Add((e.SpanStart, e.Span.End));
        var problems = new List<string>();
        var computed = 0;
        foreach (var (s, e) in spans.OrderBy(x => x))
        {
            foreach (var id in Ids(await EditActionsAsync(file, s, e, null)))
            {
                var r = await EditActionsAsync(file, s, e, id);
                computed++;
                if (r.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String && IsLanguageVersionError(m.GetString()!))
                    problems.Add($"{id} at {s}-{e}: {m.GetString()}");
            }
        }
        Assert.True(computed > 20, $"only {computed} actions computed");
        Assert.True(problems.Count == 0, string.Join("\n", problems.Distinct().Take(20)));
    }

    /// <summary>Postfix templates in C# 7.3 and C# 8 code: the inserted code parses without a newer-language-version error.</summary>
    [Theory]
    [InlineData("Compat.Contracts", "Legacy.cs", "int n = 0;", 7)]
    [InlineData("Compat.Shared", "PriceFormatter.cs", "var sum = 0;", 8)]
    public async Task PostfixTemplatesFitTheLanguageVersion(string project, string fileName, string anchor, int languageVersion)
    {
        var file = _f.File(project, fileName);
        var original = await System.IO.File.ReadAllTextAsync(file);
        var expressions = fileName == "Legacy.cs"
            ? new[] { "items", "n > 0", "_clock", "_name", "new StreamReader(\"x\")", "Code(1)", "new List<int>()", "new InvalidOperationException()" }
            : new[] { "values", "sum > 0", "Size(1)", "new System.IO.MemoryStream()", "new System.IO.MemoryStream().FlushAsync()", "values.ToArray()" };
        var options = new CSharpParseOptions(languageVersion == 7 ? LanguageVersion.CSharp7_3 : LanguageVersion.CSharp8);
        var problems = new List<string>();
        var templates = 0;
        var version = 0;
        try
        {
            foreach (var expr in expressions)
            {
                var insert = "\n" + expr + ".";
                var at = original.IndexOf(anchor, StringComparison.Ordinal) + anchor.Length;
                var text = original[..at] + insert + original[at..];
                if (version == 0) await C.DidOpenAsync(file, text);
                else await C.DidChangeAsync(file, text, version + 1);
                version++;
                var (line, ch) = TestClient.Position(text, insert, insert.Length);
                var snap = await C.BarrierAsync();
                var r = await C.RequestAsync("code/postfix", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(file), position = new { line, character = ch } });
                if (expr == "_clock")
                    Assert.Contains("if (!(_clock is null))", r.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("name").GetString() == "notnull").GetProperty("snippet").GetString());
                foreach (var item in r.GetProperty("items").EnumerateArray())
                {
                    templates++;
                    var code = Unsnippet(item.GetProperty("snippet").GetString()!);
                    var changed = original[..at] + "\n" + code + "\n" + original[at..];
                    var errors = LanguageVersionErrors(changed, options);
                    if (errors.Count > 0) problems.Add($"{expr}.{item.GetProperty("name").GetString()} → {code.Replace('\n', ' ')}: {errors[0].GetMessage()}");
                }
            }
        }
        finally
        {
            if (version > 0) await C.DidCloseAsync(file);
        }
        Assert.True(templates > 20, $"only {templates} templates");
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    /// <summary>
    /// The "feature is not available in C# x" errors of one file, parsed and bound with that language version (many
    /// version checks, e.g. 'is not' patterns, are made by the binder, not the parser). Other errors (types of the rest of
    /// the project are missing here) are ignored.
    /// </summary>
    private static List<Diagnostic> LanguageVersionErrors(string text, CSharpParseOptions options)
    {
        var refs = new[] { typeof(object), typeof(List<>), typeof(StreamReader), typeof(Enumerable), typeof(Console) }
            .Select(t => t.Assembly.Location).Append(Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!, "System.Runtime.dll"))
            .Distinct().Select(p => (MetadataReference)MetadataReference.CreateFromFile(p));
        var compilation = CSharpCompilation.Create("check", new[] { CSharpSyntaxTree.ParseText(text, options) }, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error && IsLanguageVersionError(d.GetMessage())).ToList();
    }

    [Fact]
    public void TheLanguageVersionCheckSeesBinderErrors()
    {
        Assert.NotEmpty(LanguageVersionErrors("class A { bool M(object o) => o is not null; }", new CSharpParseOptions(LanguageVersion.CSharp7_3)));
        Assert.Empty(LanguageVersionErrors("class A { bool M(object o) => !(o is null); }", new CSharpParseOptions(LanguageVersion.CSharp7_3)));
    }

    /// <summary>Generate (Alt+Insert) in C# 7.3 netstandard2.0 code: every kind computes, with no newer-C# syntax and no System.HashCode (netstandard2.1+).</summary>
    [Theory]
    [InlineData("class LegacyPoint")]
    [InlineData("class LegacyService")]
    public async Task GenerateFitsNetStandard20(string needle)
    {
        async Task<JsonElement> Generate(object? extra)
        {
            var text = await System.IO.File.ReadAllTextAsync(Legacy);
            var (line, ch) = TestClient.Position(text, needle, 8);
            var snap = await C.BarrierAsync();
            var p = new Dictionary<string, object?>
            {
                ["traceId"] = "t", ["workspaceId"] = C.WorkspaceId, ["snapshotId"] = snap, ["uri"] = UriPaths.ToUri(Legacy), ["position"] = new { line, character = ch },
            };
            if (extra != null) foreach (var pr in extra.GetType().GetProperties()) p[pr.Name] = pr.GetValue(extra);
            return await C.RequestAsync("code/generate", p);
        }
        var kinds = (await Generate(null)).GetProperty("kinds").EnumerateArray().ToList();
        Assert.Contains(kinds, k => k.GetProperty("kind").GetString() == "equality");
        var original = await System.IO.File.ReadAllTextAsync(Legacy);
        foreach (var k in kinds)
        {
            var kind = k.GetProperty("kind").GetString()!;
            var members = k.GetProperty("members").EnumerateArray().Select(m => m.GetProperty("id").GetString()!).ToArray();
            var r = await Generate(new { kind, members, equatable = true, operators = true });
            if (!(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array))
            {
                // An honest refusal (e.g. the constructor with every field exists already) is fine; one for the C# version or API is not.
                var message = r.GetProperty("message").GetString()!;
                Assert.False(IsLanguageVersionError(message) || message.Contains("HashCode", StringComparison.Ordinal), $"{kind}: {message}");
                Assert.NotEqual("equality", kind);
                continue;
            }
            var changed = ShopTests.Apply(original, edits);
            Assert.DoesNotContain("HashCode.Combine", changed);
            Assert.Empty(LanguageVersionErrors(changed, new CSharpParseOptions(LanguageVersion.CSharp7_3)));
        }
    }

    /// <summary>A VS Code snippet as the code it inserts with its default values ($0 removed, ${n:x} → x, escapes undone).</summary>
    private static string Unsnippet(string snippet)
    {
        var s = Regex.Replace(snippet, @"\$\{\d+:((?:\\.|[^}\\])*)\}", m => m.Groups[1].Value);
        s = Regex.Replace(s, @"(?<!\\)\$\d+", "");
        return s.Replace("\\}", "}").Replace("\\$", "$").Replace("\\\\", "\\");
    }

    // ------------------------------------------------------------------ running (needs the runtimes)

    [RuntimeFact("8.0")]
    public async Task Net8ConsoleBuildsAndRuns()
    {
        var project = _f.File("Compat.Cli", "Compat.Cli.csproj");
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "run", "--project", project, "--nologo" }, Path.GetDirectoryName(project)!, TimeSpan.FromMinutes(5));
        Assert.True(code == 8, output);
        Assert.Contains("Hello cli from net8 180.0 on 8", output);
    }

    [RuntimeFact("9.0")]
    public async Task Net9ConsoleBuildsAndRuns()
    {
        var project = _f.File("Compat.Console", "Compat.Console.csproj");
        var (code, output) = await Fixtures.RunAsync("dotnet", new[] { "run", "--project", project, "--nologo" }, Path.GetDirectoryName(project)!, TimeSpan.FromMinutes(5));
        Assert.True(code == 9, output);
        Assert.Contains("Order 9: 50.00 on 9", output);
    }
}

/// <summary>A fact that runs only where the Microsoft.NETCore.App runtime of the given major.minor is installed.</summary>
public sealed class RuntimeFactAttribute : FactAttribute
{
    public RuntimeFactAttribute(string version)
    {
        if (!DotnetInstall.HasRuntime(version))
            Skip = $"Needs the .NET {version} runtime, which is not installed here (only the .NET 10 SDK is required to build and load; the runtimes are installed in the Docker e2e image, scripts/test/linux-e2e.sh).";
    }
}

/// <summary>A fact that runs only where the exact .NET SDK version is installed.</summary>
public sealed class SdkFactAttribute : FactAttribute
{
    public SdkFactAttribute(string version)
    {
        if (!DotnetInstall.Sdks().Contains(version))
            Skip = $"Needs the .NET SDK {version}, which is not installed here (it is installed in the Docker e2e image, scripts/test/linux-e2e.sh).";
    }
}

/// <summary>What `dotnet --list-runtimes` / `--list-sdks` report (run outside any global.json).</summary>
public static class DotnetInstall
{
    private static readonly Lazy<string> RuntimesText = new(() => List("--list-runtimes"));
    private static readonly Lazy<string> SdksText = new(() => List("--list-sdks"));

    public static bool HasRuntime(string majorMinor) =>
        RuntimesText.Value.Split('\n').Any(l => l.StartsWith("Microsoft.NETCore.App " + majorMinor + ".", StringComparison.Ordinal));

    public static IReadOnlyList<string> Sdks() =>
        SdksText.Value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(l => l.Split(' ')[0]).ToList();

    private static string List(string arg)
    {
        try
        {
            var (_, output) = Fixtures.RunAsync("dotnet", new[] { arg }, Path.GetTempPath(), TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            return output.Replace("\r", "");
        }
        catch (Exception)
        {
            return "";
        }
    }
}
