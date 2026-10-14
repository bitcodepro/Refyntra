using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Refyntra.Refactorings.Structural;

/// <summary>
/// A placeholder of a structural pattern (ADR-012). <see cref="Kind"/>: "any" (default), "expression", "statement",
/// "identifier", "type", "argument" or "member". <see cref="Type"/>: the expression's type must be this type or derive
/// from / implement it (<see cref="ExactType"/>: exactly it). <see cref="MinCount"/>..<see cref="MaxCount"/>: how many
/// arguments or statements the placeholder stands for. <see cref="Regex"/>: the matched text (an identifier's name)
/// must match the whole expression.
/// </summary>
public sealed record PlaceholderSpec(string Name, string? Kind = null, string? Type = null, bool ExactType = false, int? MinCount = null, int? MaxCount = null, string? Regex = null);

/// <summary>A structural search pattern, its optional replacement template and the namespaces both are written against.</summary>
public sealed record PatternSpec(string Text, IReadOnlyList<PlaceholderSpec> Placeholders, string? Replacement = null, IReadOnlyList<string>? Imports = null)
{
    /// <summary>Namespaces a pattern and its replacement may use without qualification (also the usings a replacement may add).</summary>
    public static readonly IReadOnlyList<string> DefaultImports = new[] { "System", "System.Collections.Generic", "System.Linq", "System.Threading.Tasks" };

    public IReadOnlyList<string> EffectiveImports => Imports is { Count: > 0 } ? Imports : DefaultImports;
}

public enum PatternKind { Expression, Statements, Members }

/// <summary>A pattern or template that cannot be used, with a message for the user.</summary>
public sealed class PatternException : Exception
{
    public string Reason { get; }
    public PatternException(string reason, string message) : base(message) => Reason = reason;
}

/// <summary>
/// The parsed form of a <see cref="PatternSpec"/>: placeholders "$name$" become identifiers "__ssr_name", then the text
/// is parsed as an expression, else as statements, else as type members. Nothing here needs a compilation; the
/// per-project binding of the pattern's names is <see cref="PatternBinding"/>.
/// </summary>
public sealed class ParsedPattern
{
    public const string Prefix = "__ssr_";
    private static readonly Regex PlaceholderRx = new(@"\$([A-Za-z_][A-Za-z0-9_]*)\$", RegexOptions.CultureInvariant);
    private static readonly string[] Kinds = { "any", "expression", "statement", "identifier", "type", "argument", "member" };

    public PatternSpec Spec { get; }
    public PatternKind Kind { get; }
    /// <summary>The text with the placeholders replaced by identifiers.</summary>
    public string Text { get; }
    public IReadOnlyDictionary<string, PlaceholderSpec> Placeholders { get; }
    public IReadOnlyDictionary<string, Regex> Regexes { get; }

    private ParsedPattern(PatternSpec spec, PatternKind kind, string text, Dictionary<string, PlaceholderSpec> placeholders, Dictionary<string, Regex> regexes)
    {
        Spec = spec;
        Kind = kind;
        Text = text;
        Placeholders = placeholders;
        Regexes = regexes;
    }

    /// <summary>The placeholder names in a pattern or template text, in order of first use.</summary>
    public static IReadOnlyList<string> NamesIn(string text) =>
        PlaceholderRx.Matches(text ?? "").Select(m => m.Groups[1].Value).Distinct(StringComparer.Ordinal).ToList();

    public static string Substitute(string text) => PlaceholderRx.Replace(text, m => Prefix + m.Groups[1].Value);

    /// <summary>The placeholder name of an identifier text ("__ssr_x" → "x"), or null.</summary>
    public static string? NameOf(string identifier) => identifier.StartsWith(Prefix, StringComparison.Ordinal) && identifier.Length > Prefix.Length ? identifier.Substring(Prefix.Length) : null;

    public static ParsedPattern Parse(PatternSpec spec)
    {
        var raw = spec.Text ?? "";
        if (string.IsNullOrWhiteSpace(raw)) throw new PatternException("EmptyPattern", "The pattern is empty.");
        if (raw.Contains(Prefix, StringComparison.Ordinal)) throw new PatternException("InvalidPattern", $"The pattern must not contain '{Prefix}'.");
        var stray = Regex.Replace(PlaceholderRx.Replace(raw, ""), "\"(?:[^\"\\\\]|\\\\.)*\"", "");
        if (stray.Contains('$') && !raw.Contains("$\"", StringComparison.Ordinal))
            throw new PatternException("InvalidPattern", "A '$' does not start a placeholder: write placeholders as $name$.");
        var placeholders = new Dictionary<string, PlaceholderSpec>(StringComparer.Ordinal);
        var regexes = new Dictionary<string, Regex>(StringComparer.Ordinal);
        var defined = (spec.Placeholders ?? Array.Empty<PlaceholderSpec>()).Where(p => p != null).GroupBy(p => p.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var name in NamesIn(raw))
        {
            var p = defined.TryGetValue(name, out var d) ? d : new PlaceholderSpec(name);
            var kind = string.IsNullOrEmpty(p.Kind) ? "any" : p.Kind!;
            if (kind.EndsWith('s') && kind != "s") kind = kind.TrimEnd('s'); // "statements", "arguments", "members"
            if (Array.IndexOf(Kinds, kind) < 0) throw new PatternException("InvalidPlaceholder", $"${name}$: unknown kind '{p.Kind}' (any, expression, statement, identifier, type, argument, member).");
            if (p.MinCount is < 0 || p.MaxCount is < 0 || (p.MinCount is { } mn && p.MaxCount is { } mx && mn > mx))
                throw new PatternException("InvalidPlaceholder", $"${name}$: the count must be min..max with 0 ≤ min ≤ max.");
            if (!string.IsNullOrEmpty(p.Regex))
            {
                try
                {
                    regexes[name] = new Regex("^(?:" + p.Regex + ")$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));
                }
                catch (ArgumentException ex)
                {
                    throw new PatternException("InvalidPlaceholder", $"${name}$: invalid regular expression: {ex.Message}");
                }
            }
            placeholders[name] = p with { Kind = kind };
        }
        var text = Substitute(raw).Trim();
        var kindOf = Classify(text, out var error);
        if (kindOf == null) throw new PatternException("InvalidPattern", "The pattern is not a C# expression, statement(s) or member(s): " + error);
        return new ParsedPattern(spec, kindOf.Value, text, placeholders, regexes);
    }

    private static PatternKind? Classify(string text, out string error)
    {
        error = "";
        var expr = SyntaxFactory.ParseExpression(text);
        if (!expr.ContainsDiagnostics && expr.FullSpan.Length == text.Length && !text.TrimEnd().EndsWith(';')) return PatternKind.Expression;
        var block = (BlockSyntax)SyntaxFactory.ParseStatement("{\n" + text + "\n}");
        if (!block.ContainsDiagnostics && block.Statements.Count > 0 && block.FullSpan.Length == text.Length + 4
            && !block.Statements.Any(s => s is LocalFunctionStatementSyntax))
            return PatternKind.Statements;
        var unit = SyntaxFactory.ParseCompilationUnit("class __SsrC {\n" + text + "\n}");
        if (!unit.ContainsDiagnostics && unit.Members is [ClassDeclarationSyntax c] && c.Members.Count > 0) return PatternKind.Members;
        var diag = expr.GetDiagnostics().Concat(block.GetDiagnostics()).FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error);
        error = diag?.GetMessage() ?? "unexpected text.";
        return null;
    }
}
