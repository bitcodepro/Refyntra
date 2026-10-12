using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>A member the user can pick for a Generate kind (a field, property or a member of a base / delegated type).</summary>
/// <param name="Id">Stable id within the request (a member name, a documentation comment id, or "field|id" for delegating).</param>
/// <param name="Group">Delegating members: the field or property they are delegated through.</param>
public sealed record GenerateMember(string Id, string Name, string Detail, bool Picked, string? Group);

/// <summary>One Generate kind that applies to the type at the cursor.</summary>
public sealed record GenerateKind(string Kind, string Title, IReadOnlyList<GenerateMember> Members);

/// <summary>What to generate: the picked member ids and the options of Equals/GetHashCode.</summary>
public sealed record GenerateOptions(IReadOnlyList<string>? Members, bool Equatable, bool Operators);

/// <summary>
/// Rider's Generate (Alt+Insert) for C#, computed by Roslyn: constructor, Equals/GetHashCode (IEquatable&lt;T&gt;, == and
/// != operators, HashCode.Combine), ToString, properties from fields, missing interface / abstract members, overrides
/// and delegating members. Members of every part of a partial type are offered; the code goes into the part at the
/// cursor. Types are written fully qualified, then the needed usings are added and the names simplified, the new
/// members are formatted with the document's options (.editorconfig), and the result is refused when it would add a
/// compiler error. Never writes files: the client applies the edits as one undo step.
/// </summary>
public static class GeneratePlanner
{
    public const string Constructor = "constructor";
    public const string Equality = "equality";
    public const string ToStringKind = "toString";
    public const string Properties = "properties";
    public const string Implement = "implement";
    public const string Overrides = "overrides";
    public const string Delegating = "delegating";

    public static readonly string[] Kinds = { Constructor, Equality, ToStringKind, Properties, Implement, Overrides, Delegating };

    private const int MaxDelegated = 300;

    private static readonly SymbolDisplayFormat Full = SymbolDisplayFormat.FullyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat Short = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SyntaxAnnotation Imports = new("refyntra.generate.imports");

    private sealed class Refusal : Exception
    {
        public string Reason { get; }
        public Refusal(string reason, string message) : base(message) => Reason = reason;
    }

    private sealed record Ctx(Document Doc, SyntaxNode Root, SemanticModel Model, SourceText Text, TypeDeclarationSyntax Decl, INamedTypeSymbol Type, int Position, CancellationToken Ct)
    {
        public bool Nullable => (Model.GetNullableContext(Position) & NullableContext.AnnotationsEnabled) != 0;
        public string Q => Nullable ? "?" : "";
    }

