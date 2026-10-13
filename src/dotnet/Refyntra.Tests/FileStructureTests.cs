using Microsoft.CodeAnalysis;
using Refyntra.Semantics;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// File Structure (code/fileStructure, protocol 1.13) on in-memory solutions: types in source order (nested, partial),
/// member kinds / accessibility / static / signatures, #region grouping, records, generics and inherited members from
/// base classes and base interfaces in the solution and from metadata.
/// </summary>
public sealed class FileStructureTests
{
    private const string Base = """
        using System;
        namespace Lib;

        public abstract class Entity<TKey>
        {
            public TKey Id { get; protected set; } = default!;
            protected DateTime Created;
            private int _secret;
            internal int Hidden;
            public virtual string Describe() => Id!.ToString()!;
            public abstract void Validate();
            public static Entity<TKey>? Empty => null;
            public event EventHandler? Changed;
            protected void Raise() => Changed?.Invoke(this, EventArgs.Empty);
        }

        public interface IReadable { string Read(); }
        public interface IStore : IReadable { void Write(string value); int Count { get; } }
        """;

    private const string Order = """
        using System;
        using System.Collections.Generic;
        using Lib;
        namespace App;

        public partial class Order : Entity<int>, IDisposable
        {
            #region Fields
            public const int MaxLines = 10;
            private readonly List<string> _lines = new();
            public static int Created2;
            #endregion

            public Order(int id) { Id = id; }
            ~Order() { }

            #region Queries
            public int this[int index] => index;
            public decimal Total { get; set; }
            #region Nested region
            public IEnumerable<T> Lines<T>(Func<string, T> map) { foreach (var l in _lines) yield return map(l); }
            #endregion
            #endregion

            public override string Describe() => "order";
            public event EventHandler<string>? Shipped, Cancelled;
            public static Order operator +(Order a, Order b) => a;
            public static implicit operator int(Order o) => o.Id;
            public void Dispose() { }

            public class Line
            {
                public string Sku { get; init; } = "";
                public enum State { Open = 1, Closed = 2 }
            }
        }

        public record OrderDto(int Id, string? Customer)
        {
            public string Label => $"{Id}";
        }

        public readonly record struct Money(decimal Amount);

        public delegate void OrderHandler(Order order, ref int count);

        public sealed class Result<T>
        {
            public T Value { get; }
            public Result(T value) => Value = value;
            public Result<TOut> Map<TOut>(Func<T, TOut> f) => new(f(Value));
        }

        public class AppException : Exception
        {
            public override string Message => "app";
        }

        public interface IOrderStore : IStore
        {
            Order? Find(int id);
            new string Read();
        }
        """;

    private const string OrderPart = """
        namespace App;

        public partial class Order
        {
            public override void Validate() { }
            public int Lines2 => 0;
        }
        """;

