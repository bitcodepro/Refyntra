using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace Refyntra.Semantics.Metadata;

/// <summary>
/// Local assembly files behind a metadata reference: the implementation assembly of a reference assembly (the shared
/// framework next to a targeting pack, <c>lib/</c> next to a NuGet <c>ref/</c> folder, following type forwarders) and
/// the XML documentation file. Only the local file system is read; nothing is downloaded.
/// </summary>
public static class AssemblyFiles
{
    public sealed record Located(string ImplementationPath, string? XmlPath, bool ReferenceOnly);

    /// <summary>
    /// The file that implements <paramref name="topLevelTypeName"/> ("Ns.Name`1") for the reference at
    /// <paramref name="referencePath"/>. A reference assembly without a local implementation is returned itself with
    /// <see cref="Located.ReferenceOnly"/> (its members have no bodies).
    /// </summary>
    public static Located Locate(string referencePath, string topLevelTypeName)
    {
        var xml = XmlFor(referencePath);
        if (!IsReferenceAssembly(referencePath))
        {
            // An implementation facade (System.Runtime.dll of the runtime) forwards most types to another file.
            var defining = FollowForwarders(Path.GetDirectoryName(referencePath)!, Path.GetFileName(referencePath), topLevelTypeName) ?? referencePath;
            return new Located(defining, xml ?? XmlFor(defining), false);
        }
        foreach (var dir in ImplementationDirectories(referencePath))
        {
            var impl = FollowForwarders(dir, Path.GetFileName(referencePath), topLevelTypeName);
            if (impl != null && !IsReferenceAssembly(impl)) return new Located(impl, xml ?? XmlFor(impl), false);
        }
        return new Located(referencePath, xml, true);
    }

    public static string? XmlFor(string assemblyPath)
    {
        var xml = Path.ChangeExtension(assemblyPath, ".xml");
        return File.Exists(xml) ? xml : null;
    }