    private static async Task<Ctx?> ContextAsync(Snapshot snapshot, string path, LinePosition position, CancellationToken ct)
    {
        var doc = snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);
        if (doc == null) return null;
        var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return null;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return null;
        var line = text.Lines[position.Line];
        var pos = Math.Min(line.Start + position.Character, line.End);
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var decl = root!.FindToken(Math.Min(pos, Math.Max(0, root.FullSpan.End - 1))).Parent?.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().FirstOrDefault();
        if (decl == null || decl is InterfaceDeclarationSyntax) return null;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model!.GetDeclaredSymbol(decl, ct) is not INamedTypeSymbol type || type.IsStatic) return null;
        return new Ctx(doc, root, model!, text, decl, type, decl.OpenBraceToken.IsMissing || decl.OpenBraceToken.RawKind == 0 ? decl.SpanStart : decl.OpenBraceToken.Span.End, ct);
    }

    // ------------------------------------------------------------------ listing

    /// <summary>The Generate kinds that apply to the type at the position, with their candidate members.</summary>
    public static async Task<(string? TypeName, IReadOnlyList<GenerateKind> Kinds)> ListAsync(Snapshot snapshot, string path, LinePosition position, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, position, ct).ConfigureAwait(false);
        if (c == null) return (null, Array.Empty<GenerateKind>());
        var list = new List<GenerateKind>();
        foreach (var kind in Kinds)
        {
            ct.ThrowIfCancellationRequested();
            var k = Describe(c, kind);
            if (k != null) list.Add(k);
        }
        return (c.Type.ToMinimalDisplayString(c.Model, c.Position), list);
    }

    private static bool IsRecord(Ctx c) => c.Type.IsRecord;

    private static GenerateKind? Describe(Ctx c, string kind)
    {
        string Detail(ISymbol m) => (m switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null })?.ToMinimalDisplayString(c.Model, c.Position, Short) + (m is IFieldSymbol ? " · field" : " · property");
        switch (kind)
        {
            case Constructor:
                if (c.Decl.ParameterList != null) return null; // a primary constructor: other constructors must call it
                return new GenerateKind(kind, "Constructor", Ordered(c, Assignable(c)).Select(m => new GenerateMember(m.Name, m.Name, Detail(m), IsUninitializedReadOnly(m), null)).ToList());
            case Equality:
                if (IsRecord(c)) return null; // records have value equality
                var data = Ordered(c, DataMembers(c)).ToList();
                return data.Count == 0 ? null : new GenerateKind(kind, "Equality members (Equals / GetHashCode)", data.Select(m => new GenerateMember(m.Name, m.Name, Detail(m), true, null)).ToList());
            case ToStringKind:
                var shown = Ordered(c, Readable(c)).ToList();
                return shown.Count == 0 ? null : new GenerateKind(kind, "Formatting members (ToString)", shown.Select(m => new GenerateMember(m.Name, m.Name, Detail(m), true, null)).ToList());
            case Properties:
                var fields = Ordered(c, FieldsWithoutProperty(c)).ToList();
                return fields.Count == 0 ? null : new GenerateKind(kind, "Properties from fields", fields.Select(f => new GenerateMember(f.Name, PropertyName(f.Name), Detail(f), true, null)).ToList());
            case Implement:
                var missing = Missing(c).ToList();
                return missing.Count == 0 ? null : new GenerateKind(kind, "Missing members (implement interfaces / abstract members)", missing.Select(m => new GenerateMember(Id(m), Label(c, m), Origin(c, m), true, null)).ToList());
            case Overrides:
                var ov = Overridable(c).ToList();
                return ov.Count == 0 ? null : new GenerateKind(kind, "Overriding members", ov.Select(m => new GenerateMember(Id(m), Label(c, m), Origin(c, m), false, null)).ToList());
            case Delegating:
                var del = new List<GenerateMember>();
                foreach (var (via, viaType) in DelegationSources(c))
                    foreach (var m in Delegatable(c, viaType).Take(MaxDelegated))
                        del.Add(new GenerateMember(via.Name + "|" + Id(m), Label(c, m), Origin(c, m), false, via.Name));
                return del.Count == 0 ? null : new GenerateKind(kind, "Delegating members", del);
        }
        return null;
    }

    private static string Id(ISymbol m) => m.GetDocumentationCommentId() ?? m.ToDisplayString();

    private static string Label(Ctx c, ISymbol m) => m.ToMinimalDisplayString(c.Model, c.Position, new SymbolDisplayFormat(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeParamsRefOut,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier));

    private static string Origin(Ctx c, ISymbol m) => m.ContainingType.ToMinimalDisplayString(c.Model, c.Position, Short);

    // ------------------------------------------------------------------ member queries

    private static bool IsAutoProperty(IPropertySymbol p) =>
        p.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<PropertyDeclarationSyntax>().Any(d =>
            d.AccessorList != null && d.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null));

    private static bool HasInitializer(ISymbol m) => m.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).Any(s =>
        s is VariableDeclaratorSyntax { Initializer: not null } || s is PropertyDeclarationSyntax { Initializer: not null });

    /// <summary>Instance fields and auto-properties declared in source (all parts), in declaration order.</summary>
    private static IEnumerable<ISymbol> DataMembers(Ctx c) =>
        c.Type.GetMembers().Where(m => !m.IsStatic && !m.IsImplicitlyDeclared && m.CanBeReferencedByName && m.Locations.Any(l => l.IsInSource)
            && (m is IFieldSymbol { IsConst: false, AssociatedSymbol: null } || m is IPropertySymbol { IsIndexer: false } p && IsAutoProperty(p)));

    private static IEnumerable<ISymbol> Assignable(Ctx c) =>
        DataMembers(c).Where(m => m is IFieldSymbol || m is IPropertySymbol p && (p.SetMethod != null || p.IsReadOnly));

    private static bool IsUninitializedReadOnly(ISymbol m) =>
        !HasInitializer(m) && (m is IFieldSymbol { IsReadOnly: true } || m is IPropertySymbol { IsReadOnly: true });

    private static IEnumerable<ISymbol> Readable(Ctx c) =>
        c.Type.GetMembers().Where(m => !m.IsStatic && !m.IsImplicitlyDeclared && m.CanBeReferencedByName && m.Locations.Any(l => l.IsInSource) && m.Name != "EqualityContract"
            && (m is IFieldSymbol { IsConst: false, AssociatedSymbol: null } || m is IPropertySymbol { IsIndexer: false, GetMethod: not null, IsWriteOnly: false }));

    private static string PropertyName(string field)
    {
        var n = field.StartsWith("m_", StringComparison.Ordinal) ? field[2..] : field.TrimStart('_');
        return n.Length == 0 ? field : char.ToUpperInvariant(n[0]) + n[1..];
    }

    private static IEnumerable<IFieldSymbol> FieldsWithoutProperty(Ctx c) =>
        c.Type.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsImplicitlyDeclared && !f.IsConst && f.AssociatedSymbol == null && f.CanBeReferencedByName && f.Locations.Any(l => l.IsInSource)
            && PropertyName(f.Name) is var pn && pn != f.Name && SyntaxFacts.IsValidIdentifier(pn) && c.Type.GetMembers(pn).IsEmpty);

    private static bool Supported(ISymbol m) => m switch
    {
        IMethodSymbol x => x.MethodKind == MethodKind.Ordinary && !x.ReturnsByRef && !x.ReturnsByRefReadonly && !x.IsStatic,
        IPropertySymbol p => !p.ReturnsByRef && !p.ReturnsByRefReadonly && !p.IsStatic,
        IEventSymbol e => !e.IsStatic,
        _ => false,
    };

    /// <summary>Interface members without an implementation, and abstract members of the base types (non-abstract types).</summary>
    private static IEnumerable<ISymbol> Missing(Ctx c)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var i in c.Type.AllInterfaces)
            foreach (var m in i.GetMembers())
                if (m.IsAbstract && Supported(m) && c.Type.FindImplementationForInterfaceMember(m) == null && seen.Add(Id(m))) yield return m;
        if (c.Type.IsAbstract) yield break;
        var overridden = OverriddenInChain(c.Type);
        for (var b = c.Type.BaseType; b != null; b = b.BaseType)
            foreach (var m in b.GetMembers())
                if (m.IsAbstract && Supported(m) && !overridden.Contains(m.OriginalDefinition) && seen.Add(Id(m))) yield return m;
    }

    private static HashSet<ISymbol> OverriddenInChain(INamedTypeSymbol t)
    {
        var set = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        for (INamedTypeSymbol? x = t; x != null; x = x.BaseType)
            foreach (var m in x.GetMembers())
                for (var o = Overridden(m); o != null; o = Overridden(o)) set.Add(o.OriginalDefinition);
        return set;
    }

    private static ISymbol? Overridden(ISymbol m) => m switch
    {
        IMethodSymbol x => x.OverriddenMethod,
        IPropertySymbol p => p.OverriddenProperty,
        IEventSymbol e => e.OverriddenEvent,
        _ => null,
    };

    /// <summary>Virtual, abstract and override members of the base types that the type does not override yet (most derived only).</summary>
    private static IEnumerable<ISymbol> Overridable(Ctx c)
    {
        var overriddenByType = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var m in c.Type.GetMembers())
            for (var o = Overridden(m); o != null; o = Overridden(o)) overriddenByType.Add(o.OriginalDefinition);
        var hiddenByDerivedBase = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var b = c.Type.BaseType; b != null; b = b.BaseType)
        {
            foreach (var m in b.GetMembers())
            {
                if (!Supported(m) || m.IsImplicitlyDeclared) continue;
                if (!(m.IsVirtual || m.IsAbstract || m.IsOverride) || m.IsSealed) continue;
                if (overriddenByType.Contains(m.OriginalDefinition) || hiddenByDerivedBase.Contains(m.OriginalDefinition)) continue;
                if (!c.Model.IsAccessible(c.Position, m)) continue;
                if (c.Type.IsRecord && m.Name is "Equals" or "GetHashCode" or "PrintMembers" or "EqualityContract") continue;
                var key = m.Name + "/" + Label(c, m);
                if (seen.Add(key)) yield return m;
            }
            foreach (var m in b.GetMembers())
                for (var o = Overridden(m); o != null; o = Overridden(o)) hiddenByDerivedBase.Add(o.OriginalDefinition);
        }
    }

    /// <summary>Instance fields and properties whose type has members to delegate to.</summary>
    private static IEnumerable<(ISymbol Via, ITypeSymbol Type)> DelegationSources(Ctx c)
    {
        foreach (var m in c.Type.GetMembers())
        {
            if (m.IsStatic || m.IsImplicitlyDeclared || !m.CanBeReferencedByName || !m.Locations.Any(l => l.IsInSource)) continue;
            var t = m switch { IFieldSymbol { AssociatedSymbol: null, IsConst: false } f => f.Type, IPropertySymbol { IsIndexer: false, GetMethod: not null } p => p.Type, _ => null };
            if (t is INamedTypeSymbol { SpecialType: SpecialType.None, TypeKind: TypeKind.Class or TypeKind.Interface or TypeKind.Struct } && !SymbolEqualityComparer.Default.Equals(t, c.Type))
                yield return (m, t);
        }
    }

    private static IEnumerable<ISymbol> Delegatable(Ctx c, ITypeSymbol viaType)
    {
        var all = new List<ISymbol>();
        for (var x = viaType; x != null && x.SpecialType != SpecialType.System_Object && x.SpecialType != SpecialType.System_ValueType; x = x.BaseType) all.AddRange(x.GetMembers());
        if (viaType.TypeKind == TypeKind.Interface) foreach (var i in viaType.AllInterfaces) all.AddRange(i.GetMembers());
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var m in all)
        {
            if (!Supported(m) || m is IEventSymbol || m.DeclaredAccessibility != Accessibility.Public || m.IsImplicitlyDeclared) continue;
            if (m is IPropertySymbol { IsIndexer: true }) continue;
            if (!c.Type.GetMembers(m.Name).IsEmpty) continue; // already declared here (any overload)
            if (seen.Add(Label(c, m))) yield return m;
        }
    }

    // ------------------------------------------------------------------ compute

    /// <summary>Generates <paramref name="kind"/> with the options: the minimal edits of the document, compile-checked; or a refusal.</summary>
    public static async Task<EditActionOutcome> ComputeAsync(Snapshot snapshot, string path, LinePosition position, string kind, GenerateOptions options, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, position, ct).ConfigureAwait(false);
        if (c == null) return EditActionOutcome.Refused("NoType", "Place the cursor inside a class, struct or record of the loaded solution.");
        if (RenamePlanner.IsReadOnly(path)) return EditActionOutcome.Refused("ReadOnlyFile", "The file is read-only.");
        try
        {
            var info = Describe(c, kind) ?? throw new Refusal("NotApplicable", $"'{kind}' does not apply to '{c.Type.Name}'.");
            var picked = options.Members ?? info.Members.Where(m => m.Picked).Select(m => m.Id).ToList();
            var unknown = picked.Where(id => info.Members.All(m => m.Id != id)).ToList();
            if (unknown.Count > 0) throw new Refusal("UnknownMember", "These members are not available: " + string.Join(", ", unknown.Take(3)));
            (MemberDeclarationSyntax[] members, string? baseType, bool afterData) = kind switch
            {
                Constructor => (new[] { BuildConstructor(c, picked) }, null, true),
                Equality => BuildEquality(c, picked, options),
                ToStringKind => (new[] { BuildToString(c, picked) }, null, false),
                Properties => (BuildProperties(c, picked), null, true),
                Implement => (Pick(c, Missing(c), picked).Select(m => BuildMember(c, m, m.ContainingType.TypeKind == TypeKind.Interface ? MemberStyle.Implement : MemberStyle.Override, null)).ToArray(), null, false),
                Overrides => (Pick(c, Overridable(c), picked).Select(m => BuildMember(c, m, MemberStyle.Override, null)).ToArray(), null, false),
                Delegating => (BuildDelegating(c, picked), null, false),
                _ => throw new Refusal("NotApplicable", "Unknown Generate kind."),
            };
            if (members.Length == 0) throw new Refusal("NoMembers", "Nothing to generate: pick at least one member.");
            var changed = await InsertAsync(c, members, baseType, afterData).ConfigureAwait(false);
            var newText = await changed.GetTextAsync(ct).ConfigureAwait(false);
            if (newText.ContentEquals(c.Text)) throw new Refusal("NoChanges", "Nothing to generate.");
            await CompileCheckAsync(c, changed, ct).ConfigureAwait(false);
            var edits = newText.GetTextChanges(c.Text).OrderBy(x => x.Span.Start).Select(x => (c.Text.Lines.GetLinePositionSpan(x.Span), x.NewText ?? "")).ToList();
            return new EditActionOutcome(edits, Hashing.Sha256Text(c.Text.ToString()), null, null);
        }
        catch (Refusal r)
        {
            return EditActionOutcome.Refused(r.Reason, r.Message);
        }
    }

    private static IEnumerable<ISymbol> Pick(Ctx c, IEnumerable<ISymbol> candidates, IReadOnlyList<string> ids)
    {
        var set = new HashSet<string>(ids, StringComparer.Ordinal);
        return candidates.Where(m => set.Contains(Id(m)));
    }

    private static async Task CompileCheckAsync(Ctx c, Document changed, CancellationToken ct)
    {
        static Dictionary<string, int> Keys(IEnumerable<Diagnostic> ds)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var x in ds.Where(x => x.Severity == DiagnosticSeverity.Error))
            {
                var k = x.Id + ": " + x.GetMessage();
                d[k] = d.TryGetValue(k, out var n) ? n + 1 : 1;
            }
            return d;
        }
        var before = Keys(c.Model.GetDiagnostics(cancellationToken: ct));
        var model = await changed.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var after = Keys(model!.GetDiagnostics(cancellationToken: ct));
        var added = after.Where(kv => kv.Value > (before.TryGetValue(kv.Key, out var n) ? n : 0)).Select(kv => kv.Key).ToList();
        if (added.Count > 0) throw new Refusal("CompilationErrors", "The generated code would introduce compiler errors: " + string.Join("; ", added.Take(3)));
    }

    /// <summary>Inserts the members (after the fields / constructors for data-related kinds, else at the end), adds usings, simplifies, formats.</summary>
    private static async Task<Document> InsertAsync(Ctx c, MemberDeclarationSyntax[] members, string? baseType, bool afterData)
    {
        var decl = c.Decl;
        if (decl.OpenBraceToken.IsMissing || decl.OpenBraceToken.RawKind == 0)
        {
            // record R(int A); gets a body: the line break moves from the semicolon to the closing brace.
            var newLine = SyntaxFactory.EndOfLine(c.Text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");
            var semicolon = decl.SemicolonToken;
            var lastBefore = semicolon.GetPreviousToken();
            decl = decl.ReplaceToken(lastBefore, lastBefore.WithTrailingTrivia(newLine));
            decl = decl.WithSemicolonToken(default)
                .WithOpenBraceToken(SyntaxFactory.Token(SyntaxKind.OpenBraceToken).WithTrailingTrivia(newLine))
                .WithCloseBraceToken(SyntaxFactory.Token(SyntaxKind.CloseBraceToken).WithTrailingTrivia(semicolon.TrailingTrivia));
        }
        var index = decl.Members.Count;
        if (afterData)
        {
            var last = -1;
            for (var i = 0; i < decl.Members.Count; i++)
                if (decl.Members[i] is BaseFieldDeclarationSyntax or ConstructorDeclarationSyntax or PropertyDeclarationSyntax) last = i;
            index = last + 1;
        }
        // A blank line before each new member that follows another member (the formatter keeps blank lines, it does not add them).
        var eol = SyntaxFactory.EndOfLine(c.Text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");
        var annotated = members.Select((m, i) => (i > 0 || index > 0 ? m.WithLeadingTrivia(m.GetLeadingTrivia().Insert(0, eol)) : m)
            .WithAdditionalAnnotations(Formatter.Annotation, Simplifier.Annotation, Imports)).ToArray();
        if (index < decl.Members.Count)
        {
            // The member after the inserted ones keeps a blank line before it.
            var next = decl.Members[index];
            if (!next.GetLeadingTrivia().Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)))
                decl = decl.ReplaceNode(next, next.WithLeadingTrivia(next.GetLeadingTrivia().Insert(0, eol)));
        }
        decl = decl.WithMembers(decl.Members.InsertRange(index, annotated));
        if (baseType != null)
        {
            var bt = SyntaxFactory.SimpleBaseType(SyntaxFactory.ParseTypeName(baseType)).WithAdditionalAnnotations(Simplifier.Annotation, Imports);
            decl = decl.BaseList == null
                ? decl.WithIdentifier(decl.TypeParameterList == null && decl.ParameterList == null ? decl.Identifier.WithTrailingTrivia() : decl.Identifier)
                    .WithBaseList(SyntaxFactory.BaseList(SyntaxFactory.SingletonSeparatedList<BaseTypeSyntax>(bt)).WithAdditionalAnnotations(Formatter.Annotation))
                : decl.WithBaseList(decl.BaseList.AddTypes(bt));
            if (c.Decl.BaseList == null)
            {
                // Keep the line break before the opening brace where it was (after the base list now).
                var trailing = (c.Decl.ParameterList?.GetTrailingTrivia() ?? c.Decl.TypeParameterList?.GetTrailingTrivia() ?? c.Decl.Identifier.TrailingTrivia);
                if (decl.TypeParameterList != null && decl.ParameterList == null) decl = decl.WithTypeParameterList(decl.TypeParameterList.WithoutTrailingTrivia());
                if (decl.ParameterList != null) decl = decl.WithParameterList(decl.ParameterList.WithoutTrailingTrivia());
                decl = decl.WithBaseList(decl.BaseList!.WithLeadingTrivia(SyntaxFactory.Space).WithTrailingTrivia(trailing));
            }
        }
        var doc = c.Doc.WithSyntaxRoot(c.Root.ReplaceNode(c.Decl, decl));
        doc = await ImportAdder.AddImportsAsync(doc, Imports, null, c.Ct).ConfigureAwait(false);
        doc = await Simplifier.ReduceAsync(doc, Simplifier.Annotation, null, c.Ct).ConfigureAwait(false);
        doc = await Formatter.FormatAsync(doc, Formatter.Annotation, null, c.Ct).ConfigureAwait(false);
        return doc;
    }

    private static MemberDeclarationSyntax Parse(string code)
    {
        var m = SyntaxFactory.ParseMemberDeclaration(code);
        if (m == null || m.ContainsDiagnostics) throw new Refusal("GenerationFailed", "The generated member could not be parsed: " + code.Split('\n')[0]);
        return m!;
    }

    private static string T(ITypeSymbol t) => t.ToDisplayString(Full);

    private static string Self(Ctx c) => c.Type.ToDisplayString(Full);

    private static string Esc(string name) => SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None ? "@" + name : name;

    private static ITypeSymbol TypeOf(ISymbol m) => m switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => throw new InvalidOperationException() };

    private static List<ISymbol> PickData(Ctx c, IEnumerable<ISymbol> candidates, IReadOnlyList<string> ids)
    {
        var byName = candidates.ToDictionary(m => m.Name, StringComparer.Ordinal);
        return ids.Where(byName.ContainsKey).Select(id => byName[id]).OrderBy(m => Order(c, m)).ToList();
    }

    /// <summary>Declaration order: the part at the cursor first, then the other parts by file.</summary>
    private static (int, string, int) Order(Ctx c, ISymbol m)
    {
        var loc = m.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc?.SourceTree == null) return (2, "", 0);
        return (loc.SourceTree == c.Decl.SyntaxTree ? 0 : 1, loc.SourceTree.FilePath, loc.SourceSpan.Start);
    }

    private static IEnumerable<T> Ordered<T>(Ctx c, IEnumerable<T> members) where T : ISymbol => members.OrderBy(m => Order(c, m));

    // ------------------------------------------------------------------ constructor

    private static string ParameterName(string member)
    {
        var n = member.StartsWith("m_", StringComparison.Ordinal) ? member[2..] : member.TrimStart('_');
        if (n.Length == 0) n = "value";
        n = char.ToLowerInvariant(n[0]) + n[1..];
        return Esc(n);
    }

    private static MemberDeclarationSyntax BuildConstructor(Ctx c, IReadOnlyList<string> ids)
    {
        var members = PickData(c, Assignable(c), ids);
        var access = c.Type.IsAbstract ? "protected" : "public";
        var ps = members.Select(m => $"{T(TypeOf(m))} {ParameterName(m.Name)}");
        var body = members.Select(m => $"this.{Esc(m.Name)} = {ParameterName(m.Name)};");
        return Parse($"{access} {Esc(c.Type.Name)}({string.Join(", ", ps)})\n{{\n{string.Join("\n", body)}\n}}\n");
    }

    // ------------------------------------------------------------------ equality

    private static string Compare(ISymbol m, string other)
    {
        var t = TypeOf(m);
        var n = Esc(m.Name);
        var simple = t.TypeKind == TypeKind.Enum || t.SpecialType is SpecialType.System_Boolean or SpecialType.System_Char or SpecialType.System_SByte or SpecialType.System_Byte
            or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64
            or SpecialType.System_UInt64 or SpecialType.System_Decimal or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_String
            or SpecialType.System_IntPtr or SpecialType.System_UIntPtr;
        if (simple) return $"this.{n} == {other}.{n}";
        if (t.IsValueType && t.OriginalDefinition.SpecialType != SpecialType.System_Nullable_T && t is not ITypeParameterSymbol) return $"this.{n}.Equals({other}.{n})";
        return $"global::System.Collections.Generic.EqualityComparer<{T(t)}>.Default.Equals(this.{n}, {other}.{n})";
    }

    private static (MemberDeclarationSyntax[], string?, bool) BuildEquality(Ctx c, IReadOnlyList<string> ids, GenerateOptions o)
    {
        var members = PickData(c, DataMembers(c), ids);
        if (members.Count == 0) throw new Refusal("NoMembers", "Pick at least one member for Equals and GetHashCode.");
        var self = Self(c);
        var isStruct = c.Type.IsValueType;
        var q = isStruct ? "" : c.Q;
        var cmp = string.Join(" && ", members.Select(m => Compare(m, "other")));
        var list = new List<MemberDeclarationSyntax>();
        var implementsEquatable = c.Type.AllInterfaces.Any(i => i.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>" && SymbolEqualityComparer.Default.Equals(i.TypeArguments[0], c.Type));
        if (o.Equatable)
        {
            list.Add(Parse(isStruct
                ? $"public bool Equals({self} other)\n{{\nreturn {cmp};\n}}\n"
                : $"public bool Equals({self}{q} other)\n{{\nif (other is null) return false;\nif (global::System.Object.ReferenceEquals(this, other)) return true;\nreturn {cmp};\n}}\n"));
            list.Add(Parse(isStruct
                ? $"public override bool Equals(object{c.Q} obj)\n{{\nreturn obj is {self} other && this.Equals(other);\n}}\n"
                : $"public override bool Equals(object{c.Q} obj)\n{{\nif (obj is null) return false;\nif (global::System.Object.ReferenceEquals(this, obj)) return true;\nif (obj.GetType() != this.GetType()) return false;\nreturn this.Equals(({self})obj);\n}}\n"));
        }
        else
        {
            list.Add(Parse(isStruct
                ? $"public override bool Equals(object{c.Q} obj)\n{{\nreturn obj is {self} other && {cmp};\n}}\n"
                : $"public override bool Equals(object{c.Q} obj)\n{{\nif (obj is null) return false;\nif (global::System.Object.ReferenceEquals(this, obj)) return true;\nif (obj.GetType() != this.GetType()) return false;\nvar other = ({self})obj;\nreturn {cmp};\n}}\n"));
        }
        string hash;
        if (members.Count <= 8) hash = $"return global::System.HashCode.Combine({string.Join(", ", members.Select(m => "this." + Esc(m.Name)))});";
        else hash = "var hash = new global::System.HashCode();\n" + string.Join("\n", members.Select(m => $"hash.Add(this.{Esc(m.Name)});")) + "\nreturn hash.ToHashCode();";
        list.Add(Parse($"public override int GetHashCode()\n{{\n{hash}\n}}\n"));
        if (o.Operators)
        {
            list.Add(Parse(isStruct
                ? $"public static bool operator ==({self} left, {self} right)\n{{\nreturn left.Equals(right);\n}}\n"
                : $"public static bool operator ==({self}{q} left, {self}{q} right)\n{{\nreturn global::System.Object.Equals(left, right);\n}}\n"));
            list.Add(Parse(isStruct
                ? $"public static bool operator !=({self} left, {self} right)\n{{\nreturn !left.Equals(right);\n}}\n"
                : $"public static bool operator !=({self}{q} left, {self}{q} right)\n{{\nreturn !global::System.Object.Equals(left, right);\n}}\n"));
        }
        var baseType = o.Equatable && !implementsEquatable ? $"global::System.IEquatable<{self}>" : null;
        return (list.ToArray(), baseType, false);
    }

    // ------------------------------------------------------------------ ToString, properties

    private static MemberDeclarationSyntax BuildToString(Ctx c, IReadOnlyList<string> ids)
    {
        var members = PickData(c, Readable(c), ids);
        if (members.Count == 0) throw new Refusal("NoMembers", "Pick at least one member for ToString.");
        var parts = string.Join(", ", members.Select(m => $"{{nameof({Esc(m.Name)})}}: {{this.{Esc(m.Name)}}}"));
        return Parse($"public override string ToString()\n{{\nreturn $\"{parts}\";\n}}\n");
    }

    private static MemberDeclarationSyntax[] BuildProperties(Ctx c, IReadOnlyList<string> ids)
    {
        var fields = PickData(c, FieldsWithoutProperty(c), ids).Cast<IFieldSymbol>();
        return fields.Select(f =>
        {
            var name = Esc(PropertyName(f.Name));
            var field = Esc(f.Name);
            var stat = f.IsStatic ? "static " : "";
            var owner = f.IsStatic ? field : "this." + field;
            return Parse(f.IsReadOnly
                ? $"public {stat}{T(f.Type)} {name} => {owner};\n"
                : $"public {stat}{T(f.Type)} {name}\n{{\nget => {owner};\nset => {owner} = value;\n}}\n");
        }).ToArray();
    }

    // ------------------------------------------------------------------ implement, override, delegate

    private enum MemberStyle { Implement, Override, Delegate }

    private static string Parameters(IMethodSymbol m) => string.Join(", ", m.Parameters.Select(Parameter));

    private static string Parameter(IParameterSymbol p)
    {
        var sb = new StringBuilder();
        if (p.IsParams) sb.Append("params ");
        sb.Append(p.RefKind switch { RefKind.Ref => "ref ", RefKind.Out => "out ", RefKind.In => "in ", RefKind.RefReadOnlyParameter => "ref readonly ", _ => "" });
        sb.Append(T(p.Type)).Append(' ').Append(Esc(p.Name));
        if (p.HasExplicitDefaultValue) sb.Append(" = ").Append(DefaultValue(p));
        return sb.ToString();
    }

    private static string DefaultValue(IParameterSymbol p)
    {
        var v = p.ExplicitDefaultValue;
        if (v == null) return p.Type.IsReferenceType || p.Type.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T ? "null" : "default";
        if (p.Type.TypeKind == TypeKind.Enum) return $"({T(p.Type)}){SymbolDisplay.FormatPrimitive(v, quoteStrings: true, useHexadecimalNumbers: false)}";
        return v switch
        {
            bool b => b ? "true" : "false",
            string s => SymbolDisplay.FormatLiteral(s, quote: true),
            char ch => SymbolDisplay.FormatLiteral(ch, quote: true),
            float f => SymbolDisplay.FormatPrimitive(f, false, false) + "F",
            decimal d => SymbolDisplay.FormatPrimitive(d, false, false) + "M",
            long l => SymbolDisplay.FormatPrimitive(l, false, false) + "L",
            ulong ul => SymbolDisplay.FormatPrimitive(ul, false, false) + "UL",
            uint ui => SymbolDisplay.FormatPrimitive(ui, false, false) + "U",
            _ => SymbolDisplay.FormatPrimitive(v, quoteStrings: true, useHexadecimalNumbers: false) ?? "default",
        };
    }

    private static string Arguments(IMethodSymbol m) => string.Join(", ", m.Parameters.Select(p =>
        (p.RefKind switch { RefKind.Ref => "ref ", RefKind.Out => "out ", RefKind.In => "in ", _ => "" }) + Esc(p.Name)));

    private static string TypeParameters(IMethodSymbol m) => m.TypeParameters.Length == 0 ? "" : "<" + string.Join(", ", m.TypeParameters.Select(t => Esc(t.Name))) + ">";

    private static string Constraints(IMethodSymbol m)
    {
        var sb = new StringBuilder();
        foreach (var tp in m.TypeParameters)
        {
            var parts = new List<string>();
            if (tp.HasReferenceTypeConstraint) parts.Add(tp.ReferenceTypeConstraintNullableAnnotation == NullableAnnotation.Annotated ? "class?" : "class");
            if (tp.HasUnmanagedTypeConstraint) parts.Add("unmanaged");
            else if (tp.HasValueTypeConstraint) parts.Add("struct");
            if (tp.HasNotNullConstraint) parts.Add("notnull");
            parts.AddRange(tp.ConstraintTypes.Select(T));
            if (tp.HasConstructorConstraint) parts.Add("new()");
            if (parts.Count > 0) sb.Append(" where ").Append(Esc(tp.Name)).Append(" : ").Append(string.Join(", ", parts));
        }
        return sb.ToString();
    }

    private static string Access(ISymbol m, MemberStyle style) =>
        style == MemberStyle.Override ? SyntaxFacts.GetText(m.DeclaredAccessibility) : "public";

    private const string Throw = "throw new global::System.NotImplementedException();";

    private static MemberDeclarationSyntax BuildMember(Ctx c, ISymbol m, MemberStyle style, string? via)
    {
        var access = Access(m, style);
        var mod = style == MemberStyle.Override ? " override" : "";
        var target = style == MemberStyle.Delegate ? via! : "base";
        var stub = style == MemberStyle.Implement || style == MemberStyle.Override && m.IsAbstract;
        switch (m)
        {
            case IMethodSymbol x:
            {
                var asyncPrefix = "";
                var call = $"{target}.{Esc(x.Name)}{(x.IsGenericMethod && style == MemberStyle.Delegate ? TypeParameters(x) : "")}({Arguments(x)})";
                var body = stub ? Throw : x.ReturnsVoid ? call + ";" : "return " + call + ";";
                var constraints = style == MemberStyle.Override ? "" : Constraints(x);
                return Parse($"{access}{mod} {asyncPrefix}{(x.ReturnsVoid ? "void" : T(x.ReturnType))} {Esc(x.Name)}{TypeParameters(x)}({Parameters(x)}){constraints}\n{{\n{body}\n}}\n");
            }
            case IPropertySymbol p:
            {
                var name = p.IsIndexer ? $"this[{string.Join(", ", p.Parameters.Select(Parameter))}]" : Esc(p.Name);
                var access2 = p.IsIndexer ? $"[{string.Join(", ", p.Parameters.Select(a => Esc(a.Name)))}]" : "." + Esc(p.Name);
                var get = p.GetMethod != null && (style != MemberStyle.Override || c.Model.IsAccessible(c.Position, p.GetMethod))
                    ? (stub ? $"get => {Throw.TrimEnd(';')};" : $"get => {target}{access2};") : null;
                var setKeyword = p.SetMethod?.IsInitOnly == true ? "init" : "set";
                var set = p.SetMethod != null && (style != MemberStyle.Override || c.Model.IsAccessible(c.Position, p.SetMethod))
                    ? (stub ? $"{setKeyword} => {Throw.TrimEnd(';')};" : $"{setKeyword} => {target}{access2} = value;") : null;
                if (style == MemberStyle.Delegate && p.SetMethod != null && p.SetMethod.DeclaredAccessibility != Accessibility.Public) set = null;
                if (style == MemberStyle.Delegate && p.GetMethod != null && p.GetMethod.DeclaredAccessibility != Accessibility.Public) get = null;
                return Parse($"{access}{mod} {T(p.Type)} {name}\n{{\n{string.Join("\n", new[] { get, set }.Where(x => x != null))}\n}}\n");
            }
            case IEventSymbol e:
                if (style == MemberStyle.Implement) return Parse($"{access} event {T(e.Type)} {Esc(e.Name)};\n");
                return Parse(stub
                    ? $"{access}{mod} event {T(e.Type)} {Esc(e.Name)}\n{{\nadd => {Throw.TrimEnd(';')};\nremove => {Throw.TrimEnd(';')};\n}}\n"
                    : $"{access}{mod} event {T(e.Type)} {Esc(e.Name)}\n{{\nadd => base.{Esc(e.Name)} += value;\nremove => base.{Esc(e.Name)} -= value;\n}}\n");
        }
        throw new Refusal("NotApplicable", "Unsupported member.");
    }

    private static MemberDeclarationSyntax[] BuildDelegating(Ctx c, IReadOnlyList<string> ids)
    {
        var result = new List<MemberDeclarationSyntax>();
        foreach (var (via, viaType) in DelegationSources(c))
        {
            var wanted = new HashSet<string>(ids.Where(i => i.StartsWith(via.Name + "|", StringComparison.Ordinal)).Select(i => i[(via.Name.Length + 1)..]), StringComparer.Ordinal);
            if (wanted.Count == 0) continue;
            var owner = via.IsStatic ? Esc(via.Name) : "this." + Esc(via.Name);
            foreach (var m in Delegatable(c, viaType).Where(m => wanted.Contains(Id(m))))
                result.Add(BuildMember(c, m, MemberStyle.Delegate, owner));
        }
        return result.ToArray();
    }
}