    private static async Task<FileStructureModel> StructureAsync(bool inherited = true)
    {
        var s = AdhocSolution.Create(("Lib", "Base.cs", Base, Array.Empty<string>()), ("App", "Order.cs", Order, new[] { "Lib" }), ("App", "Order.Part.cs", OrderPart, new[] { "Lib" }));
        var doc = s.Projects.SelectMany(p => p.Documents).Single(d => d.Name == "Order.cs");
        var compilation = await doc.Project.GetCompilationAsync();
        Assert.Empty(compilation!.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
        var model = await FileStructure.ComputeAsync(doc, inherited, CancellationToken.None);
        Assert.NotNull(model);
        return model!;
    }

    private static StructureType Type(FileStructureModel m, string fullName) => Assert.Single(m.Types, t => t.FullName == fullName);

    [Fact]
    public async Task TypesInSourceOrderWithNestedTypesKindsAndSignatures()
    {
        var m = await StructureAsync(false);
        Assert.Equal(new[] { "Order", "Order.Line", "Order.Line.State", "OrderDto", "Money", "OrderHandler", "Result<T>", "AppException", "IOrderStore" }, m.Types.Select(t => t.FullName));
        Assert.Equal(new[] { "class", "class", "enum", "record", "recordStruct", "delegate", "class", "class", "interface" }, m.Types.Select(t => t.Kind));
        Assert.Equal("Order : Entity<int>, IDisposable", Type(m, "Order").Signature);
        Assert.Equal("Order", Type(m, "Order.Line").ContainingType);
        Assert.Equal("Order.Line", Type(m, "Order.Line").Signature);
        Assert.Equal("Order.Line", Type(m, "Order.Line.State").ContainingType);
        Assert.Equal("OrderHandler(Order, ref int) : void", Type(m, "OrderHandler").Signature);
        Assert.Equal(new[] { "Open = 1", "Closed = 2" }, Type(m, "Order.Line.State").Members.Select(x => x.Signature));
        Assert.All(Type(m, "Order.Line.State").Members, x => Assert.Equal("enumMember", x.Kind));
        Assert.All(m.Types, t => Assert.Empty(t.Inherited));
    }

    [Fact]
    public async Task MembersOfThisPartOnlyWithKindAccessibilityStaticAndSignature()
    {
        var m = await StructureAsync(false);
        var order = Type(m, "Order");
        var rows = order.Members.Select(x => $"{x.Kind} {x.Accessibility}{(x.IsStatic ? " static" : "")} {x.Signature}").ToList();
        Assert.Equal(new[]
        {
            "constant public static MaxLines : int",
            "field private _lines : List<string>",
            "field public static Created2 : int",
            "constructor public Order(int)",
            "destructor protected ~Order()",
            "indexer public this[int] : int",
            "property public Total : decimal",
            "method public Lines<T>(Func<string, T>) : IEnumerable<T>",
            "method public Describe() : string",
            "event public Shipped : EventHandler<string>?",
            "event public Cancelled : EventHandler<string>?",
            "operator public static operator +(Order, Order) : Order",
            "operator public static implicit operator int(Order)",
            "method public Dispose() : void",
        }, rows);
        // The other partial part (Order.Part.cs) is not listed here.
        Assert.DoesNotContain(order.Members, x => x.Name is "Validate" or "Lines2");
        var total = Assert.Single(order.Members, x => x.Name == "Total");
        Assert.Equal(total.SelectionRange.Start.Line, total.Range.Start.Line);
        Assert.True(total.SelectionRange.Start.Character > total.Range.Start.Character);
    }

    [Fact]
    public async Task RegionsAreNamedAndTheInnermostOneIsTheMembersRegion()
    {
        var m = await StructureAsync(false);
        Assert.Equal(new[] { "Fields", "Queries", "Nested region" }, m.Regions.Select(r => r.Name));
        var order = Type(m, "Order");
        string? Region(string name) => order.Members.First(x => x.Name == name).Region;
        Assert.Equal("Fields", Region("MaxLines"));
        Assert.Equal("Fields", Region("_lines"));
        Assert.Null(Region(".ctor"));
        Assert.Equal("Queries", Region("Total"));
        Assert.Equal("Nested region", Region("Lines"));
        Assert.Null(Region("Describe"));
    }

    [Fact]
    public async Task RecordsListTheirPositionalPropertiesAndGenericsTheirTypeParameters()
    {
        var m = await StructureAsync(false);
        Assert.Equal(new[] { "property public Id : int", "property public Customer : string?", "property public Label : string" },
            Type(m, "OrderDto").Members.Select(x => $"{x.Kind} {x.Accessibility} {x.Signature}"));
        Assert.Equal(new[] { "Amount : decimal" }, Type(m, "Money").Members.Select(x => x.Signature));
        Assert.Equal(new[] { "Value : T", "Result(T)", "Map<TOut>(Func<T, TOut>) : Result<TOut>" }, Type(m, "Result<T>").Members.Select(x => x.Signature));
    }

    [Fact]
    public async Task InheritedFromBaseClassesInTheSolutionNearestFirstWithoutOverriddenOrInaccessibleOnes()
    {
        var m = await StructureAsync();
        var inherited = Type(m, "Order").Inherited;
        // Describe is overridden here, Validate in the other partial part; _secret is private, Hidden internal to Lib.
        Assert.Equal(new[] { "Id", "Created", "Empty", "Changed", "Raise" }, inherited.Select(x => x.Name));
        Assert.All(inherited, x =>
        {
            Assert.Equal("Entity<int>", x.DeclaringType);
            Assert.True(x.Navigable);
            Assert.EndsWith("Base.cs", x.FilePath);
        });
        var id = inherited[0];
        Assert.Equal("Id : int", id.Signature);
        Assert.Equal(5, id.SelectionRange.Start.Line);
        Assert.Equal("protected", inherited.Single(x => x.Name == "Created").Accessibility);
        Assert.True(inherited.Single(x => x.Name == "Empty").IsStatic);
        // Nothing from object (ToString, Equals…) is listed.
        Assert.DoesNotContain(inherited, x => x.Name is "ToString" or "GetHashCode");
    }

    [Fact]
    public async Task InheritedFromMetadataAreListedButNotNavigable()
    {
        var m = await StructureAsync();
        var inherited = Type(m, "AppException").Inherited;
        Assert.DoesNotContain(inherited, x => x.Name == "Message"); // overridden
        var source = Assert.Single(inherited, x => x.Name == "StackTrace");
        Assert.Equal("Exception", source.DeclaringType);
        Assert.False(source.Navigable);
        Assert.Null(source.FilePath);
    }

    [Fact]
    public async Task InterfacesInheritTheMembersOfTheirBaseInterfaces()
    {
        var m = await StructureAsync();
        var store = Type(m, "IOrderStore");
        Assert.Equal(new[] { "method public Find(int) : Order?", "method public Read() : string" }, store.Members.Select(x => $"{x.Kind} {x.Accessibility} {x.Signature}"));
        // Read is redeclared (new) here: only IStore's Write and Count, and nothing from IReadable.
        Assert.Equal(new[] { "IStore.Write", "IStore.Count" }, store.Inherited.Select(x => $"{x.DeclaringType}.{x.Name}"));
        Assert.All(store.Inherited, x => Assert.True(x.Navigable));
        // Records and structs: nothing synthesized is listed as inherited.
        Assert.Empty(Type(m, "OrderDto").Inherited);
        Assert.Empty(Type(m, "Money").Inherited);
    }
}

/// <summary>code/fileStructure over the protocol on the Shop fixture.</summary>
[Collection("Shop")]
public sealed class FileStructureProtocolTests
{
    private readonly ShopFixture _f;
    private TestClient C => _f.Client;
    public FileStructureProtocolTests(ShopFixture f) => _f = f;

