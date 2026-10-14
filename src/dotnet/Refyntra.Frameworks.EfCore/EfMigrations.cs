using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.EfCore;

/// <summary>
/// The migrations of every DbContext, read from source only (protocol 1.18 <c>efcore/migrations</c>, the "Refyntra EF
/// Core" view): a migration is a class deriving from Migration with [Migration("id")]; it belongs to the DbContext of
/// its [DbContext(typeof(X))] (or to the only DbContext of the solution when that attribute is missing). Migrations are
/// ordered by id, as EF Core applies them. Nothing is built or run and no database is accessed; whether a migration is
/// applied is only known after the user's explicit "Check status" (dotnet ef migrations list, in the extension).
/// </summary>
public static class EfMigrations
{
    public static readonly KnownType MigrationAttribute = new("Microsoft.EntityFrameworkCore.Migrations.MigrationAttribute", "Microsoft.EntityFrameworkCore.Relational");

    public sealed record MigrationEntry(string Id, string Name, INamedTypeSymbol Type, Location? Main, Location? Designer, Project Project);

    public sealed record ContextEntry(INamedTypeSymbol Context, Project Project, Location? Declaration, Location? OnModelCreating,
        List<MigrationEntry> Migrations, INamedTypeSymbol? Snapshot, Location? SnapshotLocation, Project? SnapshotProject,
        List<(INamedTypeSymbol Type, Location Location)> Configurations)
    {
        /// <summary>The project that holds the migrations (dotnet ef --project): the snapshot's or the migrations', else the context's.</summary>
        public Project MigrationsProject => SnapshotProject ?? Migrations.LastOrDefault()?.Project ?? Project;

        /// <summary>The namespace of the migrations (snapshot first), or null when there are none.</summary>
        public string? MigrationsNamespace =>
            (Snapshot ?? Migrations.LastOrDefault()?.Type)?.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : null;
    }

    /// <summary>"20250101000000_Initial" → "Initial" (the id itself when it has no timestamp prefix).</summary>
    public static string NameOf(string id)
    {
        var i = id.IndexOf('_');
        return i == 14 && id[..14].All(char.IsDigit) && i + 1 < id.Length ? id[(i + 1)..] : id;
    }

