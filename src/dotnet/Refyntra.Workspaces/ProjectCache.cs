using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Host;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Workspaces;

/// <summary>
/// The persistent project index: what MSBuild produced for the projects of a solution (documents, references, analyzers
/// and source generators, compilation and parse options), stored after a complete load and used on the next open
/// while MSBuild loads again in the background. The key covers every input the load depends on that can change
/// without a reload: the solution and project files, the MSBuild files imported from the folders above them, the
/// restore output (project.assets.json, nuget.g.props/targets), the source files under each project folder (names,
/// for the SDK globs), the SDK version and the cache format. Any difference is a miss; nothing is reused partially.
/// </summary>
public static class ProjectCache
{
    private const int FormatVersion = 1;

    public sealed record CachedDocument(string Path, string[] Folders);

    public sealed record CachedProject(
        string Name,
        string AssemblyName,
        string? FilePath,
        string? OutputFilePath,
        string? OutputRefFilePath,
        string? DefaultNamespace,
        List<CachedDocument> Documents,
        List<CachedDocument> AdditionalDocuments,
        List<string> AnalyzerConfigDocuments,
        List<(string Path, string[] Aliases, bool EmbedInteropTypes)> MetadataReferences,
        List<(int Project, string[] Aliases)> ProjectReferences,
        List<string> Analyzers,
        CachedCompilationOptions Compilation,
        CachedParseOptions Parse);

    public sealed record CachedCompilationOptions(
        OutputKind OutputKind, string? ModuleName, string? MainTypeName, OptimizationLevel OptimizationLevel, bool CheckOverflow, bool AllowUnsafe,
        Platform Platform, ReportDiagnostic GeneralDiagnosticOption, int WarningLevel, Dictionary<string, ReportDiagnostic> SpecificDiagnosticOptions,
        NullableContextOptions Nullable, bool Deterministic, bool PublicSign, string? CryptoKeyFile, List<string> Usings);

    public sealed record CachedParseOptions(LanguageVersion LanguageVersion, DocumentationMode DocumentationMode, List<string> PreprocessorSymbols, Dictionary<string, string> Features);

    public sealed record CachedContext(string ContextId, int ProjectIndex, string Name, string ProjectPath, string? TargetFramework, int DocumentCount);

    public sealed record Entry(int Format, string Key, List<CachedProject> Projects, List<CachedContext> Contexts);

    private static readonly JsonSerializerOptions JsonOptions = new() { IncludeFields = true, WriteIndented = false };

    /// <summary>The cache folder (REFYNTRA_CACHE_DIR, else the user's local cache folder); null when unavailable.</summary>
    /// <summary>Tests: the cache folder for this process (null: the default).</summary>
    public static string? FolderOverride { get; set; }

    /// <summary>At most this many solutions are kept; the least recently written are removed.</summary>
    private const int MaxEntries = 64;

