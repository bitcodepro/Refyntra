using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;

namespace Refyntra.Tests;

/// <summary>
/// Smart Step Into (code/stepIntoTargets, protocol 1.14): the calls of the stopped statement in execution order, where
/// each callee's body starts, and honest reasons for calls Refyntra cannot step into (metadata, abstract, delegates).
/// </summary>
public sealed class StepIntoTargetsTests
{
    private const string Calc = """
        using System;
        namespace Lib;

        public static class Calc
        {
            public static int Square(int x) => x * x;
            public static int Twice(int x)
            {
                return x * 2;
            }
            public static int Add(int a, int b)
            {
                var sum = a + b;
                return sum;
            }
            public static void Nothing() { }
        }

        public abstract class Shape
        {
            protected Shape(int sides) { Sides = sides; }
            public int Sides { get; }
            public abstract double Area();
            public virtual string Name() => "shape";
        }

        public sealed class Square : Shape
        {
            public Square() : base(4) { }
            public override double Area() => 1;
        }

        public interface IClock { DateTime Now(); }
        public static class Ext { public static int Plus(this int a, int b) => a + b; }
        """;

    private const string App = """
        using System;
        using Lib;
        namespace App;

        public class Runner
        {
            public int Run(IClock clock, Func<int, int> f)
            {
                var r = Calc.Add(Calc.Square(2), Calc.Twice(3));
                Calc.Nothing();
                var m = Math.Max(r, 1).Plus(2);
                Shape s = new Square();
                var a = s.Area() + s.Name().Length;
                var t = clock.Now();
                var g = f(r);
                Action later = () => Calc.Nothing();
                for (var i = 0; i < Calc.Twice(2); i++)
                {
                    r += Calc.Square(i);
                }
                return r + m;
            }
        }
        """;

    private static async Task<(Document doc, StepIntoTargetsModel model)> At(string needle)
    {
        var s = AdhocSolution.Create(("Lib", "Calc.cs", Calc, Array.Empty<string>()), ("App", "Runner.cs", App, new[] { "Lib" }));
        var doc = s.Projects.SelectMany(p => p.Documents).Single(d => d.Name == "Runner.cs");
        var compilation = await doc.Project.GetCompilationAsync();
        Assert.Empty(compilation!.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
        var text = await doc.GetTextAsync();
        var pos = text.Lines.GetLinePosition(App.IndexOf(needle, StringComparison.Ordinal));
        // The debugger reports the column where the statement starts; the line's indentation is skipped.
        var model = await StepIntoTargets.ComputeAsync(doc, new LinePosition(pos.Line, 0), CancellationToken.None);
        Assert.NotNull(model);
        return (doc, model!);
    }

    private static int LineOf(string text, string needle) => text.Substring(0, text.IndexOf(needle, StringComparison.Ordinal)).Count(c => c == '\n');

    [Fact]
    public async Task CallsInExecutionOrderWithTheFirstStatementOfEachBody()
    {
        var (_, m) = await At("var r = Calc.Add(");
        Assert.Equal(new[] { "Calc.Square(int)", "Calc.Twice(int)", "Calc.Add(int, int)" }, m.Targets.Select(t => t.Label));
        Assert.All(m.Targets, t => Assert.Null(t.Reason));
        Assert.All(m.Targets, t => Assert.EndsWith("Calc.cs", t.FilePath));
        // Expression body: the expression; block body: the first statement.
        Assert.Equal(LineOf(Calc, "=> x * x"), m.Targets[0].BreakAt!.Value.Line);
        Assert.Equal(LineOf(Calc, "return x * 2"), m.Targets[1].BreakAt!.Value.Line);
        Assert.Equal(LineOf(Calc, "var sum = a + b"), m.Targets[2].BreakAt!.Value.Line);
        Assert.Equal("Calc.Twice(3)", m.Targets[1].Detail);
        Assert.Equal(LineOf(App, "Calc.Nothing();"), m.NextStatement!.Value.Line);
        Assert.Equal(LineOf(App, "var r = Calc.Add("), m.Statement.Start.Line);
    }

    [Fact]
    public async Task EmptyBodyStopsAtTheClosingBrace()
    {
        var (_, m) = await At("Calc.Nothing();");
        var t = Assert.Single(m.Targets);
        Assert.Equal(LineOf(Calc, "public static void Nothing() { }"), t.BreakAt!.Value.Line);
        Assert.Equal(Calc.Split('\n')[t.BreakAt!.Value.Line].IndexOf('}'), t.BreakAt!.Value.Character);
    }

    [Fact]
    public async Task MetadataCallsAreListedWithoutABreakpointExtensionsResolveToTheirSource()
    {
        var (_, m) = await At("var m = Math.Max(");
        Assert.Equal(new[] { "Math.Max(int, int)", "Ext.Plus(int, int)" }, m.Targets.Select(t => t.Label));
        Assert.Equal(StepIntoTargets.Reasons.Metadata, m.Targets[0].Reason);
        Assert.Null(m.Targets[0].BreakAt);
        Assert.StartsWith("M:System.Math.Max(System.Int32,System.Int32)", m.Targets[0].DocumentationId);
        Assert.False(string.IsNullOrEmpty(m.Targets[0].AssemblyName));
        Assert.Null(m.Targets[1].Reason);
        Assert.Null(m.Targets[1].DocumentationId);
    }

    [Fact]
    public async Task ConstructorsStopAtTheirInitializer()
    {
        var (_, m) = await At("Shape s = new Square();");
        var t = Assert.Single(m.Targets);
        Assert.Equal("constructor", t.Kind);
        Assert.Equal(LineOf(Calc, ": base(4)"), t.BreakAt!.Value.Line);
    }

    [Fact]
    public async Task AbstractAndInterfaceCallsHaveNoBodyVirtualCallsAreMarked()
    {
        var (_, m) = await At("var a = s.Area()");
        Assert.Equal(new[] { "Shape.Area()", "Shape.Name()" }, m.Targets.Select(t => t.Label));
        Assert.Equal(StepIntoTargets.Reasons.NoBody, m.Targets[0].Reason);
        Assert.True(m.Targets[0].IsVirtual);
        Assert.Null(m.Targets[1].Reason);
        Assert.True(m.Targets[1].IsVirtual);
        var (_, i) = await At("var t = clock.Now();");
        Assert.Equal(StepIntoTargets.Reasons.NoBody, Assert.Single(i.Targets).Reason);
    }

    [Fact]
    public async Task DelegatesAreNotSteppedIntoLambdaBodiesAreNotCallsOfTheStatement()
    {
        var (_, m) = await At("var g = f(r);");
        Assert.Equal(StepIntoTargets.Reasons.Delegate, Assert.Single(m.Targets).Reason);
        var (_, l) = await At("Action later");
        Assert.Empty(l.Targets);
    }

    [Fact]
    public async Task ALoopHeaderListsItsConditionNotItsBody()
    {
        var (_, m) = await At("for (var i = 0;");
        Assert.Equal(new[] { "Calc.Twice(int)" }, m.Targets.Select(t => t.Label));
        var (_, body) = await At("r += Calc.Square(i);");
        Assert.Equal(new[] { "Calc.Square(int)" }, body.Targets.Select(t => t.Label));
        Assert.Null(body.NextStatement); // the last statement of a loop body: no statement follows in this block
    }

    [Fact]
    public async Task TheLastStatementOfAMethodEndsAtTheClosingBrace()
    {
        var (_, m) = await At("return r + m;");
        Assert.Empty(m.Targets);
        Assert.Equal(LineOf(App, "return r + m;") + 1, m.NextStatement!.Value.Line);
    }
}
