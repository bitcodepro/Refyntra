namespace Refyntra.Host.Protocol;

// code/metadataSource (protocol 1.16): decompiled / embedded sources of metadata symbols (packages/contracts/src/protocol.ts).

/// <summary>A metadata document as the client names it: the documentation id of its top-level type and its assembly.</summary>
public sealed class MetadataDocumentRefDto
{
    public string DocumentationId { get; set; } = "";
    public string AssemblyName { get; set; } = "";
}

public sealed class MetadataSourceParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    /// <summary>A symbol id from any other result (source symbols answer reasonCode "InSource" with their location).</summary>
    public string? SymbolId { get; set; }
    /// <summary>Or a documentation id ("T:Ns.Type", "M:Ns.Type.Run(System.Int32)") with an optional assembly name.</summary>
    public string? DocumentationId { get; set; }
    public string? AssemblyName { get; set; }
    /// <summary>With <see cref="DocumentationId"/> of a type: put the caret on its first member of this name.</summary>
    public string? MemberName { get; set; }
    /// <summary>Or the symbol at <see cref="Position"/> in this solution document ("Go to Metadata" at the cursor).</summary>
    public string? Uri { get; set; }
    /// <summary>Or the symbol at <see cref="Position"/> inside this metadata document (navigation, hover, usages).</summary>
    public MetadataDocumentRefDto? Document { get; set; }
    public PositionDto? Position { get; set; }
    /// <summary>"embeddedOnly" (default): sources embedded in the PDB, else decompile; "off": always decompile.</summary>
    public string? SourcePolicy { get; set; }
    /// <summary>Only the symbol (hover): no document text.</summary>
    public bool SymbolOnly { get; set; }
}

public sealed class MetadataSymbolSpanDto
{
    public string DocumentationId { get; set; } = "";
    public RangeDto NameRange { get; set; } = new();
    public RangeDto Range { get; set; } = new();
}

public sealed class MetadataDocumentDto
{
    /// <summary>"&lt;assembly&gt;/&lt;Namespace.Type&gt;.cs": the path of the refyntra-metadata: URI.</summary>
    public string Path { get; set; } = "";
    public string AssemblyName { get; set; } = "";
    public string AssemblyVersion { get; set; } = "";
    /// <summary>The referenced file; <see cref="ImplementationPath"/> is the file that was read (differs for reference assemblies).</summary>
    public string AssemblyPath { get; set; } = "";
    public string ImplementationPath { get; set; } = "";
    public string Mvid { get; set; } = "";
    /// <summary>"decompiled" | "embeddedSource".</summary>
    public string Origin { get; set; } = "decompiled";
    /// <summary>Embedded sources: the document path recorded in the PDB.</summary>
    public string? SourceDocument { get; set; }
    public string TypeDocumentationId { get; set; } = "";
    public string Text { get; set; } = "";
    public List<MetadataSymbolSpanDto> Symbols { get; set; } = new();
    public string? Note { get; set; }
}

public sealed class MetadataSourceResultDto
{
    public MetadataDocumentDto? Document { get; set; }
    /// <summary>Where the requested symbol is in <see cref="Document"/> (its name).</summary>
    public RangeDto? SymbolRange { get; set; }
    public SymbolRefDto? Symbol { get; set; }
    /// <summary>reasonCode "InSource": the declaration in the solution.</summary>
    public LocationDto? Location { get; set; }
    /// <summary>The summary of the symbol's XML documentation (hover).</summary>
    public string? Summary { get; set; }
    /// <summary>InSource | NoSymbol | SymbolNotFound | AssemblyNotFound | DecompilerFailed | NotMetadata.</summary>
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public string DecompilerVersion { get; set; } = "";
    public string SnapshotId { get; set; } = "";
}