    public static string? Folder()
    {
        if (FolderOverride != null) return FolderOverride;
        if (Environment.GetEnvironmentVariable("REFYNTRA_PROJECT_CACHE") == "0") return null;
        var explicitDir = Environment.GetEnvironmentVariable("REFYNTRA_CACHE_DIR");
        if (!string.IsNullOrEmpty(explicitDir)) return Path.Combine(explicitDir, "projects");
        var baseDir = OperatingSystem.IsWindows()
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } x ? x : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache");
        return string.IsNullOrEmpty(baseDir) ? null : Path.Combine(baseDir, "Refyntra", "projects");
    }

    private static string? FileFor(string workspacePath) =>
        Folder() is { } dir ? Path.Combine(dir, Hashing.ShortId(Path.GetFullPath(workspacePath).ToLowerInvariant()) + ".json") : null;

    /// <summary>
    /// The key of the load inputs for these project files (sorted), or null when an input cannot be read. The SDK
    /// version comes from the caller (the registered MSBuild).
    /// </summary>
    public static string? Key(string workspacePath, IEnumerable<string> projectPaths, string sdkVersion)
    {
        try
        {
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            void Add(string s) => sha.AppendData(Encoding.UTF8.GetBytes(s + "\n"));
            void AddFile(string path)
            {
                Add(path.ToLowerInvariant());
                if (File.Exists(path)) sha.AppendData(File.ReadAllBytes(path));
                else Add("<absent>");
            }
            Add($"format {FormatVersion}");
            Add("sdk " + sdkVersion);
            AddFile(Path.GetFullPath(workspacePath));
            var dirs = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var project in projectPaths.Select(Path.GetFullPath).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                AddFile(project);
                var dir = Path.GetDirectoryName(project)!;
                dirs.Add(dir);
                foreach (var f in new[] { "project.assets.json", Path.GetFileName(project) + ".nuget.g.props", Path.GetFileName(project) + ".nuget.g.targets" })
                    AddFile(Path.Combine(dir, "obj", f));
                // The SDK globs: names of the source and markup files under the project folder (bin/obj excluded).
                foreach (var f in SourceFiles(dir)) Add(f.ToLowerInvariant());
            }
            // MSBuild files imported implicitly from the folders above the projects (and global.json for the SDK).
            var above = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var dir in dirs)
                for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
                    foreach (var name in new[] { "Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props", "global.json", "NuGet.Config", "nuget.config" })
                        above.Add(Path.Combine(d.FullName, name));
            foreach (var f in above) AddFile(f);
            return Convert.ToHexString(sha.GetHashAndReset());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static IEnumerable<string> SourceFiles(string dir)
    {
        var stack = new Stack<string>();
        stack.Push(dir);
        var result = new List<string>();
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            foreach (var sub in Directory.EnumerateDirectories(d))
            {
                var name = Path.GetFileName(sub);
                if (name.Equals("bin", StringComparison.OrdinalIgnoreCase) || name.Equals("obj", StringComparison.OrdinalIgnoreCase) || name.StartsWith('.') || name.Equals("node_modules", StringComparison.OrdinalIgnoreCase)) continue;
                stack.Push(sub);
            }
            foreach (var f in Directory.EnumerateFiles(d))
            {
                var ext = Path.GetExtension(f);
                if (ext.Equals(".cs", StringComparison.OrdinalIgnoreCase) || ext.Equals(".razor", StringComparison.OrdinalIgnoreCase) || ext.Equals(".cshtml", StringComparison.OrdinalIgnoreCase)
                    || ext.Equals(".resx", StringComparison.OrdinalIgnoreCase) || ext.Equals(".editorconfig", StringComparison.OrdinalIgnoreCase) || ext.Equals(".props", StringComparison.OrdinalIgnoreCase)
                    || ext.Equals(".targets", StringComparison.OrdinalIgnoreCase) || ext.Equals(".csproj", StringComparison.OrdinalIgnoreCase))
                    result.Add(f);
            }
        }
        result.Sort(StringComparer.OrdinalIgnoreCase);
        return result;
    }

    /// <summary>Stores a completely loaded solution (C# projects only) with its contexts. Failures are logged and ignored.</summary>
    public static void Store(string workspacePath, string key, Solution solution, IReadOnlyList<ProjectContext> contexts)
    {
        var file = FileFor(workspacePath);
        if (file == null) return;
        try
        {
            var projects = solution.Projects.Where(p => p.Language == LanguageNames.CSharp).ToList();
            var indexOf = projects.Select((p, i) => (p.Id, i)).ToDictionary(x => x.Id, x => x.i);
            var cached = new List<CachedProject>();
            foreach (var p in projects)
            {
                if (p.CompilationOptions is not CSharpCompilationOptions co || p.ParseOptions is not CSharpParseOptions po) return;
                var refs = new List<(string, string[], bool)>();
                foreach (var r in p.MetadataReferences)
                {
                    if (r is not PortableExecutableReference pe || pe.FilePath == null) return; // nothing that cannot be restored from a path
                    refs.Add((pe.FilePath, pe.Properties.Aliases.ToArray(), pe.Properties.EmbedInteropTypes));
                }
                var projectRefs = new List<(int, string[])>();
                foreach (var pr in p.ProjectReferences)
                {
                    if (!indexOf.TryGetValue(pr.ProjectId, out var target)) return;
                    projectRefs.Add((target, pr.Aliases.ToArray()));
                }
                var analyzers = new List<string>();
                foreach (var a in p.AnalyzerReferences)
                {
                    if (a.FullPath == null) return;
                    analyzers.Add(a.FullPath);
                }
                if (p.Documents.Any(d => d.FilePath == null) || p.AdditionalDocuments.Any(d => d.FilePath == null) || p.AnalyzerConfigDocuments.Any(d => d.FilePath == null)) return;
                cached.Add(new CachedProject(
                    p.Name, p.AssemblyName, p.FilePath, p.OutputFilePath, p.OutputRefFilePath, p.DefaultNamespace,
                    p.Documents.Select(d => new CachedDocument(d.FilePath!, d.Folders.ToArray())).ToList(),
                    p.AdditionalDocuments.Select(d => new CachedDocument(d.FilePath!, d.Folders.ToArray())).ToList(),
                    p.AnalyzerConfigDocuments.Select(d => d.FilePath!).ToList(),
                    refs, projectRefs, analyzers,
                    new CachedCompilationOptions(co.OutputKind, co.ModuleName, co.MainTypeName, co.OptimizationLevel, co.CheckOverflow, co.AllowUnsafe, co.Platform,
                        co.GeneralDiagnosticOption, co.WarningLevel, co.SpecificDiagnosticOptions.ToDictionary(kv => kv.Key, kv => kv.Value), co.NullableContextOptions,
                        co.Deterministic, co.PublicSign, co.CryptoKeyFile, co.Usings.ToList()),
                    new CachedParseOptions(po.LanguageVersion, po.DocumentationMode, po.PreprocessorSymbolNames.ToList(), po.Features.ToDictionary(kv => kv.Key, kv => kv.Value))));
            }
            var ctx = contexts.Where(c => c.ProjectId != null && indexOf.ContainsKey(c.ProjectId))
                .Select(c => new CachedContext(c.ContextId, indexOf[c.ProjectId!], c.Name, c.ProjectPath, c.TargetFramework, c.DocumentCount)).ToList();
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var tmp = file + "." + Environment.ProcessId + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new Entry(FormatVersion, key, cached, ctx), JsonOptions));
            File.Move(tmp, file, overwrite: true);
            foreach (var old in new DirectoryInfo(Path.GetDirectoryName(file)!).GetFiles("*.json").OrderByDescending(f => f.LastWriteTimeUtc).Skip(MaxEntries))
                old.Delete();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or JsonException)
        {
            Log.Warn("cache", "project index not stored: " + ex.GetType().Name);
        }
    }

    /// <summary>The stored entry when its key matches, else null.</summary>
    public static Entry? Load(string workspacePath, string key)
    {
        var file = FileFor(workspacePath);
        if (file == null || !File.Exists(file)) return null;
        try
        {
            var entry = JsonSerializer.Deserialize<Entry>(File.ReadAllText(file), JsonOptions);
            return entry != null && entry.Format == FormatVersion && entry.Key == key ? entry : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            Log.Warn("cache", "project index unreadable: " + ex.GetType().Name);
            return null;
        }
    }

    /// <summary>The solution of a cache entry in a workspace with the same host services as MSBuildWorkspace; the project ids by index.</summary>
    public static (AdhocWorkspace Workspace, Solution Solution, List<ProjectId> Ids) Build(Entry entry)
    {
        var workspace = new AdhocWorkspace(MSBuildMefHostServices.DefaultServices);
        var loader = workspace.Services.GetRequiredService<IAnalyzerService>().GetLoader();
        var ids = entry.Projects.Select(p => ProjectId.CreateNewId(p.Name)).ToList();
        var infos = new List<ProjectInfo>();
        for (var i = 0; i < entry.Projects.Count; i++)
        {
            var p = entry.Projects[i];
            var id = ids[i];
            var c = p.Compilation;
            var compilation = new CSharpCompilationOptions(c.OutputKind, moduleName: c.ModuleName, mainTypeName: c.MainTypeName, usings: c.Usings,
                optimizationLevel: c.OptimizationLevel, checkOverflow: c.CheckOverflow, allowUnsafe: c.AllowUnsafe, cryptoKeyFile: c.CryptoKeyFile, publicSign: c.PublicSign,
                platform: c.Platform, generalDiagnosticOption: c.GeneralDiagnosticOption, warningLevel: c.WarningLevel, specificDiagnosticOptions: c.SpecificDiagnosticOptions,
                deterministic: c.Deterministic, nullableContextOptions: c.Nullable);
            var parse = new CSharpParseOptions(p.Parse.LanguageVersion, p.Parse.DocumentationMode, SourceCodeKind.Regular, p.Parse.PreprocessorSymbols).WithFeatures(p.Parse.Features);
            DocumentInfo Doc(CachedDocument d) => DocumentInfo.Create(DocumentId.CreateNewId(id, d.Path), Path.GetFileName(d.Path), d.Folders,
                loader: new FileTextLoader(d.Path, defaultEncoding: null), filePath: d.Path);
            infos.Add(ProjectInfo.Create(id, VersionStamp.Create(), p.Name, p.AssemblyName, LanguageNames.CSharp, filePath: p.FilePath, outputFilePath: p.OutputFilePath,
                    compilationOptions: compilation, parseOptions: parse,
                    documents: p.Documents.Select(Doc),
                    projectReferences: p.ProjectReferences.Select(r => new ProjectReference(ids[r.Project], r.Aliases.ToImmutableArray())),
                    metadataReferences: p.MetadataReferences.Select(r => (MetadataReference)MetadataReference.CreateFromFile(r.Path, new MetadataReferenceProperties(MetadataImageKind.Assembly, r.Aliases.ToImmutableArray(), r.EmbedInteropTypes))),
                    analyzerReferences: p.Analyzers.Select(a => (AnalyzerReference)new AnalyzerFileReference(a, loader)),
                    additionalDocuments: p.AdditionalDocuments.Select(Doc))
                .WithOutputRefFilePath(p.OutputRefFilePath)
                .WithDefaultNamespace(p.DefaultNamespace)
                .WithAnalyzerConfigDocuments(p.AnalyzerConfigDocuments.Select(a => Doc(new CachedDocument(a, Array.Empty<string>())))));
        }
        var solution = workspace.CurrentSolution;
        foreach (var info in infos) solution = solution.AddProject(info);
        return (workspace, solution, ids);
    }
}
