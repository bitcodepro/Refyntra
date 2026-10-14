using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Host.Protocol;
using Refyntra.Semantics;
using Refyntra.Semantics.Metadata;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>
/// code/metadataSource (protocol 1.16): the read-only decompiled (or PDB-embedded) source of a metadata symbol, and
/// the symbol at a position inside such a document mapped back into the solution. One per host process; the
/// <see cref="MetadataSourceService"/> caches per assembly MVID.
/// </summary>
public sealed class MetadataSourceHandler
{
    public MetadataSourceService Service { get; } = new();

    public async Task<MetadataSourceResultDto> HandleAsync(Snapshot snap, MetadataSourceParams p, CancellationToken ct)
    {
        var policy = string.Equals(p.SourcePolicy, "off", StringComparison.OrdinalIgnoreCase) ? SourcePolicy.Off : SourcePolicy.EmbeddedOnly;
        var result = new MetadataSourceResultDto { SnapshotId = snap.Id, DecompilerVersion = MetadataSourceService.DecompilerVersion };
        try
        {
            ISymbol symbol;
            Project project;
            if (p.Document != null && p.Position != null)
            {
                var owner = await FindAsync(snap, p.Document.DocumentationId, p.Document.AssemblyName, ct).ConfigureAwait(false);
                if (owner == null) return Reason(result, "SymbolNotFound", "The type of this document is no longer referenced by the loaded solution.");
                var compilation = (await owner.Value.project.GetCompilationAsync(ct).ConfigureAwait(false))!;
                var doc = await Service.GetDocumentAsync(owner.Value.symbol, compilation, policy, ct).ConfigureAwait(false);
                if (doc == null) return Reason(result, "NotMetadata", "The type of this document has source in the solution now.");
                var hit = MetadataSourceService.SymbolAt(doc, compilation, new LinePosition(p.Position.Line, p.Position.Character), ct);
                if (hit == null) return Reason(result, "NoSymbol", "There is no symbol at this position that Refyntra can resolve.");
                if (hit.Symbol == null)
                {
                    if (!p.SymbolOnly) result.Document = Dto(doc);
                    result.SymbolRange = Mapper.Range(hit.LocalDeclaration!.Value);
                    return result;
                }
                (symbol, project) = (hit.Symbol, owner.Value.project);
            }
            else if (!string.IsNullOrEmpty(p.Uri) && p.Position != null)
            {
                string path;
                try { path = UriPaths.ToPath(p.Uri); }
                catch (ArgumentException ex) { throw new EngineException(ErrorCodes.InvalidParams, "InvalidUri", ex.Message); }
                var at = await SemanticService.SymbolAtAsync(snap, path, p.Position.Line, p.Position.Character, ct).ConfigureAwait(false);
                if (at == null) return Reason(result, "NoSymbol", "There is no symbol at the cursor.");
                (symbol, project) = at.Value;
            }
            else if (!string.IsNullOrEmpty(p.SymbolId))
            {
                (symbol, project) = await SymbolIds.ResolveAsync(snap, p.SymbolId, ct).ConfigureAwait(false);
            }
            else if (!string.IsNullOrEmpty(p.DocumentationId))
            {
                var found = await FindAsync(snap, p.DocumentationId, p.AssemblyName, ct).ConfigureAwait(false);
                if (found == null) return Reason(result, "SymbolNotFound", $"{p.DocumentationId[(p.DocumentationId.IndexOf(':') + 1)..]} is not referenced by the loaded solution.");
                (symbol, project) = found.Value;
            }
            else
            {
                throw new EngineException(ErrorCodes.InvalidParams, "InvalidParams", "symbolId, documentationId or document and position are required.");
            }

            var mapper = new Mapper(snap, project, ct);
            result.Symbol = mapper.Symbol(symbol);
            result.Summary = MetadataSourceService.Summary(symbol, ct);
            var source = await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder.FindSourceDefinitionAsync(symbol, snap.Solution, ct).ConfigureAwait(false) ?? symbol;
            if (SymbolFacts.PrimaryLocation(source) is { } inSource)
            {
                result.Location = Mapper.Location(inSource);
                return Reason(result, "InSource", "The symbol has source in the solution.");
            }
            if (p.SymbolOnly) return result;
            var comp = (await project.GetCompilationAsync(ct).ConfigureAwait(false))!;
            var document = await Service.GetDocumentAsync(symbol, comp, policy, ct).ConfigureAwait(false);
            if (document == null) return Reason(result, "NotMetadata", "The symbol has no declaration in a referenced assembly.");
            result.Document = Dto(document);
            var declared = MetadataSourceService.Declared(symbol);
            var span = (p.MemberName != null && symbol is INamedTypeSymbol ? document.FindMember(p.MemberName) : null)
                ?? document.Find(DocumentationCommentId.CreateDeclarationId(declared));
            if (span != null) result.SymbolRange = Mapper.Range(span.Name);
            return result;
        }
        catch (MetadataSourceException e)
        {
            return Reason(result, e.ReasonCode, e.Message);
        }
    }

    private static MetadataSourceResultDto Reason(MetadataSourceResultDto r, string code, string message)
    {
        r.ReasonCode = code;
        r.Message = message;
        return r;
    }

    /// <summary>A symbol by documentation id in the first project whose compilation knows it (in that assembly, when given).</summary>
    private static async Task<(ISymbol symbol, Project project)?> FindAsync(Snapshot snap, string documentationId, string? assemblyName, CancellationToken ct)
    {
        foreach (var project in snap.Solution.Projects.Where(x => x.Language == LanguageNames.CSharp))
        {
            ct.ThrowIfCancellationRequested();
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            var candidates = DocumentationCommentId.GetSymbolsForDeclarationId(documentationId, compilation);
            var hit = string.IsNullOrEmpty(assemblyName)
                ? candidates.FirstOrDefault()
                : candidates.FirstOrDefault(s => s.ContainingAssembly?.Identity.Name == assemblyName);
            if (hit != null) return (hit, project);
        }
        return null;
    }

    private static MetadataDocumentDto Dto(MetadataDocument d) => new()
    {
        Path = d.Path,
        AssemblyName = d.AssemblyName,
        AssemblyVersion = d.AssemblyVersion,
        AssemblyPath = d.AssemblyPath,
        ImplementationPath = d.ImplementationPath,
        Mvid = d.Mvid.ToString("D"),
        Origin = d.Origin,
        SourceDocument = d.SourceDocument,
        TypeDocumentationId = d.TypeDocumentationId,
        Text = d.Text,
        Symbols = d.Symbols.Select(s => new MetadataSymbolSpanDto { DocumentationId = s.DocumentationId, NameRange = Mapper.Range(s.Name), Range = Mapper.Range(s.Declaration) }).ToList(),
        Note = d.Note,
    };
}
