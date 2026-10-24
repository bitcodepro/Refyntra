using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>
/// Packages that a restore could not bring (a private feed that needs credentials): their assemblies come from the local
/// package cache that already holds them (globalPackagesFolder of a NuGet.Config here), with their .nuspec dependencies;
/// their types resolve and decompile; what is still missing is shown as information, not as an error.
/// </summary>
public sealed class PackageFallbackTests : IAsyncLifetime
{
    private string _root = "";
    private TestClient _client = null!;

    /// <summary>The reference assemblies of the running SDK's targeting pack: a package is compiled against those, as real ones are.</summary>
    private static readonly MetadataReference[] RuntimeRefs = ReferencePack();

    private static MetadataReference[] ReferencePack()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var refPacks = Path.Combine(Directory.GetParent(runtimeDir)!.Parent!.Parent!.FullName, "packs", "Microsoft.NETCore.App.Ref");
        var major = Environment.Version.Major;
        var dir = Directory.GetDirectories(refPacks).Where(d => Path.GetFileName(d).StartsWith(major + ".", StringComparison.Ordinal))
            .Select(d => Path.Combine(d, "ref", $"net{major}.0")).First(Directory.Exists);
        return new[] { "System.Runtime.dll", "System.Collections.dll", "netstandard.dll" }.Select(f => (MetadataReference)MetadataReference.CreateFromFile(Path.Combine(dir, f))).ToArray();
    }

    private static string Package(string cache, string id, string version, string tfm, string source, string? dependency = null, params string[] references)
    {
        var dir = Path.Combine(cache, id.ToLowerInvariant(), version);
        var lib = Path.Combine(dir, "lib", tfm);
        Directory.CreateDirectory(lib);
        var c = CSharpCompilation.Create(id, new[] { CSharpSyntaxTree.ParseText(source) },
            RuntimeRefs.Concat(references.Select(r => (MetadataReference)MetadataReference.CreateFromFile(r))), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var dll = Path.Combine(lib, id + ".dll");
        var r = c.Emit(dll);
        Assert.True(r.Success, string.Join("\n", r.Diagnostics));
        var deps = dependency == null ? "" : $"<dependencies><group targetFramework=\"{tfm}\"><dependency id=\"{dependency}\" version=\"1.0.0\" /></group></dependencies>";
        File.WriteAllText(Path.Combine(dir, id.ToLowerInvariant() + ".nuspec"),
            $"<?xml version=\"1.0\"?><package><metadata><id>{id}</id><version>{version}</version>{deps}</metadata></package>");
        return dll;
    }

    public async Task InitializeAsync()
    {
        _root = Path.Combine(Path.GetTempPath(), "refyntra-fallback-" + Guid.NewGuid().ToString("N")[..8]);
        var cache = Path.Combine(_root, "cache");
        var core = Package(cache, "Acme.Core", "1.0.0", "net8.0", "namespace Acme.Core { public readonly record struct Money(decimal Amount); }");
        Package(cache, "Acme.Billing", "1.2.0", "netstandard2.0",
            "namespace Acme.Billing { public class InvoiceService { public Acme.Core.Money Total(int id) => new Acme.Core.Money(id * 2m); } }", "Acme.Core", core);
        // A private feed that is not reachable and a package cache of its own; no restore is ever run.
        File.WriteAllText(Path.Combine(_root, "NuGet.Config"), """
            <?xml version="1.0" encoding="utf-8"?>
            <configuration>
              <config><add key="globalPackagesFolder" value="cache" /></config>
              <packageSources><clear /><add key="private" value="https://packages.invalid/v3/index.json" /></packageSources>
            </configuration>
            """);
        var app = Path.Combine(_root, "App");
        Directory.CreateDirectory(app);
        File.WriteAllText(Path.Combine(app, "App.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Acme.Billing" Version="1.2.0" />
                <PackageReference Include="Acme.Missing" Version="3.0.0" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(app, "Program.cs"), """
            namespace App;

            public static class Program
            {
                public static decimal Run()
                {
                    var service = new Acme.Billing.InvoiceService();
                    Acme.Core.Money total = service.Total(21);
                    Acme.Missing.Thing? thing = null;
                    return total.Amount + (thing == null ? 0 : 1);
                }
            }
            """);
        _client = TestClient.InProcess();
        await _client.InitializeAsync();
        await _client.OpenAsync(Path.Combine(app, "App.csproj"));
    }

    public async Task DisposeAsync()
    {
        await _client.DisposeAsync();
        try { Directory.Delete(_root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private string ProgramCs => Path.Combine(_root, "App", "Program.cs");

    [Fact]
    public async Task TypesOfAnUnrestoredPackageResolveFromTheCacheAndOnlyTheMissingOneIsInformation()
    {
        var snap = await _client.BarrierAsync();
        var r = await _client.RequestAsync("code/diagnostics", new { traceId = "t", workspaceId = _client.WorkspaceId, snapshotId = snap, uri = UriPaths.ToUri(ProgramCs) });
        var all = r.GetProperty("diagnostics").EnumerateArray().ToList();
        string Dump() => string.Join(" | ", all.Select(d => d.GetProperty("severity").GetString() + " " + d.GetProperty("code").GetString() + " " + d.GetProperty("message").GetString()));
        // InvoiceService (the package) and Money (its dependency) resolve: no diagnostic mentions them.
        Assert.DoesNotContain(all, d => d.GetProperty("message").GetString()!.Contains("InvoiceService") || d.GetProperty("message").GetString()!.Contains("Money"));
        // Acme.Missing is in no package folder: still reported, as information that names the cause, never as an error.
        Assert.True(all.All(d => d.GetProperty("severity").GetString() != "error"), Dump());
        var missing = Assert.Single(all, d => d.GetProperty("code").GetString() == "CS0234");
        Assert.Equal("info", missing.GetProperty("severity").GetString());
        Assert.Contains("'Missing'", missing.GetProperty("message").GetString());
        Assert.Contains("not restored", missing.GetProperty("message").GetString());
    }

    [Fact]
    public async Task APackageTypeFromTheCacheDecompiles()
    {
        var snap = await _client.BarrierAsync();
        var s = await _client.SymbolAtTextAsync(snap, ProgramCs, "InvoiceService()");
        Assert.Equal("metadata", s.GetProperty("origin").GetString());
        var r = await _client.RequestAsync("code/metadataSource", new { traceId = "t", workspaceId = _client.WorkspaceId, snapshotId = snap, symbolId = s.GetProperty("symbolId").GetString() });
        var text = r.GetProperty("document").GetProperty("text").GetString()!;
        Assert.Contains("public class InvoiceService", text);
        Assert.Contains("id * 2m", text.Replace("(decimal)id", "id"));
    }

    [Fact]
    public void ResolvesThePackageWithItsDependencyAndReportsTheMissingOne()
    {
        var result = PackageFallback.Resolve(Path.Combine(_root, "App", "App.csproj"), "net10.0");
        Assert.Equal(new[] { "Acme.Billing.dll", "Acme.Core.dll" }, result.Assemblies.Select(Path.GetFileName).OrderBy(x => x).ToArray());
        Assert.Contains("Acme.Billing/1.2.0", result.Resolved);
        Assert.Equal(new[] { "Acme.Missing/3.0.0" }, result.Unresolved);
    }

    [Fact]
    public void PicksTheNearestCompatibleFrameworkFolder()
    {
        Assert.Equal("net8.0", PackageFallback.BestFramework(new[] { "net462", "netstandard2.0", "net8.0", "net9.0" }, "net8.0"));
        Assert.Equal("netstandard2.0", PackageFallback.BestFramework(new[] { "net462", "netstandard2.0" }, "net10.0"));
        Assert.Equal("net472", PackageFallback.BestFramework(new[] { "net462", "net472", "netstandard2.0", "net8.0" }, "net48"));
        Assert.Null(PackageFallback.BestFramework(new[] { "net9.0" }, "net8.0"));
    }
}
