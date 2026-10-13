using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// In-memory Roslyn solutions for the usage classification (code/usages, protocol 1.12) and the Navigate To targets
/// (code/hierarchy "bases" / "containing"). No MSBuild: an AdhocWorkspace with the runtime's reference assemblies.
/// </summary>
internal static class AdhocSolution
{
    private static readonly MetadataReference[] Refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
        .Split(Path.PathSeparator)
        .Where(p => Path.GetFileName(p) is "System.Runtime.dll" or "System.Private.CoreLib.dll" or "System.Collections.dll" or "netstandard.dll" or "System.Linq.dll")
        .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToArray();

    /// <summary>A fake xUnit (assembly name and attribute identity like the real one) for test detection.</summary>
    private const string FakeXunit = "namespace Xunit { public class FactAttribute : System.Attribute { } }";

    public static Solution Create(params (string project, string file, string text, string[] references)[] docs)
    {
        var ws = new AdhocWorkspace();
        var solution = ws.CurrentSolution;
        var ids = new Dictionary<string, ProjectId>();
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable);
        var parse = new CSharpParseOptions(LanguageVersion.Latest);
        ProjectId Project(string name)
        {
            if (ids.TryGetValue(name, out var id)) return id;
            id = ProjectId.CreateNewId(name);
            solution = solution.AddProject(ProjectInfo.Create(id, VersionStamp.Default, name, name, LanguageNames.CSharp,
                compilationOptions: options, parseOptions: parse, metadataReferences: Refs));
            ids[name] = id;
            return id;
        }
        var xunit = Project("xunit.core");
        solution = solution.AddDocument(DocumentId.CreateNewId(xunit), "Fact.cs", SourceText.From(FakeXunit), filePath: Path.Combine(Root, "xunit", "Fact.cs"));
        foreach (var (project, file, text, _) in docs)
        {
            var pid = Project(project);
            solution = solution.AddDocument(DocumentId.CreateNewId(pid), file, SourceText.From(text), filePath: Path.Combine(Root, project, file));
        }
        foreach (var (project, _, _, references) in docs)
        foreach (var r in references)
            if (!solution.GetProject(ids[project])!.ProjectReferences.Any(x => x.ProjectId == ids[r]))
                solution = solution.AddProjectReference(ids[project], new ProjectReference(ids[r]));
        return solution;
    }

    public static readonly string Root = Path.Combine(Path.GetTempPath(), "refyntra-adhoc");

    /// <summary>The symbol declared or referenced at the first occurrence of <paramref name="needle"/> (plus offset) in <paramref name="file"/>.</summary>
    public static async Task<ISymbol> SymbolAsync(Solution solution, string file, string needle, int offset)
    {
        var doc = solution.Projects.SelectMany(p => p.Documents).Single(d => d.Name == file);
        var text = (await doc.GetTextAsync()).ToString();
        var at = text.IndexOf(needle, StringComparison.Ordinal);
        Assert.True(at >= 0, needle);
        var s = await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder.FindSymbolAtPositionAsync(doc, at + offset);
        Assert.NotNull(s);
        return s!;
    }
}

/// <summary>code/usages: one kind per usage; partial classes, generics, properties, compound assignment, nameof, attributes, inheritance, tests.</summary>
public sealed class UsageClassifierTests
{
    private const string Lib = """
        using System;
        using System.Collections.Generic;
        namespace Demo;

        public interface IShape { double Area(); }

        public partial class Order : IShape
        {
            public int Count;
            public string Name { get; set; } = "";
            public event EventHandler? Changed;
            public double Area() => Count;
            public static T Make<T>() where T : new() => new T();
        }

        public partial class Order
        {
            public void Touch() { Count++; Changed?.Invoke(this, EventArgs.Empty); }
        }

        public sealed class MarkAttribute : Attribute { }

        public class SpecialOrder : Order { }

        public class Box<T> { }
        """;

    private const string App = """
        using System;
        using System.Collections.Generic;
        namespace Demo;

        [Mark]
        public class Uses
        {
            public void Run(ref int r, out int o)
            {
                var order = new Order();
                Order other = new();
                order.Count = 1;
                order.Count += 2;
                var c = order.Count;
                order.Count--;
                Bump(ref order.Count);
                Read(out order.Count);
                order.Name = "x";
                var n = order.Name;
                order.Name += "y";
                order.Changed += (_, _) => { };
                order.Area();
                order.Touch();
                var list = new List<Order>();
                var box = new Box<Order[]>();
                var made = Order.Make<Order>();
                var label = nameof(Order.Count);
                var typeName = nameof(Order);
                (order.Count, c) = (3, 4);
                var shaped = new { order.Name };
                Func<double> f = order.Area;
                o = 0;
            }

            private static void Bump(ref int x) => x++;
            private static void Read(out int x) => x = 0;
        }
        """;

