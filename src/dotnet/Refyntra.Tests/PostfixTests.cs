using System.Diagnostics;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>One opened copy of the Refactorings fixture for the postfix tests (they only change the overlay).</summary>
public sealed class PostfixFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";
    public int Version;

    public async Task InitializeAsync() => (Client, Dir) = await RefactoringFixture.OpenAsync();

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>
/// code/postfix (protocol 1.10): templates after "expr." chosen by the expression's type (bool, nullable, enumerable,
/// countable, awaitable, disposable, exception, type name), statement templates only for a whole expression statement,
/// snippets formatted with the document options, names suggested from the expression.
/// </summary>
public sealed class PostfixTests : IClassFixture<PostfixFixture>
{
    private readonly PostfixFixture _f;
    public PostfixTests(PostfixFixture f) => _f = f;

    private string File => RefactoringFixture.Lib(_f.Dir, "Postfix/Samples.cs");

    /// <summary>Replaces <paramref name="marker"/> with <paramref name="code"/> in the overlay and asks at the end of it (or at <paramref name="caret"/> in it).</summary>
    private async Task<JsonElement> AskAsync(string marker, string code, int? caret = null)
    {
        var original = await System.IO.File.ReadAllTextAsync(File);
        var at = original.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(at >= 0, marker);
        var text = original[..at] + code + original[(at + marker.Length)..];
        if (_f.Version == 0) { await _f.Client.DidOpenAsync(File, text); _f.Version = 1; }
        else await _f.Client.DidChangeAsync(File, text, ++_f.Version);
        var (line, ch) = TestClient.Position(text, code, caret ?? code.Length);
        var snap = await _f.Client.BarrierAsync();
        return await _f.Client.RequestAsync("code/postfix", new
        {
            traceId = "t", workspaceId = _f.Client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(File), position = new { line, character = ch },
        });
    }

