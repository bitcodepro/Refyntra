using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>
/// Removes using directives the C# compiler reports as unnecessary (CS8019) in every project context of the file — the
/// same directives VS Code's "Organize imports"/"Remove unnecessary usings" removes, but across many files with one
/// preview. Global usings are never removed (they affect other files). The compiler's report is only the candidate list:
/// the result must pass the semantic proof; when removing all candidates together does not, each one is tried alone.
/// </summary>
public sealed class RemoveUnnecessaryUsingsFix : ICleanupFix
{
    public string Id => CleanupFixIds.RemoveUnnecessaryUsings;
    public string Title => "Remove unnecessary usings";
    public bool Semantic => true;

    public async Task<FixOutcome> ApplyAsync(CleanupFile file, CancellationToken ct)
    {
        // Candidates: CS8019 at the same using in every context (a using needed in one target framework stays).
        HashSet<int>? common = null;
        foreach (var doc in file.Contexts)
        {
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            if (model == null || root == null) return new FixOutcome.Skipped("NoSemanticModel", "The file has no semantic model.");
            var here = new HashSet<int>();
            foreach (var d in model.GetDiagnostics(cancellationToken: ct).Where(d => d.Id == "CS8019"))
                if (root.FindNode(d.Location.SourceSpan, getInnermostNodeForTie: true).AncestorsAndSelf().OfType<UsingDirectiveSyntax>().FirstOrDefault() is { } u)
                    here.Add(u.SpanStart);
            if (common == null) common = here;
            else common.IntersectWith(here);
        }
        var candidates = file.Root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
            .OfType<UsingDirectiveSyntax>()
            .Where(u => common != null && common.Contains(u.SpanStart) && u.GlobalKeyword.IsKind(SyntaxKind.None))
            .ToList();
        if (candidates.Count == 0) return FixOutcome.None;

        var text = file.Text.ToString();
        var all = Remove(file, text, candidates);
        if (await file.Verify(all, ct).ConfigureAwait(false) == null) return new FixOutcome.Changed(all, candidates.Count);
        // One at a time: keep each removal that keeps the proof.
        var removed = new List<UsingDirectiveSyntax>();
        string? lastReason = null;
        foreach (var c in candidates)
        {
            var trial = Remove(file, text, removed.Append(c).ToList());
            var reason = await file.Verify(trial, ct).ConfigureAwait(false);
            if (reason == null) removed.Add(c);
            else lastReason = reason;
        }
        if (removed.Count == 0)
            return new FixOutcome.Skipped("SemanticsNotProven", "The compiler reports unnecessary usings, but removing them would change the code: " + lastReason);
        return new FixOutcome.Changed(Remove(file, text, removed), removed.Count);
    }

    /// <summary>
    /// The text without <paramref name="usings"/>: each removed with its line; a comment above it stays. When every using
    /// of a block goes and nothing precedes the block in its scope, the blank lines after it go too.
    /// </summary>
    internal static string Remove(CleanupFile file, string text, IReadOnlyList<UsingDirectiveSyntax> usings)
    {
        var changes = new List<TextChange>();
        var set = new HashSet<UsingDirectiveSyntax>(usings);
        foreach (var u in usings)
        {
            var start = CleanupText.OnlyWhitespace(u.GetLeadingTrivia()) ? u.FullSpan.Start : u.SpanStart;
            var end = u.FullSpan.End;
            var siblings = u.Parent switch
            {
                CompilationUnitSyntax cu => cu.Usings,
                BaseNamespaceDeclarationSyntax ns => ns.Usings,
                _ => default,
            };
            var last = siblings.LastOrDefault();
            if (last == u && siblings.All(set.Contains) && u.Parent is not CompilationUnitSyntax { Externs.Count: > 0 } and not BaseNamespaceDeclarationSyntax { Externs.Count: > 0 }
                && NothingBefore(text, siblings[0]))
            {
                // Eat the blank lines that separated the block from what follows.
                var p = end;
                while (true)
                {
                    var q = p;
                    while (q < text.Length && (text[q] == ' ' || text[q] == '\t')) q++;
                    if (q < text.Length && text[q] == '\r' && q + 1 < text.Length && text[q + 1] == '\n') q += 2;
                    else if (q < text.Length && text[q] == '\n') q++;
                    else break;
                    p = q;
                }
                end = p;
            }
            changes.Add(new TextChange(TextSpan.FromBounds(start, end), ""));
        }
        return CleanupText.Apply(text, changes);
    }

    /// <summary>The first using of the block starts the file, or directly follows the line of the namespace's "{".</summary>
    private static bool NothingBefore(string text, UsingDirectiveSyntax first)
    {
        if (!CleanupText.OnlyWhitespace(first.GetLeadingTrivia())) return false;
        var i = first.FullSpan.Start - 1;
        while (i >= 0 && char.IsWhiteSpace(text[i])) i--;
        return i < 0 || text[i] == '{' || text[i] == '﻿';
    }
}
