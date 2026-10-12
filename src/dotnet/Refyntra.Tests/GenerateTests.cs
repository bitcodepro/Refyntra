using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>One opened copy of the Refactorings fixture for the Generate tests (they never write files).</summary>
public sealed class GenerateFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Dir { get; private set; } = "";

    public async Task InitializeAsync() => (Client, Dir) = await RefactoringFixture.OpenAsync();

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

/// <summary>
/// code/generate (protocol 1.10): the Generate kinds for the type at the cursor and the compile-checked code of each
/// (constructor, Equals/GetHashCode, ToString, properties, missing / overriding / delegating members); partial types,
/// structs, records, generics, nullable annotations, added usings and refusals.
/// </summary>
public sealed class GenerateTests : IClassFixture<GenerateFixture>
{
    private readonly GenerateFixture _f;
    public GenerateTests(GenerateFixture f) => _f = f;

    private string Samples => RefactoringFixture.Lib(_f.Dir, "Generate/Samples.cs");
    private string Part => RefactoringFixture.Lib(_f.Dir, "Generate/OrderPart.cs");

    private async Task<JsonElement> RequestAsync(string file, string needle, object? extra, string? text = null)
    {
        text ??= await File.ReadAllTextAsync(file);
        var (line, ch) = TestClient.Position(text, needle, 2);
        var snap = await _f.Client.BarrierAsync();
        var p = new Dictionary<string, object?>
        {
            ["traceId"] = "t", ["workspaceId"] = _f.Client.WorkspaceId, ["snapshotId"] = snap, ["uri"] = UriPaths.ToUri(file),
            ["position"] = new { line, character = ch },
        };
        if (extra != null) foreach (var pr in extra.GetType().GetProperties()) p[pr.Name] = pr.GetValue(extra);
        return await _f.Client.RequestAsync("code/generate", p);
    }

    private async Task<Dictionary<string, List<JsonElement>>> KindsAsync(string file, string needle)
    {
        var r = await RequestAsync(file, needle, null);
        return r.GetProperty("kinds").EnumerateArray().ToDictionary(k => k.GetProperty("kind").GetString()!, k => k.GetProperty("members").EnumerateArray().ToList());
    }