    private static List<string> Names(JsonElement r) => r.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("name").GetString()!).ToList();

    private static string Snippet(JsonElement r, string name) =>
        r.GetProperty("items").EnumerateArray().First(i => i.GetProperty("name").GetString() == name).GetProperty("snippet").GetString()!.Replace("\r\n", "\n");

    [Fact]
    public async Task ListsOfferForeachForAndNullChecksWithNamesFromTheExpression()
    {
        var r = await AskAsync("/*S*/", "numbers.");
        var names = Names(r);
        foreach (var n in new[] { "foreach", "for", "forr", "var", "ifn", "notnull", "par", "cast", "arg", "lock", "switch", "nameof" }) Assert.Contains(n, names);
        foreach (var n in new[] { "if", "not", "while", "await", "throw", "new", "using", "return", "yield" }) Assert.DoesNotContain(n, names);
        Assert.Equal("List<int>", r.GetProperty("typeName").GetString());
        Assert.Equal("foreach (var ${1:number} in numbers)\n{\n    $0\n}", Snippet(r, "foreach"));
        Assert.Equal("for (var ${1:i} = 0; $1 < numbers.Count; $1++)\n{\n    $0\n}", Snippet(r, "for"));
        Assert.Equal("for (var ${1:i} = numbers.Count - 1; $1 >= 0; $1--)\n{\n    $0\n}", Snippet(r, "forr"));
        Assert.Equal("if (numbers is null)\n{\n    $0\n}", Snippet(r, "ifn"));
        var range = r.GetProperty("expressionRange");
        Assert.Equal(range.GetProperty("start").GetProperty("line").GetInt32(), range.GetProperty("end").GetProperty("line").GetInt32());
    }

    [Fact]
    public async Task ArraysUseLengthAndTheTypedNameMayFollowTheDot()
    {
        var r = await AskAsync("/*S*/", "array.fo");
        Assert.Equal("for (var ${1:i} = 0; $1 < array.Length; $1++)\n{\n    $0\n}", Snippet(r, "for"));
        // Element name from the element type when the expression is not a plural name.
        var lines = await AskAsync("/*S*/", "lines.");
        Assert.Contains("foreach (var ${1:line} in lines)", Snippet(lines, "foreach"));
    }

    [Fact]
    public async Task BooleansGetIfNotAndWhile()
    {
        var r = await AskAsync("/*S*/", "ready.");
        var names = Names(r);
        Assert.Contains("if", names);
        Assert.Contains("while", names);
        Assert.Equal("!ready$0", Snippet(r, "not"));
        Assert.DoesNotContain("foreach", names);
        Assert.DoesNotContain("ifn", names); // bool is a non-nullable value type
        // Not a statement: only expression templates.
        var expr = Names(await AskAsync("/*S*/", "var b = ready."));
        Assert.Contains("not", expr);
        Assert.DoesNotContain("if", expr);
        Assert.DoesNotContain("var", expr);
        Assert.Equal("!(plain > 0)$0", Snippet(await AskAsync("/*S*/", "(plain > 0)."), "not").Replace("!((plain > 0))", "!(plain > 0)"));
    }

    [Fact]
    public async Task NullableValueAndReferenceTypesGetNullChecksPlainValuesDoNot()
    {
        Assert.Contains("ifn", Names(await AskAsync("/*S*/", "maybe.")));
        Assert.Contains("notnull", Names(await AskAsync("/*S*/", "count.")));
        Assert.Equal("if (count is not null)\n{\n    $0\n}", Snippet(await AskAsync("/*S*/", "count."), "notnull"));
        var plain = Names(await AskAsync("/*S*/", "plain."));
        Assert.DoesNotContain("ifn", plain);
        Assert.DoesNotContain("notnull", plain);
        Assert.DoesNotContain("lock", plain);
        // Unconstrained type parameter: may be null.
        Assert.Contains("ifn", Names(await AskAsync("/*G*/", "value.")));
        Assert.Contains("foreach (var ${1:keyValuePair} in map)", Snippet(await AskAsync("/*G*/", "map."), "foreach"));
    }

    [Fact]
    public async Task VarUsingAwaitReturnYieldAndThrowFollowTheTypeAndTheMember()
    {
        Assert.Equal("var ${1:length} = array.Length;$0", Snippet(await AskAsync("/*S*/", "array.Length."), "var"));
        var s = await AskAsync("/*S*/", "stream.");
        Assert.StartsWith("using (var ${1:stream2} = stream)\n{\n", Snippet(s, "using"));
        var a = await AskAsync("/*A*/", "LoadAsync().");
        Assert.Equal("await LoadAsync()$0", Snippet(a, "await"));
        Assert.DoesNotContain("return", Names(a)); // async Task: nothing to return
        Assert.Equal("return x;$0", Snippet(await AskAsync("/*R*/", "x."), "return"));
        var y = await AskAsync("/*Y*/", "x.");
        Assert.Equal("yield return x;$0", Snippet(y, "yield"));
        Assert.DoesNotContain("return", Names(y)); // iterator: 'return' is not offered … yield is
        var t = await AskAsync("/*T*/", "new InvalidOperationException(reason).");
        Assert.Equal("throw new InvalidOperationException(reason);$0", Snippet(t, "throw"));
        Assert.DoesNotContain("throw", Names(await AskAsync("/*T*/", "reason.")));
    }

    [Fact]
    public async Task TypeNamesGetNewOnlyWhenTheTypeCanBeCreated()
    {
        var r = await AskAsync("/*S*/", "Samples.");
        Assert.Equal("new Samples($0)", Snippet(r, "new"));
        Assert.DoesNotContain("var", Names(r));
        Assert.DoesNotContain("new", Names(await AskAsync("/*S*/", "Stream."))); // abstract
    }

    [Fact]
    public async Task NothingInCommentsStringsNamespacesOrAfterVoid()
    {
        Assert.Empty(Names(await AskAsync("/*S*/", "// numbers.")));
        Assert.Empty(Names(await AskAsync("/*S*/", "var s = \"numbers.")));
        Assert.Empty(Names(await AskAsync("/*S*/", "System.")));
        Assert.Empty(Names(await AskAsync("/*S*/", "Console.WriteLine().")));
        Assert.Empty(Names(await AskAsync("/*S*/", "numbers ."))); // a space before the dot
    }

    [Fact]
    public async Task SnippetTextIsEscapedAndAnswersAreFast()
    {
        var r = await AskAsync("/*S*/", "$\"{plain}\".");
        Assert.Equal("var ${1:text} = \\$\"{plain}\";$0", Snippet(r, "var"));
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < 5; i++) await AskAsync("/*S*/", "numbers.");
        // Generous bound for CI machines (typical is far below 50 ms per request including the overlay change).
        Assert.True(sw.ElapsedMilliseconds < 5 * 1000, $"{sw.ElapsedMilliseconds} ms for 5 requests");
    }
}
