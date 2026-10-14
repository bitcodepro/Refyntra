using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.EfCore;

namespace Refyntra.Semantics.Rules;

/// <summary>
/// OR1011 "possible N+1" (docs/rules/OR1011.md), a heuristic: a navigation property of an EF Core entity is read in a
/// foreach or an in-memory Select/SelectMany/ForEach over the results of a query that neither loads it (Include,
/// AutoInclude) nor projects, and lazy loading is not possible. Conservative: the query must be provable from the same
/// function (written inline, or a local assigned once from it), every operator of the query must be a known filter,
/// sort, tracking or materialization operator, the navigation's type must be a DbSet entity of the query's DbContext,
/// and the loop must not load anything explicitly. Anything else stays silent.
/// </summary>
public static class EfNPlusOne
{
    public sealed record Result(TextSpan Span, string Element, string Navigation, string Message, ExpressionSyntax DbSet, INamedTypeSymbol Entity, string ParameterName);

    private const string Core = "Microsoft.EntityFrameworkCore";

    private static readonly HashSet<string> PassThrough = new(StringComparer.Ordinal)
    {
        "Where", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "Skip", "Take", "Distinct", "Reverse",
        "AsNoTracking", "AsNoTrackingWithIdentityResolution", "AsTracking", "AsSplitQuery", "AsSingleQuery", "TagWith", "IgnoreQueryFilters",
        "ToList", "ToListAsync", "ToArray", "ToArrayAsync", "AsEnumerable", "AsQueryable", "AsAsyncEnumerable",
    };

    private static readonly HashSet<string> ExplicitLoading = new(StringComparer.Ordinal)
    {
        "Load", "LoadAsync", "Reference", "Collection", "Entry", "Include", "Attach", "Find", "FindAsync",
    };

    private sealed record Query(ExpressionSyntax DbSet, INamedTypeSymbol Entity, INamedTypeSymbol Context, HashSet<string> Included);

