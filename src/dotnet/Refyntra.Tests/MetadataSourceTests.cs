using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics.Metadata;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Go to metadata (code/metadataSource, protocol 1.17) without MSBuild: a library compiled here with Roslyn (with and
/// without sources in its PDB) and the runtime's own assemblies; decompiling, embedded sources, caching, cancellation,
/// the symbol at a position inside a document, and reference-assembly to implementation mapping.
/// </summary>
public sealed class MetadataSourceServiceTests
{
    private const string LibSource = """
        using System;
        namespace FixtureLib
        {
            /// <summary>Adds numbers.</summary>
            public class Calculator
            {
                /// <summary>The sum of <paramref name="a"/> and <paramref name="b"/>.</summary>
                public int Add(int a, int b) => a + b;
                public Shape? Last { get; set; }
            }

            public interface IShape
            {
                double Area();
            }

            public abstract class Shape : IShape
            {
                public abstract double Area();
            }
        }
        """;

    private static readonly MetadataReference[] RuntimeRefs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
        .Split(Path.PathSeparator)
        .Where(p => Path.GetFileName(p) is "System.Runtime.dll" or "System.Private.CoreLib.dll" or "netstandard.dll" or "System.Collections.dll")
        .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToArray();

    /// <summary>Compiles FixtureLib into a fresh folder: "embedded" (PDB with sources inside the dll), "sidecar" (a .pdb with sources next to it) or "plain" (no sources).</summary>
    private static string BuildLibrary(string mode, string extra = "")
    {
        var source = LibSource + extra;
        var dir = Path.Combine(Path.GetTempPath(), "refyntra-metadata-tests", mode + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var path = "/_/src/FixtureLib/Calculator.cs";
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(source, System.Text.Encoding.UTF8), new CSharpParseOptions(LanguageVersion.Latest, DocumentationMode.Diagnose), path);
        var c = CSharpCompilation.Create("FixtureLib", new[] { tree }, RuntimeRefs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, deterministic: true));
        var dll = Path.Combine(dir, "FixtureLib.dll");
        using var pe = File.Create(dll);
        using var xml = File.Create(Path.Combine(dir, "FixtureLib.xml"));
        var embedded = mode == "plain" ? null : new[] { EmbeddedText.FromSource(path, SourceText.From(source, System.Text.Encoding.UTF8)) };
        EmitResult r;
        if (mode == "sidecar")
        {
            using var pdb = File.Create(Path.Combine(dir, "FixtureLib.pdb"));
            r = c.Emit(pe, pdb, xml, embeddedTexts: embedded, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb, pdbFilePath: "/_/obj/FixtureLib.pdb"));
        }
        else
        {
            r = c.Emit(pe, xmlDocumentationStream: xml, embeddedTexts: embedded, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.Embedded));
        }
        Assert.True(r.Success, string.Join("\n", r.Diagnostics));
        return dll;
    }

    private static Compilation Consumer(string libraryPath) =>
        CSharpCompilation.Create("App", new[] { CSharpSyntaxTree.ParseText("class App { FixtureLib.Calculator C = new(); string S = \"\"; }") },
            RuntimeRefs.Append(MetadataReference.CreateFromFile(libraryPath, documentation: XmlDocumentationProvider.CreateFromFile(Path.ChangeExtension(libraryPath, ".xml")))),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

    private static (int line, int character) At(MetadataDocument d, string needle, int offset = 0) => TestClient.Position(d.Text, needle, offset);

    [Fact]
    public async Task DecompilesALibraryTypeWithXmlDocsAndDeclarations()
    {
        var lib = BuildLibrary("plain");
        var c = Consumer(lib);
        var service = new MetadataSourceService();
        var calc = c.GetTypeByMetadataName("FixtureLib.Calculator")!;
        var doc = await service.GetDocumentAsync(calc.GetMembers("Add").Single(), c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        Assert.NotNull(doc);
        Assert.Equal("FixtureLib/FixtureLib.Calculator.cs", doc!.Path);
        Assert.Equal(MetadataDocument.Decompiled, doc.Origin);
        Assert.Equal("T:FixtureLib.Calculator", doc.TypeDocumentationId);
        Assert.Contains("public class Calculator", doc.Text);
        Assert.Contains("return a + b;", doc.Text);
        Assert.Contains("/// <summary>Adds numbers.</summary>", doc.Text);
        Assert.Contains("// Decompiled from FixtureLib.dll with ICSharpCode.Decompiler " + MetadataSourceService.DecompilerVersion, doc.Text);
        Assert.DoesNotContain(Path.GetDirectoryName(lib)!, doc.Text);
        var add = doc.Find("M:FixtureLib.Calculator.Add(System.Int32,System.Int32)");
        Assert.NotNull(add);
        var line = doc.Text.Split('\n')[add!.Name.Start.Line];
        Assert.Equal("Add", line.Substring(add.Name.Start.Character, add.Name.End.Character - add.Name.Start.Character));
        Assert.NotNull(doc.Find("P:FixtureLib.Calculator.Last"));
        Assert.Equal(add, doc.FindMember("Add"));
        // A getter has no declaration of its own: the property.
        Assert.Equal(doc.Find("P:FixtureLib.Calculator.Last"), doc.Find("M:FixtureLib.Calculator.get_Last"));
    }

    [Fact]
    public async Task EmbeddedSourceInThePdbIsPreferredUnlessThePolicyIsOff()
    {
        foreach (var mode in new[] { "embedded", "sidecar" })
        {
            var lib = BuildLibrary(mode);
            var c = Consumer(lib);
            var service = new MetadataSourceService();
            var calc = c.GetTypeByMetadataName("FixtureLib.Calculator")!;
            var doc = await service.GetDocumentAsync(calc, c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
            Assert.Equal(MetadataDocument.EmbeddedSource, doc!.Origin);
            Assert.Equal("/_/src/FixtureLib/Calculator.cs", doc.SourceDocument);
            Assert.Contains("public int Add(int a, int b) => a + b;", doc.Text);
            Assert.Contains("// Source embedded in the PDB of FixtureLib.dll: /_/src/FixtureLib/Calculator.cs", doc.Text);
            Assert.NotNull(doc.Find("M:FixtureLib.Calculator.Add(System.Int32,System.Int32)"));
            // An interface has no method bodies: its file comes from the type-to-document records.
            var shape = await service.GetDocumentAsync(c.GetTypeByMetadataName("FixtureLib.IShape")!, c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
            Assert.Equal(MetadataDocument.EmbeddedSource, shape!.Origin);
            Assert.Equal("FixtureLib/FixtureLib.IShape.cs", shape.Path);
            var off = await service.GetDocumentAsync(calc, c, SourcePolicy.Off, CancellationToken.None);
            Assert.Equal(MetadataDocument.Decompiled, off!.Origin);
            Assert.Contains("return a + b;", off.Text);
        }
    }

    [Fact]
    public async Task DocumentsAreCachedPerAssemblyMvidAndCancellationLeavesNothingBehind()
    {
        var lib = BuildLibrary("plain");
        var c = Consumer(lib);
        var service = new MetadataSourceService();
        var calc = c.GetTypeByMetadataName("FixtureLib.Calculator")!;
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetDocumentAsync(calc, c, SourcePolicy.EmbeddedOnly, cts.Token));
        Assert.Equal(0, service.Builds);
        Assert.Equal(0, service.CachedDocuments);
        var first = await service.GetDocumentAsync(calc, c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        var c1 = Consumer(lib);
        var again = await service.GetDocumentAsync(c1.GetTypeByMetadataName("FixtureLib.Calculator")!.GetMembers("Add").Single(), c1, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        Assert.Same(first, again);
        Assert.Equal(1, service.Builds);
        Assert.Equal(1, service.CachedAssemblies);
        // Another type of the same assembly reuses the decompiler of that MVID.
        await service.GetDocumentAsync(c.GetTypeByMetadataName("FixtureLib.Shape")!, c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        Assert.Equal(2, service.Builds);
        Assert.Equal(1, service.CachedAssemblies);
        // The same build (deterministic) has the same MVID: cached. A changed library has another MVID: a new document.
        var same = Consumer(BuildLibrary("plain"));
        Assert.Same(first, await service.GetDocumentAsync(same.GetTypeByMetadataName("FixtureLib.Calculator")!, same, SourcePolicy.EmbeddedOnly, CancellationToken.None));
        var rebuilt = BuildLibrary("plain", "namespace FixtureLib { public static class Extra { public const int V = 2; } }");
        var c2 = Consumer(rebuilt);
        var other = await service.GetDocumentAsync(c2.GetTypeByMetadataName("FixtureLib.Calculator")!, c2, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        Assert.Equal(first!.Text.Split('\n').Length, other!.Text.Split('\n').Length);
        Assert.Equal(3, service.Builds);
    }

    [Fact]
    public async Task SymbolAtMapsDeclarationsAndReferencesBackAndKeepsLocalsInTheDocument()
    {
        var lib = BuildLibrary("plain");
        var c = Consumer(lib);
        var doc = (await new MetadataSourceService().GetDocumentAsync(c.GetTypeByMetadataName("FixtureLib.Calculator")!, c, SourcePolicy.EmbeddedOnly, CancellationToken.None))!;
        var (l1, c1) = At(doc, "class Calculator", 6);
        var type = MetadataSourceService.SymbolAt(doc, c, new LinePosition(l1, c1), CancellationToken.None);
        Assert.True(type!.Symbol is INamedTypeSymbol { Name: "Calculator" } t && t.Locations.Single().IsInMetadata);
        var (l2, c2) = At(doc, "Shape? Last", 1);
        var shape = MetadataSourceService.SymbolAt(doc, c, new LinePosition(l2, c2), CancellationToken.None);
        Assert.Equal("T:FixtureLib.Shape", shape!.Symbol!.GetDocumentationCommentId());
        Assert.Equal("FixtureLib", shape.Symbol.ContainingAssembly.Name);
        var (l3, c3) = At(doc, "int a,", 4);
        var param = MetadataSourceService.SymbolAt(doc, c, new LinePosition(l3, c3), CancellationToken.None);
        Assert.Null(param!.Symbol);
        Assert.Equal(l3, param.LocalDeclaration!.Value.Start.Line);
        var (l4, c4) = At(doc, "int a,", 0);
        var keyword = MetadataSourceService.SymbolAt(doc, c, new LinePosition(l4, c4), CancellationToken.None);
        Assert.Equal("T:System.Int32", keyword!.Symbol!.GetDocumentationCommentId());
        var (l5, c5) = At(doc, "// MVID");
        Assert.Null(MetadataSourceService.SymbolAt(doc, c, new LinePosition(l5, c5 + 3), CancellationToken.None));
        Assert.Equal("Adds numbers.", MetadataSourceService.Summary(c.GetTypeByMetadataName("FixtureLib.Calculator")!, CancellationToken.None));
        Assert.Equal("The sum of a and b.", MetadataSourceService.Summary(c.GetTypeByMetadataName("FixtureLib.Calculator")!.GetMembers("Add").Single(), CancellationToken.None));
    }

    [Fact]
    public async Task RuntimeTypesAreDecompiledFromTheDefiningFile()
    {
        var c = Consumer(BuildLibrary("plain"));
        var service = new MetadataSourceService();
        var doc = await service.GetDocumentAsync(c.GetSpecialType(SpecialType.System_String), c, SourcePolicy.EmbeddedOnly, CancellationToken.None);
        Assert.NotNull(doc);
        Assert.EndsWith("System.Private.CoreLib.dll", doc!.ImplementationPath);
        Assert.Contains("public sealed class String", doc.Text);
        Assert.NotNull(doc.FindMember("Concat"));
        var list = c.GetTypeByMetadataName("System.Collections.Generic.List`1")!;
        var listDoc = await service.GetDocumentAsync(list.GetMembers("Add").Single(), c, SourcePolicy.Off, CancellationToken.None);
        Assert.Equal("System.Private.CoreLib/System.Collections.Generic.List`1.cs", listDoc!.Path);
        Assert.NotNull(listDoc.Find("M:System.Collections.Generic.List`1.Add(`0)"));
    }

    [Fact]
    public void ReferenceAssembliesOfATargetingPackMapToTheSharedFramework()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var root = Directory.GetParent(runtimeDir)!.Parent!.Parent!.FullName;
        var refPacks = Path.Combine(root, "packs", "Microsoft.NETCore.App.Ref");
        var major = Environment.Version.Major;
        var refDll = Directory.Exists(refPacks)
            ? Directory.GetDirectories(refPacks).Where(d => Path.GetFileName(d).StartsWith(major + ".", StringComparison.Ordinal))
                .Select(d => Path.Combine(d, "ref", $"net{major}.0", "System.Runtime.dll")).FirstOrDefault(File.Exists)
            : null;
        Assert.NotNull(refDll); // the SDK running the tests has its targeting pack
        Assert.True(AssemblyFiles.IsReferenceAssembly(refDll!));
        var located = AssemblyFiles.Locate(refDll!, "System.String");
        Assert.False(located.ReferenceOnly);
        Assert.Equal("System.Private.CoreLib.dll", Path.GetFileName(located.ImplementationPath));
        Assert.Contains(Path.Combine("shared", "Microsoft.NETCore.App"), located.ImplementationPath);
        Assert.Equal(AssemblyFiles.XmlFor(refDll!), located.XmlPath);
        // Not a reference assembly: the file itself (or the file a facade forwards to).
        var lib = BuildLibrary("plain");
        Assert.Equal(lib, AssemblyFiles.Locate(lib, "FixtureLib.Calculator").ImplementationPath);
    }
}

/// <summary>code/metadataSource over the protocol on the Shop fixture: a BCL type, a NuGet type, navigation inside, usages back.</summary>
[Collection("Shop")]
public sealed class MetadataSourceProtocolTests
{
    private readonly ShopFixture _f;
    private TestClient C => _f.Client;
    public MetadataSourceProtocolTests(ShopFixture f) => _f = f;

    private Task<JsonElement> Metadata(string snap, object extra) =>
        C.RequestAsync("code/metadataSource", Merge(new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap }, extra));

    private static Dictionary<string, object?> Merge(object a, object b)
    {
        var d = new Dictionary<string, object?>();
        foreach (var o in new[] { a, b })
            foreach (var p in o.GetType().GetProperties()) d[p.Name] = p.GetValue(o);
        return d;
    }

    private static bool HasXml(JsonElement doc) => File.Exists(Path.ChangeExtension(doc.GetProperty("assemblyPath").GetString()!, ".xml"));

    private static string Line(JsonElement doc, JsonElement range)
    {
        var lines = doc.GetProperty("text").GetString()!.Split('\n');
        return lines[range.GetProperty("start").GetProperty("line").GetInt32()];
    }

    private static string Word(JsonElement doc, JsonElement range)
    {
        var s = range.GetProperty("start");
        var e = range.GetProperty("end");
        return Line(doc, range).Substring(s.GetProperty("character").GetInt32(), e.GetProperty("character").GetInt32() - s.GetProperty("character").GetInt32());
    }

    [Fact]
    public async Task StringFromTheSolutionOpensTheDecompiledImplementationAndIsCached()
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, _f.File("Shop.Api", "Services", "OrderServices.cs"), "string customer");
        Assert.Equal("metadata", s.GetProperty("origin").GetString());
        var r = await Metadata(snap, new { symbolId = s.GetProperty("symbolId").GetString() });
        var doc = r.GetProperty("document");
        Assert.Equal("System.Runtime/System.String.cs", doc.GetProperty("path").GetString());
        Assert.Equal("decompiled", doc.GetProperty("origin").GetString());
        Assert.EndsWith("System.Private.CoreLib.dll", doc.GetProperty("implementationPath").GetString());
        Assert.Contains("public sealed class String", doc.GetProperty("text").GetString());
        // The reference pack's XML documentation, when this SDK has it next to the reference assembly.
        Assert.Equal(HasXml(doc), doc.GetProperty("text").GetString()!.Contains("/// <summary>", StringComparison.Ordinal));
        Assert.Equal("String", Word(doc, r.GetProperty("symbolRange")));
        Assert.False(string.IsNullOrEmpty(r.GetProperty("decompilerVersion").GetString()));
        var builds = _f.Client.Engine!.Metadata.Service.Builds;
        var byId = await Metadata(snap, new { documentationId = "T:System.String", assemblyName = "System.Runtime", memberName = "Concat" });
        Assert.Equal(builds, _f.Client.Engine!.Metadata.Service.Builds);
        Assert.Equal("Concat", Word(byId.GetProperty("document"), byId.GetProperty("symbolRange")));
    }

    [Fact]
    public async Task NuGetTypeNavigatesInsideAndFindsUsagesBackInTheSolution()
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, _f.File("Shop.Api", "Program.cs"), "IMediator mediator");
        var r = await Metadata(snap, new { symbolId = s.GetProperty("symbolId").GetString() });
        var doc = r.GetProperty("document");
        Assert.Equal("MediatR/MediatR.IMediator.cs", doc.GetProperty("path").GetString());
        Assert.Equal("MediatR", doc.GetProperty("assemblyName").GetString());
        var text = doc.GetProperty("text").GetString()!;
        Assert.Contains("public interface IMediator : ISender, IPublisher", text);
        // MediatR.xml is restored next to the dll unless NuGet skips XML files (NUGET_XMLDOC_MODE=skip, e.g. SDK containers).
        Assert.Equal(HasXml(doc), text.Contains("/// <summary>", StringComparison.Ordinal));
        var (line, ch) = TestClient.Position(text, "ISender,", 2);
        var inside = await Metadata(snap, new { document = new { documentationId = "T:MediatR.IMediator", assemblyName = "MediatR" }, position = new { line, character = ch } });
        Assert.Equal("MediatR/MediatR.ISender.cs", inside.GetProperty("document").GetProperty("path").GetString());
        Assert.Equal("ISender", Word(inside.GetProperty("document"), inside.GetProperty("symbolRange")));
        var symbol = inside.GetProperty("symbol");
        Assert.Equal("metadata", symbol.GetProperty("origin").GetString());
        Assert.Equal(HasXml(doc), inside.TryGetProperty("summary", out var summary) && !string.IsNullOrEmpty(summary.GetString()));
        var usages = await C.RequestAsync("code/usages", new { traceId = "t", workspaceId = C.WorkspaceId, snapshotId = snap, symbolId = symbol.GetProperty("symbolId").GetString(), limit = 100 });
        Assert.Contains(usages.GetProperty("items").EnumerateArray(), u => u.GetProperty("uri").GetString()!.EndsWith("Program.cs", StringComparison.Ordinal));
        // Hover: the symbol only, no text.
        var hover = await Metadata(snap, new { document = new { documentationId = "T:MediatR.IMediator", assemblyName = "MediatR" }, position = new { line, character = ch }, symbolOnly = true });
        Assert.Equal(JsonValueKind.Null, hover.TryGetProperty("document", out var d) ? d.ValueKind : JsonValueKind.Null);
        Assert.Contains("ISender", hover.GetProperty("symbol").GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task SourceSymbolsAnswerInSourceAndUnknownIdsAreReported()
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, _f.File("Shop.Api", "Program.cs"), "CancelOrderCommand(id)");
        var r = await Metadata(snap, new { symbolId = s.GetProperty("symbolId").GetString() });
        Assert.Equal("InSource", r.GetProperty("reasonCode").GetString());
        Assert.EndsWith("OrderRequests.cs", r.GetProperty("location").GetProperty("uri").GetString());
        var (line, ch) = TestClient.Position(await File.ReadAllTextAsync(_f.File("Shop.Api", "Program.cs")), "ISender sender", 2);
        var atCursor = await Metadata(snap, new { uri = UriPaths.ToUri(_f.File("Shop.Api", "Program.cs")), position = new { line, character = ch } });
        Assert.Equal("MediatR/MediatR.ISender.cs", atCursor.GetProperty("document").GetProperty("path").GetString());
        var missing = await Metadata(snap, new { documentationId = "T:Nope.Missing" });
        Assert.Equal("SymbolNotFound", missing.GetProperty("reasonCode").GetString());
        var ex = await Assert.ThrowsAsync<RpcError>(() => Metadata(snap, new { sourcePolicy = "off" }));
        Assert.Equal("InvalidParams", ex.ReasonCode);
        var policyOff = await Metadata(snap, new { documentationId = "T:MediatR.Unit", sourcePolicy = "off" });
        Assert.Equal("decompiled", policyOff.GetProperty("document").GetProperty("origin").GetString());
        Assert.Equal("MediatR.Contracts/MediatR.Unit.cs", policyOff.GetProperty("document").GetProperty("path").GetString());
    }
}
