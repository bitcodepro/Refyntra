using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>The fix ids of Code Cleanup (protocol: PrepareParams.cleanup.fixes, setting refyntra.cleanup.profile).</summary>
public static class CleanupFixIds
{
    public const string RemoveUnnecessaryUsings = "removeUnnecessaryUsings";
    public const string SortUsings = "sortUsings";
    public const string FileScopedNamespace = "fileScopedNamespace";
    public const string Whitespace = "whitespace";
    /// <summary>Not offered in this version (see <see cref="CleanupPlanner.NotOffered"/>).</summary>
    public const string EditorConfigCodeStyle = "editorConfigCodeStyle";
}

/// <summary>One file as a fix sees it: the current text (after the fixes before it), its syntax and the .editorconfig options.</summary>
public sealed class CleanupFile
{
    public required string Path { get; init; }
    public required SourceText Text { get; init; }
    public required SyntaxNode Root { get; init; }
    /// <summary>.editorconfig options for the file (keys lower case, values as written).</summary>
    public required ImmutableDictionary<string, string> Options { get; init; }
    /// <summary>Effective C# language version of every project context of the file.</summary>
    public required IReadOnlyList<LanguageVersion> LanguageVersions { get; init; }
    /// <summary>The documents of the file in every project context (analysis solution), with <see cref="Text"/>.</summary>
    public required IReadOnlyList<Document> Contexts { get; init; }
    /// <summary>
    /// Semantic proof of a candidate text: null when it keeps every symbol binding, declared symbol, literal value and
    /// diagnostic of the original in every context; otherwise why not.
    /// </summary>
    public required Func<string, CancellationToken, Task<string?>> Verify { get; init; }

    public string LineBreak => CreateFilePlanner.LineBreak(Text.ToString());

    /// <summary>The value of a boolean .editorconfig option ("true"/"false", a ":severity" suffix ignored), or null.</summary>
    public bool? Flag(string key) => Option(key) switch { "true" => true, "false" => false, _ => null };

    /// <summary>The value of an .editorconfig option without a ":severity" suffix, lower case, or null.</summary>
    public string? Option(string key)
    {
        if (!Options.TryGetValue(key, out var v)) return null;
        var i = v.IndexOf(':');
        return (i >= 0 ? v.Substring(0, i) : v).Trim().ToLowerInvariant();
    }
}

/// <summary>What a fix did to one file.</summary>
public abstract record FixOutcome
{
    /// <summary>The fix has nothing to do (already clean, or the option does not ask for it).</summary>
    public sealed record NotApplicable : FixOutcome;
    /// <summary>The new text and how many places changed (usings removed, lines trimmed, ...). Already verified.</summary>
    public sealed record Changed(string Text, int Count) : FixOutcome;
    /// <summary>The fix would apply but is not provably safe here.</summary>
    public sealed record Skipped(string ReasonCode, string Message) : FixOutcome;

    public static readonly FixOutcome None = new NotApplicable();
}

/// <summary>
/// One Code Cleanup fix. A fix is text-only, idempotent (a second run returns NotApplicable) and returns only text that
/// <see cref="CleanupFile.Verify"/> accepted (or Skipped with the reason).
/// </summary>
public interface ICleanupFix
{
    string Id { get; }
    string Title { get; }
    /// <summary>Changes C# syntax (usings, namespaces): not run on files with conditional compilation.</summary>
    bool Semantic { get; }
    Task<FixOutcome> ApplyAsync(CleanupFile file, CancellationToken ct);
}

internal static class CleanupText
{
    /// <summary>Applies non-overlapping changes (any order) to <paramref name="text"/>.</summary>
    public static string Apply(string text, IEnumerable<TextChange> changes) =>
        SourceText.From(text).WithChanges(changes.OrderBy(c => c.Span.Start)).ToString();

    public static bool OnlyWhitespace(SyntaxTriviaList trivia) =>
        trivia.All(t => t.IsKind(SyntaxKind.WhitespaceTrivia) || t.IsKind(SyntaxKind.EndOfLineTrivia));

    public static bool HasDirective(SyntaxTriviaList trivia) => trivia.Any(t => t.IsDirective || t.IsKind(SyntaxKind.DisabledTextTrivia));
}
