using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>Small semantic facts shared by Safe Delete, Extract Method and Change Signature.</summary>
internal static class CodeFacts
{
    /// <summary>
    /// True when evaluating <paramref name="e"/> cannot have an observable side effect: literals, default, typeof, nameof,
    /// sizeof, lambdas (creating one runs nothing), locals, parameters, fields, constants and enum members (also through a
    /// member access on such a value), and tuples/parentheses/unary minus of those. Anything that can run user code
    /// (calls, property getters, object creation, conversions, operators) is not.
    /// </summary>
    public static bool IsSideEffectFree(ExpressionSyntax e, SemanticModel model, CancellationToken ct)
    {
        switch (e)
        {
            case LiteralExpressionSyntax:
            case DefaultExpressionSyntax:
            case TypeOfExpressionSyntax:
            case SizeOfExpressionSyntax:
            case ThisExpressionSyntax:
            case AnonymousFunctionExpressionSyntax:
                return true;
            case ParenthesizedExpressionSyntax p:
                return IsSideEffectFree(p.Expression, model, ct);
            case TupleExpressionSyntax t:
                return t.Arguments.All(a => IsSideEffectFree(a.Expression, model, ct));
            case PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.UnaryMinusExpression or (int)SyntaxKind.UnaryPlusExpression } u:
                return model.GetConstantValue(u, ct).HasValue;
            case InvocationExpressionSyntax inv when inv.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" }:
                return model.GetConstantValue(inv, ct).HasValue;
            case IdentifierNameSyntax or MemberAccessExpressionSyntax:
            {
                if (model.GetConstantValue(e, ct).HasValue) return true;
                var symbol = model.GetSymbolInfo(e, ct).Symbol;
                if (symbol is not (ILocalSymbol or IParameterSymbol or IFieldSymbol)) return false;
                return e is not MemberAccessExpressionSyntax ma || IsSideEffectFree(ma.Expression, model, ct) || model.GetSymbolInfo(ma.Expression, ct).Symbol is INamedTypeSymbol or INamespaceSymbol;
            }
            default:
                return model.GetConstantValue(e, ct).HasValue;
        }
    }

    /// <summary>A plain C# identifier (no '@' escape, no reserved keyword).</summary>
    public static bool IsValidIdentifier(string name) =>
        SyntaxFacts.IsValidIdentifier(name) && SyntaxFacts.GetKeywordKind(name) == SyntaxKind.None;

    /// <summary>
    /// Uses of <paramref name="name"/> that the compiler cannot connect to a symbol: string literals with exactly that
    /// text outside nameof (possible reflection, serialization or routing names) and member accesses on dynamic values.
    /// Searched in every document of <paramref name="projects"/> (null: the whole solution).
    /// </summary>
    public static async Task<List<string>> UnknownUsesAsync(Solution solution, IEnumerable<ProjectId>? projects, string name, CancellationToken ct, int max = 5)
    {
        var result = new List<string>();
        var ids = projects?.ToList() ?? solution.ProjectIds.ToList();
        foreach (var pid in ids)
        {
            var project = solution.GetProject(pid);
            if (project == null) continue;
            foreach (var doc in project.Documents)
            {
                ct.ThrowIfCancellationRequested();
                var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                if (text.ToString().IndexOf(name, StringComparison.Ordinal) < 0) continue;
                var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                if (root == null) continue;
                SemanticModel? model = null;
                foreach (var node in root.DescendantNodes())
                {
                    string? what = null;
                    if (node is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression) && lit.Token.ValueText == name
                        && !lit.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" }))
                        what = $"string \"{name}\"";
                    else if (node is MemberAccessExpressionSyntax ma && ma.Name.Identifier.ValueText == name)
                    {
                        model ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                        if (model!.GetTypeInfo(ma.Expression, ct).Type is { TypeKind: TypeKind.Dynamic }) what = $"dynamic member access .{name}";
                    }
                    if (what == null) continue;
                    var line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    var file = Path.GetFileName(doc.FilePath ?? doc.Name);
                    var entry = $"{what} in {file}:{line}";
                    if (!result.Contains(entry)) result.Add(entry);
                    if (result.Count >= max) return result;
                }
            }
        }
        return result;
    }

    /// <summary>Location label "File.cs:12" of a source location.</summary>
    public static string Label(Location l) => $"{Path.GetFileName(l.SourceTree?.FilePath)}:{l.GetLineSpan().StartLinePosition.Line + 1}";

    /// <summary>True when the symbol is declared in source and none of its declarations is in generated code.</summary>
    public static (string reason, string message)? SourceGuard(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (!symbol.Locations.Any(l => l.IsInSource))
            return ("MetadataSymbol", "The symbol is defined in a referenced assembly, not in source.");
        if (symbol.IsImplicitlyDeclared)
            return ("UnsupportedSymbolKind", "The symbol is implicitly declared.");
        foreach (var loc in symbol.Locations.Where(l => l.IsInSource))
            if (SymbolFacts.IsGeneratedTree(snapshot.Solution, loc.SourceTree!, ct))
                return ("GeneratedCode", "The symbol is declared in generated code.");
        return null;
    }
}
