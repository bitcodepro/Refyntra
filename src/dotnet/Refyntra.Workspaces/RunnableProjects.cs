using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace Refyntra.Workspaces;

/// <summary>Kinds of projects as Run and Debug sees them (protocol 1.8, workspace/runnableProjects).</summary>
public static class RunnableKinds
{
    public const string Console = "console", Web = "web", Worker = "worker", WinForms = "winforms", Wpf = "wpf",
        Test = "test", Library = "library", Maui = "maui", BlazorWasm = "blazor-wasm";
}

/// <summary>
/// What is known about one project: from the loaded MSBuild evaluation (Roslyn project instances: output kind, output
/// path, target framework, resolved metadata references) and from the project file itself (SDK, a few properties).
/// </summary>
public sealed record ProjectFacts
{
    public required string ProjectPath { get; init; }
    public required string Name { get; init; }
    public string? AssemblyName { get; init; }
    /// <summary>From the evaluation: ConsoleApplication / WindowsApplication / DynamicallyLinkedLibrary …; null when unknown.</summary>
    public OutputKind? OutputKind { get; init; }
    /// <summary>One entry per loaded target framework instance: (tfm, output file path).</summary>
    public IReadOnlyList<(string? Tfm, string? OutputPath)> Instances { get; init; } = Array.Empty<(string?, string?)>();
    /// <summary>File names (lower case, no folder) of the resolved metadata references.</summary>
    public IReadOnlySet<string> References { get; init; } = new HashSet<string>();
    /// <summary>The project file's SDKs (Sdk attribute, &lt;Sdk Name&gt;, &lt;Import Sdk&gt;).</summary>
    public IReadOnlyList<string> Sdks { get; init; } = Array.Empty<string>();
    /// <summary>Properties set in the project file (and the Directory.Build.props files above it); last one wins.</summary>
    public IReadOnlyDictionary<string, string> Properties { get; init; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    /// <summary>PackageReference names (lower case).</summary>
    public IReadOnlySet<string> Packages { get; init; } = new HashSet<string>();
}

public sealed record RunnableProject
{
    public required string Name { get; init; }
    public required string ProjectPath { get; init; }
    public required string Kind { get; init; }
    /// <summary>True when Run and Debug can start it on some platform (see WindowsOnly).</summary>
    public required bool Runnable { get; init; }
    /// <summary>Why it is not runnable (test project, library, MAUI …), or a limitation; null when nothing to say.</summary>
    public string? Reason { get; init; }
    public bool WindowsOnly { get; init; }
    public required IReadOnlyList<string> TargetFrameworks { get; init; }
    /// <summary>Output file per target framework from the evaluation (the Debug configuration of the design-time build).</summary>
    public required IReadOnlyList<(string? Tfm, string? OutputPath)> Outputs { get; init; }
    public string? AssemblyName { get; init; }
    /// <summary>Properties/launchSettings.json next to the project, when it exists (the client reads the profiles).</summary>
    public string? LaunchSettingsPath { get; init; }
}

public static class RunnableProjectDetector
{
    private static readonly string[] TestReferences = { "xunit.core.dll", "xunit.v3.core.dll", "nunit.framework.dll", "microsoft.visualstudio.testplatform.testframework.dll", "microsoft.testplatform.testhost.dll", "testhost.dll" };
    private static readonly string[] TestPackages = { "microsoft.net.test.sdk", "xunit", "xunit.v3", "nunit", "mstest", "mstest.testframework", "tunit" };