    private static string Apply(string text, JsonElement edits)
    {
        var lines = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++) if (text[i] == '\n') lines.Add(i + 1);
        int Off(JsonElement p) => lines[p.GetProperty("line").GetInt32()] + p.GetProperty("character").GetInt32();
        foreach (var e in edits.EnumerateArray().OrderByDescending(e => Off(e.GetProperty("range").GetProperty("start"))))
            text = text[..Off(e.GetProperty("range").GetProperty("start"))] + e.GetProperty("newText").GetString() + text[Off(e.GetProperty("range").GetProperty("end"))..];
        return text.Replace("\r\n", "\n");
    }

    private async Task<string> GenerateAsync(string file, string needle, object options, string? text = null)
    {
        var r = await RequestAsync(file, needle, options, text);
        Assert.True(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        return Apply(text ?? await File.ReadAllTextAsync(file), edits);
    }

    private async Task RefusedAsync(string file, string needle, object options, string reason)
    {
        var r = await RequestAsync(file, needle, options);
        Assert.False(r.TryGetProperty("edits", out var edits) && edits.ValueKind == JsonValueKind.Array, r.ToString());
        Assert.Equal(reason, r.GetProperty("reasonCode").GetString());
    }

    private static void Has(string expected, string actual)
    {
        if (!actual.Contains(expected, StringComparison.Ordinal)) File.WriteAllText(Path.Combine(Path.GetTempPath(), "refyntra-gen-" + Guid.NewGuid().ToString("N")[..6] + ".txt"), expected + "\n=====\n" + actual);
        Assert.True(actual.Contains(expected, StringComparison.Ordinal), $"expected:\n{expected}\n---- actual:\n{actual}");
    }

    private static string Between(string text, string from, string to)
    {
        var s = text.IndexOf(from, StringComparison.Ordinal);
        var e = text.IndexOf(to, s + from.Length, StringComparison.Ordinal);
        return text[s..e];
    }

    [Fact]
    public async Task ListsTheKindsThatApplyToTheTypeAtTheCursor()
    {
        var person = await KindsAsync(Samples, "class Person");
        Assert.Equal(new[] { "constructor", "equality", "toString", "properties", "overrides", "delegating" }, person.Keys);
        var ctor = person["constructor"].ToDictionary(m => m.GetProperty("id").GetString()!, m => m.GetProperty("picked").GetBoolean());
        Assert.Equal(new[] { "_name", "_age", "Email", "Tags" }, ctor.Keys);
        Assert.False(ctor["_name"]); // has an initializer
        Assert.False(ctor["Tags"]);
        Assert.Equal(new[] { "_name" }, person["properties"].Select(m => m.GetProperty("id").GetString()).ToArray()); // Age exists for _age
        // A record has value equality and a primary constructor; Point is a struct.
        var money = await KindsAsync(Samples, "record Money");
        Assert.DoesNotContain("equality", money.Keys);
        Assert.DoesNotContain("constructor", money.Keys);
        Assert.Contains("toString", money.Keys);
        Assert.Contains("equality", (await KindsAsync(Samples, "struct Point")).Keys);
        // An interface or a position outside a type: nothing.
        Assert.Empty(await KindsAsync(Samples, "interface IShape"));
        Assert.Empty(await KindsAsync(Samples, "namespace Refactorings"));
    }

    [Fact]
    public async Task ConstructorAssignsThePickedMembersWithParameterNamesFromTheMembers()
    {
        var after = await GenerateAsync(Samples, "class Person", new { kind = "constructor", members = new[] { "_age", "Email", "_name" } });
        Has(
            "    public int Age => _age;\n\n    public Person(string name, int age, string? email)\n    {\n        _name = name;\n        _age = age;\n        Email = email;\n    }\n",
            after);
    }

    [Fact]
    public async Task PartialTypesOfferMembersOfEveryPartAndGenerateIntoThePartAtTheCursor()
    {
        var kinds = await KindsAsync(Part, "partial class Order");
        // The part at the cursor first.
        Assert.Equal(new[] { "_total", "_id" }, kinds["constructor"].Select(m => m.GetProperty("id").GetString()).ToArray());
        var after = await GenerateAsync(Part, "partial class Order", new { kind = "constructor", members = new[] { "_id", "_total" } });
        Has("    private readonly decimal _total;\n\n    public Order(decimal total, int id)\n    {\n        _total = total;\n        _id = id;\n    }\n", after);
    }

    [Fact]
    public async Task EqualityWithIEquatableOperatorsAndHashCodeCombine()
    {
        var after = await GenerateAsync(Samples, "class Person", new { kind = "equality", members = new[] { "_name", "_age", "Email" }, equatable = true, operators = true });
        Has("public class Person : IEquatable<Person>\n{", after);
        var person = Between(after, "public class Person", "public partial class Order");
        Has("    public bool Equals(Person? other)\n    {\n        if (other is null) return false;\n        if (ReferenceEquals(this, other)) return true;\n        return _name == other._name && _age == other._age && Email == other.Email;\n    }", person);
        Has("    public override bool Equals(object? obj)\n    {\n        if (obj is null) return false;\n        if (ReferenceEquals(this, obj)) return true;\n        if (obj.GetType() != GetType()) return false;\n        return Equals((Person)obj);\n    }", person);
        Has("        return HashCode.Combine(_name, _age, Email);", person);
        Has("    public static bool operator ==(Person? left, Person? right)\n    {\n        return Equals(left, right);\n    }", person);
        Has("public static bool operator !=(Person? left, Person? right)", person);
    }

    [Fact]
    public async Task StructEqualityWithoutIEquatableUsesAPattern()
    {
        var after = await GenerateAsync(Samples, "struct Point", new { kind = "equality", members = new[] { "X", "Y" } });
        var point = Between(after, "public struct Point", "public record Money");
        Has("    public override bool Equals(object? obj)\n    {\n        return obj is Point other && X == other.X && Y == other.Y;\n    }", point);
        Has("return HashCode.Combine(X, Y);", point);
        Assert.DoesNotContain("IEquatable", point);
    }

    [Fact]
    public async Task GenericEqualityAddsUsingsAndComparesTypeParametersWithEqualityComparer()
    {
        var after = await GenerateAsync(Part, "class Box", new { kind = "equality", members = new[] { "_value", "_size" }, equatable = true });
        Has("using System;\nusing System.Collections.Generic;\n", after);
        Has("public class Box<T> : IEquatable<Box<T>>", after);
        Has("return EqualityComparer<T>.Default.Equals(_value, other._value) && _size == other._size;", after);
        Has("public bool Equals(Box<T>? other)", after);
    }

    [Fact]
    public async Task ToStringUsesNameofAndInterpolation()
    {
        var after = await GenerateAsync(Samples, "class Person", new { kind = "toString", members = new[] { "_age", "Email" } });
        Has("    public override string ToString()\n    {\n        return $\"{nameof(_age)}: {_age}, {nameof(Email)}: {Email}\";\n    }\n}", after);
        var money = await GenerateAsync(Samples, "record Money", new { kind = "toString", members = new[] { "Amount" } });
        Has("public record Money(decimal Amount, string Currency)\n{\n    public override string ToString()\n    {\n        return $\"{nameof(Amount)}: {Amount}\";\n    }\n}", money);
    }

    [Fact]
    public async Task PropertiesFromFieldsAreReadOnlyForReadOnlyFields()
    {
        var after = await GenerateAsync(Samples, "class Person", new { kind = "properties", members = new[] { "_name" } });
        Has("    public string Name => _name;\n}", after);
        // Public fields X and Y already have property-style names: nothing to generate.
        Assert.DoesNotContain("properties", (await KindsAsync(Samples, "struct Point")).Keys);
    }

    [Fact]
    public async Task ImplementsMissingInterfaceAndAbstractMembers()
    {
        var text = (await File.ReadAllTextAsync(Samples)).Replace("public class Circle\n", "public class Circle : ShapeBase, IShape\n").Replace("public class Circle\r\n", "public class Circle : ShapeBase, IShape\r\n");
        await _f.Client.DidOpenAsync(Samples, text);
        try
        {
            var r = await RequestAsync(Samples, "class Circle", null, text);
            var implement = r.GetProperty("kinds").EnumerateArray().First(k => k.GetProperty("kind").GetString() == "implement");
            Assert.Equal(4, implement.GetProperty("members").GetArrayLength());
            var after = await GenerateAsync(Samples, "class Circle", new { kind = "implement" }, text);
            var circle = Between(after, "public class Circle", "public class Square");
            Has("    public double Area()\n    {\n        throw new NotImplementedException();\n    }", circle);
            Has("    public string Name\n    {\n        get => throw new NotImplementedException();\n    }", circle);
            Has("    public event EventHandler? Changed;", circle);
            Has("    public override double Perimeter()\n    {\n        throw new NotImplementedException();\n    }", circle);
        }
        finally
        {
            await _f.Client.DidCloseAsync(Samples);
        }
    }

    [Fact]
    public async Task OverridesCallTheBaseMember()
    {
        var kinds = await KindsAsync(Samples, "class Square");
        var names = kinds["overrides"].Select(m => m.GetProperty("name").GetString()).ToList();
        Assert.Contains(names, n => n!.Contains("Describe()"));
        Assert.Contains(names, n => n!.Contains("OnChanged(int code)"));
        Assert.Contains(names, n => n!.Contains("ToString()"));
        Assert.DoesNotContain(names, n => n!.Contains("Perimeter")); // already overridden
        var ids = kinds["overrides"].Where(m => m.GetProperty("name").GetString()!.Contains("Describe") || m.GetProperty("name").GetString()!.Contains("OnChanged")).Select(m => m.GetProperty("id").GetString()).ToArray();
        var after = await GenerateAsync(Samples, "class Square", new { kind = "overrides", members = ids });
        Has("    public override string Describe()\n    {\n        return base.Describe();\n    }", after);
        Has("    protected override void OnChanged(int code)\n    {\n        base.OnChanged(code);\n    }", after);
    }

    [Fact]
    public async Task DelegatingMembersGoThroughTheField()
    {
        var kinds = await KindsAsync(Samples, "class Service");
        var members = kinds["delegating"];
        Assert.All(members, m => Assert.Equal("_logger", m.GetProperty("group").GetString()));
        var ids = members.Select(m => m.GetProperty("id").GetString()).ToArray();
        Assert.Equal(2, ids.Length);
        var after = await GenerateAsync(Samples, "class Service", new { kind = "delegating", members = ids });
        Has("    public void Log(string message)\n    {\n        _logger.Log(message);\n    }", after);
        Has("    public int Count\n    {\n        get => _logger.Count;\n        set => _logger.Count = value;\n    }", after);
    }

    [Fact]
    public async Task RefusesDuplicatesUnknownMembersAndEmptySelections()
    {
        await RefusedAsync(Samples, "class WithCtor", new { kind = "constructor", members = new[] { "_a" } }, "CompilationErrors");
        await RefusedAsync(Samples, "class Person", new { kind = "toString", members = new[] { "Nope" } }, "UnknownMember");
        await RefusedAsync(Samples, "class Person", new { kind = "equality", members = Array.Empty<string>() }, "NoMembers");
        await RefusedAsync(Samples, "record Money", new { kind = "equality" }, "NotApplicable");
    }
}
