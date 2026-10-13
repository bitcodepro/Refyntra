using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>One member of a type in File Structure (protocol 1.13, <c>code/fileStructure</c>).</summary>
public sealed record StructureMember(
    string Name,
    string Kind,
    string Accessibility,
    bool IsStatic,
    string Signature,
    LinePositionSpan Range,
    LinePositionSpan SelectionRange,
    string? Region,
    string? DeclaringType = null,
    string? FilePath = null,
    bool Navigable = true);

/// <summary>A type declared in the file, with its members in source order and (optionally) the inherited ones.</summary>
public sealed record StructureType(
    string Name,
    string FullName,
    string Kind,
    string Accessibility,
    bool IsStatic,
    string Signature,
    LinePositionSpan Range,
    LinePositionSpan SelectionRange,
    string? Region,
    string? ContainingType,
    List<StructureMember> Members,
    List<StructureMember> Inherited);

public sealed record StructureRegion(string Name, LinePositionSpan Range);

public sealed record FileStructureModel(List<StructureType> Types, List<StructureRegion> Regions);

/// <summary>
/// File Structure (Rider's Ctrl+F12): the types of one C# document (nested types too, every partial part in this file)
/// and their members in source order, with kind, accessibility, static, a short signature, ranges and the innermost
/// <c>#region</c>. Inherited members come from the base classes (an interface: its base interfaces), nearest first;
/// members overridden or hidden in the type, inaccessible ones and <see cref="object"/>'s are left out. Inherited
/// members declared in the solution carry their file; metadata members are listed but not navigable.
/// </summary>
public static class FileStructure
{
    public static class Kinds
    {
        public const string Class = "class", Struct = "struct", Interface = "interface", Enum = "enum", Record = "record", RecordStruct = "recordStruct", Delegate = "delegate";
        public const string Method = "method", Constructor = "constructor", Destructor = "destructor", Property = "property", Indexer = "indexer", Field = "field",
            Constant = "constant", Event = "event", Operator = "operator", EnumMember = "enumMember";
    }