    /// <summary>The results of one trigger node: a foreach statement or an in-memory Select/SelectMany/ForEach call.</summary>
    public static IEnumerable<Result> Check(SemanticModel model, SyntaxNode node, CancellationToken ct)
    {
        ISymbol? element;
        SyntaxNode body;
        ExpressionSyntax source;
        switch (node)
        {
            case ForEachStatementSyntax fe:
                element = model.GetDeclaredSymbol(fe, ct);
                body = fe.Statement;
                source = fe.Expression;
                break;
            case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Select" or "SelectMany" or "ForEach" } ma } inv
                when inv.ArgumentList.Arguments.Count == 1 && inv.ArgumentList.Arguments[0].Expression is LambdaExpressionSyntax lam:
            {
                var m = model.GetSymbolInfo(inv, ct).Symbol as IMethodSymbol;
                var inMemory = CodeInspections.IsEnumerable(m)
                    || (m is { Name: "ForEach" } && m.ContainingType?.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>");
                if (!inMemory) return Array.Empty<Result>();
                var p = lam switch
                {
                    SimpleLambdaExpressionSyntax s => s.Parameter,
                    ParenthesizedLambdaExpressionSyntax { ParameterList.Parameters.Count: 1 } pl => pl.ParameterList.Parameters[0],
                    _ => null,
                };
                if (p == null) return Array.Empty<Result>();
                element = model.GetDeclaredSymbol(p, ct);
                body = lam.Body;
                source = ma.Expression;
                break;
            }
            default:
                return Array.Empty<Result>();
        }
        if (element == null) return Array.Empty<Result>();
        var fn = CodeInspections.FunctionOf(node);
        if (fn == null) return Array.Empty<Result>();
        var q = Trace(model, source, fn, 0, ct);
        if (q == null) return Array.Empty<Result>();
        var elementType = element switch { ILocalSymbol l => l.Type, IParameterSymbol ps => ps.Type, _ => null };
        if (elementType is not INamedTypeSymbol et || !SymbolEqualityComparer.Default.Equals(et.OriginalDefinition, q.Entity.OriginalDefinition)) return Array.Empty<Result>();
        if (LazyLoadingPossible(model.Compilation, q.Entity)) return Array.Empty<Result>();
        if (body.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(i => NameOf(i) is { } n && ExplicitLoading.Contains(n))) return Array.Empty<Result>();
        var mapped = MappedEntities(q.Context);
        var results = new List<Result>();
        var reported = new HashSet<string>(StringComparer.Ordinal);
        foreach (var access in body.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
        {
            ct.ThrowIfCancellationRequested();
            if (access.Expression is not IdentifierNameSyntax id || id.Identifier.ValueText != element.Name) continue;
            if (!SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id, ct).Symbol, element)) continue;
            if (model.GetSymbolInfo(access, ct).Symbol is not IPropertySymbol prop) continue;
            if (access.Parent is AssignmentExpressionSyntax asg && asg.Left == access) continue;
            if (access.Ancestors().Any(a => a is InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } })) continue;
            if (reported.Contains(prop.Name) || q.Included.Contains(prop.Name)) continue;
            if (!IsNavigation(prop, mapped)) continue;
            if (AutoIncluded(model.Compilation, prop.Name, q.Entity)) continue;
            reported.Add(prop.Name);
            var param = ParameterName(q.Entity, fn);
            results.Add(new Result(access.Span, element.Name, prop.Name,
                $"Possible N+1: '{element.Name}.{prop.Name}' is read for every result of a query that does not load '{prop.Name}' (no Include and no projection). "
                + $"Without lazy loading it is not loaded (null or empty); loading it per result would cost one query each. Load it with the query, e.g. '.Include({param} => {param}.{prop.Name})'.",
                q.DbSet, q.Entity, param));
        }
        return results;
    }

    /// <summary>The OR1011 result at <paramref name="span"/> (recomputed for the quick fix), or null.</summary>
    public static Result? At(SemanticModel model, SyntaxNode root, TextSpan span, CancellationToken ct)
    {
        var node = root.FindNode(span, getInnermostNodeForTie: true);
        foreach (var a in node.AncestorsAndSelf())
            if (a is ForEachStatementSyntax or InvocationExpressionSyntax)
                foreach (var r in Check(model, a, ct))
                    if (r.Span == span) return r;
        return null;
    }

    private static string? NameOf(InvocationExpressionSyntax i) => i.Expression switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
        IdentifierNameSyntax n => n.Identifier.ValueText,
        GenericNameSyntax g => g.Identifier.ValueText,
        _ => null,
    };

    private static ExpressionSyntax Strip(ExpressionSyntax e)
    {
        while (true)
        {
            switch (e)
            {
                case ParenthesizedExpressionSyntax p: e = p.Expression; continue;
                case AwaitExpressionSyntax a: e = a.Expression; continue;
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } cm }: e = cm.Expression; continue;
                default: return e;
            }
        }
    }

    /// <summary>The query <paramref name="source"/> provably comes from, or null.</summary>
    private static Query? Trace(SemanticModel model, ExpressionSyntax source, SyntaxNode fn, int depth, CancellationToken ct)
    {
        var e = Strip(source);
        if (e is IdentifierNameSyntax local)
        {
            if (depth > 2 || model.GetSymbolInfo(local, ct).Symbol is not ILocalSymbol ls) return null;
            if (ls.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) is not VariableDeclaratorSyntax { Initializer: { } init } decl) return null;
            if (!fn.Span.Contains(decl.Span) || decl.SpanStart > local.SpanStart) return null;
            if (decl.Parent?.Parent is not LocalDeclarationStatementSyntax lds || lds.UsingKeyword != default) return null;
            // Assigned only by its declaration.
            foreach (var r in CodeInspections.References(model, fn, ls, ct))
                if (r.Parent is AssignmentExpressionSyntax a && a.Left == r || r.Parent is PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax
                    || r.Parent is ArgumentSyntax arg && !arg.RefKindKeyword.IsKind(SyntaxKind.None)) return null;
            return Trace(model, init.Value, fn, depth + 1, ct);
        }
        var included = new HashSet<string>(StringComparer.Ordinal);
        while (true)
        {
            var type = model.GetTypeInfo(e, ct).Type;
            if (type is INamedTypeSymbol nt && EfCoreModule.DbSet1.Matches(nt) && nt.TypeArguments[0] is INamedTypeSymbol entity)
            {
                var context = e switch
                {
                    MemberAccessExpressionSyntax m => model.GetSymbolInfo(m, ct).Symbol is IPropertySymbol { ContainingType: { } ct1 } ? ct1 : null,
                    IdentifierNameSyntax n => model.GetSymbolInfo(n, ct).Symbol is IPropertySymbol { ContainingType: { } ct2 } ? ct2 : null,
                    InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name: GenericNameSyntax { Identifier.ValueText: "Set" } } sm } => model.GetTypeInfo(sm.Expression, ct).Type as INamedTypeSymbol,
                    InvocationExpressionSyntax { Expression: GenericNameSyntax { Identifier.ValueText: "Set" } } => model.GetEnclosingSymbol(e.SpanStart, ct)?.ContainingType,
                    _ => null,
                };
                if (context == null || !DerivesFromDbContext(context)) return null;
                return new Query(e, entity, context, included);
            }
            if (e is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } inv) return null;
            var name = ma.Name.Identifier.ValueText;
            if (model.GetSymbolInfo(inv, ct).Symbol is not IMethodSymbol method) return null;
            var def = method.ReducedFrom ?? method;
            var ns = def.ContainingType?.ContainingNamespace?.ToDisplayString();
            var linqOrEf = ns is "System.Linq" or Core || def.ContainingAssembly?.Identity.Name == Core;
            if (name is "Include" && linqOrEf)
            {
                var arg = inv.ArgumentList.Arguments.LastOrDefault()?.Expression;
                if (arg == null) return null;
                var c = model.GetConstantValue(arg, ct);
                if (c.HasValue)
                {
                    if (c.Value is not string path) return null;
                    included.Add(path.Split('.')[0].Trim());
                }
                else if (arg is SimpleLambdaExpressionSyntax { Body: ExpressionSyntax body } sl && FirstMember(body, sl.Parameter.Identifier.ValueText) is { } nav)
                    included.Add(nav);
                else return null;
            }
            else if (name is "ThenInclude" && linqOrEf) { /* deeper levels: the first level was recorded by its Include */ }
            else if (!PassThrough.Contains(name) || !linqOrEf) return null;
            e = Strip(ma.Expression);
        }
    }

    /// <summary>"x.Nav", "x.Nav.Where(...)", "(x.Nav as T)" → "Nav".</summary>
    private static string? FirstMember(ExpressionSyntax body, string parameter)
    {
        var e = body;
        while (true)
        {
            switch (e)
            {
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax m }: e = m.Expression; continue;
                case ParenthesizedExpressionSyntax p: e = p.Expression; continue;
                case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AsExpression } b: e = b.Left; continue;
                case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } s: e = s.Operand; continue;
                case MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax id } ma when id.Identifier.ValueText == parameter: return ma.Name.Identifier.ValueText;
                case MemberAccessExpressionSyntax ma: e = ma.Expression; continue;
                default: return null;
            }
        }
    }

    private static bool DerivesFromDbContext(INamedTypeSymbol t)
    {
        for (var x = t.BaseType; x != null; x = x.BaseType)
            if (EfCoreModule.DbContext.Matches(x)) return true;
        return false;
    }

    private static HashSet<INamedTypeSymbol> MappedEntities(INamedTypeSymbol context)
    {
        var set = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        for (var t = context; t != null && !EfCoreModule.DbContext.Matches(t); t = t.BaseType)
            foreach (var p in t.GetMembers().OfType<IPropertySymbol>())
                if (p.Type is INamedTypeSymbol pt && EfCoreModule.DbSet1.Matches(pt) && pt.TypeArguments[0] is INamedTypeSymbol e) set.Add(e.OriginalDefinition);
        return set;
    }

    /// <summary>A reference or collection navigation to an entity of the context (not [NotMapped], not a computed property).</summary>
    private static bool IsNavigation(IPropertySymbol prop, HashSet<INamedTypeSymbol> mapped)
    {
        if (prop.IsStatic || prop.IsIndexer || prop.GetAttributes().Any(a => a.AttributeClass?.Name == "NotMappedAttribute")) return false;
        if (prop.SetMethod == null && !prop.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is PropertyDeclarationSyntax { AccessorList: { } al } && al.Accessors.All(x => x.Body == null && x.ExpressionBody == null))) return false;
        var t = prop.Type;
        if (t is INamedTypeSymbol named && mapped.Contains(named.OriginalDefinition)) return true;
        if (t.SpecialType == SpecialType.System_String) return false;
        var element = t is IArrayTypeSymbol arr ? arr.ElementType
            : (t as INamedTypeSymbol)?.AllInterfaces.Concat(t is INamedTypeSymbol { TypeKind: TypeKind.Interface } self ? new[] { self } : Array.Empty<INamedTypeSymbol>())
                .FirstOrDefault(i => i.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T)?.TypeArguments[0];
        return element is INamedTypeSymbol en && mapped.Contains(en.OriginalDefinition);
    }

    private static bool LazyLoadingPossible(Compilation compilation, INamedTypeSymbol entity)
    {
        if (compilation.ReferencedAssemblyNames.Any(a => a.Name == "Microsoft.EntityFrameworkCore.Proxies")) return true;
        static bool Lazy(ITypeSymbol? t) =>
            t is INamedTypeSymbol { Name: "ILazyLoader" } n && n.ContainingNamespace?.ToDisplayString() == "Microsoft.EntityFrameworkCore.Infrastructure"
            || t is INamedTypeSymbol { Name: "Action", Arity: 2 } a && a.TypeArguments[0].SpecialType == SpecialType.System_Object && a.TypeArguments[1].SpecialType == SpecialType.System_String;
        for (var t = entity; t != null; t = t.BaseType)
        {
            foreach (var m in t.GetMembers())
            {
                if (m is IFieldSymbol f && Lazy(f.Type) || m is IPropertySymbol p && Lazy(p.Type)) return true;
                if (m is IMethodSymbol { MethodKind: MethodKind.Constructor } c && c.Parameters.Any(x => Lazy(x.Type))) return true;
            }
        }
        return false;
    }

    private static readonly ConditionalWeakTable<Compilation, HashSet<string>> AutoIncludes = new();

    /// <summary>Navigations configured with AutoInclude() anywhere in the compilation (by name; conservative).</summary>
    private static bool AutoIncluded(Compilation compilation, string navigation, INamedTypeSymbol entity)
    {
        var set = AutoIncludes.GetValue(compilation, c =>
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var tree in c.SyntaxTrees)
            {
                if (tree.GetText().ToString().IndexOf("AutoInclude", StringComparison.Ordinal) < 0) continue;
                foreach (var inv in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "AutoInclude" } am) continue;
                    // modelBuilder.Entity<T>().Navigation(x => x.Nav).AutoInclude(): the lambda's member; a string: the string.
                    if (am.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Navigation" } } nav && nav.ArgumentList.Arguments.FirstOrDefault()?.Expression is { } a)
                    {
                        if (a is SimpleLambdaExpressionSyntax { Body: ExpressionSyntax b } sl && FirstMember(b, sl.Parameter.Identifier.ValueText) is { } n) names.Add(n);
                        else if (a is LiteralExpressionSyntax lit) names.Add(lit.Token.ValueText);
                        else names.Add("*");
                    }
                    else names.Add("*");
                }
            }
            return names;
        });
        return set.Contains("*") || set.Contains(navigation);
    }

    private static string ParameterName(INamedTypeSymbol entity, SyntaxNode fn)
    {
        var used = new HashSet<string>(fn.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>().Select(i => i.Identifier.ValueText)
            .Concat(fn.DescendantNodesAndSelf().OfType<VariableDeclaratorSyntax>().Select(v => v.Identifier.ValueText))
            .Concat(fn.DescendantNodesAndSelf().OfType<ParameterSyntax>().Select(v => v.Identifier.ValueText))
            .Concat(fn.DescendantNodesAndSelf().OfType<ForEachStatementSyntax>().Select(v => v.Identifier.ValueText)), StringComparer.Ordinal);
        foreach (var candidate in new[] { char.ToLowerInvariant(entity.Name[0]).ToString(), "x", "e", "it", "item" })
            if (SyntaxFacts.GetKeywordKind(candidate) == SyntaxKind.None && !used.Contains(candidate)) return candidate;
        return "entity" + used.Count;
    }
}
