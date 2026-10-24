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
        Assert.Equal(new[] { "Acme.Missing [3.0.0, )" }, result.Unresolved);
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

/// <summary>NuGet's own rules in the fallback: version ranges, the selected assets target and its exclusions, platform frameworks, .NETFramework nuspec groups.</summary>
public sealed class PackageFallbackRulesTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "refyntra-fallback-rules-" + Guid.NewGuid().ToString("N")[..8]);
    private string Cache => Path.Combine(_root, "cache");

    public PackageFallbackRulesTests()
    {
        // NuGet.Frameworks/NuGet.Versioning come from the SDK's MSBuild folder at run time (Microsoft.Build.Locator).
        MsBuildBootstrap.EnsureRegistered(Directory.GetCurrentDirectory());
        Directory.CreateDirectory(Cache);
        File.WriteAllText(Path.Combine(_root, "NuGet.Config"), "<configuration><config><add key=\"globalPackagesFolder\" value=\"cache\" /></config></configuration>");
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>A package folder with empty dll files (only their presence matters here) and a nuspec.</summary>
    private void Pkg(string id, string version, string[] files, string? nuspecDependencies = null)
    {
        var dir = Path.Combine(Cache, id.ToLowerInvariant(), version);
        Directory.CreateDirectory(dir);
        foreach (var f in files)
        {
            var p = Path.Combine(dir, f.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, "");
        }
        File.WriteAllText(Path.Combine(dir, id.ToLowerInvariant() + ".nuspec"),
            $"<package><metadata><id>{id}</id><version>{version}</version>{nuspecDependencies}</metadata></package>");
    }

    private string Project(string name, string tfm, string items)
    {
        var dir = Path.Combine(_root, name);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".csproj");
        File.WriteAllText(path, $"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>{tfm}</TargetFramework></PropertyGroup><ItemGroup>{items}</ItemGroup></Project>");
        return path;
    }

    private string? Find(string? range) =>
        PackageFallback.FindPackage(PackageFallback.PackageFolders(_root, Array.Empty<string>()), "Range.Lib", range == null ? null : NuGet.Versioning.VersionRange.Parse(range)) is { } d
            ? Path.GetFileName(d) : null;

    [Fact]
    public void AVersionOutsideTheRangeIsNeverSubstituted()
    {
        Pkg("Range.Lib", "1.0.0", new[] { "lib/net8.0/Range.Lib.dll" });
        Pkg("Range.Lib", "1.5.0", new[] { "lib/net8.0/Range.Lib.dll" });
        Pkg("Range.Lib", "2.0.0", new[] { "lib/net8.0/Range.Lib.dll" });
        Assert.Null(Find("[3.0.0]"));                 // exact and not cached: unresolved, never 2.0.0
        Assert.Equal("2.0.0", Find("[2.0.0]"));
        Assert.Equal("1.5.0", Find("(1.0.0,2.0.0)")); // exclusive bounds: neither 1.0.0 nor 2.0.0
        Assert.Equal("1.5.0", Find("1.2.0"));         // "1.2.0" means 1.2.0 or higher: NuGet's lowest applicable
        Assert.Null(Find("[2.5.0,3.0.0)"));
        Assert.Equal("2.0.0", Find(null));            // no version at all: the highest cached
    }

    [Fact]
    public void AssetsUseTheSelectedTargetItsCompileEntriesAndExactVersions()
    {
        Pkg("Both", "1.0.0", new[] { "lib/net8.0/Both.dll", "lib/net48/Both.dll" });
        Pkg("OnlyNet48", "1.0.0", new[] { "lib/net48/OnlyNet48.dll" });
        Pkg("NoCompile", "1.0.0", new[] { "lib/net8.0/NoCompile.dll" });
        Pkg("Placeholder", "1.0.0", new[] { "lib/net8.0/_._" });
        Pkg("WrongVersion", "1.0.0", new[] { "lib/net8.0/WrongVersion.dll" });
        var project = Project("Multi", "net8.0", "");
        static string Lib(string id, string v) => $"\"{id}/{v}\": {{ \"type\": \"package\", \"path\": \"{id.ToLowerInvariant()}/{v}\" }}";
        var missingFolder = JsonSerializer.Serialize(Path.Combine(_root, "missing-folder"));
        var assets = "{ \"version\": 3, \"targets\": {"
            + " \"net8.0\": {"
            + "   \"Both/1.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net8.0/Both.dll\": {} } },"
            + "   \"NoCompile/1.0.0\": { \"type\": \"package\" },"            // ExcludeAssets=compile: no compile section
            + "   \"Placeholder/1.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net8.0/_._\": {} } },"
            + "   \"WrongVersion/2.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net8.0/WrongVersion.dll\": {} } } },"
            + " \"net8.0/win-x64\": { \"OnlyNet48/1.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net48/OnlyNet48.dll\": {} } } },"
            + " \".NETFramework,Version=v4.8\": {"
            + "   \"Both/1.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net48/Both.dll\": {} } },"
            + "   \"OnlyNet48/1.0.0\": { \"type\": \"package\", \"compile\": { \"lib/net48/OnlyNet48.dll\": {} } } } },"
            + " \"libraries\": { " + string.Join(", ", Lib("Both", "1.0.0"), Lib("OnlyNet48", "1.0.0"), Lib("NoCompile", "1.0.0"), Lib("Placeholder", "1.0.0"), Lib("WrongVersion", "2.0.0")) + " },"
            + " \"packageFolders\": { " + missingFolder + ": {} } }";
        Directory.CreateDirectory(Path.Combine(_root, "Multi", "obj"));
        File.WriteAllText(Path.Combine(_root, "Multi", "obj", "project.assets.json"), assets);

        var net8 = PackageFallback.Resolve(project, "net8.0");
        Assert.Equal(Path.GetFullPath(Path.Combine(Cache, "both", "1.0.0", "lib", "net8.0", "Both.dll")), Path.GetFullPath(Assert.Single(net8.Assemblies)));
        Assert.Equal(new[] { "Both/1.0.0", "NoCompile/1.0.0", "Placeholder/1.0.0" }, net8.Resolved.OrderBy(x => x, StringComparer.Ordinal).ToArray());
        Assert.Equal(new[] { "WrongVersion/2.0.0" }, net8.Unresolved); // only 1.0.0 is cached: not substituted
        var net48 = PackageFallback.Resolve(project, "net48");
        Assert.Equal(new[] { "Both.dll", "OnlyNet48.dll" }, net48.Assemblies.Select(Path.GetFileName).OrderBy(x => x, StringComparer.Ordinal).ToArray());
        Assert.All(net48.Assemblies, a => Assert.Contains(Path.Combine("lib", "net48"), a));
    }

    [Fact]
    public void ExcludedCompileAssetsOfAPackageReferenceStayExcluded()
    {
        Pkg("Analyzer.Only", "1.0.0", new[] { "lib/net8.0/Analyzer.Only.dll" });
        var r = PackageFallback.Resolve(Project("Excl", "net8.0", "<PackageReference Include=\"Analyzer.Only\" Version=\"1.0.0\" ExcludeAssets=\"compile\" />"), "net8.0");
        Assert.Empty(r.Assemblies);
        Assert.Equal(new[] { "Analyzer.Only/1.0.0" }, r.Resolved);
    }

    [Fact]
    public void PlatformFrameworksKeepTheirPlatform()
    {
        Assert.Equal("net8.0", PackageFallback.BestFramework(new[] { "net8.0-windows7.0", "net8.0" }, "net8.0"));
        Assert.Equal("net8.0-windows7.0", PackageFallback.BestFramework(new[] { "net8.0", "net8.0-windows7.0" }, "net8.0-windows7.0"));
        Assert.Null(PackageFallback.BestFramework(new[] { "net8.0-android" }, "net8.0"));
        Assert.Null(PackageFallback.BestFramework(new[] { "net8.0-windows7.0" }, "net8.0"));
        Assert.Equal("net8.0-ios", PackageFallback.BestFramework(new[] { "net8.0-android", "net8.0-ios", "netstandard2.0" }, "net8.0-ios"));
    }

    [Fact]
    public void DotNetFrameworkNuspecGroupsPickTheRightTransitiveDependencies()
    {
        Pkg("Host.Lib", "1.0.0", new[] { "lib/net472/Host.Lib.dll", "lib/netstandard2.0/Host.Lib.dll" },
            "<dependencies><group targetFramework=\".NETFramework4.7.2\"><dependency id=\"Desktop.Dep\" version=\"1.0.0\" /></group>"
            + "<group targetFramework=\".NETStandard2.0\"><dependency id=\"Standard.Dep\" version=\"1.0.0\" /></group></dependencies>");
        Pkg("Desktop.Dep", "1.0.0", new[] { "lib/net472/Desktop.Dep.dll" });
        Pkg("Standard.Dep", "1.0.0", new[] { "lib/netstandard2.0/Standard.Dep.dll" });
        const string item = "<PackageReference Include=\"Host.Lib\" Version=\"1.0.0\" />";
        var net48 = PackageFallback.Resolve(Project("Desk", "net48", item), "net48");
        Assert.Equal(new[] { "Desktop.Dep/1.0.0", "Host.Lib/1.0.0" }, net48.Resolved.OrderBy(x => x, StringComparer.Ordinal).ToArray());
        Assert.Contains(net48.Assemblies, a => a.EndsWith(Path.Combine("net472", "Host.Lib.dll"), StringComparison.Ordinal));
        var net8 = PackageFallback.Resolve(Project("Core", "net8.0", item), "net8.0");
        Assert.Equal(new[] { "Host.Lib/1.0.0", "Standard.Dep/1.0.0" }, net8.Resolved.OrderBy(x => x, StringComparer.Ordinal).ToArray());
        Assert.Contains(net8.Assemblies, a => a.EndsWith(Path.Combine("netstandard2.0", "Host.Lib.dll"), StringComparison.Ordinal));
    }
}
