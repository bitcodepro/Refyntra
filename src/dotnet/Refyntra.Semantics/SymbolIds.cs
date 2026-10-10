using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>
/// Opaque symbol ids: base64url of (version, sessionEpoch, snapshotId, projectContextId, kind, assembly, key).
/// kind "D" = DocumentationCommentId; kind "L" = local/parameter/lambda identified by file path and position.
/// Valid only for the snapshot they were produced on.
/// </summary>
public static class SymbolIds
{
    private const string Version = "r1";

    public static string? Encode(Snapshot snapshot, ISymbol symbol, string contextId)
    {
        symbol = Normalize(symbol);
        var docId = DocumentationCommentId.CreateDeclarationId(symbol);
        string kind, key;
        if (docId != null && symbol.Kind is not (SymbolKind.Local or SymbolKind.Parameter or SymbolKind.RangeVariable or SymbolKind.Label)
            && symbol is not IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction })
        {
            kind = "D";
            key = docId;
        }
        else
        {
            var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
            if (loc?.SourceTree?.FilePath is not { Length: > 0 } path) return null;
            kind = "L";
            key = path + "|" + loc.SourceSpan.Start;
        }
        var assembly = symbol.ContainingAssembly?.Identity.Name ?? "";
        var raw = string.Join('\n', Version, snapshot.Epoch, snapshot.Id, contextId, kind, assembly, key);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public sealed record Decoded(string Epoch, string SnapshotId, string ContextId, string Kind, string Assembly, string Key);

    public static Decoded? TryDecode(string id)
    {
        try
        {
            var b64 = id.Replace('-', '+').Replace('_', '/');
            b64 += new string('=', (4 - b64.Length % 4) % 4);
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(b64)).Split('\n');
            if (parts.Length != 7 || parts[0] != Version) return null;
            return new Decoded(parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static ISymbol Normalize(ISymbol symbol) => symbol switch
    {
        IAliasSymbol alias => alias.Target,
        _ => symbol,
    };

    /// <summary>Resolves an id on the given (current) snapshot. Throws StaleSnapshot / UnknownSymbol.</summary>
    public static async Task<(ISymbol symbol, Project project)> ResolveAsync(Snapshot snapshot, string symbolId, CancellationToken ct)
    {
        var d = TryDecode(symbolId) ?? throw new EngineException(ErrorCodes.UnknownSymbol, "UnknownSymbol", "The symbol id is malformed.");
        if (d.Epoch != snapshot.Epoch || d.SnapshotId != snapshot.Id)
            throw new EngineException(ErrorCodes.StaleSnapshot, "StaleSnapshot",
                "The symbol id belongs to another snapshot or session. Query the symbol again on the current snapshot.");
        var ctx = snapshot.Session.ContextById(d.ContextId);
        var project = ctx?.ProjectId != null ? snapshot.Solution.GetProject(ctx.ProjectId) : null;
        if (project == null) throw new EngineException(ErrorCodes.UnknownSymbol, "UnknownSymbol", "The project context of the symbol is not loaded.");
        ISymbol? symbol = null;
        if (d.Kind == "D")
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation != null)
            {
                var candidates = DocumentationCommentId.GetSymbolsForDeclarationId(d.Key, compilation);
                symbol = candidates.FirstOrDefault(s => (s.ContainingAssembly?.Identity.Name ?? "") == d.Assembly) ?? candidates.FirstOrDefault();
            }
        }
        else if (d.Kind == "L")
        {
            var sep = d.Key.LastIndexOf('|');
            if (sep > 0 && int.TryParse(d.Key.AsSpan(sep + 1), out var pos))
            {
                var path = d.Key.Substring(0, sep);
                var doc = project.Documents.FirstOrDefault(x => x.FilePath != null && UriPaths.PathComparer.Equals(x.FilePath, path));
                if (doc != null) symbol = await SymbolFinder.FindSymbolAtPositionAsync(doc, pos, ct).ConfigureAwait(false);
            }
        }
        if (symbol == null) throw new EngineException(ErrorCodes.UnknownSymbol, "UnknownSymbol", "The symbol could not be resolved in this snapshot.");
        var source = await SymbolFinder.FindSourceDefinitionAsync(symbol, snapshot.Solution, ct).ConfigureAwait(false);
        symbol = source ?? symbol;
        var owner = SymbolFacts.OwningProject(snapshot.Solution, symbol) ?? project;
        return (symbol, owner);
    }
}
