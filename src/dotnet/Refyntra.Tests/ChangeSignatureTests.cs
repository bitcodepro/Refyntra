using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;
using static Refyntra.Tests.RefactoringFixture;

namespace Refyntra.Tests;

/// <summary>
/// Change Signature: reorder, rename, add and remove parameters across an interface, its implementation, an override and
/// every call site (named arguments, cross-project, constructors and initializers, reduced extension calls, params);
/// evaluation order kept with named arguments; refusals for method groups, used or side-effecting removed parameters,
/// overload changes and invalid input; dynamic calls make the plan limited.
/// </summary>
public sealed class ChangeSignatureTests
{
    private const string Action = "csharp.changeSignature";

    private static string Greeter(string dir) => Lib(dir, "ChangeSignature/Greeter.cs");

    private static object Sig(params object[] ps) => new { parameters = ps };

    [Fact]
    public async Task SignatureInfoListsTheParameters()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var snap = await c.BarrierAsync();
        var s = await c.SymbolAtTextAsync(snap, Greeter(dir), "virtual string Greet", 15);
        var info = await c.RequestAsync("code/signature", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        Assert.Equal("Greet", info.GetProperty("name").GetString());
        var ps = info.GetProperty("parameters").EnumerateArray().ToList();
        Assert.Equal(new[] { "name", "times" }, ps.Select(p => p.GetProperty("name").GetString()));
        Assert.Equal(new[] { "string", "int" }, ps.Select(p => p.GetProperty("type").GetString()));
        var field = await c.SymbolAtTextAsync(snap, Greeter(dir), "_counter");
        var none = await c.RequestAsync("code/signature", new { traceId = "t", workspaceId = c.WorkspaceId, snapshotId = snap, symbolId = field.GetProperty("symbolId").GetString() });
        Assert.Equal("UnsupportedSymbolKind", none.GetProperty("reasonCode").GetString());
    }

