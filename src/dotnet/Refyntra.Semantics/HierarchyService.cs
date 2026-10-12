using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>One hierarchy neighbour: a symbol with a source declaration, and the spans that connect it (call sites).</summary>
public sealed record HierarchyHit(ISymbol Symbol, List<Location> FromLocations);

public sealed record HierarchyModel(List<HierarchyHit> Items, string Completeness, bool Truncated);

/// <summary>
/// Call and type hierarchy (protocol 1.7, <c>code/hierarchy</c>) over one immutable snapshot. Only neighbours declared in
/// source are returned (a hierarchy item needs a document); metadata symbols are skipped.
/// </summary>
public static class HierarchyService
{
    public const int MaxItems = 500;

    public static readonly string[] Directions = { "incoming", "outgoing", "supertypes", "subtypes" };

    public static bool IsCallable(ISymbol s) => s is IMethodSymbol or IPropertySymbol or IEventSymbol or IFieldSymbol { IsConst: false };

    public static async Task<HierarchyModel> QueryAsync(Snapshot snapshot, ISymbol symbol, string direction, CancellationToken ct)
    {
        var items = direction switch
        {
            "incoming" => await IncomingAsync(snapshot, symbol, ct).ConfigureAwait(false),
            "outgoing" => await OutgoingAsync(snapshot, symbol, ct).ConfigureAwait(false),
            "supertypes" => Supertypes(symbol),
            "subtypes" => await SubtypesAsync(snapshot, symbol, ct).ConfigureAwait(false),
            _ => throw new ArgumentOutOfRangeException(nameof(direction)),
        };
        var ordered = items
            .Where(h => h.Symbol.Locations.Any(l => l.IsInSource))
            .OrderBy(h => SymbolFacts.PrimaryLocation(h.Symbol)?.SourceTree?.FilePath, StringComparer.Ordinal)
            .ThenBy(h => SymbolFacts.PrimaryLocation(h.Symbol)?.SourceSpan.Start ?? 0)
            .ToList();
        return new HierarchyModel(ordered.Take(MaxItems).ToList(), SemanticService.Completeness(snapshot), ordered.Count > MaxItems);
    }

    private static string Key(ISymbol s) => (DocumentationCommentId.CreateDeclarationId(s.OriginalDefinition) ?? s.ToDisplayString()) + "|" + s.ContainingAssembly?.Name;

    private static async Task<List<HierarchyHit>> IncomingAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (!IsCallable(symbol) && symbol is not INamedTypeSymbol) return new();
        var targets = new List<ISymbol> { symbol };
        // A type: its constructors are what is "called".
        if (symbol is INamedTypeSymbol t) targets = t.InstanceConstructors.Cast<ISymbol>().Where(c => !c.IsImplicitlyDeclared || c.Locations.Any(l => l.IsInSource)).ToList();
        var byCaller = new Dictionary<string, HierarchyHit>(StringComparer.Ordinal);
        foreach (var target in targets)
        {
            var callers = await SymbolFinder.FindCallersAsync(target, snapshot.Solution, ct).ConfigureAwait(false);
            foreach (var c in callers)
            {
                var caller = c.CallingSymbol;
                // Calls from a lambda or local function belong to the member that contains them.
                while (caller is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction } && caller.ContainingSymbol != null) caller = caller.ContainingSymbol;
                var key = Key(caller);
                if (!byCaller.TryGetValue(key, out var hit)) byCaller[key] = hit = new HierarchyHit(caller, new List<Location>());
                foreach (var loc in c.Locations.Where(l => l.IsInSource))
                    if (!hit.FromLocations.Any(x => x.SourceTree == loc.SourceTree && x.SourceSpan == loc.SourceSpan)) hit.FromLocations.Add(loc);
            }
        }
        return byCaller.Values.ToList();
    }

    private static async Task<List<HierarchyHit>> OutgoingAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (symbol is not (IMethodSymbol or IPropertySymbol)) return new();
        var byTarget = new Dictionary<string, HierarchyHit>(StringComparer.Ordinal);
        foreach (var syntaxRef in symbol.DeclaringSyntaxReferences)
        {
            var node = await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);
            var doc = snapshot.Solution.GetDocument(node.SyntaxTree);
            if (doc == null) continue;
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model == null) continue;
            foreach (var n in node.DescendantNodes())
            {
                ct.ThrowIfCancellationRequested();
                SyntaxNode? site = n switch
                {
                    InvocationExpressionSyntax inv => inv.Expression,
                    BaseObjectCreationExpressionSyntax oc => oc,
                    ConstructorInitializerSyntax ci => ci,
                    _ => null,
                };
                if (site == null) continue;
                var target = model.GetSymbolInfo(n is InvocationExpressionSyntax ? n : site, ct).Symbol;
                if (target is not IMethodSymbol m) continue;
                if (m.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction or MethodKind.DelegateInvoke) continue;
                var def = m.ReducedFrom ?? m;
                def = def.OriginalDefinition;
                if (!def.Locations.Any(l => l.IsInSource)) continue;
                var key = Key(def);
                if (!byTarget.TryGetValue(key, out var hit)) byTarget[key] = hit = new HierarchyHit(def, new List<Location>());
                var span = site switch
                {
                    MemberAccessExpressionSyntax ma => ma.Name.Span,
                    BaseObjectCreationExpressionSyntax oc => oc.Span,
                    _ => site.Span,
                };
                hit.FromLocations.Add(Location.Create(node.SyntaxTree, span));
            }
        }
        return byTarget.Values.ToList();
    }

    private static List<HierarchyHit> Supertypes(ISymbol symbol)
    {
        if (symbol is not INamedTypeSymbol t) return new();
        var list = new List<ISymbol>();
        if (t.BaseType is { SpecialType: not SpecialType.System_Object and not SpecialType.System_ValueType and not SpecialType.System_Enum } b) list.Add(b.OriginalDefinition);
        list.AddRange(t.Interfaces.Select(i => (ISymbol)i.OriginalDefinition));
        return list.Select(s => new HierarchyHit(s, new List<Location>())).ToList();
    }

    private static async Task<List<HierarchyHit>> SubtypesAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (symbol is not INamedTypeSymbol t) return new();
        var solution = snapshot.Solution;
        var list = new List<ISymbol>();
        if (t.TypeKind == TypeKind.Interface)
        {
            list.AddRange(await SymbolFinder.FindImplementationsAsync(t, solution, transitive: false, cancellationToken: ct).ConfigureAwait(false));
            list.AddRange(await SymbolFinder.FindDerivedInterfacesAsync(t, solution, transitive: false, cancellationToken: ct).ConfigureAwait(false));
        }
        else if (t.TypeKind == TypeKind.Class)
        {
            list.AddRange(await SymbolFinder.FindDerivedClassesAsync(t, solution, transitive: false, cancellationToken: ct).ConfigureAwait(false));
        }
        return list.GroupBy(Key).Select(g => new HierarchyHit(g.First(), new List<Location>())).ToList();
    }
}