    private const string Tests = """
        namespace Demo.Tests;
        using Demo;

        public class OrderTests
        {
            [Xunit.Fact]
            public void Counts() { var o = new Order(); o.Count = 5; }
        }
        """;

    private static Solution Solution() => AdhocSolution.Create(
        ("Demo.Lib", "Order.cs", Lib, Array.Empty<string>()),
        ("Demo.App", "Uses.cs", App, new[] { "Demo.Lib" }),
        ("Demo.Tests", "OrderTests.cs", Tests, new[] { "Demo.Lib", "xunit.core" }));

    private static async Task<List<UsageHit>> UsagesAsync(Solution s, string file, string needle, int offset)
    {
        var symbol = await AdhocSolution.SymbolAsync(s, file, needle, offset);
        var model = await UsageClassifier.FindAsync(s, symbol, 0, CancellationToken.None);
        Assert.Equal(model.Items.Count, model.Total);
        return model.Items;
    }

    /// <summary>Usage kinds at the lines of Uses.cs that contain <paramref name="lineNeedle"/>.</summary>
    private static List<string> KindsOn(List<UsageHit> hits, string lineNeedle) =>
        hits.Where(h => h.LineText.Contains(lineNeedle, StringComparison.Ordinal)).Select(h => h.Kind).ToList();

    [Fact]
    public async Task FieldReadsWritesAndReadWrites()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public int Count;", 11);
        Assert.Equal(new[] { UsageKinds.Write }, KindsOn(hits, "order.Count = 1;"));
        Assert.Equal(new[] { UsageKinds.ReadWrite }, KindsOn(hits, "order.Count += 2;"));
        Assert.Equal(new[] { UsageKinds.Read }, KindsOn(hits, "var c = order.Count;"));
        Assert.Equal(new[] { UsageKinds.ReadWrite }, KindsOn(hits, "order.Count--;"));
        Assert.Equal(new[] { UsageKinds.ReadWrite }, KindsOn(hits, "Bump(ref order.Count);"));
        Assert.Equal(new[] { UsageKinds.Write }, KindsOn(hits, "Read(out order.Count);"));
        Assert.Equal(new[] { UsageKinds.NameOf }, KindsOn(hits, "nameof(Order.Count)"));
        Assert.Equal(new[] { UsageKinds.Write }, KindsOn(hits, "(order.Count, c) = (3, 4);"));
        // The other part of the partial class: Count++ in Touch().
        var touch = Assert.Single(hits, h => h.LineText.Contains("Count++", StringComparison.Ordinal));
        Assert.Equal(UsageKinds.ReadWrite, touch.Kind);
        Assert.Equal("Touch", touch.ContainingMember);
        Assert.Equal("Order", touch.ContainingType);
    }

    [Fact]
    public async Task PropertyGetSetAndCompoundAssignment()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public string Name", 14);
        Assert.Equal(new[] { UsageKinds.Write }, KindsOn(hits, "order.Name = \"x\";"));
        Assert.Equal(new[] { UsageKinds.Read }, KindsOn(hits, "var n = order.Name;"));
        Assert.Equal(new[] { UsageKinds.ReadWrite }, KindsOn(hits, "order.Name += \"y\";"));
        Assert.Equal(new[] { UsageKinds.Read }, KindsOn(hits, "new { order.Name }"));
    }

    [Fact]
    public async Task EventSubscriptionIsAWriteAndRaisingIsAnInvocation()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "event EventHandler? Changed", 20);
        Assert.Equal(new[] { UsageKinds.Write }, KindsOn(hits, "order.Changed +="));
        Assert.Equal(new[] { UsageKinds.Invocation }, KindsOn(hits, "Changed?.Invoke"));
    }

    [Fact]
    public async Task MethodInvocationsAndMethodGroups()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public double Area()", 14);
        Assert.Equal(new[] { UsageKinds.Invocation }, KindsOn(hits, "order.Area();"));
        Assert.Equal(new[] { UsageKinds.Other }, KindsOn(hits, "Func<double> f = order.Area;"));
        var generic = await UsagesAsync(Solution(), "Order.cs", "public static T Make<T>", 16);
        Assert.Equal(new[] { UsageKinds.Invocation }, KindsOn(generic, "Order.Make<Order>()"));
    }

    [Fact]
    public async Task TypeUsagesByShape()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public partial class Order : IShape", 21);
        Assert.Equal(new[] { UsageKinds.ObjectCreation }, KindsOn(hits, "var order = new Order();"));
        // Target-typed new() references the constructor, not the type: only the declared type is a usage of Order.
        Assert.Equal(new[] { UsageKinds.Other }, KindsOn(hits, "Order other = new();"));
        Assert.Equal(new[] { UsageKinds.TypeArgument }, KindsOn(hits, "new List<Order>()"));
        Assert.Equal(new[] { UsageKinds.TypeArgument }, KindsOn(hits, "new Box<Order[]>()"));
        Assert.Equal(new[] { UsageKinds.Other, UsageKinds.TypeArgument }, KindsOn(hits, "Order.Make<Order>()"));
        Assert.Equal(new[] { UsageKinds.NameOf }, KindsOn(hits, "nameof(Order)"));
        Assert.Equal(new[] { UsageKinds.Inheritance }, KindsOn(hits, "class SpecialOrder : Order"));
    }

    [Fact]
    public async Task InterfaceImplementationAndAttributes()
    {
        var s = Solution();
        var shape = await UsagesAsync(s, "Order.cs", "public interface IShape", 17);
        Assert.Equal(new[] { UsageKinds.Inheritance }, KindsOn(shape, "class Order : IShape"));
        var mark = await UsagesAsync(s, "Order.cs", "class MarkAttribute", 6);
        var attr = Assert.Single(mark, h => h.LineText.Trim() == "[Mark]");
        Assert.Equal(UsageKinds.Attribute, attr.Kind);
        Assert.Equal("Uses", attr.ContainingType);
        Assert.Null(attr.ContainingMember);
    }

    [Fact]
    public async Task TestUsagesAreMarked()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public int Count;", 11);
        var inTest = Assert.Single(hits, h => h.IsTest);
        Assert.Equal("Demo.Tests", inTest.Project.Name);
        Assert.Equal("Counts", inTest.ContainingMember);
        Assert.Equal(UsageKinds.Write, inTest.Kind);
        Assert.All(hits.Where(h => h.Project.Name != "Demo.Tests"), h => Assert.False(h.IsTest));
    }

    [Fact]
    public async Task ResultsAreCappedWithTheTotal()
    {
        var s = Solution();
        var symbol = await AdhocSolution.SymbolAsync(s, "Order.cs", "public int Count;", 11);
        var all = await UsageClassifier.FindAsync(s, symbol, 0, CancellationToken.None);
        var two = await UsageClassifier.FindAsync(s, symbol, 2, CancellationToken.None);
        Assert.Equal(2, two.Items.Count);
        Assert.True(two.Truncated);
        Assert.Equal(all.Total, two.Total);
        Assert.False(all.Truncated);
        Assert.Equal(all.Items.Take(2).Select(h => h.Location.SourceSpan), two.Items.Select(h => h.Location.SourceSpan));
    }

    [Fact]
    public async Task LineTextIsTheWholeLineAndTheRangeIsTheName()
    {
        var hits = await UsagesAsync(Solution(), "Order.cs", "public int Count;", 11);
        var h = Assert.Single(hits, x => x.LineText.Contains("var c = order.Count;", StringComparison.Ordinal));
        Assert.StartsWith("        ", h.LineText);
        Assert.Equal("Count", h.LineText.Substring(h.Span.Start.Character, h.Span.End.Character - h.Span.Start.Character));
    }
}

