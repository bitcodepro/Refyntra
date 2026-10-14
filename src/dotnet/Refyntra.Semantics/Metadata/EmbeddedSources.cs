using System.Collections.Immutable;
using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;

namespace Refyntra.Semantics.Metadata;

/// <summary>
/// Source files embedded in a portable PDB (the PDB embedded in the assembly, or a matching <c>.pdb</c> next to it).
/// Source Link URLs are never followed: only text that is already inside the PDB is used.
/// </summary>
public static class EmbeddedSources
{
    private static readonly Guid EmbeddedSourceKind = new("0E8A571B-6926-466E-B4AD-8AB04611F5FE");
    private static readonly Guid TypeDefinitionDocumentsKind = new("932E74BC-DBA9-4478-8D46-0F32A7BAB3D3");

    /// <param name="DocumentName">The document path recorded in the PDB (usually a deterministic "/_/src/..." path).</param>
    public sealed record Source(string DocumentName, string Text);

    /// <summary>
    /// The embedded source of the file that declares the top-level type <paramref name="topLevelTypeName"/>
    /// ("Ns.Name`1"); with <paramref name="memberName"/>, the file of that member's body when the type is partial.
    /// Null when there is no portable PDB, no such type, or its file is not embedded.
    /// </summary>
    public static Source? Find(byte[] image, string assemblyPath, string topLevelTypeName, string? memberName, CancellationToken ct)
    {
        try
        {
            using var pe = new PEReader(ImmutableArray.Create(image));
            if (!pe.HasMetadata) return null;
            using var provider = OpenPdb(pe, assemblyPath);
            if (provider == null) return null;
            var pdb = provider.GetMetadataReader();
            var md = pe.GetMetadataReader();
            var type = FindType(md, topLevelTypeName);
            if (type.IsNil) return null;
            var counts = new Dictionary<DocumentHandle, int>();
            var preferred = new HashSet<DocumentHandle>();
            void Visit(TypeDefinitionHandle th)
            {
                var t = md.GetTypeDefinition(th);
                foreach (var mh in t.GetMethods())
                {
                    ct.ThrowIfCancellationRequested();
                    var info = pdb.GetMethodDebugInformation(mh.ToDebugInformationHandle());
                    var docs = info.Document.IsNil ? info.GetSequencePoints().Select(s => s.Document).Distinct().ToList() : new List<DocumentHandle> { info.Document };
                    var isPreferred = memberName != null && md.StringComparer.Equals(md.GetMethodDefinition(mh).Name, memberName);
                    foreach (var d in docs.Where(d => !d.IsNil))
                    {
                        counts[d] = counts.GetValueOrDefault(d) + 1;
                        if (isPreferred) preferred.Add(d);
                    }
                }
                foreach (var nested in t.GetNestedTypes()) Visit(nested);
            }
            Visit(type);
            if (counts.Count == 0)
            {
                // Types without method bodies (interfaces, enums): the compiler records their files separately.
                foreach (var h in pdb.GetCustomDebugInformation(type))
                {
                    var cdi = pdb.GetCustomDebugInformation(h);
                    if (pdb.GetGuid(cdi.Kind) != TypeDefinitionDocumentsKind) continue;
                    var r = pdb.GetBlobReader(cdi.Value);
                    while (r.RemainingBytes > 0) counts[MetadataTokens.DocumentHandle(r.ReadCompressedInteger())] = 1;
                }
            }
            var ordered = counts.OrderByDescending(kv => preferred.Contains(kv.Key)).ThenByDescending(kv => kv.Value).Select(kv => kv.Key);
            foreach (var d in ordered)
            {
                var text = EmbeddedText(pdb, d);
                if (text != null) return new Source(pdb.GetString(pdb.GetDocument(d).Name), text);
            }
            return null;
        }
        catch (Exception e) when (e is BadImageFormatException or InvalidOperationException or IOException or InvalidDataException)
        {
            return null;
        }
    }

    private static MetadataReaderProvider? OpenPdb(PEReader pe, string assemblyPath)
    {
        var entries = pe.ReadDebugDirectory();
        var embedded = entries.FirstOrDefault(e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
        if (embedded.DataSize > 0) return pe.ReadEmbeddedPortablePdbDebugDirectoryData(embedded);
        // A portable PDB next to the assembly (never the build-machine path from the CodeView entry), matched by id.
        var codeView = entries.FirstOrDefault(e => e.Type == DebugDirectoryEntryType.CodeView);
        if (codeView.DataSize == 0) return null;
        var expected = pe.ReadCodeViewDebugDirectoryData(codeView).Guid;
        var side = Path.ChangeExtension(assemblyPath, ".pdb");
        if (!File.Exists(side)) return null;
        var bytes = File.ReadAllBytes(side);
        if (bytes.Length < 4 || bytes[0] != (byte)'B' || bytes[1] != (byte)'S' || bytes[2] != (byte)'J' || bytes[3] != (byte)'B') return null;
        var provider = MetadataReaderProvider.FromPortablePdbImage(ImmutableArray.Create(bytes));
        var id = provider.GetMetadataReader().DebugMetadataHeader?.Id;
        if (id is { Length: >= 16 } && new Guid(id.Value.AsSpan(0, 16)) == expected) return provider;
        provider.Dispose();
        return null;
    }

    private static TypeDefinitionHandle FindType(MetadataReader md, string topLevelTypeName)
    {
        var split = topLevelTypeName.LastIndexOf('.');
        var ns = split < 0 ? "" : topLevelTypeName[..split];
        var name = split < 0 ? topLevelTypeName : topLevelTypeName[(split + 1)..];
        foreach (var h in md.TypeDefinitions)
        {
            var t = md.GetTypeDefinition(h);
            if (t.GetDeclaringType().IsNil && md.StringComparer.Equals(t.Name, name) && md.StringComparer.Equals(t.Namespace, ns)) return h;
        }
        return default;
    }

    private static string? EmbeddedText(MetadataReader pdb, DocumentHandle document)
    {
        foreach (var h in pdb.GetCustomDebugInformation(document))
        {
            var cdi = pdb.GetCustomDebugInformation(h);
            if (pdb.GetGuid(cdi.Kind) != EmbeddedSourceKind) continue;
            var r = pdb.GetBlobReader(cdi.Value);
            var format = r.ReadInt32();
            var raw = r.ReadBytes(r.RemainingBytes);
            byte[] bytes;
            if (format == 0) bytes = raw;
            else
            {
                if (format < 0 || format > 64 * 1024 * 1024) return null;
                using var ds = new DeflateStream(new MemoryStream(raw), CompressionMode.Decompress);
                bytes = new byte[format];
                ds.ReadExactly(bytes);
            }
            using var reader = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
        return null;
    }
}