    public static bool IsReferenceAssembly(string path)
    {
        try
        {
            using var pe = new PEReader(File.OpenRead(path));
            if (!pe.HasMetadata) return false;
            var md = pe.GetMetadataReader();
            if (!md.IsAssembly) return false;
            foreach (var h in md.GetAssemblyDefinition().GetCustomAttributes())
                if (AttributeTypeName(md, md.GetCustomAttribute(h)) == "System.Runtime.CompilerServices.ReferenceAssemblyAttribute") return true;
            return false;
        }
        catch (Exception e) when (e is IOException or BadImageFormatException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string? AttributeTypeName(MetadataReader md, CustomAttribute a)
    {
        EntityHandle type;
        if (a.Constructor.Kind == HandleKind.MemberReference) type = md.GetMemberReference((MemberReferenceHandle)a.Constructor).Parent;
        else if (a.Constructor.Kind == HandleKind.MethodDefinition) type = md.GetMethodDefinition((MethodDefinitionHandle)a.Constructor).GetDeclaringType();
        else return null;
        return type.Kind switch
        {
            HandleKind.TypeReference => Full(md.GetString(md.GetTypeReference((TypeReferenceHandle)type).Namespace), md.GetString(md.GetTypeReference((TypeReferenceHandle)type).Name)),
            HandleKind.TypeDefinition => Full(md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)type).Namespace), md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)type).Name)),
            _ => null,
        };
    }

    private static string Full(string ns, string name) => ns.Length == 0 ? name : ns + "." + name;

    /// <summary>
    /// Where an implementation may live: <c>dotnet/shared/&lt;Framework&gt;/&lt;version&gt;</c> for
    /// <c>dotnet/packs/&lt;Framework&gt;.Ref/&lt;version&gt;/ref/&lt;tfm&gt;</c>, and <c>lib/&lt;tfm&gt;</c> for a NuGet
    /// package's <c>ref/&lt;tfm&gt;</c>.
    /// </summary>
    public static IEnumerable<string> ImplementationDirectories(string referencePath)
    {
        var tfmDir = new DirectoryInfo(Path.GetDirectoryName(referencePath)!);
        var refDir = tfmDir.Parent;
        if (refDir == null || !string.Equals(refDir.Name, "ref", StringComparison.OrdinalIgnoreCase)) yield break;
        var versionDir = refDir.Parent;
        var packDir = versionDir?.Parent;
        if (versionDir == null || packDir == null) yield break;
        // NuGet: <id>/<version>/ref/<tfm> -> <id>/<version>/lib/<tfm> (same tfm first).
        var lib = Path.Combine(versionDir.FullName, "lib");
        if (Directory.Exists(lib))
        {
            var same = Path.Combine(lib, tfmDir.Name);
            if (Directory.Exists(same)) yield return same;
            foreach (var d in Directory.GetDirectories(lib).OrderByDescending(x => x, StringComparer.OrdinalIgnoreCase))
                if (!string.Equals(d, same, StringComparison.OrdinalIgnoreCase)) yield return d;
        }
        // Targeting pack: <root>/packs/<Fw>.Ref/<version>/ref/<tfm> -> <root>/shared/<Fw>/<version>.
        var packs = packDir.Parent;
        if (packs == null || !string.Equals(packs.Name, "packs", StringComparison.OrdinalIgnoreCase) || packs.Parent == null) yield break;
        if (!packDir.Name.EndsWith(".Ref", StringComparison.OrdinalIgnoreCase)) yield break;
        var shared = Path.Combine(packs.Parent.FullName, "shared", packDir.Name[..^4]);
        if (!Directory.Exists(shared)) yield break;
        var wanted = ParseVersion(versionDir.Name);
        var versions = Directory.GetDirectories(shared)
            .Select(d => (dir: d, v: ParseVersion(Path.GetFileName(d))))
            .Where(x => x.v != null && wanted != null && x.v.Major == wanted.Major)
            .OrderByDescending(x => x.v == wanted)
            .ThenByDescending(x => x.v!.Minor == wanted!.Minor)
            .ThenByDescending(x => x.v)
            .Select(x => x.dir);
        foreach (var d in versions) yield return d;
    }

    private static Version? ParseVersion(string s)
    {
        var core = s.Split('-', '+')[0];
        return Version.TryParse(core, out var v) ? v : null;
    }

    /// <summary>The file in <paramref name="dir"/> that defines the type, following type forwarders (at most 5 hops).</summary>
    public static string? FollowForwarders(string dir, string fileName, string topLevelTypeName)
    {
        var split = topLevelTypeName.LastIndexOf('.');
        var ns = split < 0 ? "" : topLevelTypeName[..split];
        var name = split < 0 ? topLevelTypeName : topLevelTypeName[(split + 1)..];
        var file = fileName;
        for (var hop = 0; hop < 5; hop++)
        {
            var path = Path.Combine(dir, file);
            if (!File.Exists(path)) return null;
            try
            {
                using var pe = new PEReader(File.OpenRead(path));
                if (!pe.HasMetadata) return null;
                var md = pe.GetMetadataReader();
                foreach (var h in md.TypeDefinitions)
                {
                    var t = md.GetTypeDefinition(h);
                    if (t.GetDeclaringType().IsNil && md.StringComparer.Equals(t.Name, name) && md.StringComparer.Equals(t.Namespace, ns)) return path;
                }
                string? next = null;
                foreach (var h in md.ExportedTypes)
                {
                    var e = md.GetExportedType(h);
                    if (!md.StringComparer.Equals(e.Name, name) || !md.StringComparer.Equals(e.Namespace, ns)) continue;
                    if (e.Implementation.Kind == HandleKind.AssemblyReference)
                        next = md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)e.Implementation).Name) + ".dll";
                    break;
                }
                if (next == null) return null;
                file = next;
            }
            catch (Exception e) when (e is IOException or BadImageFormatException or UnauthorizedAccessException)
            {
                return null;
            }
        }
        return null;
    }
}