/// <summary>Navigate To targets computed on the host: base symbols (types and members) and the containing type.</summary>
public sealed class NavigationTargetsTests
{
    private const string Code = """
        namespace Demo;
        public interface IEntity { int Id { get; } }
        public interface IAudited : IEntity { void Audit(); }
        public abstract class EntityBase : IAudited
        {
            public abstract int Id { get; }
            public virtual void Audit() { }
            public class Nested { public void Inner(int value) { var local = value; } }
        }
        public class Customer : EntityBase, System.IDisposable
        {
            public override int Id => 1;
            public override void Audit() { }
            void System.IDisposable.Dispose() { }
        }
        public class VipCustomer : Customer
        {
            public override void Audit() { base.Audit(); }
        }
        """;

    private static Solution S() => AdhocSolution.Create(("Demo", "Code.cs", Code, Array.Empty<string>()));

    private static async Task<List<string>> BasesAsync(string needle, int offset) =>
        NavigationTargets.Bases(await AdhocSolution.SymbolAsync(S(), "Code.cs", needle, offset)).Select(Describe).ToList();

    private static string Describe(ISymbol s) => s is INamedTypeSymbol ? s.Name : $"{s.ContainingType.Name}.{s.Name}";

    [Fact]
    public async Task TypeBasesAreBaseClassesNearestFirstThenSourceInterfaces()
    {
        Assert.Equal(new[] { "Customer", "EntityBase", "IAudited", "IEntity" }, await BasesAsync("class VipCustomer", 6));
        // System.IDisposable is metadata (no document): left out.
        Assert.Equal(new[] { "EntityBase", "IAudited", "IEntity" }, await BasesAsync("class Customer", 6));
    }