    /// <summary>Classifies one project. Pure: everything comes from <paramref name="f"/>.</summary>
    public static RunnableProject Classify(ProjectFacts f)
    {
        bool Prop(string name) => f.Properties.TryGetValue(name, out var v) && v.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
        bool Sdk(string name) => f.Sdks.Any(s => s.Split('/')[0].Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        bool Ref(string file) => f.References.Contains(file);

        var outputType = f.Properties.TryGetValue("OutputType", out var ot) ? ot.Trim() : null;
        var exe = f.OutputKind is Microsoft.CodeAnalysis.OutputKind.ConsoleApplication or Microsoft.CodeAnalysis.OutputKind.WindowsApplication
            || (f.OutputKind == null && (string.Equals(outputType, "Exe", StringComparison.OrdinalIgnoreCase) || string.Equals(outputType, "WinExe", StringComparison.OrdinalIgnoreCase)));
        var web = Sdk("Microsoft.NET.Sdk.Web");
        var tfms = f.Instances.Select(i => i.Tfm).Where(t => t != null).Select(t => t!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (tfms.Count == 0)
        {
            var list = f.Properties.TryGetValue("TargetFrameworks", out var many) ? many : f.Properties.TryGetValue("TargetFramework", out var one) ? one : null;
            if (list != null) tfms = list.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(t => !t.Contains("$(")).ToList();
        }
        var dir = Path.GetDirectoryName(f.ProjectPath) ?? "";
        var launch = Path.Combine(dir, "Properties", "launchSettings.json");
        RunnableProject Make(string kind, bool runnable, string? reason = null, bool windowsOnly = false) => new()
        {
            Name = f.Name,
            ProjectPath = f.ProjectPath,
            Kind = kind,
            Runnable = runnable,
            Reason = reason,
            WindowsOnly = windowsOnly,
            TargetFrameworks = tfms,
            Outputs = f.Instances,
            AssemblyName = f.AssemblyName,
            LaunchSettingsPath = File.Exists(launch) ? launch : null,
        };

        if (Prop("IsTestProject") || TestReferences.Any(Ref) || f.Packages.Any(p => TestPackages.Contains(p)))
            return Make(RunnableKinds.Test, false, "Test project: run its tests from the Test Explorer or the Tests group of Related.");
        if (Prop("UseMaui") || Sdk("Microsoft.NET.Sdk.Maui"))
            return Make(RunnableKinds.Maui, false, ".NET MAUI apps need platform workloads, devices or emulators; Refyntra does not run or debug them.");
        if (Sdk("Microsoft.NET.Sdk.BlazorWebAssembly"))
            return Make(RunnableKinds.BlazorWasm, false, "Blazor WebAssembly runs in the browser; Refyntra does not debug WebAssembly. Run the hosting server project instead.");
        if (!exe && !web)
            return Make(RunnableKinds.Library, false, "Class library: nothing to start.");
        if (Prop("UseWPF") || Ref("presentationframework.dll"))
            return Make(RunnableKinds.Wpf, true, "WPF apps run on Windows only.", windowsOnly: true);
        if (Prop("UseWindowsForms") || Ref("system.windows.forms.dll"))
            return Make(RunnableKinds.WinForms, true, "Windows Forms apps run on Windows only.", windowsOnly: true);
        if (web) return Make(RunnableKinds.Web, true);
        if (Sdk("Microsoft.NET.Sdk.Worker")) return Make(RunnableKinds.Worker, true);
        return Make(RunnableKinds.Console, true);
    }

    /// <summary>Facts read from a project file (and the Directory.Build.props files above it) only. Pure apart from file reads.</summary>
    public static ProjectFacts FromProjectFile(string projectPath)
    {
        var props = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var sdks = new List<string>();
        var packages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Directory.Build.props first (outermost first), then the project: the project wins, as in MSBuild.
        var chain = new List<string>();
        for (var d = Path.GetDirectoryName(projectPath); d != null; d = Path.GetDirectoryName(d))
        {
            var p = Path.Combine(d, "Directory.Build.props");
            if (File.Exists(p)) chain.Insert(0, p);
        }
        chain.Add(projectPath);
        foreach (var file in chain)
        {
            XDocument doc;
            try { doc = XDocument.Load(file); }
            catch (Exception) { continue; }
            var root = doc.Root;
            if (root == null) continue;
            if (file == projectPath)
            {
                if (root.Attribute("Sdk")?.Value is { } s) sdks.AddRange(s.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                sdks.AddRange(root.Elements().Where(e => e.Name.LocalName == "Sdk").Select(e => e.Attribute("Name")?.Value).Where(v => v != null).Select(v => v!));
                sdks.AddRange(root.Elements().Where(e => e.Name.LocalName == "Import").Select(e => e.Attribute("Sdk")?.Value).Where(v => v != null).Select(v => v!));
            }
            foreach (var group in root.Elements().Where(e => e.Name.LocalName == "PropertyGroup"))
            foreach (var p in group.Elements())
                props[p.Name.LocalName] = p.Value;
            foreach (var pr in root.Descendants().Where(e => e.Name.LocalName == "PackageReference"))
                if (pr.Attribute("Include")?.Value is { } inc) packages.Add(inc.ToLowerInvariant());
        }
        return new ProjectFacts
        {
            ProjectPath = projectPath,
            Name = Path.GetFileNameWithoutExtension(projectPath),
            AssemblyName = props.TryGetValue("AssemblyName", out var an) && !an.Contains("$(") ? an : Path.GetFileNameWithoutExtension(projectPath),
            Sdks = sdks,
            Properties = props,
            Packages = packages,
        };
    }

    private static readonly Regex TfmInName = new(@"\((?<tfm>[a-z0-9.\-]+)\)$", RegexOptions.IgnoreCase);

    /// <summary>Every C# project of the loaded solution, one entry per project file (multi-targeting folded).</summary>
    public static IReadOnlyList<RunnableProject> Detect(Solution solution)
    {
        var result = new List<RunnableProject>();
        foreach (var group in solution.Projects.Where(p => p.Language == LanguageNames.CSharp && p.FilePath != null).GroupBy(p => p.FilePath!, UriPaths.PathComparer))
        {
            var instances = group.ToList();
            var file = FromProjectFile(group.Key);
            var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in instances)
            foreach (var r in p.MetadataReferences.OfType<PortableExecutableReference>())
                if (r.FilePath != null) refs.Add(Path.GetFileName(r.FilePath).ToLowerInvariant());
            var first = instances[0];
            var facts = file with
            {
                Name = TfmInName.Replace(first.Name, "").TrimEnd(),
                AssemblyName = first.AssemblyName,
                OutputKind = first.CompilationOptions?.OutputKind,
                Instances = instances.Select(p => (Tfm(p), p.OutputFilePath)).OrderBy(i => i.Item1, StringComparer.OrdinalIgnoreCase).ToList(),
                References = refs,
            };
            result.Add(Classify(facts));
        }
        return result.OrderBy(r => r.Runnable ? 0 : 1).ThenBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static string? Tfm(Project p)
    {
        var m = TfmInName.Match(p.Name);
        if (m.Success) return m.Groups["tfm"].Value;
        var dir = p.OutputFilePath == null ? null : Path.GetFileName(Path.GetDirectoryName(p.OutputFilePath));
        return dir != null && Regex.IsMatch(dir, "^(net|netcoreapp)[0-9.]+(-[a-z0-9.]+)?$", RegexOptions.IgnoreCase) ? dir : null;
    }
}
