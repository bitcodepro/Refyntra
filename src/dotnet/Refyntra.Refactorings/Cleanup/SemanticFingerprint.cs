using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Refyntra.Refactorings.Cleanup;

/// <summary>
/// What a cleanup must not change in a document, as Roslyn sees it in one project context: the symbol every name,
/// expression and type binds to (with its type and converted type), every declared symbol, every literal value (strings
/// included, so whitespace inside a string is protected) and the diagnostics (id and message; hidden ones excluded).
/// Using directives and namespace names are left out: they are what the fixes change. Doc comments are bound as well
/// (the analysis solution parses them), so a using needed by a cref is kept.
/// </summary>
public sealed record SemanticFingerprint(IReadOnlyList<string> Entries, IReadOnlyList<string> Diagnostics)
{
    private static readonly SymbolDisplayFormat Format = SymbolDisplayFormat.FullyQualifiedFormat
        .WithMemberOptions(SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeExplicitInterface)
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeParamsRefOut)
        .WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier | SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    private static string Key(ISymbol? s) => s == null ? "-" : s.Kind + ":" + s.ToDisplayString(Format);

    public static async Task<SemanticFingerprint> ComputeAsync(Document document, CancellationToken ct)
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false) ?? throw new InvalidOperationException("No semantic model");
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false) ?? throw new InvalidOperationException("No syntax root");
        var entries = new List<string>();
        foreach (var node in root.DescendantNodes(n => n is not UsingDirectiveSyntax, descendIntoTrivia: true))
        {
            ct.ThrowIfCancellationRequested();
            if (node is UsingDirectiveSyntax || IsNamespaceName(node)) continue;
            switch (node)
            {
                case ExpressionSyntax or CrefSyntax:
                {
                    var si = model.GetSymbolInfo(node, ct);
                    var entry = node.Kind() + "|" + Key(si.Symbol) + "|" + si.CandidateReason + "|" + string.Join(",", si.CandidateSymbols.Select(Key));
                    if (node is ExpressionSyntax e)
                    {
                        var ti = model.GetTypeInfo(e, ct);
                        entry += "|" + Key(ti.Type) + "|" + Key(ti.ConvertedType);
                    }
                    entries.Add(entry);
                    break;
                }
                case MemberDeclarationSyntax and not BaseNamespaceDeclarationSyntax or VariableDeclaratorSyntax or ParameterSyntax
                    or TypeParameterSyntax or SingleVariableDesignationSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax:
                    entries.Add("decl|" + Key(model.GetDeclaredSymbol(node, ct)));
                    break;
            }
        }
        foreach (var token in root.DescendantTokens(descendIntoTrivia: true))
            if (token.Kind() is SyntaxKind.StringLiteralToken or SyntaxKind.CharacterLiteralToken or SyntaxKind.NumericLiteralToken
                or SyntaxKind.InterpolatedStringTextToken or SyntaxKind.SingleLineRawStringLiteralToken or SyntaxKind.MultiLineRawStringLiteralToken
                or SyntaxKind.Utf8StringLiteralToken or SyntaxKind.Utf8SingleLineRawStringLiteralToken or SyntaxKind.Utf8MultiLineRawStringLiteralToken)
                entries.Add("lit|" + token.Kind() + "|" + token.ValueText);
        var diagnostics = model.GetDiagnostics(cancellationToken: ct)
            .Where(d => d.Severity != DiagnosticSeverity.Hidden)
            .Select(d => d.Id + "|" + d.Severity + "|" + d.GetMessage())
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
        return new SemanticFingerprint(entries, diagnostics);
    }

    private static bool IsNamespaceName(SyntaxNode node)
    {
        for (var n = node; n != null; n = n.Parent)
            if (n.Parent is BaseNamespaceDeclarationSyntax ns && ns.Name == n) return true;
        return false;
    }

    /// <summary>
    /// Null when <paramref name="after"/> keeps everything of this fingerprint. Diagnostics with an id in
    /// <paramref name="mayDisappear"/> may go away (a duplicate using that was removed), none may appear.
    /// </summary>
    public string? Compare(SemanticFingerprint after, IReadOnlySet<string> mayDisappear)
    {
        if (Entries.Count != after.Entries.Count) return $"the number of bound names changed ({Entries.Count} → {after.Entries.Count})";
        for (var i = 0; i < Entries.Count; i++)
            if (!string.Equals(Entries[i], after.Entries[i], StringComparison.Ordinal))
                return Entries[i].StartsWith("lit|", StringComparison.Ordinal) ? "a literal value would change" : "a name would bind differently (" + Describe(after.Entries[i]) + ")";
        var before = Diagnostics.GroupBy(d => d).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        foreach (var g in after.Diagnostics.GroupBy(d => d))
            if (g.Count() > (before.TryGetValue(g.Key, out var c) ? c : 0)) return "a diagnostic would appear (" + g.Key.Split('|')[0] + ")";
        var now = after.Diagnostics.GroupBy(d => d).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        foreach (var (key, count) in before)
            if (count > (now.TryGetValue(key, out var c) ? c : 0) && !mayDisappear.Contains(key.Split('|')[0]))
                return "a diagnostic would disappear (" + key.Split('|')[0] + ")";
        return null;
    }

    private static string Describe(string entry)
    {
        var parts = entry.Split('|');
        return parts.Length > 1 ? parts[0] + " " + parts[1] : entry;
    }
}