    [Fact]
    public async Task MemberBasesAreTheOverriddenChainAndInterfaceMembers()
    {
        Assert.Equal(new[] { "Customer.Audit", "EntityBase.Audit", "IAudited.Audit" }, await BasesAsync("public override void Audit() { base", 21));
        Assert.Equal(new[] { "EntityBase.Audit", "IAudited.Audit" }, await BasesAsync("public override void Audit() { }", 21));
        Assert.Equal(new[] { "IAudited.Audit" }, await BasesAsync("public virtual void Audit()", 20));
        Assert.Equal(new[] { "EntityBase.Id", "IEntity.Id" }, await BasesAsync("public override int Id", 20));
        Assert.Empty(await BasesAsync("void System.IDisposable.Dispose", 24));
    }

    [Fact]
    public async Task ContainingTypeOfMembersNestedTypesAndLocals()
    {
        var s = S();
        string? Containing(ISymbol x) => NavigationTargets.Containing(x).Select(c => c.Name).SingleOrDefault();
        Assert.Equal("Customer", Containing(await AdhocSolution.SymbolAsync(s, "Code.cs", "public override int Id", 20)));
        Assert.Equal("EntityBase", Containing(await AdhocSolution.SymbolAsync(s, "Code.cs", "public class Nested", 13)));
        Assert.Equal("Nested", Containing(await AdhocSolution.SymbolAsync(s, "Code.cs", "var local", 4)));
        Assert.Equal("Nested", Containing(await AdhocSolution.SymbolAsync(s, "Code.cs", "int value)", 4)));
        Assert.Null(Containing(await AdhocSolution.SymbolAsync(s, "Code.cs", "class Customer", 6)));
    }
}

/// <summary>code/usages and the new hierarchy directions over the protocol on the Shop fixture.</summary>
[Collection("Shop")]
public sealed class UsagesProtocolTests
{
    private readonly ShopFixture _f;
    private TestClient C => _f.Client;
    public UsagesProtocolTests(ShopFixture f) => _f = f;

    private string Services => _f.File("Shop.Api", "Services", "OrderServices.cs");

    private async Task<(string snap, string symbolId)> AtAsync(string needle, int offset)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, Services, needle, offset);
        return (snap, s.GetProperty("symbolId").GetString()!);
    }

    [Fact]
    public async Task UsagesCarryKindContainerProjectAndLine()
    {
        var (snap, id) = await AtAsync("OrderDto? Find(int id);", 11);
        var r = await C.RequestAsync("code/usages", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = id });
        Assert.Equal("Find", r.GetProperty("subject").GetProperty("name").GetString());
        var items = r.GetProperty("items").EnumerateArray().ToList();
        Assert.NotEmpty(items);
        Assert.Equal(items.Count, r.GetProperty("total").GetInt32());
        Assert.False(r.GetProperty("truncated").GetBoolean());
        var call = Assert.Single(items, i => i.GetProperty("lineText").GetString()!.Contains("_orders.Find(request.Id)", StringComparison.Ordinal));
        Assert.Equal("invocation", call.GetProperty("kind").GetString());
        Assert.Equal("Handle", call.GetProperty("containingMember").GetString());
        Assert.Equal("Shop.Api", call.GetProperty("projectName").GetString());
        Assert.False(call.GetProperty("isTest").GetBoolean());
    }

    [Fact]
    public async Task UsagesLimitIsHonoured()
    {
        var (snap, id) = await AtAsync("public interface IOrderService", 17);
        var r = await C.RequestAsync("code/usages", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = id, limit = 1 });
        Assert.Single(r.GetProperty("items").EnumerateArray());
        Assert.True(r.GetProperty("total").GetInt32() > 1);
        Assert.True(r.GetProperty("truncated").GetBoolean());
    }

    [Fact]
    public async Task HierarchyBasesAndContaining()
    {
        var (snap, id) = await AtAsync("public OrderDto? Find(int id) => _orders", 17);
        var bases = await C.RequestAsync("code/hierarchy", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = id, direction = "bases" });
        var b = Assert.Single(bases.GetProperty("items").EnumerateArray());
        Assert.Equal("Find", b.GetProperty("symbol").GetProperty("name").GetString());
        Assert.EndsWith("IOrderService", b.GetProperty("symbol").GetProperty("containerName").GetString());
        var containing = await C.RequestAsync("code/hierarchy", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = id, direction = "containing" });
        Assert.Equal("OrderService", Assert.Single(containing.GetProperty("items").EnumerateArray()).GetProperty("symbol").GetProperty("name").GetString());
    }
}
