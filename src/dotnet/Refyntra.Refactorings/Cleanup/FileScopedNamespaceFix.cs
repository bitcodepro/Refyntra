using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>
/// Converts "namespace N { ... }" to "namespace N;" when .editorconfig asks for it (csharp_style_namespace_declarations =
/// file_scoped) and every project context of the file compiles with C# 10 or later. Only a file whose single top-level
/// member is that namespace (no top-level code, no second or nested namespace), with no comment on the namespace's
/// header or braces and no string spanning lines inside it (dedenting would change it). The body is dedented by one
/// level; lines that are not indented by that level keep their text.
/// </summary>
public sealed class FileScopedNamespaceFix : ICleanupFix
{
    public string Id => CleanupFixIds.FileScopedNamespace;
    public string Title => "Use file-scoped namespace";
    public bool Semantic => true;

    public async Task<FixOutcome> ApplyAsync(CleanupFile file, CancellationToken ct)
    {
        if (file.Option("csharp_style_namespace_declarations") != "file_scoped") return FixOutcome.None;
        if (file.Root is not CompilationUnitSyntax cu) return FixOutcome.None;
        var blocks = cu.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).OfType<NamespaceDeclarationSyntax>().ToList();
        if (blocks.Count == 0) return FixOutcome.None;
        if (file.LanguageVersions.Any(v => v < LanguageVersion.CSharp10))
            return new FixOutcome.Skipped("LanguageVersion", "The project compiles with a C# version before 10, which has no file-scoped namespaces.");
        if (cu.Members.Count != 1 || cu.Members[0] is not NamespaceDeclarationSyntax ns)
            return new FixOutcome.Skipped("NotSingleNamespace", "The file has more than one namespace or code outside its namespace.");
        if (ns.Members.OfType<BaseNamespaceDeclarationSyntax>().Any())
            return new FixOutcome.Skipped("NotSingleNamespace", "The namespace contains a nested namespace.");
        if (!CleanupText.OnlyWhitespace(ns.Name.GetTrailingTrivia()) || !CleanupText.OnlyWhitespace(ns.OpenBraceToken.LeadingTrivia)
            || !CleanupText.OnlyWhitespace(ns.OpenBraceToken.TrailingTrivia) || !CleanupText.OnlyWhitespace(ns.CloseBraceToken.LeadingTrivia)
            || !CleanupText.OnlyWhitespace(ns.CloseBraceToken.TrailingTrivia) || ns.SemicolonToken.Span.Length > 0
            || !ns.OpenBraceToken.TrailingTrivia.Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)))
            return new FixOutcome.Skipped("NamespaceLayout", "A comment or code stands on the line of the namespace's name or braces.");
        if (ns.DescendantTokens().Any(t => t.Span.Length > 0 && file.Text.Lines.GetLinePosition(t.SpanStart).Line != file.Text.Lines.GetLinePosition(t.Span.End).Line
                && t.Kind() is SyntaxKind.StringLiteralToken or SyntaxKind.InterpolatedStringTextToken or SyntaxKind.MultiLineRawStringLiteralToken
                    or SyntaxKind.Utf8StringLiteralToken or SyntaxKind.Utf8MultiLineRawStringLiteralToken or SyntaxKind.InterpolatedMultiLineRawStringStartToken
                    or SyntaxKind.InterpolatedRawStringEndToken)
            || ns.DescendantNodes().OfType<InterpolatedStringExpressionSyntax>().Any(s => file.Text.Lines.GetLinePosition(s.SpanStart).Line != file.Text.Lines.GetLinePosition(s.Span.End).Line))
            return new FixOutcome.Skipped("MultiLineString", "A string inside the namespace spans several lines; dedenting the body would change it.");

        var text = file.Text;
        var lines = text.Lines;
        var eol = file.LineBreak;
        var nsLine = lines.GetLineFromPosition(ns.NamespaceKeyword.SpanStart);
        var nsIndent = text.ToString(TextSpan.FromBounds(nsLine.Start, ns.NamespaceKeyword.SpanStart));
        var bodyFirst = lines.GetLineFromPosition(ns.OpenBraceToken.Span.End).LineNumber + 1;
        var closeLine = lines.GetLineFromPosition(ns.CloseBraceToken.SpanStart);
        if (text.ToString(TextSpan.FromBounds(closeLine.Start, ns.CloseBraceToken.SpanStart)).Trim().Length > 0)
            return new FixOutcome.Skipped("NamespaceLayout", "Code stands before the namespace's closing brace on its line.");
        var unit = IndentUnit(text, bodyFirst, closeLine.LineNumber, nsIndent);
        if (unit == null) return new FixOutcome.Skipped("NamespaceLayout", "The namespace body has no consistent indentation.");

        var sb = new StringBuilder();
        sb.Append(text.ToString(TextSpan.FromBounds(0, ns.Name.Span.End))).Append(';').Append(eol);
        var body = new List<string>();
        for (var n = bodyFirst; n < closeLine.LineNumber; n++)
        {
            var line = lines[n].ToString();
            body.Add(line.Trim().Length == 0 ? "" : line.StartsWith(nsIndent + unit, StringComparison.Ordinal) ? nsIndent + line.Substring(nsIndent.Length + unit.Length) : line);
        }
        while (body.Count > 0 && body[0].Length == 0) body.RemoveAt(0);
        while (body.Count > 0 && body[^1].Length == 0) body.RemoveAt(body.Count - 1);
        if (body.Count > 0) sb.Append(eol);
        foreach (var l in body) sb.Append(l).Append(eol);
        // After the closing brace: the rest of the file (its line break is already written after the last body line).
        var afterClose = text.ToString(TextSpan.FromBounds(closeLine.EndIncludingLineBreak, text.Length));
        var closeHadBreak = closeLine.EndIncludingLineBreak > closeLine.End;
        var result = sb.ToString();
        if (!closeHadBreak && afterClose.Length == 0 && result.EndsWith(eol, StringComparison.Ordinal)) result = result.Substring(0, result.Length - eol.Length);
        result += afterClose;
        if (await file.Verify(result, ct).ConfigureAwait(false) is { } reason)
            return new FixOutcome.Skipped("SemanticsNotProven", "The file-scoped namespace would change the code: " + reason);
        return new FixOutcome.Changed(result, 1);
    }

    /// <summary>The indentation one level below the namespace: from the first non-blank body line ("    " or "\t").</summary>
    private static string? IndentUnit(SourceText text, int first, int end, string nsIndent)
    {
        for (var n = first; n < end; n++)
        {
            var line = text.Lines[n].ToString();
            if (line.Trim().Length == 0) continue;
            if (!line.StartsWith(nsIndent, StringComparison.Ordinal)) return null;
            var rest = line.Substring(nsIndent.Length);
            var ws = rest.Length - rest.TrimStart(' ', '\t').Length;
            return ws == 0 ? null : rest.Substring(0, ws);
        }
        return "    ";
    }
}
