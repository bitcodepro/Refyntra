using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Documentation;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;

namespace Refyntra.Semantics.Metadata;

/// <summary>
/// ICSharpCode.Decompiler (ILSpy's engine, MIT) for one assembly image. References are resolved only from the given
/// local files (the project's metadata references and the implementation directory); nothing is downloaded and no
/// PDB is read by the decompiler. Not thread-safe by itself: <see cref="Decompile"/> serialises callers.
/// </summary>
public sealed class TypeDecompiler
{
    private readonly CSharpDecompiler _decompiler;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public static string Version { get; } =
        typeof(CSharpDecompiler).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0]
        ?? typeof(CSharpDecompiler).Assembly.GetName().Version?.ToString() ?? "unknown";

    public TypeDecompiler(string path, byte[] image, string? xmlPath, IReadOnlyDictionary<string, string> referencePaths)
    {
        var file = new PEFile(path, new MemoryStream(image), PEStreamOptions.PrefetchEntireImage);
        var settings = new DecompilerSettings(LanguageVersion.Latest)
        {
            ThrowOnAssemblyResolveErrors = false,
            ShowXmlDocumentation = true,
            UseDebugSymbols = false,
            FileScopedNamespaces = false,
        };
        _decompiler = new CSharpDecompiler(file, new LocalResolver(referencePaths), settings);
        if (xmlPath != null) _decompiler.DocumentationProvider = new XmlDocumentationProvider(xmlPath);
    }

    /// <summary>C# text of the top-level type with the reflection name <paramref name="topLevelTypeName"/> ("Ns.Name`1").</summary>
    public string Decompile(string topLevelTypeName, CancellationToken ct)
    {
        _gate.Wait(ct);
        try
        {
            _decompiler.CancellationToken = ct;
            return _decompiler.DecompileTypeAsString(new FullTypeName(topLevelTypeName));
        }
        finally
        {
            _decompiler.CancellationToken = CancellationToken.None;
            _gate.Release();
        }
    }

    private sealed class Snapshot : IDisposable { public void Dispose() { } }

    /// <summary>Resolves assembly references by simple name from known local files only.</summary>
    private sealed class LocalResolver : IAssemblyResolver
    {
        private readonly IReadOnlyDictionary<string, string> _paths;
        private readonly Dictionary<string, MetadataFile?> _loaded = new(StringComparer.OrdinalIgnoreCase);

        public LocalResolver(IReadOnlyDictionary<string, string> paths) => _paths = paths;

        public MetadataFile? Resolve(IAssemblyReference reference)
        {
            lock (_loaded)
            {
                if (_loaded.TryGetValue(reference.Name, out var f)) return f;
                f = null;
                if (_paths.TryGetValue(reference.Name, out var path))
                {
                    try { f = new PEFile(path, new MemoryStream(File.ReadAllBytes(path)), PEStreamOptions.PrefetchEntireImage); }
                    catch (Exception e) when (e is IOException or BadImageFormatException or UnauthorizedAccessException) { f = null; }
                }
                _loaded[reference.Name] = f;
                return f;
            }
        }

        public IDisposable BeginSnapshot() => new Snapshot();
        public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
        public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
        public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
    }
}