    [Fact]
    public async Task ReorderUpdatesHierarchyAndEveryCallSite()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 1, name = "times" }, new { from = 0, name = "name" })));
        var after = After(plan, file);
        Assert.Contains("string Greet(int times, string name);", after);
        Assert.Contains("public virtual string Greet(int times, string name) =>", after);
        Assert.Contains("public override string Greet(int times, string who) => base.Greet(name: who, times: times)", after);
        Assert.Contains("greeter.Greet(2, \"a\") + greeter.Greet(times: 3, name: \"b\")", after);
        Assert.Contains("new Greeter().Greet(1, \"c\")", after);
        Assert.Contains("new LoudGreeter().Greet(1, \"app\")", After(plan, App(dir, "Program.cs")));
        Assert.Contains(plan.GetProperty("evidence").EnumerateArray(), e => e.GetProperty("description").GetString()!.StartsWith("Hierarchy:"));
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task RenameAndAddUpdateNamedArgumentsBodiesAndDocumentation()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15,
            Sig(new { from = 0, name = "person" }, new { from = 1, name = "times" }, new { name = "polite", type = "bool", callSiteValue = "true" })));
        var after = After(plan, file);
        Assert.Contains("string Greet(string person, int times, bool polite);", after);
        Assert.Contains("\"Hi \" + person", after);
        Assert.Contains("<param name=\"person\">Who is greeted.</param>", after);
        Assert.Contains("Greet(string person, int times, bool polite) => base.Greet(person, times, true)", after);
        Assert.Contains("greeter.Greet(\"a\", 2, true) + greeter.Greet(person: \"b\", times: 3, polite: true)", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task OptionalNewParameterWithoutCallSiteValueIsOmitted()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "static int Next", 11, Sig(new { name = "step", type = "int", defaultValue = "1" })));
        var after = After(plan, file);
        Assert.Contains("public static int Next(int step = 1) => ++_counter;", after);
        Assert.Contains("Combine(Next(), Next())", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task MethodGroupUseIsRefused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var r = await PrepareAtAsync(c, Action, file, "static int Twice", 11, Sig(new { from = 0, name = "value" }));
        // Twice is used as a method group in All: it could not be updated.
        Unavailable(r, "MethodGroupUse");
    }

    [Fact]
    public async Task ReorderOfSideEffectingArgumentsKeepsEvaluationOrder()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "static int Combine", 11, Sig(new { from = 1, name = "b" }, new { from = 0, name = "a" })));
        var after = After(plan, file);
        Assert.Contains("public static int Combine(int b, int a) => a - b;", after);
        Assert.Contains("Combine(a: Next(), b: Next())", after);
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task ReorderPreservesReadsAroundMutatingCalls()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Lib(dir, "ChangeSignature/EvaluationOrder.cs");
        var before = File.ReadAllText(file);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "int Combine(int a", 4,
            Sig(new { from = 1, name = "b" }, new { from = 0, name = "a" })));
        var after = After(plan, file);

        static int[] Run(string source)
        {
            var compilation = CSharpCompilation.Create("SignatureEvaluation" + Guid.NewGuid().ToString("N"),
                new[] { CSharpSyntaxTree.ParseText(source) },
                new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = new MemoryStream();
            var emitted = compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));
            var type = Assembly.Load(stream.ToArray()).GetType("SignatureEvaluationOrder")!;
            return new[] { "ReadBeforeMutation", "MutationBeforeRead", "CapturedLocal" }
                .Select(name => (int)type.GetMethod(name)!.Invoke(null, null)!).ToArray();
        }

        var expected = Run(before);
        Assert.Equal(new[] { 1, 11, 1 }, expected);
        Assert.Equal(expected, Run(after));
    }

    [Fact]
    public async Task RemovalRefusals()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        Unavailable(await PrepareAtAsync(c, Action, file, "static int Ignore", 11, Sig(new { from = 0, name = "a" })), "ArgumentHasSideEffects");
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "name" })), "ParameterUsed");
        var overload = await PrepareAtAsync(c, Action, file, "static string Show(int v, int pad)", 14, Sig(new { from = 0, name = "v" }));
        Assert.Equal("unavailable", overload.GetProperty("kind").GetString());
        Assert.Contains(overload.GetProperty("reasonCode").GetString(), new[] { "ParameterUsed", "OverloadResolutionChange", "CompilationErrors" });
    }

    [Fact]
    public async Task InvalidInputIsRefused()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "name" }, new { from = 1, name = "times" })), "NoChanges");
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "name" }, new { from = 1, name = "name" })), "DuplicateParameter");
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "name" }, new { from = 1, name = "times" }, new { name = "x", type = "int" })), "MissingValue");
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "name" }, new { from = 1, name = "times" }, new { name = "x", type = "int(", callSiteValue = "1" })), "InvalidType");
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "times" }, new { from = 1, name = "count" })), "NameInUse");
        // Renaming to a name used in the body could change what that name means.
        Unavailable(await PrepareAtAsync(c, Action, file, "virtual string Greet", 15, Sig(new { from = 0, name = "Enumerable" }, new { from = 1, name = "times" })), "NameInUse");
    }

    [Fact]
    public async Task ConstructorAndInitializerCallsAreUpdated()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "public Point(int x", 7, Sig(new { from = 1, name = "y" }, new { from = 0, name = "x" })));
        var after = After(plan, file);
        Assert.Contains("public Point(int y, int x)", after);
        Assert.Contains("new Point(1, 0)", after);
        Assert.Contains(": base(3, 2)", after);
        Assert.Contains("new Point(5, 4)", After(plan, App(dir, "Program.cs")));
        await ApplyToDiskAsync(c, plan);
        await AssertBuildsAsync(dir);
    }

    [Fact]
    public async Task ExtensionAndParamsCallsAreUpdated()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plus = Prepared(await PrepareAtAsync(c, Action, file, "static int Plus", 11,
            Sig(new { from = 0, name = "x" }, new { from = 1, name = "y" }, new { name = "z", type = "int", callSiteValue = "0" })));
        Assert.Contains("5.Plus(3, 0)", After(plus, file));
        var sum = Prepared(await PrepareAtAsync(c, Action, file, "static int SumAll", 11,
            Sig(new { from = 0, name = "label" }, new { name = "flag", type = "bool", callSiteValue = "false" }, new { from = 1, name = "values" })));
        var after = After(sum, file);
        Assert.Contains("SumAll(string label, bool flag, params int[] values)", after);
        Assert.Contains("SumAll(\"x\", false, 1, 2, 3)", after);
        Unavailable(await PrepareAtAsync(c, Action, file, "static int SumAll", 11, Sig(new { from = 1, name = "values" }, new { from = 0, name = "label" })), "ParamsArray");
    }

    [Fact]
    public async Task DynamicCallsMakeThePlanLimited()
    {
        var (c, dir) = await OpenAsync();
        await using var _ = c;
        var file = Greeter(dir);
        var plan = Prepared(await PrepareAtAsync(c, Action, file, "void Run(int a)", 5, Sig(new { from = 0, name = "a" }, new { name = "b", type = "int", callSiteValue = "0" })));
        Assert.Equal("limited", plan.GetProperty("validation").GetProperty("status").GetString());
        Assert.Contains("dynamic member access .Run", Limitations(plan));
        Assert.Contains("new Dyn().Run(2, 0)", After(plan, file));
    }
}
