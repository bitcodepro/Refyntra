using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Refyntra.Frameworks.Abstractions;

/// <summary>A framework type identified by full metadata name (with generic arity) and a set of accepted assembly names.</summary>
public sealed record KnownType(string FullMetadataName, params string[] AssemblyNames)
{
    public bool Matches(ITypeSymbol? type)
    {
        if (type is not INamedTypeSymbol named) return false;
        var def = named.OriginalDefinition;
        if (def.ContainingAssembly == null) return false;
        if (!AssemblyNames.Contains(def.ContainingAssembly.Identity.Name, StringComparer.Ordinal)) return false;
        return SymbolIdentity.FullMetadataName(def) == FullMetadataName;
    }
}

public static class SymbolIdentity
{
    /// <summary>Namespace-qualified metadata name including generic arity, e.g. "MediatR.IRequest`1".</summary>
    public static string FullMetadataName(INamedTypeSymbol type)
    {
        var names = new List<string>();
        var outer = type;
        for (var t = type; t != null; t = t.ContainingType)
        {
            names.Insert(0, t.MetadataName);
            outer = t;
        }
        var ns = outer.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : "";
        return ns + string.Join("+", names);
    }

    /// <summary>
    /// True when both symbols denote the same definition. Works across compilations (a type seen from a referencing
    /// project) by comparing documentation ids and the declaring assembly name.
    /// </summary>
    public static bool SameDefinition(ISymbol? a, ISymbol? b)
    {
        if (a == null || b == null) return false;
        var da = a.OriginalDefinition;
        var db = b.OriginalDefinition;
        if (SymbolEqualityComparer.Default.Equals(da, db)) return true;
        if (da.Kind != db.Kind) return false;
        var ia = DocumentationCommentId.CreateDeclarationId(da);
        var ib = DocumentationCommentId.CreateDeclarationId(db);
        return ia != null && ia == ib && da.ContainingAssembly?.Identity.Name == db.ContainingAssembly?.Identity.Name;
    }

    /// <summary>
    /// Identity and label of the composition root that contains the node: the containing method (or the top-level
    /// program) plus the project (assembly) it belongs to, e.g. "Program.&lt;Main&gt;$ (Shop.Api)". The project is part of
    /// the identity: two apps with top-level statements both have a Program.&lt;Main&gt;$.
    /// </summary>
    public static string CompositionRoot(SemanticModel model, SyntaxNode node, CancellationToken ct)
    {
        var assembly = model.Compilation.AssemblyName;
        var method = ContainingMethod(model, node, ct);
        return string.IsNullOrEmpty(assembly) ? method : $"{method} ({assembly})";
    }

    private static string ContainingMethod(SemanticModel model, SyntaxNode node, CancellationToken ct)
    {
        var member = node.AncestorsAndSelf().FirstOrDefault(n =>
            n is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax or GlobalStatementSyntax
                or PropertyDeclarationSyntax);
        if (member is LocalFunctionStatementSyntax)
            member = member.Ancestors().FirstOrDefault(n => n is BaseMethodDeclarationSyntax or GlobalStatementSyntax) ?? member;
        if (member is GlobalStatementSyntax)
        {
            var entry = model.Compilation.GetEntryPoint(ct);
            return entry != null ? entry.ContainingType.ToDisplayString() + "." + entry.Name : "Program.<Main>$";
        }
        if (member != null && model.GetDeclaredSymbol(member, ct) is { } sym)
        {
            var container = sym.ContainingType?.ToDisplayString();
            var name = sym is IMethodSymbol m && m.MethodKind == MethodKind.Constructor ? sym.ContainingType?.Name ?? sym.Name : sym.Name;
            return container != null ? container + "." + name : name;
        }
        return "<unknown>";
    }

    public static IMethodSymbol? InvokedMethod(SemanticModel model, InvocationExpressionSyntax inv, CancellationToken ct)
    {
        var info = model.GetSymbolInfo(inv, ct);
        var m = info.Symbol as IMethodSymbol;
        if (m == null && info.CandidateSymbols.Length == 1) m = info.CandidateSymbols[0] as IMethodSymbol;
        return m;
    }

    public static string? InvokedName(InvocationExpressionSyntax inv) => inv.Expression switch
    {
        MemberAccessExpressionSyntax ma => ma.Name.Identifier.ValueText,
        IdentifierNameSyntax id => id.Identifier.ValueText,
        GenericNameSyntax g => g.Identifier.ValueText,
        MemberBindingExpressionSyntax mb => mb.Name.Identifier.ValueText,
        _ => null,
    };

    public static string VersionEvidence(IAssemblySymbol assembly)
    {
        var id = assembly.Identity;
        var token = id.PublicKeyToken.IsDefaultOrEmpty ? "null" : Convert.ToHexStringLower(id.PublicKeyToken.AsSpan());
        return $"{id.Name}, Version={id.Version}, PublicKeyToken={token}";
    }

    /// <summary>All C# documents of a project whose text contains any of the markers (cheap prefilter).</summary>
    public static async Task<List<(Document doc, SyntaxNode root, SemanticModel model)>> DocumentsContainingAsync(
        Project project, string[] markers, CancellationToken ct)
    {
        var result = new List<(Document, SyntaxNode, SemanticModel)>();
        foreach (var doc in project.Documents)
        {
            ct.ThrowIfCancellationRequested();
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            var s = text.ToString();
            if (!markers.Any(m => s.Contains(m, StringComparison.Ordinal))) continue;
            var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (root != null && model != null) result.Add((doc, root, model));
        }
        return result;
    }
}
