using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Safe Delete: deletes a type, member, parameter or local only when nothing else uses it. Preconditions: the symbol is
/// declared in source (not generated) and every use found by Roslyn is inside the deleted code. An interface, abstract or
/// virtual member is deleted with its implementations/overrides (each must be unused too); a member that implements or
/// overrides another member is refused (deleting it would change which code runs). Every partial declaration of a type is
/// deleted; a file left without code is deleted when its Compile membership is plain (SDK default glob), otherwise it is
/// kept empty. A parameter is removed from the method, its hierarchy and every call site (Change Signature with the
/// parameter left out). Framework relations (MediatR handlers, DI registrations, endpoints) and string/dynamic uses the
/// compiler cannot see make the plan limited. The compilation delta must be clean. Never writes files.
/// </summary>
public static class SafeDeletePlanner
{
    public const string ActionId = "csharp.safeDelete";

    /// <summary>Cheap guards (used by capability/query too).</summary>
    public static (string reason, string message)? Guard(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (CodeFacts.SourceGuard(snapshot, symbol, ct) is { } g) return g;
        switch (symbol)
        {
            case INamedTypeSymbol:
            case IFieldSymbol:
            case IEventSymbol:
            case ILocalSymbol:
                break;
            case IPropertySymbol:
                break;
            case IMethodSymbol m when m.MethodKind is MethodKind.Ordinary or MethodKind.LocalFunction:
                if (m.PartialDefinitionPart != null || m.PartialImplementationPart != null || m.IsPartialDefinition)
                    return ("PartialMethod", "Deleting partial methods is not supported.");
                break;
            case IMethodSymbol { MethodKind: MethodKind.Constructor, IsStatic: false } c:
                if (c.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is TypeDeclarationSyntax))
                    return ("PrimaryConstructor", "Deleting a primary constructor is not supported.");
                break;
            case IMethodSymbol m:
                return ("UnsupportedSymbolKind", $"Deleting {m.MethodKind} methods is not supported (they run without an explicit call).");
            case IParameterSymbol p:
                if (p.ContainingSymbol is not IMethodSymbol owner)
                    return ("UnsupportedSymbolKind", "Deleting parameters of indexers and delegates is not supported.");
                if (ChangeSignaturePlanner.Guard(snapshot, owner, ct) is { } cg) return cg;
                break;
            default:
                return ("UnsupportedSymbolKind", $"Deleting {symbol.Kind} symbols is not supported.");
        }
        if (symbol is ILocalSymbol local && local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) is not VariableDeclaratorSyntax { Parent.Parent: LocalDeclarationStatementSyntax })
            return ("UnsupportedDeclaration", "Only locals declared in a declaration statement can be deleted (not pattern, out, foreach, using or deconstruction variables).");
        if (symbol is IFieldSymbol f && f.AssociatedSymbol != null)
            return ("UnsupportedSymbolKind", "The field belongs to another symbol (a backing field or a tuple element).");
        if (symbol is IMethodSymbol or IPropertySymbol or IEventSymbol && Overridden(symbol) is { } baseMember)
            return ("ImplementsMember", $"{symbol.Name} {(baseMember.ContainingType.TypeKind == TypeKind.Interface ? "implements" : "overrides")} {baseMember.ContainingType.Name}.{baseMember.Name}; deleting it would change which code runs. Delete {baseMember.ContainingType.Name}.{baseMember.Name} instead (its implementations are deleted with it).");
        return null;
    }

    /// <summary>The member <paramref name="symbol"/> overrides or implements, if any.</summary>
    private static ISymbol? Overridden(ISymbol symbol)
    {
        var over = symbol switch
        {
            IMethodSymbol m => (ISymbol?)m.OverriddenMethod,
            IPropertySymbol p => p.OverriddenProperty,
            IEventSymbol e => e.OverriddenEvent,
            _ => null,
        };
        if (over != null) return over;
        var type = symbol.ContainingType;
        if (type == null) return null;
        foreach (var iface in type.AllInterfaces)
        foreach (var member in iface.GetMembers())
            if (SymbolEqualityComparer.Default.Equals(type.FindImplementationForInterfaceMember(member), symbol)) return member;
        return null;
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (Guard(snapshot, symbol, ct) is { } g) return RenameOutcome.Unavailable(g.reason, g.message);
        if (symbol is IParameterSymbol parameter) return await DeleteParameterAsync(snapshot, parameter, ct).ConfigureAwait(false);
        var solution = snapshot.Solution;

        // ---------------- what is deleted: the symbol, its implementations/overrides (cascade) and their declarations
        var targets = new List<ISymbol> { symbol };
        if (symbol is IMethodSymbol or IPropertySymbol or IEventSymbol && (symbol.ContainingType?.TypeKind == TypeKind.Interface || symbol.IsAbstract || symbol.IsVirtual))
        {
            var queue = new Queue<ISymbol>(targets);
            while (queue.Count > 0)
            {
                var s = queue.Dequeue();
                var more = new List<ISymbol>();
                more.AddRange(await SymbolFinder.FindOverridesAsync(s, solution, cancellationToken: ct).ConfigureAwait(false));
                if (s.ContainingType?.TypeKind == TypeKind.Interface)
                    more.AddRange(await SymbolFinder.FindImplementationsAsync(s, solution, cancellationToken: ct).ConfigureAwait(false));
                foreach (var m in more)
                {
                    if (targets.Contains(m, SymbolEqualityComparer.Default)) continue;
                    if (CodeFacts.SourceGuard(snapshot, m, ct) is { } mg) return RenameOutcome.Unavailable(mg.reason, $"{m.ContainingType?.Name}.{m.Name}: {mg.message}");
                    targets.Add(m);
                    queue.Enqueue(m);
                }
            }
        }
        // Declarations to remove, and every symbol declared inside them (members of a deleted type, nested types).
        var declNodes = new List<SyntaxNode>();
        var covered = new List<ISymbol>();
        foreach (var t in targets)
        {
            foreach (var r in t.DeclaringSyntaxReferences)
            {
                var node = await r.GetSyntaxAsync(ct).ConfigureAwait(false);
                if (RemovalNode(node) is not { } removal) return RenameOutcome.Unavailable("UnsupportedDeclaration", $"The declaration of {t.Name} at {CodeFacts.Label(node.GetLocation())} cannot be removed on its own.");
                declNodes.Add(removal);
            }
            covered.Add(t);
            if (t is INamedTypeSymbol type) covered.AddRange(AllMembers(type));
        }

        // ---------------- every use must be inside the deleted code
        bool Inside(Location l) => l.IsInSource && declNodes.Any(d => d.SyntaxTree.FilePath == l.SourceTree!.FilePath && d.FullSpan.Contains(l.SourceSpan));
        var uses = new List<Location>();
        foreach (var s in covered)
        {
            foreach (var rs in await SymbolFinder.FindReferencesAsync(s, solution, ct).ConfigureAwait(false))
            foreach (var loc in rs.Locations)
                if (!Inside(loc.Location) && !uses.Any(u => u.SourceTree?.FilePath == loc.Location.SourceTree?.FilePath && u.SourceSpan == loc.Location.SourceSpan))
                    uses.Add(loc.Location);
        }
        if (uses.Count > 0)
        {
            var list = uses.OrderBy(u => u.SourceTree?.FilePath, StringComparer.Ordinal).ThenBy(u => u.SourceSpan.Start).ToList();
            return RenameOutcome.Unavailable("ReferencesRemain",
                $"{symbol.Name} is still used in {list.Count} place(s): {string.Join(", ", list.Take(8).Select(CodeFacts.Label))}{(list.Count > 8 ? ", …" : "")}. Remove these uses first (Show Related lists them).");
        }

        // ---------------- local: the initializer must not have side effects (deleting it would drop them)
        if (symbol is ILocalSymbol local)
        {
            var declarator = (VariableDeclaratorSyntax)local.DeclaringSyntaxReferences[0].GetSyntax(ct);
            if (declarator.Parent?.Parent is LocalDeclarationStatementSyntax { UsingKeyword.RawKind: not 0 })
                return RenameOutcome.Unavailable("UsingDeclaration", $"{local.Name} is a using declaration; deleting it would drop its Dispose call.");
            if (declarator.Initializer is { } init)
            {
                var model = solution.GetDocument(declarator.SyntaxTree) is { } d ? await d.GetSemanticModelAsync(ct).ConfigureAwait(false) : null;
                if (model == null || !CodeFacts.IsSideEffectFree(init.Value, model, ct))
                    return RenameOutcome.Unavailable("InitializerHasSideEffects", $"The initializer of {local.Name} may have side effects; deleting it could change behavior. Keep the expression as a statement or remove it yourself.");
            }
        }
        // A field initializer may have side effects too (it runs in every constructor).
        if (symbol is IFieldSymbol field && field.DeclaringSyntaxReferences[0].GetSyntax(ct) is VariableDeclaratorSyntax { Initializer: { } fieldInit } fdecl && !field.IsConst)
        {
            var model = solution.GetDocument(fdecl.SyntaxTree) is { } d ? await d.GetSemanticModelAsync(ct).ConfigureAwait(false) : null;
            if (model == null || !CodeFacts.IsSideEffectFree(fieldInit.Value, model, ct))
                return RenameOutcome.Unavailable("InitializerHasSideEffects", $"The initializer of {field.Name} may have side effects (it runs when the object or type is initialized); deleting it could change behavior.");
        }

        // ---------------- edits
        var after = solution;
        var deletes = new List<PlannedFileDelete>();
        var limitations = new List<string>();
        var evidence = new List<(string, Location?)>();
        var limited = new List<string>();
        var owners = new HashSet<ProjectId>();
        foreach (var group in declNodes.GroupBy(n => n.SyntaxTree))
        {
            var docIds = snapshot.Session.DocumentIdsForPath(group.Key.FilePath);
            var doc = solution.GetDocument(group.Key);
            if (doc == null) return RenameOutcome.Unavailable("UnsupportedDeclaration", "A declaration is not in a document of the workspace.");
            var root = await group.Key.GetRootAsync(ct).ConfigureAwait(false);
            var editor = new SyntaxEditor(root, solution.Services);
            foreach (var node in group.Distinct()) editor.RemoveNode(node, SyntaxRemoveOptions.KeepUnbalancedDirectives | SyntaxRemoveOptions.AddElasticMarker);
            var newRoot = editor.GetChangedRoot();
            foreach (var id in docIds.Where(id => after.GetDocument(id) != null)) owners.Add(id.ProjectId);
            if (symbol is INamedTypeSymbol && IsEmptyOfCode(newRoot) && doc.FilePath is { } path)
            {
                var keep = FileDeleteGuard(snapshot, path);
                if (keep == null)
                {
                    var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                    deletes.Add(new PlannedFileDelete(path, Hashing.Sha256Text(text.ToString()), FileRenamePlanner.ProjectsOf(snapshot, path)));
                    after = after.RemoveDocuments(docIds.Where(id => after.GetDocument(id) != null).ToImmutableArrayOrEmpty());
                    evidence.Add(($"{Path.GetFileName(path)} contains nothing but {symbol.Name}{(declNodes.Count > 1 ? " (and its other deleted declarations)" : "")}: it leaves the SDK default Compile glob when deleted (no Compile item names it)", null));
                    continue;
                }
                limitations.Add($"{Path.GetFileName(path)} is kept without code: {keep}");
            }
            foreach (var id in docIds) if (after.GetDocument(id) != null) after = after.WithDocumentSyntaxRoot(id, newRoot);
        }

        // ---------------- what the compiler cannot see
        var owner = SymbolFacts.OwningProject(solution, symbol);
        if (symbol is INamedTypeSymbol or IMethodSymbol { MethodKind: MethodKind.Ordinary } && owner != null)
        {
            var related = await SemanticService.RelatedAsync(snapshot, symbol, owner, ct).ConfigureAwait(false);
            var framework = related.Relations.Where(r => r.RelationKind is not (RelationKinds.Declaration or RelationKinds.Reference or RelationKinds.Implementation or RelationKinds.Test)).ToList();
            foreach (var r in framework.Take(8))
                limited.Add($"Framework relation ({r.RelationKind}, {r.Confidence}): {r.Target.Label} — the framework may use {symbol.Name} at run time (for example MediatR handler discovery or a DI registration), which no compile-time reference shows.");
        }
        if (symbol is not (ILocalSymbol or IParameterSymbol) && symbol.DeclaredAccessibility != Accessibility.Private)
        {
            var unknown = await CodeFacts.UnknownUsesAsync(solution, null, symbol.Name, ct).ConfigureAwait(false);
            if (unknown.Count > 0)
                limited.Add($"Uses the compiler cannot connect to {symbol.Name} (reflection, serialization or dynamic) may exist: {string.Join("; ", unknown)}.");
        }
        if (symbol is not (ILocalSymbol or IParameterSymbol) && symbol.DeclaredAccessibility is Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal)
            limitations.Add($"{symbol.Name} is publicly visible; code outside the loaded solution may still use it.");
        limitations.Add("Uses through reflection, dynamic, serialization, configuration files or markup are not found by the compiler.");
        evidence.Insert(0, ($"No use of {string.Join(", ", targets.Select(t => t.Name).Distinct())} outside the deleted code (Roslyn FindReferences{(covered.Count > targets.Count ? $" for {covered.Count} symbol(s) including members" : "")})", SymbolFacts.PrimaryLocation(symbol)));
        if (targets.Count > 1)
            evidence.Add(($"Deleted with it: {string.Join(", ", targets.Skip(1).Select(t => $"{t.ContainingType?.Name}.{t.Name}"))} (implementations/overrides)", null));
        var title = $"Safe delete {Kind(symbol)} {symbol.Name}";
        return await SolutionPlanBuilder.BuildAsync(snapshot, after, new SolutionPlanBuilder.Options(ActionId, title, limitations, evidence, limited, owners, deletes), ct).ConfigureAwait(false);
    }

    private static async Task<RenameOutcome> DeleteParameterAsync(Snapshot snapshot, IParameterSymbol parameter, CancellationToken ct)
    {
        var method = (IMethodSymbol)parameter.ContainingSymbol;
        var spec = method.Parameters.Where(p => p.Ordinal != parameter.Ordinal).Select(p => new ParameterSpec(p.Ordinal, p.Name)).ToList();
        var result = await ChangeSignaturePlanner.ChangeAsync(snapshot, method, spec, ct).ConfigureAwait(false);
        if (result.Refusal is { } r)
            return RenameOutcome.Unavailable(r.reason == "ParameterUsed" ? "ReferencesRemain" : r.reason, r.message);
        result.Limitations.Insert(0, "Only call sites the compiler binds to the method are updated; reflection, dynamic calls and code outside the loaded solution are not.");
        result.Evidence.Insert(0, ($"{parameter.Name} is not used in the body of {ChangeSignaturePlanner.DisplayName(method)} or of any member of its hierarchy", SymbolFacts.PrimaryLocation(parameter)));
        return await SolutionPlanBuilder.BuildAsync(snapshot, result.After!, new SolutionPlanBuilder.Options(ActionId, $"Safe delete parameter {parameter.Name} of {ChangeSignaturePlanner.DisplayName(method)}",
            result.Limitations, result.Evidence, result.LimitedReasons, result.Projects), ct).ConfigureAwait(false);
    }

    private static string Kind(ISymbol s) => s switch
    {
        INamedTypeSymbol t => t.TypeKind switch { TypeKind.Interface => "interface", TypeKind.Struct => "struct", TypeKind.Enum => "enum", TypeKind.Delegate => "delegate", _ => t.IsRecord ? "record" : "class" },
        IMethodSymbol { MethodKind: MethodKind.Constructor } => "constructor",
        IMethodSymbol { MethodKind: MethodKind.LocalFunction } => "local function",
        IMethodSymbol => "method",
        IPropertySymbol => "property",
        IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } => "enum member",
        IFieldSymbol => "field",
        IEventSymbol => "event",
        ILocalSymbol => "local",
        _ => s.Kind.ToString().ToLowerInvariant(),
    };

    private static IEnumerable<ISymbol> AllMembers(INamedTypeSymbol type)
    {
        foreach (var m in type.GetMembers())
        {
            if (m.IsImplicitlyDeclared) continue;
            yield return m;
            if (m is INamedTypeSymbol nested) foreach (var n in AllMembers(nested)) yield return n;
        }
    }

    /// <summary>The node to remove for a declaration: one declarator of a multi-variable field/event/local, else the declaration.</summary>
    private static SyntaxNode? RemovalNode(SyntaxNode decl) => decl switch
    {
        VariableDeclaratorSyntax v when v.Parent is VariableDeclarationSyntax vd && vd.Variables.Count > 1 => v,
        VariableDeclaratorSyntax v when v.Parent?.Parent is BaseFieldDeclarationSyntax or LocalDeclarationStatementSyntax => v.Parent.Parent,
        EnumMemberDeclarationSyntax e => e,
        MemberDeclarationSyntax m => m,
        LocalFunctionStatementSyntax l => l,
        _ => null,
    };

    /// <summary>True when the file has no code left: only usings, extern aliases, empty namespaces, comments and directives.</summary>
    internal static bool IsEmptyOfCode(SyntaxNode root)
    {
        if (root is not CompilationUnitSyntax cu) return false;
        if (cu.AttributeLists.Count > 0) return false;
        if (cu.Usings.Any(u => u.GlobalKeyword.RawKind != 0)) return false;
        return cu.Members.All(EmptyNamespace);
        static bool EmptyNamespace(MemberDeclarationSyntax m) =>
            m is BaseNamespaceDeclarationSyntax ns && ns.Usings.All(u => u.GlobalKeyword.RawKind == 0) && ns.Members.All(EmptyNamespace);
    }

    /// <summary>Why the file must stay (with no code) instead of being deleted, or null when deleting it is proven plain.</summary>
    private static string? FileDeleteGuard(Snapshot snapshot, string path)
    {
        var projects = FileRenamePlanner.ProjectsOf(snapshot, path);
        if (projects.Count == 0) return "its project is not known.";
        foreach (var project in projects)
            if (FileRenamePlanner.ProveCompileMembership(project, path, path, "the file is kept", "deleted", "deleting the file") is { } refusal)
                return refusal.message;
        var other = snapshot.Session.DocumentIdsForPath(path).Select(id => snapshot.Solution.GetProject(id.ProjectId)?.FilePath).OfType<string>()
            .Where(p => !projects.Contains(p, UriPaths.PathComparer)).ToList();
        if (other.Count > 0) return "the file is linked into another project.";
        return null;
    }
}

internal static class ImmutableHelpers
{
    public static System.Collections.Immutable.ImmutableArray<T> ToImmutableArrayOrEmpty<T>(this IEnumerable<T> items) => System.Collections.Immutable.ImmutableArray.CreateRange(items);
}