    private static readonly SymbolDisplayFormat TypeFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameOnly,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    public static async Task<FileStructureModel?> ComputeAsync(Document doc, bool includeInherited, CancellationToken ct)
    {
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (root == null || model == null) return null;
        var regions = Regions(root, text);
        string? RegionOf(SyntaxNode n)
        {
            var at = n.SpanStart;
            StructureRegion? best = null;
            foreach (var r in regions)
            {
                var span = text.Lines.GetTextSpan(r.Range);
                if (span.Start <= at && at <= span.End && (best == null || text.Lines.GetTextSpan(best.Range).Length > span.Length)) best = r;
            }
            return best?.Name;
        }
        LinePositionSpan Span(TextSpan s) => text.Lines.GetLinePositionSpan(s);

        var types = new List<StructureType>();
        foreach (var node in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax))
        {
            ct.ThrowIfCancellationRequested();
            if (node is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)) continue;
            if (model.GetDeclaredSymbol(node, ct) is not INamedTypeSymbol type) continue;
            var members = new List<StructureMember>();
            if (node is TypeDeclarationSyntax td)
            {
                // Positional records: the parameters are properties.
                if (td is RecordDeclarationSyntax { ParameterList: { } pl })
                    foreach (var p in pl.Parameters)
                        if (type.GetMembers(p.Identifier.ValueText).OfType<IPropertySymbol>().FirstOrDefault() is { } prop)
                            members.Add(Member(prop, Kinds.Property, Span(p.Span), Span(p.Identifier.Span), RegionOf(p)));
                foreach (var m in td.Members)
                {
                    switch (m)
                    {
                        case BaseTypeDeclarationSyntax or DelegateDeclarationSyntax:
                            break; // nested types are types of their own
                        case BaseFieldDeclarationSyntax f:
                            foreach (var v in f.Declaration.Variables)
                                if (model.GetDeclaredSymbol(v, ct) is { } fs)
                                    members.Add(Member(fs, f is EventFieldDeclarationSyntax ? Kinds.Event : fs is IFieldSymbol { IsConst: true } ? Kinds.Constant : Kinds.Field, Span(f.Span), Span(v.Identifier.Span), RegionOf(f)));
                            break;
                        default:
                            if (model.GetDeclaredSymbol(m, ct) is { } ms && KindOf(ms) is { } kind)
                                members.Add(Member(ms, kind, Span(m.Span), Span(NameSpan(m)), RegionOf(m)));
                            break;
                    }
                }
            }
            else if (node is EnumDeclarationSyntax ed)
            {
                foreach (var em in ed.Members)
                    if (model.GetDeclaredSymbol(em, ct) is { } es)
                        members.Add(Member(es, Kinds.EnumMember, Span(em.Span), Span(em.Identifier.Span), RegionOf(em)));
            }
            var inherited = includeInherited ? Inherited(type, model.Compilation, ct) : new List<StructureMember>();
            var nameToken = node switch
            {
                BaseTypeDeclarationSyntax b => b.Identifier,
                DelegateDeclarationSyntax d => d.Identifier,
                _ => default,
            };
            types.Add(new StructureType(
                type.Name,
                FullName(type),
                KindOfType(type),
                Access(type),
                type.IsStatic,
                TypeSignature(type),
                Span(node.Span),
                Span(nameToken.Span),
                RegionOf(node),
                type.ContainingType is { } outer ? FullName(outer) : null,
                members,
                inherited));
        }
        return new FileStructureModel(types, regions);
    }

    /// <summary>"Outer.Inner&lt;T&gt;": the type with its containing types (no namespace).</summary>
    public static string FullName(INamedTypeSymbol type) =>
        type.ContainingType is { } outer ? $"{FullName(outer)}.{type.ToDisplayString(TypeFormat)}" : type.ToDisplayString(TypeFormat);

    private static StructureMember Member(ISymbol s, string kind, LinePositionSpan range, LinePositionSpan selection, string? region) =>
        new(s.Name, kind, Access(s), s.IsStatic || s is IFieldSymbol { IsConst: true }, Signature(s, kind), range, selection, region);

    private static TextSpan NameSpan(MemberDeclarationSyntax m) => m switch
    {
        MethodDeclarationSyntax x => x.Identifier.Span,
        ConstructorDeclarationSyntax x => x.Identifier.Span,
        DestructorDeclarationSyntax x => x.Identifier.Span,
        PropertyDeclarationSyntax x => x.Identifier.Span,
        EventDeclarationSyntax x => x.Identifier.Span,
        IndexerDeclarationSyntax x => x.ThisKeyword.Span,
        OperatorDeclarationSyntax x => x.OperatorToken.Span,
        ConversionOperatorDeclarationSyntax x => x.Type.Span,
        _ => m.Span,
    };

    private static string? KindOf(ISymbol s) => s switch
    {
        IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } => Kinds.Constructor,
        IMethodSymbol { MethodKind: MethodKind.Destructor } => Kinds.Destructor,
        IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator or MethodKind.Conversion } => Kinds.Operator,
        IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.ExplicitInterfaceImplementation } => Kinds.Method,
        IPropertySymbol { IsIndexer: true } => Kinds.Indexer,
        IPropertySymbol => Kinds.Property,
        IEventSymbol => Kinds.Event,
        IFieldSymbol { IsConst: true } => Kinds.Constant,
        IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } => Kinds.EnumMember,
        IFieldSymbol => Kinds.Field,
        _ => null,
    };

    private static string KindOfType(INamedTypeSymbol t) => t.TypeKind switch
    {
        Microsoft.CodeAnalysis.TypeKind.Interface => Kinds.Interface,
        Microsoft.CodeAnalysis.TypeKind.Enum => Kinds.Enum,
        Microsoft.CodeAnalysis.TypeKind.Delegate => Kinds.Delegate,
        Microsoft.CodeAnalysis.TypeKind.Struct => t.IsRecord ? Kinds.RecordStruct : Kinds.Struct,
        _ => t.IsRecord ? Kinds.Record : Kinds.Class,
    };

    /// <summary>public | internal | protected | private | protectedInternal | privateProtected.</summary>
    public static string Access(ISymbol s) => s.DeclaredAccessibility switch
    {
        Accessibility.Public => "public",
        Accessibility.Internal => "internal",
        Accessibility.Protected => "protected",
        Accessibility.ProtectedOrInternal => "protectedInternal",
        Accessibility.ProtectedAndInternal => "privateProtected",
        Accessibility.Private => "private",
        // Interface members and enum members without a modifier are public; a type without one is internal.
        _ => s is INamedTypeSymbol { ContainingType: null } ? "internal" : s.ContainingType?.TypeKind is Microsoft.CodeAnalysis.TypeKind.Interface or Microsoft.CodeAnalysis.TypeKind.Enum ? "public" : "private",
    };

    private static string T(ITypeSymbol t) => t.ToDisplayString(TypeFormat);

    private static string Parameters(IEnumerable<IParameterSymbol> ps) =>
        string.Join(", ", ps.Select(p => (p.RefKind switch { RefKind.Ref => "ref ", RefKind.Out => "out ", RefKind.In => "in ", _ => "" }) + (p.IsParams ? "params " : "") + T(p.Type)));

    /// <summary>Rider-style short signature: "Find(int) : OrderDto?", "Total : decimal", "this[int] : string".</summary>
    public static string Signature(ISymbol s, string kind)
    {
        switch (s)
        {
            case IMethodSymbol m:
                var name = m.MethodKind switch
                {
                    MethodKind.Constructor or MethodKind.StaticConstructor => m.ContainingType.Name,
                    MethodKind.Destructor => "~" + m.ContainingType.Name,
                    MethodKind.Conversion => $"{(m.Name == WellKnownMemberNames.ImplicitConversionName ? "implicit" : "explicit")} operator {T(m.ReturnType)}",
                    MethodKind.UserDefinedOperator => "operator " + (SyntaxFacts.GetText(SyntaxFacts.GetOperatorKind(m.Name)) is { Length: > 0 } op ? op : m.Name),
                    MethodKind.ExplicitInterfaceImplementation => m.Name,
                    _ => m.Name,
                };
                var generics = m.TypeParameters.Length > 0 ? $"<{string.Join(", ", m.TypeParameters.Select(p => p.Name))}>" : "";
                var ret = kind is Kinds.Constructor or Kinds.Destructor || m.MethodKind == MethodKind.Conversion ? "" : $" : {T(m.ReturnType)}";
                return $"{name}{generics}({Parameters(m.Parameters)}){ret}";
            case IPropertySymbol { IsIndexer: true } ix:
                return $"this[{Parameters(ix.Parameters)}] : {T(ix.Type)}";
            case IPropertySymbol p:
                return $"{p.Name} : {T(p.Type)}";
            case IEventSymbol e:
                return $"{e.Name} : {T(e.Type)}";
            case IFieldSymbol { ContainingType.TypeKind: Microsoft.CodeAnalysis.TypeKind.Enum } ef:
                return ef.HasConstantValue ? $"{ef.Name} = {ef.ConstantValue}" : ef.Name;
            case IFieldSymbol f:
                return $"{f.Name} : {T(f.Type)}";
            default:
                return s.Name;
        }
    }

    /// <summary>"OrderService : IOrderService", "Result&lt;T&gt; : Base&lt;T&gt;, IDisposable".</summary>
    private static string TypeSignature(INamedTypeSymbol t)
    {
        if (t.TypeKind == Microsoft.CodeAnalysis.TypeKind.Delegate && t.DelegateInvokeMethod is { } inv)
            return $"{FullName(t)}({Parameters(inv.Parameters)}) : {T(inv.ReturnType)}";
        var bases = new List<string>();
        if (t.BaseType is { SpecialType: not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum) } b && t.TypeKind == Microsoft.CodeAnalysis.TypeKind.Class)
            bases.Add(T(b));
        // A record's IEquatable<Self> is synthesized, not written.
        bases.AddRange(t.Interfaces.Where(i => !(t.IsRecord && i.Name == "IEquatable" && SymbolEqualityComparer.Default.Equals(i.TypeArguments.FirstOrDefault(), t))).Select(T));
        return bases.Count > 0 ? $"{FullName(t)} : {string.Join(", ", bases)}" : FullName(t);
    }

    /// <summary>A key that is equal for a member and the member that overrides or hides it.</summary>
    private static string Key(ISymbol s) => s switch
    {
        IMethodSymbol m => $"m:{m.Name}`{m.TypeParameters.Length}({string.Join(",", m.Parameters.Select(p => p.RefKind + p.Type.ToDisplayString()))})",
        IPropertySymbol { IsIndexer: true } p => $"i:({string.Join(",", p.Parameters.Select(x => x.Type.ToDisplayString()))})",
        _ => $"n:{s.Name}",
    };

    private static List<StructureMember> Inherited(INamedTypeSymbol type, Compilation compilation, CancellationToken ct)
    {
        var result = new List<StructureMember>();
        if (type.TypeKind is Microsoft.CodeAnalysis.TypeKind.Enum or Microsoft.CodeAnalysis.TypeKind.Delegate) return result;
        // Every member of the type (all partial parts, also those in other files) hides what it overrides or redeclares.
        var seen = new HashSet<string>(type.GetMembers().Where(m => !m.IsImplicitlyDeclared || m is IPropertySymbol).Select(Key), StringComparer.Ordinal);
        IEnumerable<INamedTypeSymbol> sources = type.TypeKind == Microsoft.CodeAnalysis.TypeKind.Interface
            ? type.AllInterfaces
            : BaseChain(type);
        foreach (var source in sources)
        {
            ct.ThrowIfCancellationRequested();
            var declaring = FullName(source);
            foreach (var m in source.GetMembers())
            {
                if (m.IsImplicitlyDeclared || m is INamedTypeSymbol) continue;
                if (KindOf(m) is not { } kind || kind is Kinds.Constructor or Kinds.Destructor) continue;
                if (m is IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.ExplicitInterfaceImplementation }) continue;
                if (!compilation.IsSymbolAccessibleWithin(m, type)) continue;
                if (!seen.Add(Key(m))) continue;
                var loc = m.Locations.FirstOrDefault(l => l.IsInSource && l.SourceTree?.FilePath is { Length: > 0 });
                var span = loc?.GetLineSpan().Span ?? default;
                result.Add(new StructureMember(m.Name, kind, Access(m), m.IsStatic || m is IFieldSymbol { IsConst: true }, Signature(m, kind), span, span, null, declaring, loc?.SourceTree?.FilePath, loc != null));
            }
        }
        return result;
    }

    /// <summary>The base classes, nearest first, without <see cref="object"/>, <see cref="ValueType"/> and <see cref="Enum"/>.</summary>
    private static IEnumerable<INamedTypeSymbol> BaseChain(INamedTypeSymbol type)
    {
        for (var b = type.BaseType; b != null; b = b.BaseType)
        {
            if (b.SpecialType is SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum) yield break;
            yield return b;
        }
    }

    /// <summary>The #region / #endregion pairs of the document (nested ones too), in source order.</summary>
    public static List<StructureRegion> Regions(SyntaxNode root, SourceText text)
    {
        var result = new List<StructureRegion>();
        var stack = new Stack<RegionDirectiveTriviaSyntax>();
        foreach (var d in root.DescendantTrivia(descendIntoTrivia: true).Select(t => t.GetStructure()).OfType<DirectiveTriviaSyntax>().OrderBy(d => d.SpanStart))
        {
            if (d is RegionDirectiveTriviaSyntax r) stack.Push(r);
            else if (d is EndRegionDirectiveTriviaSyntax e && stack.Count > 0)
            {
                var open = stack.Pop();
                var name = open.EndOfDirectiveToken.LeadingTrivia.ToString().Trim();
                result.Add(new StructureRegion(name.Length > 0 ? name : "#region", text.Lines.GetLinePositionSpan(TextSpan.FromBounds(open.SpanStart, e.Span.End))));
            }
        }
        return result.OrderBy(r => r.Range.Start).ToList();
    }
}