    [Fact]
    public async Task FileStructureOfOrderServices()
    {
        var snap = await C.BarrierAsync();
        var uri = UriPaths.ToUri(_f.File("Shop.Api", "Services", "OrderServices.cs"));
        var r = await C.RequestAsync("code/fileStructure", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri, includeInherited = true });
        var types = r.GetProperty("types").EnumerateArray().ToList();
        Assert.Equal("IOrderService", types[0].GetProperty("name").GetString());
        var service = types.Single(t => t.GetProperty("name").GetString() == "OrderService");
        Assert.Equal("OrderService : IOrderService", service.GetProperty("signature").GetString());
        var members = service.GetProperty("members").EnumerateArray().Select(x => x.GetProperty("signature").GetString()).ToList();
        Assert.Equal(new[] { "_orders : Dictionary<int, OrderDto>", "Find(int) : OrderDto?", "Create(string, decimal) : int" }, members);
        Assert.Equal("private", service.GetProperty("members")[0].GetProperty("accessibility").GetString());
        Assert.Empty(service.GetProperty("inherited").EnumerateArray());
        Assert.False(r.TryGetProperty("reasonCode", out var reason) && reason.ValueKind == System.Text.Json.JsonValueKind.String);
        var missing = await C.RequestAsync("code/fileStructure", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(_f.File("Shop.Api", "Nope.cs")) });
        Assert.Equal("DocumentNotFound", missing.GetProperty("reasonCode").GetString());
    }
}
