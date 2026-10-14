using System.Collections.Concurrent;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics.Metadata;

/// <summary>Which sources may be shown for metadata besides decompiled code (setting refyntra.metadata.sourceLink).</summary>
public enum SourcePolicy
{
    /// <summary>Source files embedded in the assembly's portable PDB; otherwise decompile. Never downloads.</summary>
    EmbeddedOnly,
    /// <summary>Always decompile.</summary>
    Off,
}

/// <summary>A declaration in a metadata document: its documentation id, the name and the whole declaration.</summary>
public sealed record MetadataSymbolSpan(string DocumentationId, LinePositionSpan Name, LinePositionSpan Declaration);

/// <summary>
/// The read-only C# text of one top-level metadata type (decompiled, or the embedded source from the PDB) and the
/// declarations in it. <see cref="Path"/> is "&lt;assembly&gt;/&lt;Namespace.Type&gt;.cs".
/// </summary>
public sealed record MetadataDocument(
    string Path,
    string AssemblyName,
    string AssemblyVersion,
    string AssemblyPath,
    string ImplementationPath,
    Guid Mvid,
    string Origin,
    string? SourceDocument,
    string TypeDocumentationId,
    string Text,
    IReadOnlyList<MetadataSymbolSpan> Symbols,
    string? Note,
    SyntaxTree Tree)
{
    public const string Decompiled = "decompiled";
    public const string EmbeddedSource = "embeddedSource";

    /// <summary>The declaration of a documentation id, else of its nearest declared container ("M:A.B.C(int)" -> "T:A.B").</summary>
    public MetadataSymbolSpan? Find(string? documentationId)
    {
        if (documentationId == null) return null;
        var exact = Symbols.FirstOrDefault(s => s.DocumentationId == documentationId);
        if (exact != null) return exact;
        // Ids may carry the return type ("...~System.Int32") on one side only.
        static string Bare(string id) => id.IndexOf('~') is var t and >= 0 ? id[..t] : id;
        var bare = Bare(documentationId);
        exact = Symbols.FirstOrDefault(s => Bare(s.DocumentationId) == bare);
        if (exact != null) return exact;
        // Accessors: their property or event ("M:A.B.get_Name" -> "P:A.B.Name").
        if (documentationId.StartsWith("M:", StringComparison.Ordinal))
        {
            var dot = documentationId.LastIndexOf('.', documentationId.IndexOf('(') is var open and >= 0 ? open : documentationId.Length - 1);
            var member = documentationId[(dot + 1)..].Split('(')[0];
            foreach (var (prefix, kind) in new[] { ("get_", "P:"), ("set_", "P:"), ("init_", "P:"), ("add_", "E:"), ("remove_", "E:") })
            {
                if (!member.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var owner = documentationId[2..dot];
                var hit = Symbols.FirstOrDefault(s => s.DocumentationId == kind + owner + "." + member[prefix.Length..])
                    ?? (member == "get_Item" || member == "set_Item" ? Symbols.FirstOrDefault(s => s.DocumentationId.StartsWith("P:" + owner + ".Item(", StringComparison.Ordinal)) : null);
                if (hit != null) return hit;
            }
        }
        // Other members without their own declaration: the closest declaration by name prefix.
        var body = documentationId.Length > 2 ? documentationId[2..] : documentationId;
        var paren = body.IndexOf('(');
        var plain = paren < 0 ? body : body[..paren];
        return Symbols.Where(s => plain.StartsWith(s.DocumentationId[2..].Split('(')[0], StringComparison.Ordinal))
            .OrderByDescending(s => s.DocumentationId.Length).FirstOrDefault();
    }

    /// <summary>The first declaration of a member of the type by name ("ToString", ".ctor" -> constructors).</summary>
    public MetadataSymbolSpan? FindMember(string memberName)
    {
        var type = TypeDocumentationId[2..];
        var name = memberName == ".ctor" ? "#ctor" : memberName;
        return Symbols.FirstOrDefault(s => s.DocumentationId.Length > 2 && s.DocumentationId[1] == ':' && s.DocumentationId[0] != 'T'
            && (s.DocumentationId[2..] == type + "." + name || s.DocumentationId[2..].StartsWith(type + "." + name + "(", StringComparison.Ordinal)
                || s.DocumentationId[2..].StartsWith(type + "." + name + "``", StringComparison.Ordinal)));
    }
}

/// <summary>What the cursor is on inside a metadata document.</summary>
public sealed record MetadataHit(ISymbol? Symbol, LinePositionSpan? LocalDeclaration);

/// <summary>
/// Go to metadata / decompiled sources. One instance per host process: decompilers are cached per assembly MVID and
/// documents per (MVID, type, policy). Reads only local files; nothing is downloaded.
/// </summary>
public sealed class MetadataSourceService
{
    private const int MaxDecompilers = 8;
    private const int MaxDocuments = 128;
    private readonly ConcurrentDictionary<string, MetadataDocument> _documents = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Guid, (TypeDecompiler decompiler, long used)> _decompilers = new();
    private long _clock;

    public int CachedDocuments => _documents.Count;
    public int CachedAssemblies => _decompilers.Count;
    /// <summary>How many documents were built (not served from the cache); for tests.</summary>
    public int Builds => _builds;
    private int _builds;

    public static string DecompilerVersion => TypeDecompiler.Version;

    /// <summary>The outermost type that contains <paramref name="symbol"/> (the type itself for a top-level type).</summary>
    public static INamedTypeSymbol? TopLevelType(ISymbol symbol)
    {
        var t = symbol as INamedTypeSymbol ?? symbol.ContainingType;
        while (t?.ContainingType != null) t = t.ContainingType;
        return t?.OriginalDefinition;
    }

    /// <summary>Metadata symbols as declared: original definitions, reduced extension methods as declared.</summary>
    public static ISymbol Declared(ISymbol symbol)
    {
        symbol = symbol is IMethodSymbol { ReducedFrom: { } r } ? r : symbol;
        return symbol.OriginalDefinition;
    }

    public static string ReflectionName(INamedTypeSymbol top)
    {
        var ns = top.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() : "";
        return ns.Length == 0 ? top.MetadataName : ns + "." + top.MetadataName;
    }

    /// <summary>
    /// The document of the top-level type around a metadata symbol, from the cache or built now. Null when the symbol
    /// is not from metadata (or is a namespace). Throws <see cref="MetadataSourceException"/> when the assembly file
    /// cannot be read or decompiled, <see cref="OperationCanceledException"/> on cancellation.
    /// </summary>
    public async Task<MetadataDocument?> GetDocumentAsync(ISymbol symbol, Compilation compilation, SourcePolicy policy, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var top = TopLevelType(Declared(symbol));
        if (top == null || !top.Locations.Any(l => l.IsInMetadata)) return null;
        var assembly = top.ContainingAssembly;
        if (compilation.GetMetadataReference(assembly) is not PortableExecutableReference { FilePath: { Length: > 0 } referencePath } || !File.Exists(referencePath))
            throw new MetadataSourceException("AssemblyNotFound", $"The file of {assembly.Identity.Name} is not available locally.");
        var typeName = ReflectionName(top);
        var located = Locate(referencePath, typeName);
        Guid mvid;
        try { mvid = MvidOf(located.ImplementationPath); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new MetadataSourceException("AssemblyNotFound", $"{System.IO.Path.GetFileName(located.ImplementationPath)} cannot be read: {e.Message}");
        }
        var key = $"{mvid:N}|{typeName}|{policy}|{assembly.Identity.Name}";
        if (_documents.TryGetValue(key, out var cached)) return cached;
        byte[] image;
        try { image = await File.ReadAllBytesAsync(located.ImplementationPath, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new MetadataSourceException("AssemblyNotFound", $"{System.IO.Path.GetFileName(located.ImplementationPath)} cannot be read: {e.Message}");
        }
        var actual = Mvid(image);
        if (actual != mvid)
        {
            // Replaced between the header read and now: build for what was read.
            _stamps.TryRemove(located.ImplementationPath, out _);
            mvid = actual;
            key = $"{mvid:N}|{typeName}|{policy}|{assembly.Identity.Name}";
        }

        var docId = DocumentationCommentId.CreateDeclarationId(top) ?? "T:" + typeName;
        string text, origin;
        string? sourceDocument = null, note = null;
        var embedded = policy == SourcePolicy.EmbeddedOnly ? EmbeddedSources.Find(image, located.ImplementationPath, typeName, symbol is IMethodSymbol m ? m.MetadataName : null, ct) : null;
        if (embedded != null)
        {
            origin = MetadataDocument.EmbeddedSource;
            sourceDocument = embedded.DocumentName;
            text = Header(assembly, located, mvid, typeName, $"Source embedded in the PDB of {System.IO.Path.GetFileName(located.ImplementationPath)}: {embedded.DocumentName}") + embedded.Text;
        }
        else
        {
            origin = MetadataDocument.Decompiled;
            if (located.ReferenceOnly) note = "Reference assembly: no implementation was found locally, so members have no bodies.";
            var decompiler = Decompiler(mvid, located, compilation, image);
            string body;
            try { body = await Task.Run(() => decompiler.Decompile(typeName, ct), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { throw; }
            catch (Exception e)
            {
                throw new MetadataSourceException("DecompilerFailed", $"{typeName} could not be decompiled: {e.GetType().Name}: {e.Message}");
            }
            text = Header(assembly, located, mvid, typeName, $"Decompiled from {System.IO.Path.GetFileName(located.ImplementationPath)} with ICSharpCode.Decompiler {DecompilerVersion}" + (note != null ? $". {note}" : "")) + body;
        }
        text = text.Replace("\r\n", "\n");
        ct.ThrowIfCancellationRequested();
        var tree = CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.Preview), path: "", cancellationToken: ct);
        var symbols = Declarations(tree, compilation, ct);
        var doc = new MetadataDocument(
            assembly.Identity.Name + "/" + DisplayTypeName(top) + ".cs",
            assembly.Identity.Name, assembly.Identity.Version.ToString(), referencePath, located.ImplementationPath, mvid, origin, sourceDocument,
            docId, text, symbols, note, tree);
        Interlocked.Increment(ref _builds);
        if (_documents.Count >= MaxDocuments) _documents.Clear();
        return _documents.GetOrAdd(key, doc);
    }

    /// <summary>"Ns.Outer`1" without arity markers: "Ns.Outer".</summary>
    private static string DisplayTypeName(INamedTypeSymbol top)
    {
        var ns = top.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : "";
        var name = top.Arity > 0 ? $"{top.Name}`{top.Arity}" : top.Name;
        return ns + name;
    }

    private static string Header(IAssemblySymbol assembly, AssemblyFiles.Located located, Guid mvid, string typeName, string how)
    {
        var sb = new StringBuilder();
        sb.Append("// ").Append(typeName).Append('\n');
        sb.Append("// Assembly: ").Append(assembly.Identity.GetDisplayName()).Append('\n');
        if (!string.Equals(System.IO.Path.GetFileNameWithoutExtension(located.ImplementationPath), assembly.Identity.Name, StringComparison.OrdinalIgnoreCase))
            sb.Append("// Implementation: ").Append(System.IO.Path.GetFileName(located.ImplementationPath)).Append('\n');
        sb.Append("// MVID: ").Append(mvid.ToString("D")).Append('\n');
        sb.Append("// ").Append(how).Append('\n');
        sb.Append("// Read-only: no source for this type in the solution.\n\n");
        return sb.ToString();
    }

    private readonly ConcurrentDictionary<string, (DateTime written, long length, Guid mvid)> _stamps = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, (DateTime written, AssemblyFiles.Located located)> _located = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Where a type of a reference is implemented; cached until the reference file changes.</summary>
    private AssemblyFiles.Located Locate(string referencePath, string typeName)
    {
        var key = referencePath + "|" + typeName;
        var written = File.GetLastWriteTimeUtc(referencePath);
        if (_located.TryGetValue(key, out var hit) && hit.written == written && File.Exists(hit.located.ImplementationPath)) return hit.located;
        var located = AssemblyFiles.Locate(referencePath, typeName);
        _located[key] = (written, located);
        return located;
    }

    /// <summary>The MVID of an assembly file from its metadata header; cached by write time and length.</summary>
    private Guid MvidOf(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("The file does not exist.", path);
        if (_stamps.TryGetValue(path, out var s) && s.written == info.LastWriteTimeUtc && s.length == info.Length) return s.mvid;
        Guid mvid;
        try
        {
            using var pe = new PEReader(File.OpenRead(path));
            var md = pe.GetMetadataReader();
            mvid = md.GetGuid(md.GetModuleDefinition().Mvid);
        }
        catch (BadImageFormatException e)
        {
            throw new MetadataSourceException("AssemblyNotFound", $"Not a .NET assembly: {e.Message}");
        }
        _stamps[path] = (info.LastWriteTimeUtc, info.Length, mvid);
        return mvid;
    }

    private static Guid Mvid(byte[] image)
    {
        try
        {
            using var pe = new PEReader(new MemoryStream(image));
            var md = pe.GetMetadataReader();
            return md.GetGuid(md.GetModuleDefinition().Mvid);
        }
        catch (BadImageFormatException e)
        {
            throw new MetadataSourceException("AssemblyNotFound", $"Not a .NET assembly: {e.Message}");
        }
    }

    private TypeDecompiler Decompiler(Guid mvid, AssemblyFiles.Located located, Compilation compilation, byte[] image)
    {
        var now = Interlocked.Increment(ref _clock);
        if (_decompilers.TryGetValue(mvid, out var hit))
        {
            _decompilers[mvid] = (hit.decompiler, now);
            return hit.decompiler;
        }
        var paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var implDir = System.IO.Path.GetDirectoryName(located.ImplementationPath)!;
        // The implementation directory first (a shared framework resolves its own forwarders), then the project's references.
        foreach (var f in SafeFiles(implDir)) paths.TryAdd(System.IO.Path.GetFileNameWithoutExtension(f), f);
        foreach (var r in compilation.References.OfType<PortableExecutableReference>())
            if (r.FilePath is { Length: > 0 } p) paths.TryAdd(System.IO.Path.GetFileNameWithoutExtension(p), p);
        var created = new TypeDecompiler(located.ImplementationPath, image, located.XmlPath, paths);
        if (_decompilers.Count >= MaxDecompilers)
        {
            var oldest = _decompilers.OrderBy(kv => kv.Value.used).First().Key;
            _decompilers.TryRemove(oldest, out _);
        }
        _decompilers[mvid] = (created, now);
        return created;
    }

    private static IEnumerable<string> SafeFiles(string dir)
    {
        try { return Directory.GetFiles(dir, "*.dll"); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return Array.Empty<string>(); }
    }

    /// <summary>A compilation of the document's text against the project's references (the type is declared in it).</summary>
    private static CSharpCompilation Compile(SyntaxTree tree, Compilation compilation) =>
        CSharpCompilation.Create("Refyntra.Metadata", new[] { tree }, compilation.References,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));

    private static IReadOnlyList<MetadataSymbolSpan> Declarations(SyntaxTree tree, Compilation compilation, CancellationToken ct)
    {
        var model = Compile(tree, compilation).GetSemanticModel(tree, ignoreAccessibility: true);
        var list = new List<MetadataSymbolSpan>();
        foreach (var node in tree.GetRoot(ct).DescendantNodes(n => n is not (BlockSyntax or ArrowExpressionClauseSyntax or EqualsValueClauseSyntax)))
        {
            ct.ThrowIfCancellationRequested();
            var name = NameToken(node);
            if (name == null) continue;
            var declared = model.GetDeclaredSymbol(node, ct);
            var id = declared == null ? null : DocumentationCommentId.CreateDeclarationId(declared);
            if (id == null) continue;
            list.Add(new MetadataSymbolSpan(id, tree.GetLineSpan(name.Value.Span).Span, tree.GetLineSpan(node is VariableDeclaratorSyntax ? node.Parent!.Parent!.Span : node.Span).Span));
        }
        return list;
    }

    private static SyntaxToken? NameToken(SyntaxNode node) => node switch
    {
        BaseTypeDeclarationSyntax t => t.Identifier,
        DelegateDeclarationSyntax d => d.Identifier,
        MethodDeclarationSyntax m => m.Identifier,
        ConstructorDeclarationSyntax c => c.Identifier,
        DestructorDeclarationSyntax d => d.Identifier,
        PropertyDeclarationSyntax p => p.Identifier,
        EventDeclarationSyntax e => e.Identifier,
        IndexerDeclarationSyntax i => i.ThisKeyword,
        OperatorDeclarationSyntax o => o.OperatorToken,
        ConversionOperatorDeclarationSyntax c => c.Type.GetFirstToken(),
        EnumMemberDeclarationSyntax e => e.Identifier,
        VariableDeclaratorSyntax v when v.Parent?.Parent is BaseFieldDeclarationSyntax => v.Identifier,
        _ => null,
    };

    /// <summary>
    /// The symbol at a position of a metadata document, mapped back into <paramref name="compilation"/> (so its id,
    /// usages and source location are those of the solution). Locals and parameters declared in the document give
    /// their declaration instead. Null when nothing is there or it cannot be mapped.
    /// </summary>
    public static MetadataHit? SymbolAt(MetadataDocument document, Compilation compilation, LinePosition position, CancellationToken ct)
    {
        var tree = document.Tree;
        var text = tree.GetText(ct);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return null;
        var line = text.Lines[position.Line];
        var offset = Math.Min(line.Start + position.Character, line.End);
        var mcomp = Compile(tree, compilation);
        var model = mcomp.GetSemanticModel(tree, ignoreAccessibility: true);
        var root = tree.GetRoot(ct);
        var token = root.FindToken(offset);
        if (!IsNameLike(token) && offset > 0)
        {
            var before = root.FindToken(offset - 1);
            if (IsNameLike(before)) token = before;
        }
        if (!IsNameLike(token)) return null;
        ISymbol? found = null;
        for (var node = token.Parent; node != null && found == null; node = node.Parent)
        {
            if (NameToken(node) is { } nt && nt == token || node is ParameterSyntax ps && ps.Identifier == token
                || node is TypeParameterSyntax tp && tp.Identifier == token || node is VariableDeclaratorSyntax vd && vd.Identifier == token
                || node is SingleVariableDesignationSyntax sv && sv.Identifier == token || node is LocalFunctionStatementSyntax lf && lf.Identifier == token
                || node is ForEachStatementSyntax fe && fe.Identifier == token || node is CatchDeclarationSyntax cd && cd.Identifier == token)
            {
                found = model.GetDeclaredSymbol(node, ct);
                break;
            }
            if (node is ExpressionSyntax or TypeSyntax or ConstructorInitializerSyntax or AttributeSyntax or CrefSyntax)
            {
                var info = model.GetSymbolInfo(node, ct);
                found = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
                if (found == null && node is TypeSyntax) found = model.GetTypeInfo(node, ct).Type is { TypeKind: not TypeKind.Error } t ? t : null;
            }
            if (node is StatementSyntax or MemberDeclarationSyntax) break;
        }
        if (found == null) return null;
        if (found is IAliasSymbol alias) found = alias.Target;
        if (found.Kind is SymbolKind.Local or SymbolKind.Parameter or SymbolKind.RangeVariable or SymbolKind.Label or SymbolKind.TypeParameter
            || found is IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction })
        {
            var loc = found.Locations.FirstOrDefault(l => l.SourceTree == tree);
            return loc == null ? null : new MetadataHit(null, loc.GetLineSpan().Span);
        }
        found = Declared(found);
        var id = DocumentationCommentId.CreateDeclarationId(found);
        if (id == null) return null;
        var assemblyName = SymbolEqualityComparer.Default.Equals(found.ContainingAssembly, mcomp.Assembly) ? document.AssemblyName : found.ContainingAssembly?.Identity.Name;
        var candidates = DocumentationCommentId.GetSymbolsForDeclarationId(id, compilation);
        var mapped = candidates.FirstOrDefault(s => s.ContainingAssembly?.Identity.Name == assemblyName) ?? candidates.FirstOrDefault();
        return mapped == null ? null : new MetadataHit(mapped, null);
    }

    private static bool IsNameLike(SyntaxToken t) =>
        t.IsKind(SyntaxKind.IdentifierToken) || t.IsKind(SyntaxKind.ThisKeyword) || t.IsKind(SyntaxKind.BaseKeyword) || SyntaxFacts.IsPredefinedType(t.Kind())
        || (t.Parent is OperatorDeclarationSyntax o && o.OperatorToken == t);

    /// <summary>The plain text of the summary of a symbol's XML documentation (null when there is none).</summary>
    public static string? Summary(ISymbol symbol, CancellationToken ct)
    {
        var xml = symbol.GetDocumentationCommentXml(cancellationToken: ct);
        if (string.IsNullOrWhiteSpace(xml)) return null;
        try
        {
            var summary = XElement.Parse(xml).Element("summary");
            if (summary == null) return null;
            var sb = new StringBuilder();
            foreach (var n in summary.DescendantNodes())
            {
                if (n is XText t) sb.Append(t.Value);
                else if (n is XElement e && (e.Name == "see" || e.Name == "paramref" || e.Name == "typeparamref") && !e.Nodes().Any())
                {
                    var r = (string?)e.Attribute("cref") ?? (string?)e.Attribute("name") ?? (string?)e.Attribute("langword") ?? "";
                    sb.Append(r.Length > 2 && r[1] == ':' ? r[2..] : r);
                }
            }
            var s = string.Join(' ', sb.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            return s.Length == 0 ? null : s;
        }
        catch (System.Xml.XmlException)
        {
            return null;
        }
    }
}

/// <summary>A metadata document cannot be produced: <see cref="ReasonCode"/> is AssemblyNotFound or DecompilerFailed.</summary>
public sealed class MetadataSourceException : Exception
{
    public string ReasonCode { get; }
    public MetadataSourceException(string reasonCode, string message) : base(message) => ReasonCode = reasonCode;
}
