using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>
/// Text only, and only what .editorconfig asks for: trim_trailing_whitespace = true removes spaces and tabs at line ends
/// (never inside a string literal or in code disabled by #if, where they could matter); insert_final_newline = true adds
/// the file's own line break at the end. Nothing happens without these options (VS Code's files.* settings are not read).
/// </summary>
public sealed class WhitespaceFix : ICleanupFix
{
    public string Id => CleanupFixIds.Whitespace;
    public string Title => "Trailing whitespace and final newline (.editorconfig)";
    public bool Semantic => false;

    public async Task<FixOutcome> ApplyAsync(CleanupFile file, CancellationToken ct)
    {
        var trim = file.Flag("trim_trailing_whitespace") == true;
        var finalNewline = file.Flag("insert_final_newline") == true;
        if (!trim && !finalNewline) return FixOutcome.None;
        var text = file.Text;
        var changes = new List<TextChange>();
        var count = 0;
        if (trim)
        {
            foreach (var line in text.Lines)
            {
                var end = line.End;
                var start = end;
                while (start > line.Start && text[start - 1] is ' ' or '\t') start--;
                if (start == end || Protected(file.Root, start)) continue;
                changes.Add(new TextChange(TextSpan.FromBounds(start, end), ""));
                count++;
            }
        }
        var s = text.ToString();
        if (finalNewline && s.Length > 0 && !s.EndsWith('\n'))
        {
            string? eol = file.Option("end_of_line") switch { "lf" => "\n", "crlf" => "\r\n", _ => null };
            eol ??= s.Contains('\n') ? file.LineBreak : null;
            // A one-line file without end_of_line: the line break style is unknown; the final newline is left alone.
            if (eol != null && !Protected(file.Root, s.Length))
            {
                changes.Add(new TextChange(new TextSpan(s.Length, 0), eol));
                count++;
            }
        }
        if (changes.Count == 0) return FixOutcome.None;
        var result = CleanupText.Apply(s, changes);
        if (await file.Verify(result, ct).ConfigureAwait(false) is { } reason)
            return new FixOutcome.Skipped("SemanticsNotProven", "Removing the whitespace would change the code: " + reason);
        return new FixOutcome.Changed(result, count);
    }

    /// <summary>The position is inside a token (a string spanning lines) or in disabled code or an unterminated comment.</summary>
    private static bool Protected(SyntaxNode root, int position)
    {
        var token = root.FindToken(Math.Min(position, Math.Max(0, root.FullSpan.End - 1)), findInsideTrivia: true);
        if (token.SpanStart < position && position < token.Span.End) return true;
        var trivia = root.FindTrivia(Math.Min(position, Math.Max(0, root.FullSpan.End - 1)), findInsideTrivia: true);
        if (trivia.IsKind(SyntaxKind.DisabledTextTrivia) && trivia.SpanStart <= position && position <= trivia.Span.End) return true;
        if (trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) && !trivia.ToString().EndsWith("*/", StringComparison.Ordinal) && position >= trivia.SpanStart) return true;
        return false;
    }
}
