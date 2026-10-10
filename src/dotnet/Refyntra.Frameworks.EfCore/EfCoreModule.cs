using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Frameworks.Abstractions;

namespace Refyntra.Frameworks.EfCore;

/// <summary>
/// EF Core model navigation from source only: DbContext ↔ entities, configurations, tables, navigations, query sites and
/// migrations. Identity is checked by metadata name and declaring assembly (Microsoft.EntityFrameworkCore,
/// .Relational, .Abstractions); a same-name DbContext/DbSet elsewhere never matches. The model is never built at
/// runtime and no database is ever accessed.
/// </summary>
public sealed class EfCoreModule : IFrameworkModule
{
    private const string Core = "Microsoft.EntityFrameworkCore", Relational = "Microsoft.EntityFrameworkCore.Relational",
        Abstractions = "Microsoft.EntityFrameworkCore.Abstractions";
    private static readonly string[] EfAssemblies = { Core, Relational, Abstractions };
    private static readonly string[] AnnotationAssemblies = { "System.ComponentModel.Annotations", "System.ComponentModel.DataAnnotations", "netstandard" };

    public static readonly KnownType DbContext = new("Microsoft.EntityFrameworkCore.DbContext", Core);
    public static readonly KnownType DbSet1 = new("Microsoft.EntityFrameworkCore.DbSet`1", Core);
    public static readonly KnownType IEntityTypeConfiguration1 = new("Microsoft.EntityFrameworkCore.IEntityTypeConfiguration`1", Core);
    public static readonly KnownType ModelBuilder = new("Microsoft.EntityFrameworkCore.ModelBuilder", Core);
    public static readonly KnownType EntityTypeBuilder1 = new("Microsoft.EntityFrameworkCore.Metadata.Builders.EntityTypeBuilder`1", Core);
    public static readonly KnownType Migration = new("Microsoft.EntityFrameworkCore.Migrations.Migration", Relational);
    public static readonly KnownType MigrationBuilder = new("Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder", Relational);
    public static readonly KnownType ModelSnapshot = new("Microsoft.EntityFrameworkCore.Infrastructure.ModelSnapshot", Core, Relational);
    public static readonly KnownType DbContextAttribute = new("Microsoft.EntityFrameworkCore.Infrastructure.DbContextAttribute", Core);
    public static readonly KnownType TableAttribute = new("System.ComponentModel.DataAnnotations.Schema.TableAttribute", AnnotationAssemblies);
    public static readonly KnownType KeyAttribute = new("System.ComponentModel.DataAnnotations.KeyAttribute", AnnotationAssemblies);
    public static readonly KnownType ForeignKeyAttribute = new("System.ComponentModel.DataAnnotations.Schema.ForeignKeyAttribute", AnnotationAssemblies);
    public static readonly KnownType NotMappedAttribute = new("System.ComponentModel.DataAnnotations.Schema.NotMappedAttribute", AnnotationAssemblies);

    public string Id => "efcore";
    public string ProviderRouteId => "csharp.roslyn/efcore";

    private const string ReadOnlyNote = "Read-only reference: migrations and model snapshots are generated code; Refyntra neither runs nor edits them.";
    private const string NoRuntime = "Static source analysis only: the EF Core model is never built at runtime and no database is accessed.";

    public enum MappingKind { DbSet, EntityCall, ApplyConfiguration, AssemblyScan, Convention }

    public sealed record ContextFact(INamedTypeSymbol Type, ProjectId ProjectId);

    public sealed record MappingFact(INamedTypeSymbol Entity, INamedTypeSymbol Context, MappingKind Kind, string How, Location? Location,
        string Confidence, INamedTypeSymbol? Configuration = null);

    public sealed record ConfigurationFact(INamedTypeSymbol Configuration, INamedTypeSymbol Entity, ProjectId ProjectId);

    public sealed record TableFact(INamedTypeSymbol Entity, string Name, string? Schema, string Source, Location? Location, bool Convention)
    {
        public string Qualified => Schema != null ? Schema + "." + Name : Name;
    }

    public sealed record NavigationFact(INamedTypeSymbol From, string? Property, INamedTypeSymbol To, string? Inverse, string Shape,
        string? ForeignKey, Location? Location, string Confidence, bool Owned);

    public sealed record QueryFact(INamedTypeSymbol Entity, string Form, string Container, Location Location, SyntaxTree Tree, TextSpan Span,
        ProjectId ProjectId, int GroupKey);

    public sealed record MigrationFact(INamedTypeSymbol Type, bool IsSnapshot, INamedTypeSymbol? Context, List<(string Text, Location Location)> Tables,
        List<(string Name, Location Location)> Entities);

    public sealed record DynamicSite(INamedTypeSymbol Context, Location Location, string Description);

    public sealed class Facts
    {
        public List<ContextFact> Contexts { get; } = new();
        public List<MappingFact> Mappings { get; } = new();
        public List<ConfigurationFact> Configurations { get; } = new();
        public List<TableFact> Tables { get; } = new();
        public List<NavigationFact> Navigations { get; } = new();
        public List<QueryFact> Queries { get; } = new();
        public List<MigrationFact> Migrations { get; } = new();
        public List<DynamicSite> Dynamic { get; } = new();
        public List<INamedTypeSymbol> Owned { get; } = new();
        public SortedSet<string> AssemblyEvidence { get; } = new(StringComparer.Ordinal);

        /// <summary>Distinct mapped entity types (owned types excluded).</summary>
        public IEnumerable<INamedTypeSymbol> Entities =>
            Mappings.GroupBy(m => Key(m.Entity), StringComparer.Ordinal).Select(g => g.First().Entity);

        /// <summary>Table names of an entity: explicit ones, else the convention name.</summary>
        public IEnumerable<TableFact> TablesOf(ISymbol entity) => Tables.Where(t => SymbolIdentity.SameDefinition(t.Entity, entity));
    }

