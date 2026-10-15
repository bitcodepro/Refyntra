using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>Hover of the editor: the signature line (C#) and the text sections (documentation, type, exceptions…).</summary>
public sealed record HoverModel(string? Signature, List<string> Sections, LinePositionSpan Span);

public sealed record SignatureParameterModel(string Label, string? Documentation);

public sealed record SignatureModel(string Label, string? Documentation, List<SignatureParameterModel> Parameters);

/// <summary>Signature help of the editor: the overloads of the call around the position and the argument being typed.</summary>
public sealed record SignatureHelpModel(List<SignatureModel> Signatures, int ActiveSignature, int ActiveParameter);

/// <summary>
/// Hover (Roslyn's QuickInfoService, as in Visual Studio) and signature help (the overloads of the invocation or object
/// creation around the position, read from the semantic model) for the editor (protocol 1.23).
/// </summary>
public static class EditorInfo
{
    private static readonly SymbolDisplayFormat SignatureFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeParamsRefOut)
        .WithMemberOptions(SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeContainingType);

    private static readonly SymbolDisplayFormat ParameterFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeParamsRefOut);

    public static async Task<HoverModel?> HoverAsync(Document doc, int position, CancellationToken ct)
    {
        var service = QuickInfoService.GetService(doc);
        if (service == null) return null;
        var info = await service.GetQuickInfoAsync(doc, position, ct).ConfigureAwait(false);
        if (info == null) return null;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        string? signature = null;
        var sections = new List<string>();
        foreach (var section in info.Sections)
        {
            var s = string.Concat(section.TaggedParts.Select(p => p.Text)).Trim();
            if (s.Length == 0) continue;
            if (section.Kind == QuickInfoSectionKinds.Description && signature == null) signature = s;
            else sections.Add(s);
        }
        if (signature == null && sections.Count == 0) return null;
        return new HoverModel(signature, sections, text.Lines.GetLinePositionSpan(info.Span));
    }

    public static async Task<SignatureHelpModel?> SignatureHelpAsync(Document doc, int position, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null || model == null) return null;
        var token = root.FindToken(Math.Max(0, position - 1));
        // The innermost argument list whose parentheses contain the position.
        var list = token.Parent?.AncestorsAndSelf().OfType<BaseArgumentListSyntax>()
            .FirstOrDefault(a => a.OpenToken(position) && (a.CloseToken().IsMissing || position <= a.CloseToken().SpanStart));
        if (list == null) return null;
        var callee = list.Parent;
        IEnumerable<IMethodSymbol> methods;
        switch (callee)
        {
            case InvocationExpressionSyntax inv:
            {
                var info = model.GetSymbolInfo(inv, ct);
                var group = model.GetMemberGroup(inv.Expression, ct).OfType<IMethodSymbol>().ToList();
                methods = group.Count > 0 ? group : info.CandidateSymbols.OfType<IMethodSymbol>().Concat(info.Symbol is IMethodSymbol m ? new[] { m } : Array.Empty<IMethodSymbol>());
                break;
            }
            case BaseObjectCreationExpressionSyntax creation:
            {
                var type = model.GetTypeInfo(creation, ct).Type as INamedTypeSymbol;
                methods = type?.InstanceConstructors.Where(c => model.IsAccessible(position, c)) ?? Enumerable.Empty<IMethodSymbol>();
                break;
            }
            case ConstructorInitializerSyntax init:
            {
                var info = model.GetSymbolInfo(init, ct);
                methods = info.CandidateSymbols.OfType<IMethodSymbol>().Concat(info.Symbol is IMethodSymbol m ? new[] { m } : Array.Empty<IMethodSymbol>());
                break;
            }
            default:
                return null;
        }
        var all = methods.Distinct<IMethodSymbol>(SymbolEqualityComparer.Default).ToList();
        if (all.Count == 0) return null;
        var argIndex = list.Arguments.GetSeparators().Count(s => s.SpanStart < position);
        // The resolved overload first when the call binds.
        var bound = callee switch
        {
            InvocationExpressionSyntax i => model.GetSymbolInfo(i, ct).Symbol as IMethodSymbol,
            BaseObjectCreationExpressionSyntax c => model.GetSymbolInfo(c, ct).Symbol as IMethodSymbol,
            _ => null,
        };
        var active = bound != null ? all.FindIndex(m => SymbolEqualityComparer.Default.Equals(m, bound)) : -1;
        if (active < 0) active = Math.Max(0, all.FindIndex(m => m.Parameters.Length > argIndex || m.Parameters.Any(p => p.IsParams)));
        var signatures = all.Select(m => new SignatureModel(
            m.ToDisplayString(SignatureFormat),
            Summary(m),
            m.Parameters.Select(p => new SignatureParameterModel(p.ToDisplayString(ParameterFormat), ParamDoc(m, p.Name))).ToList())).ToList();
        var activeParameter = Math.Min(argIndex, Math.Max(0, (all[active].Parameters.Length) - 1));
        return new SignatureHelpModel(signatures, active, activeParameter);
    }

    private static bool OpenToken(this BaseArgumentListSyntax a, int position) =>
        a switch
        {
            ArgumentListSyntax l => l.OpenParenToken.SpanStart < position,
            BracketedArgumentListSyntax b => b.OpenBracketToken.SpanStart < position,
            _ => false,
        };

    private static SyntaxToken CloseToken(this BaseArgumentListSyntax a) =>
        a switch
        {
            ArgumentListSyntax l => l.CloseParenToken,
            BracketedArgumentListSyntax b => b.CloseBracketToken,
            _ => default,
        };

    private static string? Summary(ISymbol s)
    {
        var xml = s.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(xml, "<summary>(.*?)</summary>", System.Text.RegularExpressions.RegexOptions.Singleline);
        return m.Success ? Clean(m.Groups[1].Value) : null;
    }

    private static string? ParamDoc(ISymbol s, string name)
    {
        var xml = s.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(xml, $"<param name=\"{System.Text.RegularExpressions.Regex.Escape(name)}\">(.*?)</param>", System.Text.RegularExpressions.RegexOptions.Singleline);
        return m.Success ? Clean(m.Groups[1].Value) : null;
    }

    private static string Clean(string xml)
    {
        var t = System.Text.RegularExpressions.Regex.Replace(xml, "<see(also)? cref=\"[A-Z]:([^\"]+)\"\\s*/>", m => m.Groups[2].Value.Split('.').Last());
        t = System.Text.RegularExpressions.Regex.Replace(t, "<paramref name=\"([^\"]+)\"\\s*/>", "$1");
        t = System.Text.RegularExpressions.Regex.Replace(t, "<[^>]+>", "");
        return System.Text.RegularExpressions.Regex.Replace(System.Net.WebUtility.HtmlDecode(t), "\\s+", " ").Trim();
    }
}
