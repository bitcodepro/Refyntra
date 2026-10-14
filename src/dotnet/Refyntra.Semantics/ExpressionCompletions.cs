using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>
/// Completions of the debugger's Immediate window (protocol 1.21, <c>code/expressionCompletions</c>): the names visible
/// at the stopped position (locals, parameters, members, types) or, after a dot, the members of the expression before
/// it, bound speculatively by Roslyn at that position. Nothing is evaluated; the expression is never run.
/// </summary>
public static class ExpressionCompletions
{
    private const int Max = 100;

    public static async Task<List<string>?> ComputeAsync(Document doc, LinePosition at, string text, int caret, CancellationToken ct)
    {
        var source = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (at.Line < 0 || at.Line >= source.Lines.Count) return null;
        var line = source.Lines[at.Line];
        var position = Math.Min(line.Start + Math.Max(0, at.Character), line.End);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model == null) return null;
        caret = Math.Clamp(caret, 0, text.Length);
        var start = caret;
        while (start > 0 && (char.IsLetterOrDigit(text[start - 1]) || text[start - 1] == '_')) start--;
        var prefix = text[start..caret];

        IEnumerable<ISymbol> symbols;
        if (start > 0 && text[start - 1] == '.')
        {
            var receiver = ReceiverBefore(text, start - 1);
            if (receiver.Length == 0) return new List<string>();
            var expr = SyntaxFactory.ParseExpression(receiver.TrimEnd('?'));
            var symbol = model.GetSpeculativeSymbolInfo(position, expr, SpeculativeBindingOption.BindAsExpression).Symbol;
            if (symbol is INamespaceSymbol ns) symbols = ns.GetMembers();
            else if (symbol is INamedTypeSymbol type)
                symbols = model.LookupStaticMembers(position, type).Concat(type.GetTypeMembers());
            else
            {
                var t = model.GetSpeculativeTypeInfo(position, expr, SpeculativeBindingOption.BindAsExpression).Type;
                if (t == null || t.TypeKind == TypeKind.Error) return new List<string>();
                if (t.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T && receiver.EndsWith("?", StringComparison.Ordinal) && t is INamedTypeSymbol { TypeArguments.Length: 1 } nt)
                    t = nt.TypeArguments[0];
                symbols = model.LookupSymbols(position, t, includeReducedExtensionMethods: true).Where(s => !s.IsStatic || s is IMethodSymbol { MethodKind: MethodKind.ReducedExtension });
            }
        }
        else symbols = model.LookupSymbols(position);

        return symbols
            .Where(s => s.CanBeReferencedByName && !s.IsImplicitlyDeclared && s is not IMethodSymbol { MethodKind: not (MethodKind.Ordinary or MethodKind.ReducedExtension or MethodKind.LocalFunction) })
            .Select(s => s.Name)
            .Where(n => n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n.StartsWith(prefix, StringComparison.Ordinal) ? 0 : 1)
            .ThenBy(n => n, StringComparer.OrdinalIgnoreCase)
            .Take(Max)
            .ToList();
    }

    /// <summary>The member-access chain that ends before the dot at <paramref name="dot"/>: <c>a + order.Lines[0]</c> → <c>order.Lines[0]</c>.</summary>
    internal static string ReceiverBefore(string text, int dot)
    {
        var i = dot;
        var depth = 0;
        while (i > 0)
        {
            var ch = text[i - 1];
            if (ch is ')' or ']') depth++;
            else if (ch is '(' or '[')
            {
                if (depth == 0) break;
                depth--;
            }
            else if (depth == 0 && !(char.IsLetterOrDigit(ch) || ch is '_' or '.' or '?' or '!' or '@')) break;
            i--;
        }
        return text[i..dot].Trim();
    }
}