    internal static string Key(ISymbol s) =>
        (DocumentationCommentId.CreateDeclarationId(s.OriginalDefinition) ?? s.Name) + "|" + s.OriginalDefinition.ContainingAssembly?.Identity.Name;

    public string? Detection(object facts)
    {
        var f = (Facts)facts;
        return f.AssemblyEvidence.Count == 0 ? null : string.Join("; ", f.AssemblyEvidence);
    }

    // ------------------------------------------------------------------ analysis

    public async Task<object> AnalyzeAsync(FrameworkContext context, CancellationToken ct)
    {
        var facts = new Facts();
        var efProjects = new List<(Project project, Compilation compilation)>();
        foreach (var project in context.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation == null) continue;
            var ef = compilation.References.Select(compilation.GetAssemblyOrModuleSymbol).OfType<IAssemblySymbol>()
                .Where(a => EfAssemblies.Contains(a.Identity.Name)).ToList();
            if (ef.Count == 0) continue;
            foreach (var a in ef) facts.AssemblyEvidence.Add(SymbolIdentity.VersionEvidence(a));
            efProjects.Add((project, compilation));
        }

        // Pass 1: types (contexts, DbSet properties, configurations, migrations).
        var dbSetNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (project, compilation) in efProjects)
        {
            foreach (var type in AllSourceTypes(compilation.Assembly.GlobalNamespace))
            {
                if (type.TypeKind != TypeKind.Class) continue;
                if (DerivesFrom(type, DbContext))
                {
                    facts.Contexts.Add(new ContextFact(type, project.Id));
                    for (var t = type; t != null && !DbContext.Matches(t); t = t.BaseType)
                    {
                        foreach (var p in t.GetMembers().OfType<IPropertySymbol>())
                        {
                            if (p.Type is not INamedTypeSymbol pt || !DbSet1.Matches(pt) || pt.TypeArguments[0] is not INamedTypeSymbol entity) continue;
                            dbSetNames.Add(p.Name);
                            facts.Mappings.Add(new MappingFact(entity, type, MappingKind.DbSet, $"DbSet<{entity.Name}> {p.Name}",
                                p.Locations.FirstOrDefault(l => l.IsInSource), Confidences.Proven));
                        }
                    }
                }
                foreach (var iface in type.AllInterfaces)
                    if (IEntityTypeConfiguration1.Matches(iface) && iface.TypeArguments[0] is INamedTypeSymbol e && !type.IsAbstract)
                        facts.Configurations.Add(new ConfigurationFact(type, e, project.Id));
                var isMigration = DerivesFrom(type, Migration);
                if (isMigration || DerivesFrom(type, ModelSnapshot))
                {
                    var ctxAttr = type.GetAttributes().FirstOrDefault(a => DbContextAttribute.Matches(a.AttributeClass));
                    var ctx = ctxAttr?.ConstructorArguments.FirstOrDefault().Value as INamedTypeSymbol;
                    facts.Migrations.Add(new MigrationFact(type, !isMigration, ctx, new(), new()));
                }
            }
        }

        // Pass 2: syntax (OnModelCreating, configurations, fluent calls, queries, migration bodies).
        var markers = dbSetNames.Concat(new[] { "Set<", "Entity", "ApplyConfiguration", "ToTable", "Has", "Owns", "MigrationBuilder" }).ToArray();
        foreach (var (project, compilation) in efProjects)
        foreach (var (doc, root, model) in await SymbolIdentity.DocumentsContainingAsync(project, markers, ct).ConfigureAwait(false))
        {
            ct.ThrowIfCancellationRequested();
            foreach (var node in root.DescendantNodes())
            {
                if (node is InvocationExpressionSyntax inv) AnalyzeInvocation(facts, model, inv, project.Id, ct);
                else if (node is IdentifierNameSyntax id && dbSetNames.Contains(id.Identifier.ValueText)) AnalyzeDbSetAccess(facts, model, id, project.Id, ct);
            }
        }

        AddAnnotations(facts);
        AddConventions(facts);
        AddConventionTables(facts);
        return facts;
    }

    private static bool DerivesFrom(INamedTypeSymbol type, KnownType known)
    {
        for (var t = type.BaseType; t != null; t = t.BaseType)
            if (known.Matches(t)) return true;
        return false;
    }

    private static bool IsEf(IMethodSymbol m) => m.ContainingAssembly != null && EfAssemblies.Contains(m.ContainingAssembly.Identity.Name);

    private static INamedTypeSymbol? EnclosingType(SemanticModel model, SyntaxNode node, CancellationToken ct) =>
        node.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault() is { } td ? model.GetDeclaredSymbol(td, ct) : null;

    private static ContextFact? ContextOf(Facts facts, INamedTypeSymbol? type) =>
        type == null ? null : facts.Contexts.FirstOrDefault(c => SymbolIdentity.SameDefinition(c.Type, type));

    private static MigrationFact? MigrationOf(Facts facts, INamedTypeSymbol? type) =>
        type == null ? null : facts.Migrations.FirstOrDefault(m => SymbolIdentity.SameDefinition(m.Type, type));

    private static bool InLoop(SyntaxNode node) =>
        node.Ancestors().TakeWhile(a => a is not MemberDeclarationSyntax).Any(a => a is ForEachStatementSyntax or ForStatementSyntax or WhileStatementSyntax or DoStatementSyntax);

    private static readonly HashSet<string> ReflectionCalls = new(StringComparer.Ordinal) { "GetTypes", "GetExportedTypes", "CreateInstance", "MakeGenericMethod", "MakeGenericType" };

    private static void AnalyzeInvocation(Facts facts, SemanticModel model, InvocationExpressionSyntax inv, ProjectId projectId, CancellationToken ct)
    {
        var name = SymbolIdentity.InvokedName(inv);
        if (name == null) return;
        var enclosing = EnclosingType(model, inv, ct);

        // Reflection inside OnModelCreating: dynamic model building.
        if (ReflectionCalls.Contains(name) && ContextOf(facts, enclosing) is { } rc && InOnModelCreating(inv))
        {
            AddDynamic(facts, inv, new DynamicSite(rc.Type, inv.GetLocation(), $"{name}() in OnModelCreating (reflection)"));
            return;
        }

        if (name is not ("Entity" or "ApplyConfiguration" or "ApplyConfigurationsFromAssembly" or "ToTable" or "HasOne" or "HasMany"
            or "OwnsOne" or "OwnsMany" or "Set" or "CreateTable" or "DropTable" or "RenameTable" or "AddColumn" or "DropColumn"
            or "AlterColumn" or "RenameColumn" or "CreateIndex" or "DropIndex" or "AddForeignKey" or "DropForeignKey" or "AddPrimaryKey"
            or "DropPrimaryKey" or "InsertData" or "UpdateData" or "DeleteData" or "AddUniqueConstraint" or "DropUniqueConstraint"))
            return;
        var method = SymbolIdentity.InvokedMethod(model, inv, ct);
        if (method == null) return;
        var location = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.GetLocation() : inv.GetLocation();

        // Migrations: MigrationBuilder table references and model snapshot entity names (read-only).
        if (MigrationBuilder.Matches(method.ContainingType))
        {
            if (MigrationOf(facts, enclosing) is not { } mig) return;
            if (model.GetOperation(inv, ct) is not IInvocationOperation op) return;
            foreach (var arg in op.Arguments)
            {
                var p = arg.Parameter?.Name;
                var isTable = p is "table" or "principalTable" || p is "name" or "newName" && name is "CreateTable" or "DropTable" or "RenameTable";
                if (isTable && arg.Value.ConstantValue is { HasValue: true, Value: string s })
                    mig.Tables.Add((s + "\u0001" + name, location));
            }
            return;
        }

        var containingType = method.ContainingType;
        if (name == "Set")
        {
            if (!DbContext.Matches(containingType) || method.TypeArguments.Length != 1 || method.TypeArguments[0] is not INamedTypeSymbol e) return;
            // `public DbSet<T> Items => Set<T>();` defines a DbSet; it is no query.
            if (inv.Ancestors().OfType<PropertyDeclarationSyntax>().FirstOrDefault() is { } pd && model.GetDeclaredSymbol(pd, ct) is IPropertySymbol ps
                && DbSet1.Matches(ps.Type)) return;
            AddQuery(facts, model, inv, e, $"Set<{e.Name}>()", location, projectId, ct);
            return;
        }

        if (!IsEf(method)) return;

        if (name == "Entity" && ModelBuilder.Matches(containingType))
        {
            var ctx = ContextOf(facts, enclosing);
            var mig = MigrationOf(facts, enclosing);
            INamedTypeSymbol? entity = method.TypeArguments.Length == 1 ? method.TypeArguments[0] as INamedTypeSymbol : null;
            if (entity == null && inv.ArgumentList.Arguments.Count > 0)
            {
                var a0 = inv.ArgumentList.Arguments[0].Expression;
                if (a0 is TypeOfExpressionSyntax to) entity = model.GetTypeInfo(to.Type, ct).Type as INamedTypeSymbol;
                else if (model.GetConstantValue(a0, ct) is { HasValue: true, Value: string s})
                {
                    if (mig != null) mig.Entities.Add((s, location));
                    return;
                }
            }
            if (ctx == null) return;
            if (entity == null || InLoop(inv))
            {
                AddDynamic(facts, inv, new DynamicSite(ctx.Type, inv.GetLocation(), InLoop(inv) ? "Entity(...) inside a loop" : "Entity(...) with a type computed at runtime"));
                return;
            }
            facts.Mappings.Add(new MappingFact(entity, ctx.Type, MappingKind.EntityCall, $"Entity<{entity.Name}>() in {ctx.Type.Name}.OnModelCreating",
                location, Confidences.Proven));
            return;
        }

        if (name == "ApplyConfiguration" && ModelBuilder.Matches(containingType))
        {
            if (ContextOf(facts, enclosing) is not { } ctx) return;
            var config = inv.ArgumentList.Arguments.Count > 0 ? model.GetTypeInfo(inv.ArgumentList.Arguments[0].Expression, ct).Type as INamedTypeSymbol : null;
            var entity = method.TypeArguments.Length == 1 ? method.TypeArguments[0] as INamedTypeSymbol : null;
            if (entity == null || InLoop(inv) || config is null || config.TypeKind is TypeKind.Interface or TypeKind.Error)
            {
                AddDynamic(facts, inv, new DynamicSite(ctx.Type, inv.GetLocation(), "ApplyConfiguration(...) with a configuration that is not statically known"));
                if (entity == null) return;
            }
            facts.Mappings.Add(new MappingFact(entity, ctx.Type, MappingKind.ApplyConfiguration,
                $"ApplyConfiguration({config?.Name ?? "?"}) in {ctx.Type.Name}.OnModelCreating", location, Confidences.Proven,
                config is { TypeKind: TypeKind.Class } ? config : null));
            return;
        }

        if (name == "ApplyConfigurationsFromAssembly" && ModelBuilder.Matches(containingType))
        {
            if (ContextOf(facts, enclosing) is not { } ctx) return;
            // typeof(X).Assembly → the assembly declaring X; its source configurations are scanned (likely).
            var arg = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
            IAssemblySymbol? assembly = null;
            if (arg is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Assembly", Expression: TypeOfExpressionSyntax tof })
                assembly = model.GetTypeInfo(tof.Type, ct).Type?.ContainingAssembly;
            // Assembly.GetExecutingAssembly() → the assembly of the code making the call (the context's own assembly).
            else if (arg is InvocationExpressionSyntax gea && model.GetSymbolInfo(gea, ct).Symbol is IMethodSymbol { Name: "GetExecutingAssembly", IsStatic: true } m
                     && m.ContainingType?.ToDisplayString() == "System.Reflection.Assembly")
                assembly = enclosing?.ContainingAssembly;
            // GetType().Assembly / this.GetType().Assembly → the runtime type's assembly; a derived context in another
            // assembly would differ, so this stays a likely scan like the others.
            else if (arg is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Assembly", Expression: InvocationExpressionSyntax gt }
                     && gt.ArgumentList.Arguments.Count == 0
                     && model.GetSymbolInfo(gt, ct).Symbol is IMethodSymbol { Name: "GetType" } gm && gm.ContainingType?.SpecialType == SpecialType.System_Object
                     && (gt.Expression is IdentifierNameSyntax || gt.Expression is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax }))
                assembly = enclosing?.ContainingAssembly;
            if (assembly == null)
            {
                AddDynamic(facts, inv, new DynamicSite(ctx.Type, inv.GetLocation(), "ApplyConfigurationsFromAssembly(...) with an assembly that is not statically known"));
                return;
            }
            // Recorded after pass 1: configurations are all known now.
            foreach (var c in facts.Configurations.Where(c => c.Configuration.ContainingAssembly?.Identity.Name == assembly.Identity.Name))
                facts.Mappings.Add(new MappingFact(c.Entity, ctx.Type, MappingKind.AssemblyScan,
                    $"ApplyConfigurationsFromAssembly scan: {c.Configuration.Name}", location, Confidences.Likely, c.Configuration));
            return;
        }

        // Fluent configuration on EntityTypeBuilder<T> (in OnModelCreating or IEntityTypeConfiguration<T>.Configure).
        var receiver = inv.Expression is MemberAccessExpressionSyntax rma ? model.GetTypeInfo(rma.Expression, ct).Type as INamedTypeSymbol : null;
        if (receiver == null || !EntityTypeBuilder1.Matches(receiver) || receiver.TypeArguments[0] is not INamedTypeSymbol from) return;
        var where = enclosing != null ? $"{enclosing.Name}" : "configuration";
        if (name == "ToTable")
        {
            var args = inv.ArgumentList.Arguments;
            if (args.Count == 0) return;
            if (model.GetConstantValue(args[0].Expression, ct) is not { HasValue: true, Value: string table }) return;
            string? schema = args.Count > 1 && model.GetConstantValue(args[1].Expression, ct) is { HasValue: true, Value: string sc } ? sc : null;
            facts.Tables.Add(new TableFact(from, table, schema, $"ToTable in {where}", location, false));
            return;
        }
        if (method.TypeArguments.Length != 1 || method.TypeArguments[0] is not INamedTypeSymbol to2) return;
        var prop = LambdaMember(inv.ArgumentList.Arguments.FirstOrDefault()?.Expression);
        if (name is "OwnsOne" or "OwnsMany")
        {
            facts.Owned.Add(to2);
            facts.Navigations.Add(new NavigationFact(from, prop, to2, null, name, null, location, Confidences.Proven, true));
            return;
        }
        // HasOne/HasMany(...).WithOne/WithMany(...).HasForeignKey(...)
        string? inverse = null, with = null, fk = null;
        SyntaxNode cur = inv;
        while (cur.Parent is MemberAccessExpressionSyntax pma && pma.Parent is InvocationExpressionSyntax next)
        {
            var n = pma.Name.Identifier.ValueText;
            if (n is "WithOne" or "WithMany") { with = n; inverse = LambdaMember(next.ArgumentList.Arguments.FirstOrDefault()?.Expression); }
            else if (n == "HasForeignKey")
                fk = string.Join(", ", next.ArgumentList.Arguments.Select(a => LambdaMember(a.Expression)
                    ?? (model.GetConstantValue(a.Expression, ct) is { HasValue: true, Value: string s } ? s : null)).Where(s => s != null));
            cur = next;
        }
        facts.Navigations.Add(new NavigationFact(from, prop, to2, inverse, name + (with != null ? "/" + with : ""), string.IsNullOrEmpty(fk) ? null : fk,
            location, Confidences.Proven, false));
    }

    /// <summary>One dynamic site per statement of OnModelCreating (a loop over GetTypes() with Entity(type) is one site).</summary>
    private static void AddDynamic(Facts facts, SyntaxNode node, DynamicSite site)
    {
        SyntaxNode statement = node.AncestorsAndSelf().OfType<StatementSyntax>().FirstOrDefault(st => st.Parent is BlockSyntax { Parent: BaseMethodDeclarationSyntax }) ?? node;
        var span = statement.GetLocation();
        if (facts.Dynamic.Any(d => SymbolIdentity.SameDefinition(d.Context, site.Context) && d.Location.SourceTree == span.SourceTree
                && span.SourceSpan.Contains(d.Location.SourceSpan))) return;
        facts.Dynamic.Add(site);
    }

    private static bool InOnModelCreating(SyntaxNode node) =>
        node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText == "OnModelCreating";

    /// <summary>"o => o.Customer" → "Customer"; "o => new { o.A, o.B }" → "A, B".</summary>
    private static string? LambdaMember(ExpressionSyntax? e)
    {
        var body = e switch
        {
            SimpleLambdaExpressionSyntax s => s.Body,
            ParenthesizedLambdaExpressionSyntax p => p.Body,
            _ => null,
        };
        return body switch
        {
            MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
            AnonymousObjectCreationExpressionSyntax a => string.Join(", ", a.Initializers.Select(i => i.Expression is MemberAccessExpressionSyntax im ? im.Name.Identifier.ValueText : i.ToString())),
            _ => null,
        };
    }

    private static void AnalyzeDbSetAccess(Facts facts, SemanticModel model, IdentifierNameSyntax id, ProjectId projectId, CancellationToken ct)
    {
        if (model.GetSymbolInfo(id, ct).Symbol is not IPropertySymbol p) return;
        if (p.Type is not INamedTypeSymbol pt || !DbSet1.Matches(pt) || pt.TypeArguments[0] is not INamedTypeSymbol entity) return;
        if (id.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" })) return;
        AddQuery(facts, model, id, entity, p.Name, id.GetLocation(), projectId, ct);
    }

    private static void AddQuery(Facts facts, SemanticModel model, SyntaxNode node, INamedTypeSymbol entity, string form, Location location,
        ProjectId projectId, CancellationToken ct)
    {
        var container = SymbolIdentity.CompositionRoot(model, node, ct);
        // Top-level statements: every lambda (e.g. an endpoint handler) is its own group.
        var group = node.Ancestors().Any(a => a is GlobalStatementSyntax)
            ? node.Ancestors().OfType<LambdaExpressionSyntax>().LastOrDefault()?.SpanStart ?? 0
            : 0;
        facts.Queries.Add(new QueryFact(entity, form, container, location, node.SyntaxTree, node.Span, projectId, group));
    }

    // ------------------------------------------------------------------ annotations and conventions

    private static bool HasAttribute(ISymbol s, KnownType attr) => s.GetAttributes().Any(a => attr.Matches(a.AttributeClass));

    private static void AddAnnotations(Facts facts)
    {
        foreach (var entity in facts.Entities.ToList())
        {
            var attr = entity.GetAttributes().FirstOrDefault(a => TableAttribute.Matches(a.AttributeClass));
            if (attr?.ConstructorArguments.FirstOrDefault().Value is string name)
            {
                var schema = attr.NamedArguments.FirstOrDefault(n => n.Key == "Schema").Value.Value as string;
                var loc = attr.ApplicationSyntaxReference?.GetSyntax().GetLocation();
                facts.Tables.Add(new TableFact(entity, name, schema, "[Table] attribute", loc, false));
            }
        }
    }

    private static bool IsEntityCandidate(Facts facts, ITypeSymbol? t) =>
        t is INamedTypeSymbol { TypeKind: TypeKind.Class, IsAbstract: false } n && n.SpecialType == SpecialType.None
        && n.Locations.Any(l => l.IsInSource) && !HasAttribute(n, NotMappedAttribute)
        && !facts.Owned.Any(o => SymbolIdentity.SameDefinition(o, n)) && !facts.Contexts.Any(c => SymbolIdentity.SameDefinition(c.Type, n))
        && n.GetMembers().OfType<IPropertySymbol>().Any(p => p.Name == "Id" || p.Name == n.Name + "Id" || HasAttribute(p, KeyAttribute));

    private static INamedTypeSymbol? CollectionElement(ITypeSymbol t)
    {
        if (t.SpecialType == SpecialType.System_String || t is not INamedTypeSymbol n) return null;
        var ienum = (n.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T ? n : null)
            ?? n.AllInterfaces.FirstOrDefault(i => i.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T);
        return ienum?.TypeArguments[0] as INamedTypeSymbol;
    }

    /// <summary>
    /// Navigation properties by convention (a property whose type, or collection element type, is an entity candidate) and
    /// entity discovery through them, iterated to a fixed point. Both are likely: EF Core's own conventions decide.
    /// </summary>
    private static void AddConventions(Facts facts)
    {
        var queue = new Queue<INamedTypeSymbol>(facts.Entities);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (queue.Count > 0)
        {
            var entity = queue.Dequeue();
            if (!visited.Add(Key(entity))) continue;
            foreach (var p in entity.GetMembers().OfType<IPropertySymbol>())
            {
                if (p.IsStatic || p.IsIndexer || HasAttribute(p, NotMappedAttribute)) continue;
                var element = CollectionElement(p.Type);
                var target = element ?? p.Type as INamedTypeSymbol;
                if (!IsEntityCandidate(facts, target)) continue;
                var to = (INamedTypeSymbol)target!;
                if (facts.Navigations.Any(n => SymbolIdentity.SameDefinition(n.From, entity) && n.Property == p.Name
                        || SymbolIdentity.SameDefinition(n.To, entity) && n.Inverse == p.Name)) continue;
                var fkAttr = p.GetAttributes().FirstOrDefault(a => ForeignKeyAttribute.Matches(a.AttributeClass));
                var fk = fkAttr?.ConstructorArguments.FirstOrDefault().Value as string;
                facts.Navigations.Add(new NavigationFact(entity, p.Name, to, null, element != null ? "collection (convention)" : "reference (convention)",
                    fk, p.Locations.FirstOrDefault(l => l.IsInSource), fkAttr != null ? Confidences.Proven : Confidences.Likely, false));
                if (!facts.Entities.Any(e => SymbolIdentity.SameDefinition(e, to)))
                {
                    foreach (var ctx in facts.Mappings.Where(m => SymbolIdentity.SameDefinition(m.Entity, entity)).Select(m => m.Context)
                                 .GroupBy(Key).Select(g => g.First()).ToList())
                        facts.Mappings.Add(new MappingFact(to, ctx, MappingKind.Convention, $"convention: reachable from {entity.Name}.{p.Name}",
                            p.Locations.FirstOrDefault(l => l.IsInSource), Confidences.Likely));
                }
                queue.Enqueue(to);
            }
        }
    }

    /// <summary>Entities without ToTable/[Table]: the DbSet property name, else the CLR type name (EF Core convention).</summary>
    private static void AddConventionTables(Facts facts)
    {
        foreach (var entity in facts.Entities)
        {
            if (facts.TablesOf(entity).Any()) continue;
            var dbSet = facts.Mappings.FirstOrDefault(m => m.Kind == MappingKind.DbSet && SymbolIdentity.SameDefinition(m.Entity, entity));
            var name = dbSet != null ? dbSet.How[(dbSet.How.LastIndexOf(' ') + 1)..] : entity.Name;
            facts.Tables.Add(new TableFact(entity, name, null, dbSet != null ? $"convention: {dbSet.How}" : "convention: type name",
                dbSet?.Location ?? entity.Locations.FirstOrDefault(l => l.IsInSource), true));
        }
    }

    private static IEnumerable<INamedTypeSymbol> AllSourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol child)
                foreach (var t in AllSourceTypes(child)) yield return t;
            else if (member is INamedTypeSymbol type)
                foreach (var t in WithNested(type)) yield return t;
        }
    }

    private static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
    {
        if (type.Locations.Any(l => l.IsInSource)) yield return type;
        foreach (var nested in type.GetTypeMembers())
            foreach (var t in WithNested(nested)) yield return t;
    }

    // ------------------------------------------------------------------ relations

    private static string Strongest(IEnumerable<string> confidences)
    {
        var list = confidences.ToList();
        return list.Contains(Confidences.Proven) ? Confidences.Proven : list.Contains(Confidences.Likely) ? Confidences.Likely : Confidences.Heuristic;
    }

    private static Location? SourceLocation(ISymbol s) => s.Locations.FirstOrDefault(l => l.IsInSource);

    private static string Line(Location? l) =>
        l?.SourceTree == null ? "" : $"{Path.GetFileName(l.SourceTree.FilePath)}:{l.GetLineSpan().StartLinePosition.Line + 1}";

    public IReadOnlyList<FrameworkRelation> Relate(object factsObj, ISymbol subject, FrameworkContext context)
    {
        var facts = (Facts)factsObj;
        var result = new List<FrameworkRelation>();
        if (facts.AssemblyEvidence.Count == 0) return result;
        var evidence = new EvidenceItem("EF Core identity: " + string.Join("; ", facts.AssemblyEvidence));

        if (subject is IPropertySymbol prop) { RelateProperty(facts, prop, evidence, result); return result; }
        var type = subject switch
        {
            INamedTypeSymbol t => t,
            IMethodSymbol { MethodKind: MethodKind.Constructor } c => c.ContainingType,
            IMethodSymbol { Name: "OnModelCreating" or "Configure" } m => m.ContainingType,
            _ => null,
        };
        if (type == null) return result;

        if (facts.Contexts.Any(c => SymbolIdentity.SameDefinition(c.Type, type))) RelateContext(facts, type, evidence, result);
        var isEntity = facts.Entities.Any(e => SymbolIdentity.SameDefinition(e, type));
        if (isEntity) RelateEntity(facts, type, evidence, result);
        else if (facts.Owned.Any(o => SymbolIdentity.SameDefinition(o, type))) RelateNavigations(facts, type, evidence, result);
        foreach (var c in facts.Configurations.Where(c => SymbolIdentity.SameDefinition(c.Configuration, type)))
            RelateConfiguration(facts, c, evidence, result);
        return result;
    }

    private FrameworkRelation Rel(string kind, string group, RelationTarget target, IEnumerable<EvidenceItem> evidence, string confidence,
        IEnumerable<string>? limitations = null) =>
        new(kind, group, target, evidence.ToList(), confidence, (limitations ?? Array.Empty<string>()).ToList(), ProviderRouteId);

    private void RelateContext(Facts facts, INamedTypeSymbol ctx, EvidenceItem evidence, List<FrameworkRelation> result)
    {
        var dynamic = facts.Dynamic.Where(d => SymbolIdentity.SameDefinition(d.Context, ctx)).ToList();
        var dynamicLimit = dynamic.Count > 0
            ? new[] { $"{ctx.Name} also builds part of its model dynamically ({dynamic.Count} site(s)); entity types added there are unknown." }
            : Array.Empty<string>();
        var mappings = facts.Mappings.Where(m => SymbolIdentity.SameDefinition(m.Context, ctx)).ToList();
        foreach (var g in mappings.GroupBy(m => Key(m.Entity), StringComparer.Ordinal))
        {
            var entity = g.First().Entity;
            var confidence = Strongest(g.Select(m => m.Confidence));
            var limits = new List<string>(dynamicLimit);
            if (g.All(m => m.Kind == MappingKind.AssemblyScan)) limits.Add("Found by scanning the assembly passed to ApplyConfigurationsFromAssembly: configurations are matched statically; EF Core's own filtering (e.g. constructors, accessibility) is not reproduced.");
            if (g.All(m => m.Kind == MappingKind.Convention)) limits.Add("Discovered by convention through a navigation property; EF Core's conventions at runtime decide.");
            result.Add(Rel(RelationKinds.EfCoreEntity, RelationGroups.Data,
                new RelationTarget($"{entity.Name} ({string.Join("; ", g.Select(m => m.How).Distinct())})", Symbol: entity),
                g.Select(m => new EvidenceItem(m.How, m.Location)).Append(evidence), confidence, limits));
        }
        foreach (var m in mappings.Where(m => m.Configuration != null).GroupBy(m => Key(m.Configuration!), StringComparer.Ordinal).Select(g => g.First()))
        {
            result.Add(Rel(RelationKinds.EfCoreConfiguration, RelationGroups.Data,
                new RelationTarget($"{m.Configuration!.Name} (IEntityTypeConfiguration<{m.Entity.Name}>)", Symbol: m.Configuration),
                new[] { new EvidenceItem(m.How, m.Location), evidence }, m.Confidence));
        }
        foreach (var d in dynamic)
        {
            result.Add(Rel(RelationKinds.EfCoreEntity, RelationGroups.Data,
                new RelationTarget($"Unknown entity types: {d.Description} ({Line(d.Location)})", Location: d.Location),
                new[] { new EvidenceItem(d.Description, d.Location) }, Confidences.Heuristic,
                new[] { "Dynamic model building (loop or reflection) is not resolved: the entity types added here are unknown. " + NoRuntime }));
        }
        foreach (var mig in facts.Migrations.Where(m => m.Context != null && SymbolIdentity.SameDefinition(m.Context, ctx)))
        {
            result.Add(Rel(RelationKinds.EfCoreMigration, RelationGroups.Data,
                new RelationTarget($"{mig.Type.Name} ({(mig.IsSnapshot ? "model snapshot" : "migration")}, read-only)", Symbol: mig.Type),
                new[] { new EvidenceItem($"[DbContext(typeof({ctx.Name}))] on {mig.Type.Name}", SourceLocation(mig.Type)), evidence },
                Confidences.Proven, new[] { ReadOnlyNote }));
        }
    }

    private void RelateEntity(Facts facts, INamedTypeSymbol entity, EvidenceItem evidence, List<FrameworkRelation> result)
    {
        var mappings = facts.Mappings.Where(m => SymbolIdentity.SameDefinition(m.Entity, entity)).ToList();
        foreach (var g in mappings.GroupBy(m => Key(m.Context), StringComparer.Ordinal))
        {
            var ctx = g.First().Context;
            result.Add(Rel(RelationKinds.EfCoreDbContext, RelationGroups.Data,
                new RelationTarget($"{ctx.Name} ({string.Join("; ", g.Select(m => m.How).Distinct())})", Symbol: ctx),
                g.Select(m => new EvidenceItem(m.How, m.Location)).Append(evidence), Strongest(g.Select(m => m.Confidence))));
        }
        foreach (var c in facts.Configurations.Where(c => SymbolIdentity.SameDefinition(c.Entity, entity)))
        {
            var applied = mappings.Any(m => m.Configuration != null && SymbolIdentity.SameDefinition(m.Configuration, c.Configuration));
            result.Add(Rel(RelationKinds.EfCoreConfiguration, RelationGroups.Data,
                new RelationTarget($"{c.Configuration.Name} (IEntityTypeConfiguration<{entity.Name}>)", Symbol: c.Configuration),
                new[] { new EvidenceItem($"{c.Configuration.Name} implements IEntityTypeConfiguration<{entity.Name}>", SourceLocation(c.Configuration)), evidence },
                Confidences.Proven, applied ? null : new[] { "No ApplyConfiguration/ApplyConfigurationsFromAssembly for this configuration was found." }));
        }
        foreach (var m in mappings.Where(m => m.Kind == MappingKind.EntityCall))
        {
            result.Add(Rel(RelationKinds.EfCoreConfiguration, RelationGroups.Data, new RelationTarget(m.How, Location: m.Location),
                new[] { new EvidenceItem(m.How, m.Location), evidence }, m.Confidence));
        }
        foreach (var t in facts.TablesOf(entity).GroupBy(t => t.Qualified, StringComparer.Ordinal).Select(g => g.First()))
        {
            result.Add(Rel(RelationKinds.EfCoreTable, RelationGroups.Data,
                new RelationTarget(t.Convention ? $"{t.Qualified} (convention)" : t.Qualified, Location: t.Location),
                new[] { new EvidenceItem(t.Source, t.Location), evidence },
                t.Convention ? Confidences.Likely : Confidences.Proven,
                t.Convention ? new[] { "Convention name (no ToTable or [Table] found); naming conventions or providers may change it." } : null));
        }
        RelateNavigations(facts, entity, evidence, result);

        foreach (var g in facts.Queries.Where(q => SymbolIdentity.SameDefinition(q.Entity, entity))
                     .GroupBy(q => (q.Container, q.Tree.FilePath, q.GroupKey)))
        {
            var first = g.OrderBy(q => q.Span.Start).First();
            var forms = string.Join(", ", g.Select(q => q.Form).Distinct());
            result.Add(Rel(RelationKinds.EfCoreQuery, RelationGroups.Callers,
                new RelationTarget($"{forms} in {first.Container} ({Line(first.Location)})", Location: first.Location),
                g.Select(q => new EvidenceItem($"{q.Form} ({entity.Name})", q.Location)), Confidences.Proven,
                new[] { "Query sites are uses of DbSet<T> / Set<T>() in source; the SQL is not derived. " + NoRuntime }));
        }

        var tableNames = facts.TablesOf(entity).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var fullName = SymbolIdentity.FullMetadataName(entity);
        foreach (var mig in facts.Migrations)
        {
            var hits = mig.Tables.Where(t => tableNames.Contains(t.Text.Split('\u0001')[0])).ToList();
            var entityHits = mig.Entities.Where(e => e.Name == fullName).ToList();
            if (hits.Count == 0 && entityHits.Count == 0) continue;
            var ops = hits.Select(h => $"{h.Text.Split('\u0001')[1]} {h.Text.Split('\u0001')[0]}").Concat(entityHits.Select(e => $"Entity(\"{e.Name}\")")).Distinct();
            var first = hits.Select(h => h.Location).Concat(entityHits.Select(e => e.Location)).First();
            result.Add(Rel(RelationKinds.EfCoreMigration, RelationGroups.Data,
                new RelationTarget($"{mig.Type.Name}: {string.Join(", ", ops)} ({(mig.IsSnapshot ? "model snapshot" : "migration")}, read-only)", Location: first),
                hits.Select(h => new EvidenceItem(h.Text.Replace('\u0001', ' '), h.Location)).Concat(entityHits.Select(e => new EvidenceItem($"Entity(\"{e.Name}\")", e.Location))),
                Confidences.Likely, new[] { "Matched by table or entity name text in generated code. " + ReadOnlyNote }));
        }
    }

    private void RelateNavigations(Facts facts, INamedTypeSymbol type, EvidenceItem evidence, List<FrameworkRelation> result)
    {
        foreach (var n in facts.Navigations.Where(n => SymbolIdentity.SameDefinition(n.From, type)))
        {
            var label = n.Owned
                ? $"{n.Property ?? "?"} → {n.To.Name} (owned, {n.Shape})"
                : $"{n.Property ?? "(no navigation)"} → {n.To.Name} ({n.Shape}{(n.Inverse != null ? ", inverse " + n.Inverse : "")}{(n.ForeignKey != null ? ", FK " + n.ForeignKey : "")})";
            result.Add(Rel(RelationKinds.EfCoreNavigation, RelationGroups.Data, new RelationTarget(label, Symbol: n.To, Location: n.Location),
                new[] { new EvidenceItem(n.Shape, n.Location), evidence }, n.Confidence,
                n.Confidence == Confidences.Likely ? new[] { "Relationship by convention; EF Core's conventions at runtime decide." } : null));
        }
        foreach (var n in facts.Navigations.Where(n => SymbolIdentity.SameDefinition(n.To, type) && !SymbolIdentity.SameDefinition(n.From, type)))
        {
            var label = n.Owned
                ? $"owned by {n.From.Name} ({n.From.Name}.{n.Property ?? "?"}, {n.Shape})"
                : $"{n.Inverse ?? "(no navigation)"} → {n.From.Name} (inverse of {n.From.Name}.{n.Property ?? "?"}, {n.Shape}{(n.ForeignKey != null ? ", FK " + n.ForeignKey : "")})";
            result.Add(Rel(RelationKinds.EfCoreNavigation, RelationGroups.Data, new RelationTarget(label, Symbol: n.From, Location: n.Location),
                new[] { new EvidenceItem(n.Shape, n.Location), evidence }, n.Confidence,
                n.Confidence == Confidences.Likely ? new[] { "Relationship by convention; EF Core's conventions at runtime decide." } : null));
        }
    }

    private void RelateConfiguration(Facts facts, ConfigurationFact c, EvidenceItem evidence, List<FrameworkRelation> result)
    {
        result.Add(Rel(RelationKinds.EfCoreEntity, RelationGroups.Data, new RelationTarget($"{c.Entity.Name} (configured entity)", Symbol: c.Entity),
            new[] { new EvidenceItem($"{c.Configuration.Name} implements IEntityTypeConfiguration<{c.Entity.Name}>", SourceLocation(c.Configuration)), evidence },
            Confidences.Proven));
        foreach (var g in facts.Mappings.Where(m => m.Configuration != null && SymbolIdentity.SameDefinition(m.Configuration, c.Configuration))
                     .GroupBy(m => Key(m.Context), StringComparer.Ordinal))
        {
            var m = g.First();
            result.Add(Rel(RelationKinds.EfCoreDbContext, RelationGroups.Data, new RelationTarget($"{m.Context.Name} ({m.How})", Symbol: m.Context),
                new[] { new EvidenceItem(m.How, m.Location), evidence }, Strongest(g.Select(x => x.Confidence))));
        }
    }

    private void RelateProperty(Facts facts, IPropertySymbol prop, EvidenceItem evidence, List<FrameworkRelation> result)
    {
        if (prop.Type is INamedTypeSymbol pt && DbSet1.Matches(pt) && pt.TypeArguments[0] is INamedTypeSymbol entity
            && facts.Contexts.Any(c => SymbolIdentity.SameDefinition(c.Type, prop.ContainingType)))
        {
            result.Add(Rel(RelationKinds.EfCoreEntity, RelationGroups.Data, new RelationTarget($"{entity.Name} (DbSet<{entity.Name}> {prop.Name})", Symbol: entity),
                new[] { new EvidenceItem($"DbSet<{entity.Name}> {prop.Name}", SourceLocation(prop)), evidence }, Confidences.Proven));
            foreach (var t in facts.TablesOf(entity).GroupBy(t => t.Qualified).Select(g => g.First()))
                result.Add(Rel(RelationKinds.EfCoreTable, RelationGroups.Data, new RelationTarget(t.Convention ? $"{t.Qualified} (convention)" : t.Qualified, Location: t.Location),
                    new[] { new EvidenceItem(t.Source, t.Location), evidence }, t.Convention ? Confidences.Likely : Confidences.Proven));
            return;
        }
        foreach (var n in facts.Navigations.Where(n => n.Property == prop.Name && SymbolIdentity.SameDefinition(n.From, prop.ContainingType)
                                                    || n.Inverse == prop.Name && SymbolIdentity.SameDefinition(n.To, prop.ContainingType)))
        {
            var other = n.Property == prop.Name && SymbolIdentity.SameDefinition(n.From, prop.ContainingType) ? n.To : n.From;
            result.Add(Rel(RelationKinds.EfCoreNavigation, RelationGroups.Data, new RelationTarget($"{prop.Name} → {other.Name} ({n.Shape})", Symbol: other, Location: n.Location),
                new[] { new EvidenceItem(n.Shape, n.Location), evidence }, n.Confidence));
        }
    }

    // ------------------------------------------------------------------ search support

    /// <summary>Mapped entities (owned types excluded) with their table names, for the "entity:" and "table:" Find filters.</summary>
    public static IEnumerable<(INamedTypeSymbol Entity, IReadOnlyList<string> Tables)> EntitiesWithTables(object factsObj)
    {
        var facts = (Facts)factsObj;
        foreach (var e in facts.Entities)
            yield return (e, facts.TablesOf(e).SelectMany(t => t.Schema != null ? new[] { t.Name, t.Qualified } : new[] { t.Name }).Distinct().ToList());
    }
}
