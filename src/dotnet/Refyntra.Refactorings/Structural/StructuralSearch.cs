using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings.Structural;

/// <summary>One search result: where, the line it starts on, and what each placeholder matched (shortened).</summary>
public sealed record SearchHit(string Path, LinePositionSpan Range, string LineText, IReadOnlyDictionary<string, string> Values);

public sealed record SearchOutcome(PatternKind Kind, IReadOnlyList<SearchHit> Hits, bool Truncated, int FilesSearched, int FilesWithMatches, IReadOnlyList<string> Notes, long ElapsedMs);

/// <summary>
/// Structural search (protocol 1.19, code/structuralSearch): the pattern is parsed once, bound once per project, and
/// matched against every C# document of the scope (a document, its project(s), the solution). Generated code is skipped;
/// a linked file is searched in its first project only. Documents that lack a word every match must contain are not
/// bound at all (no semantic model is built for them).
/// </summary>
public static class StructuralSearch
{
    public static readonly string[] Scopes = { "document", "project", "solution" };
    public const int MaxLimit = 5000;

    /// <summary>The documents of a scope (null when the scope needs a document that is not in the solution).</summary>
    public static IReadOnlyList<Document>? ScopeDocuments(Snapshot snapshot, string scope, string? path)
    {
        var solution = snapshot.Solution;
        Document? start = path == null ? null : snapshot.Session.DocumentIdsForPath(path).Select(solution.GetDocument).FirstOrDefault(d => d != null);
        IEnumerable<Document> docs;
        switch (scope)
        {
            case "document":
                if (start == null) return null;
                docs = new[] { start };
                break;
            case "project":
                if (start == null) return null;
                docs = snapshot.Session.DocumentIdsForPath(path!).Select(id => solution.GetProject(id.ProjectId)!).Distinct().SelectMany(p => p.Documents);
                break;
            default:
                docs = solution.Projects.Where(p => p.Language == LanguageNames.CSharp).SelectMany(p => p.Documents);
                break;
        }
        var seen = new HashSet<string>(UriPaths.PathComparer);
        return docs.Where(d => d.FilePath != null && seen.Add(d.FilePath)).ToList();
    }

    /// <summary>Binds patterns per project (one binding per project and pattern).</summary>
    public sealed class Binder
    {
        private readonly ParsedPattern _pattern;
        private readonly Dictionary<ProjectId, PatternBinding> _byProject = new();
        public List<string> Notes { get; } = new();

        public Binder(ParsedPattern pattern) => _pattern = pattern;

        public async Task<PatternBinding> ForAsync(Project project, CancellationToken ct)
        {
            if (_byProject.TryGetValue(project.Id, out var b)) return b;
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false) ?? throw new PatternException("NoCompilation", $"Project {project.Name} has no compilation.");
            b = PatternBinding.Create(_pattern, compilation, ct);
            foreach (var (name, type) in b.Constraints)
                if (type == null)
                {
                    var note = $"${name}$: type '{_pattern.Placeholders[name].Type}' is not found in project {project.Name}; it matches nothing there.";
                    if (!Notes.Contains(note)) Notes.Add(note);
                }
            _byProject[project.Id] = b;
            return b;
        }
    }

    /// <summary>The matches of one document (empty for generated code and documents without the pattern's words).</summary>
    public static async Task<List<StructuralMatch>> MatchDocumentAsync(Snapshot snapshot, Document doc, Binder binder, CancellationToken ct)
    {
        var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return new List<StructuralMatch>();
        var binding = await binder.ForAsync(doc.Project, ct).ConfigureAwait(false);
        if (binding.RequiredWords.Count > 0)
        {
            var text = (await doc.GetTextAsync(ct).ConfigureAwait(false)).ToString();
            if (binding.RequiredWords.Any(w => text.IndexOf(w, StringComparison.Ordinal) < 0)) return new List<StructuralMatch>();
        }
        var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return new StructuralMatcher(binding, model!, ct).FindAll(doc, root);
    }

    public static async Task<SearchOutcome> SearchAsync(Snapshot snapshot, PatternSpec spec, string scope, string? path, int limit, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        if (Array.IndexOf(Scopes, scope) < 0) throw new PatternException("InvalidParams", "scope must be document, project or solution.");
        limit = Math.Clamp(limit <= 0 ? 200 : limit, 1, MaxLimit);
        var parsed = ParsedPattern.Parse(spec);
        var docs = ScopeDocuments(snapshot, scope, path) ?? throw new PatternException("NoDocument", "The file is not a C# document of the loaded solution.");
        var binder = new Binder(parsed);
        var hits = new List<SearchHit>();
        int files = 0, withMatches = 0;
        var truncated = false;
        foreach (var doc in docs)
        {
            ct.ThrowIfCancellationRequested();
            files++;
            var matches = await MatchDocumentAsync(snapshot, doc, binder, ct).ConfigureAwait(false);
            if (matches.Count == 0) continue;
            withMatches++;
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            foreach (var m in matches)
            {
                if (hits.Count >= limit)
                {
                    truncated = true;
                    break;
                }
                var range = text.Lines.GetLinePositionSpan(m.Span);
                var line = text.Lines[range.Start.Line].ToString();
                hits.Add(new SearchHit(doc.FilePath!, range, line.Length > 300 ? line.Substring(0, 300) : line,
                    m.Bindings.ToDictionary(kv => kv.Key, kv => Shorten(kv.Value.Text), StringComparer.Ordinal)));
            }
            if (truncated) break;
        }
        return new SearchOutcome(parsed.Kind, hits, truncated, files, withMatches, binder.Notes, sw.ElapsedMilliseconds);
    }

    private static string Shorten(string s)
    {
        s = string.Join(" ", s.Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries));
        return s.Length > 120 ? s.Substring(0, 117) + "..." : s;
    }
}