    public static async Task<List<ContextEntry>> DiscoverAsync(IEnumerable<Project> projects, CancellationToken ct)
    {
        var contexts = new List<(INamedTypeSymbol Type, Project Project)>();
        var migrations = new List<(INamedTypeSymbol Type, INamedTypeSymbol? Context, string Id, Project Project)>();
        var snapshots = new List<(INamedTypeSymbol Type, INamedTypeSymbol? Context, Project Project)>();
        var configurations = new List<(INamedTypeSymbol Type, INamedTypeSymbol Entity)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var project in projects)
        {
            ct.ThrowIfCancellationRequested();
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            if (!compilation.ReferencedAssemblyNames.Any(a => a.Name == "Microsoft.EntityFrameworkCore")) continue;
            foreach (var type in Types(compilation.Assembly.GlobalNamespace))
            {
                if (type.TypeKind != TypeKind.Class || !seen.Add(Key(type))) continue;
                if (!type.IsAbstract && Derives(type, EfCoreModule.DbContext)) contexts.Add((type, project));
                var ctxAttr = type.GetAttributes().FirstOrDefault(a => EfCoreModule.DbContextAttribute.Matches(a.AttributeClass));
                var ctx = ctxAttr?.ConstructorArguments.FirstOrDefault().Value as INamedTypeSymbol;
                if (Derives(type, EfCoreModule.Migration))
                {
                    var id = type.GetAttributes().FirstOrDefault(a => MigrationAttribute.Matches(a.AttributeClass))?.ConstructorArguments.FirstOrDefault().Value as string;
                    if (!string.IsNullOrEmpty(id)) migrations.Add((type, ctx, id, project));
                }
                else if (Derives(type, EfCoreModule.ModelSnapshot)) snapshots.Add((type, ctx, project));
                if (!type.IsAbstract)
                    foreach (var i in type.AllInterfaces)
                        if (EfCoreModule.IEntityTypeConfiguration1.Matches(i) && i.TypeArguments[0] is INamedTypeSymbol e) configurations.Add((type, e));
            }
        }
        var result = new List<ContextEntry>();
        INamedTypeSymbol? Owner(INamedTypeSymbol? declared) =>
            declared != null ? contexts.Select(c => c.Type).FirstOrDefault(c => Key(c) == Key(declared)) : contexts.Count == 1 ? contexts[0].Type : null;
        foreach (var (ctx, project) in contexts.OrderBy(c => c.Type.Name, StringComparer.Ordinal).ThenBy(c => c.Type.ToDisplayString(), StringComparer.Ordinal))
        {
            var mine = migrations.Where(m => Owner(m.Context) is { } o && Key(o) == Key(ctx)).OrderBy(m => m.Id, StringComparer.Ordinal)
                .Select(m => new MigrationEntry(m.Id, NameOf(m.Id), m.Type, MainLocation(m.Type, ct), DesignerLocation(m.Type), m.Project)).ToList();
            var snap = snapshots.FirstOrDefault(s => Owner(s.Context) is { } o && Key(o) == Key(ctx));
            var mapped = MappedEntities(ctx);
            var configs = configurations.Where(c => mapped.Contains(Key(c.Entity)))
                .Select(c => (c.Type, Location: c.Type.Locations.FirstOrDefault(l => l.IsInSource)))
                .Where(c => c.Location != null).Select(c => (c.Type, c.Location!)).OrderBy(c => c.Type.Name, StringComparer.Ordinal).ToList();
            var onModel = ctx.GetMembers("OnModelCreating").OfType<IMethodSymbol>().FirstOrDefault(m => m.Locations.Any(l => l.IsInSource));
            result.Add(new ContextEntry(ctx, project, ctx.Locations.FirstOrDefault(l => l.IsInSource), onModel?.Locations.FirstOrDefault(l => l.IsInSource),
                mine, snap.Type, snap.Type?.Locations.FirstOrDefault(l => l.IsInSource), snap.Project, configs));
        }
        return result;
    }

    private static HashSet<string> MappedEntities(INamedTypeSymbol ctx)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        for (var t = ctx; t != null && !EfCoreModule.DbContext.Matches(t); t = t.BaseType)
            foreach (var p in t.GetMembers().OfType<IPropertySymbol>())
                if (p.Type is INamedTypeSymbol pt && EfCoreModule.DbSet1.Matches(pt) && pt.TypeArguments[0] is INamedTypeSymbol e) set.Add(Key(e));
        return set;
    }

    /// <summary>The declaration with Up/Down (not the .Designer.cs part) at the class name.</summary>
    private static Location? MainLocation(INamedTypeSymbol type, CancellationToken ct)
    {
        foreach (var r in type.DeclaringSyntaxReferences)
            if (r.GetSyntax(ct) is ClassDeclarationSyntax c && c.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.ValueText == "Up"))
                return c.Identifier.GetLocation();
        return type.Locations.Where(l => l.IsInSource).OrderBy(l => IsDesigner(l) ? 1 : 0).FirstOrDefault();
    }

    private static Location? DesignerLocation(INamedTypeSymbol type) => type.Locations.FirstOrDefault(l => l.IsInSource && IsDesigner(l));

    private static bool IsDesigner(Location l) => l.SourceTree?.FilePath.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase) == true;

    private static string Key(ISymbol s) => s.OriginalDefinition.ToDisplayString() + "|" + s.OriginalDefinition.ContainingAssembly?.Identity.Name;

    private static bool Derives(INamedTypeSymbol type, KnownType known)
    {
        for (var t = type.BaseType; t != null; t = t.BaseType)
            if (known.Matches(t)) return true;
        return false;
    }

    private static IEnumerable<INamedTypeSymbol> Types(INamespaceSymbol ns)
    {
        foreach (var m in ns.GetMembers())
        {
            if (m is INamespaceSymbol child)
                foreach (var t in Types(child)) yield return t;
            else if (m is INamedTypeSymbol t)
            {
                yield return t;
                foreach (var n in t.GetTypeMembers()) yield return n;
            }
        }
    }
}
