using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>A constructor / DI helper that applies at a position (protocol 1.11, code/constructorActions).</summary>
/// <param name="Kind">"quickfix" or "rewrite".</param>
/// <param name="Member">The existing member an "Initialize" action assigns, or the undeclared name of "Create field and inject".</param>
/// <param name="Members">"Initialize all readonly fields": the members.</param>
/// <param name="TypeId">"Register in DI": documentation comment id of the service type.</param>
public sealed record CtorAction(string ActionId, string Title, string Kind, bool Preferred, string? Member = null, IReadOnlyList<string>? Members = null, string? TypeId = null);

/// <summary>One choice the client asks the user for (members, a constructor, a type, an implementation, a composition root).</summary>
public sealed record CtorChoice(string Id, string Label, string? Detail, bool Picked);

/// <summary>The compile-checked edits of one document.</summary>
public sealed record CtorFileEdits(string Path, string DocumentHash, IReadOnlyList<(LinePositionSpan Range, string NewText)> Edits);

/// <summary>What to compute: the action and the user's answers to earlier <see cref="CtorOutcome.Need"/>s.</summary>
public sealed record CtorRequest(string ActionId, string? Member, IReadOnlyList<string>? Members, string? Type, string? Constructor);

/// <summary>
/// The result of a constructor action: the edits (possibly in several parts of a partial type), or a question
/// (<see cref="Need"/> "members" | "constructor" | "type" with <see cref="Choices"/>), or a refusal.
/// <see cref="RegisterTypeId"/>: after "Create field and inject", a service type that is not registered in DI yet.
/// </summary>
public sealed record CtorOutcome(IReadOnlyList<CtorFileEdits>? Files, string? Need, IReadOnlyList<CtorChoice>? Choices, string? ReasonCode, string? Message,
    string? Note = null, string? RegisterTypeId = null, string? RegisterTypeName = null)
{
    public static CtorOutcome Refused(string reason, string message) => new(null, null, null, reason, message);
    public static CtorOutcome Ask(string need, IReadOnlyList<CtorChoice> choices, string message) => new(null, need, choices, null, message);
}

/// <summary>
/// Rider's constructor and DI helpers computed by Roslyn: create and initialise a field or property from a constructor
/// parameter (or a primary constructor parameter), initialise an existing unassigned member, initialise all unused
/// parameters, initialise readonly fields from a constructor (creating one when there is none), add parameters to a
/// constructor, and create an injected field for an undeclared <c>_name</c> whose type is inferred from its uses. Types
/// are semantic (written fully qualified, then usings added and names simplified), every part of a partial type is
/// considered, names follow the .editorconfig naming rules for private fields (then the existing fields), the result is
/// formatted with the document options and refused when it adds a compiler error. Never writes files.
/// </summary>
public static class ConstructorPlanner
{
    public const string Prefix = "csharp.ctor.";
    public const string IntroduceField = Prefix + "introduceField";
    public const string IntroduceProperty = Prefix + "introduceProperty";
    public const string InitializeExisting = Prefix + "initializeExisting";
    public const string InitializeAllParameters = Prefix + "initializeAllParameters";
    public const string InitializeMembers = Prefix + "initializeMembers";
    public const string AddParameters = Prefix + "addParameters";
    public const string CreateInjectedField = Prefix + "createInjectedField";
    public const string RegisterDi = Prefix + "registerDi";
    public const string Generate = Prefix + "generate";

    private const string QuickFix = "quickfix";
    private const string Rewrite = "rewrite";
    private const int MaxTypeChoices = 50;

    private static readonly SymbolDisplayFormat Full = SymbolDisplayFormat.FullyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat Short = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SyntaxAnnotation Imports = new("refyntra.ctor.imports");

    private sealed class Refusal : Exception
    {
        public string Reason { get; }
        public Refusal(string reason, string message) : base(message) => Reason = reason;
    }

    private sealed class Question : Exception
    {
        public CtorOutcome Outcome { get; }
        public Question(CtorOutcome o) : base(o.Message) => Outcome = o;
    }

    private sealed record Ctx(Snapshot Snap, Document Doc, SyntaxNode Root, SemanticModel Model, SourceText Text, int Pos, TypeDeclarationSyntax Decl, INamedTypeSymbol Type, CancellationToken Ct)
    {
        public SyntaxToken Token => Root.FindToken(Math.Min(Pos, Math.Max(0, Root.FullSpan.End - 1)));
        public Solution Solution => Snap.Solution;
    }

    internal static Document? DocumentOf(Snapshot snapshot, string path) =>
        snapshot.Session.DocumentIdsForPath(path).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);

    private static async Task<Ctx?> ContextAsync(Snapshot snapshot, string path, LinePosition position, CancellationToken ct)
    {
        var doc = DocumentOf(snapshot, path);
        if (doc == null) return null;
        var tree = await doc.GetSyntaxTreeAsync(ct).ConfigureAwait(false);
        if (tree == null || SymbolFacts.IsGeneratedTree(snapshot.Solution, tree, ct)) return null;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (position.Line < 0 || position.Line >= text.Lines.Count) return null;
        var line = text.Lines[position.Line];
        var pos = Math.Min(line.Start + position.Character, line.End);
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var token = root!.FindToken(Math.Min(pos, Math.Max(0, root.FullSpan.End - 1)));
        var decl = token.Parent?.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().FirstOrDefault();
        if (decl == null || decl is InterfaceDeclarationSyntax) return null;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model!.GetDeclaredSymbol(decl, ct) is not INamedTypeSymbol type) return null;
        return new Ctx(snapshot, doc, root, model!, text, pos, decl, type, ct);
    }

    // ------------------------------------------------------------------ listing

    /// <summary>The constructor / DI actions at the position (syntax plus a few semantic queries; no compilation of other files).</summary>
    public static async Task<IReadOnlyList<CtorAction>> ListAsync(Snapshot snapshot, string path, LinePosition position, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, position, ct).ConfigureAwait(false);
        if (c == null || c.Type.IsStatic) return Array.Empty<CtorAction>();
        var list = new List<CtorAction>();
        var style = NamingFor(c);

        if (ParameterAt(c) is { } at)
        {
            if (at.Primary && c.Type.IsRecord) return list; // positional record parameters already are properties
            var param = (IParameterSymbol)c.Model.GetDeclaredSymbol(at.Syntax, ct)!;
            if (param == null) return list;
            var used = IsParameterUsed(c, at);
            if (!used)
            {
                var existing = at.Primary ? null : UnassignedMembers(c).FirstOrDefault(m => SymbolEqualityComparer.Default.Equals(TypeOf(m), param.Type));
                if (existing != null)
                    list.Add(new CtorAction(InitializeExisting, $"Initialize {(existing is IFieldSymbol ? "field" : "property")} '{existing.Name}'", Rewrite, true, existing.Name));
                var field = FieldName(param.Name, style);
                list.Add(new CtorAction(IntroduceField, at.Primary ? $"Create field '{field}' from primary constructor parameter" : $"Create and initialize field '{field}'", Rewrite, existing == null));
                list.Add(new CtorAction(IntroduceProperty, $"Create and initialize property '{PropertyName(param.Name)}'", Rewrite, false));
            }
            if (at.Ctor != null && UnusedParameters(c, at.Ctor).Count > 1)
                list.Add(new CtorAction(InitializeAllParameters, "Initialize all unassigned parameters from constructor", Rewrite, false));
            if (param.Type is INamedTypeSymbol nt && IsRegistrable(nt))
                list.Add(new CtorAction(RegisterDi, $"Register '{param.Type.ToMinimalDisplayString(c.Model, c.Pos, Short)}' in DI…", Rewrite, false, TypeId: nt.OriginalDefinition.GetDocumentationCommentId()));
            return list;
        }

        if (MemberAt(c) is { } member)
        {
            var unassigned = UnassignedMembers(c);
            if (unassigned.Any(u => SymbolEqualityComparer.Default.Equals(u, member)))
            {
                list.Add(new CtorAction(InitializeMembers, $"Initialize '{member.Name}' from constructor", QuickFix, true, Members: new[] { member.Name }));
                if (unassigned.Count > 1)
                    list.Add(new CtorAction(InitializeMembers, "Initialize all readonly fields from constructor", QuickFix, false, Members: unassigned.Select(u => u.Name).ToList()));
            }
            return list;
        }

        if (UndeclaredFieldAt(c) is { } missing)
        {
            list.Add(new CtorAction(CreateInjectedField, $"Create field '{missing.Identifier.ValueText}' and inject via constructor", QuickFix, true, missing.Identifier.ValueText));
            return list;
        }

        var onHeader = c.Pos >= c.Decl.SpanStart && (c.Decl.OpenBraceToken.IsMissing || c.Decl.OpenBraceToken.RawKind == 0 ? c.Pos <= c.Decl.Span.End : c.Pos <= c.Decl.OpenBraceToken.SpanStart);
        if (onHeader)
        {
            if (c.Decl.ParameterList == null && ConstructorCandidates(c).Any()) list.Add(new CtorAction(Generate, "Generate constructor…", Rewrite, false));
            if (ExplicitConstructors(c).Any() && UnassignedMembers(c).Count > 0) list.Add(new CtorAction(AddParameters, "Add parameters to constructor…", Rewrite, false));
        }
        return list;
    }

    // ------------------------------------------------------------------ compute

    /// <summary>Computes one action: compile-checked edits of the changed documents, a question, or a refusal.</summary>
    public static async Task<CtorOutcome> ComputeAsync(Snapshot snapshot, string path, LinePosition position, CtorRequest request, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, position, ct).ConfigureAwait(false);
        if (c == null) return CtorOutcome.Refused("NoType", "Place the cursor inside a class, struct or record of the loaded solution.");
        if (c.Type.IsStatic) return CtorOutcome.Refused("StaticType", "A static class has no instance constructor.");
        try
        {
            var style = NamingFor(c);
            var (solution, note, register) = request.ActionId switch
            {
                IntroduceField or IntroduceProperty or InitializeExisting => (await IntroduceAsync(c, request, style).ConfigureAwait(false), (string?)null, (INamedTypeSymbol?)null),
                InitializeAllParameters => (await InitializeAllAsync(c, style).ConfigureAwait(false), null, null),
                InitializeMembers or AddParameters => (await InitializeMembersAsync(c, request, style).ConfigureAwait(false), null, null),
                CreateInjectedField => await CreateInjectedAsync(c, request, style).ConfigureAwait(false),
                _ => throw new Refusal("NotApplicable", "Unknown constructor action."),
            };
            var files = await FinishAsync(c, solution).ConfigureAwait(false);
            return new CtorOutcome(files, null, null, null, null, note ?? (style.Source == "default" ? null : $"Field names follow {style.Source}."),
                register?.OriginalDefinition.GetDocumentationCommentId(), register?.ToMinimalDisplayString(c.Model, c.Pos, Short));
        }
        catch (Refusal r)
        {
            return CtorOutcome.Refused(r.Reason, r.Message);
        }
        catch (Question q)
        {
            return q.Outcome;
        }
    }

    /// <summary>Usings, simplification and formatting of every changed document; per document compile check; the edits.</summary>
    private static async Task<IReadOnlyList<CtorFileEdits>> FinishAsync(Ctx c, Solution after)
    {
        var ct = c.Ct;
        var result = new List<CtorFileEdits>();
        var changed = after.GetChanges(c.Solution).GetProjectChanges().SelectMany(p => p.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true)).Distinct().ToList();
        if (changed.Count == 0) throw new Refusal("NoChanges", "The action produces no edits.");
        foreach (var id in changed)
        {
            var doc = after.GetDocument(id)!;
            doc = await ImportAdder.AddImportsAsync(doc, Imports, null, ct).ConfigureAwait(false);
            doc = await Simplifier.ReduceAsync(doc, Simplifier.Annotation, null, ct).ConfigureAwait(false);
            doc = await Formatter.FormatAsync(doc, Formatter.Annotation, null, ct).ConfigureAwait(false);
            after = doc.Project.Solution;
        }
        foreach (var id in changed)
        {
            var oldDoc = c.Solution.GetDocument(id)!;
            var newDoc = after.GetDocument(id)!;
            if (oldDoc.FilePath == null) throw new Refusal("GeneratedCode", "The change touches a document without a file.");
            if (RenamePlanner.IsReadOnly(oldDoc.FilePath)) throw new Refusal("ReadOnlyFile", "The file is read-only: " + Path.GetFileName(oldDoc.FilePath));
            if (SymbolFacts.IsGeneratedTree(c.Solution, (await oldDoc.GetSyntaxTreeAsync(ct).ConfigureAwait(false))!, ct))
                throw new Refusal("GeneratedCode", "The change would edit generated code: " + Path.GetFileName(oldDoc.FilePath));
            var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
            var newText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
            if (newText.ContentEquals(oldText)) continue;
            await CompileCheckAsync(oldDoc, newDoc, ct).ConfigureAwait(false);
            var edits = newText.GetTextChanges(oldText).OrderBy(x => x.Span.Start).Select(x => (oldText.Lines.GetLinePositionSpan(x.Span), x.NewText ?? "")).ToList();
            result.Add(new CtorFileEdits(oldDoc.FilePath, Hashing.Sha256Text(oldText.ToString()), edits));
        }
        if (result.Count == 0) throw new Refusal("NoChanges", "The action produces no edits.");
        // The document at the cursor first.
        return result.OrderBy(f => UriPaths.PathComparer.Equals(f.Path, c.Doc.FilePath ?? "") ? 0 : 1).ThenBy(f => f.Path, StringComparer.Ordinal).ToList();
    }

    private static async Task CompileCheckAsync(Document before, Document after, CancellationToken ct)
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
        var m0 = await before.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var m1 = await after.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var b = Keys(m0!.GetDiagnostics(cancellationToken: ct));
        var a = Keys(m1!.GetDiagnostics(cancellationToken: ct));
        var added = a.Where(kv => kv.Value > (b.TryGetValue(kv.Key, out var n) ? n : 0)).Select(kv => kv.Key).ToList();
        if (added.Count > 0) throw new Refusal("CompilationErrors", "The change would introduce compiler errors: " + string.Join("; ", added.Take(3)));
    }

    // ------------------------------------------------------------------ positions

    private sealed record ParamAt(ParameterSyntax Syntax, ConstructorDeclarationSyntax? Ctor, bool Primary);

    private static ParamAt? ParameterAt(Ctx c)
    {
        var p = c.Token.Parent?.AncestorsAndSelf().TakeWhile(a => a is not BlockSyntax and not ArrowExpressionClauseSyntax).OfType<ParameterSyntax>().FirstOrDefault();
        if (p?.Parent is not ParameterListSyntax list) return null;
        if (list.Parent is ConstructorDeclarationSyntax ctor && !ctor.Modifiers.Any(SyntaxKind.StaticKeyword) && ctor.Parent == c.Decl) return new ParamAt(p, ctor, false);
        if (list.Parent == c.Decl) return new ParamAt(p, null, true);
        return null;
    }

    /// <summary>The field or get-only property whose declaration the cursor is on.</summary>
    private static ISymbol? MemberAt(Ctx c)
    {
        var node = c.Token.Parent;
        if (node?.AncestorsAndSelf().FirstOrDefault(a => a is VariableDeclaratorSyntax or PropertyDeclarationSyntax or BlockSyntax or ArrowExpressionClauseSyntax or EqualsValueClauseSyntax) is { } owner)
        {
            if (owner is VariableDeclaratorSyntax v && v.Parent?.Parent is FieldDeclarationSyntax fd && fd.Parent == c.Decl) return c.Model.GetDeclaredSymbol(v, c.Ct);
            if (owner is PropertyDeclarationSyntax pd && pd.Parent == c.Decl && c.Pos <= pd.Identifier.Span.End) return c.Model.GetDeclaredSymbol(pd, c.Ct);
        }
        // On the type or modifiers of a single-variable field declaration.
        if (node?.AncestorsAndSelf().OfType<FieldDeclarationSyntax>().FirstOrDefault() is { Declaration.Variables.Count: 1 } f && f.Parent == c.Decl
            && c.Pos < f.Declaration.Variables[0].Identifier.SpanStart)
            return c.Model.GetDeclaredSymbol(f.Declaration.Variables[0], c.Ct);
        return null;
    }

    /// <summary>A field-shaped name (<c>_repo</c>, <c>m_repo</c>) used in an instance member that does not bind to anything.</summary>
    private static IdentifierNameSyntax? UndeclaredFieldAt(Ctx c)
    {
        var tok = c.Token;
        if (!tok.IsKind(SyntaxKind.IdentifierToken) && c.Pos > 0) tok = c.Root.FindToken(c.Pos - 1);
        if (tok.Parent is not IdentifierNameSyntax id || !tok.IsKind(SyntaxKind.IdentifierToken)) return null;
        if (!IsFieldShaped(id.Identifier.ValueText)) return null;
        if (id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id) return null;
        if (id.Parent is MemberBindingExpressionSyntax or QualifiedNameSyntax or NameColonSyntax) return null;
        var member = id.Ancestors().OfType<MemberDeclarationSyntax>().FirstOrDefault();
        if (member == null || member.Parent != c.Decl || member is BaseTypeDeclarationSyntax) return null;
        if (member is BaseMethodDeclarationSyntax bm && bm.Modifiers.Any(SyntaxKind.StaticKeyword)) return null;
        if (member is BasePropertyDeclarationSyntax bp && bp.Modifiers.Any(SyntaxKind.StaticKeyword)) return null;
        if (member is BaseFieldDeclarationSyntax) return null;
        var info = c.Model.GetSymbolInfo(id, c.Ct);
        if (info.Symbol != null || info.CandidateSymbols.Length > 0) return null;
        if (c.Type.GetMembers(id.Identifier.ValueText).Any()) return null;
        return id;
    }

    private static bool IsFieldShaped(string n) =>
        n.Length > 1 && (n[0] == '_' && (char.IsLetter(n[1])) || n.StartsWith("m_", StringComparison.Ordinal) && n.Length > 2 && char.IsLetter(n[2]));

    // ------------------------------------------------------------------ members

    private static ITypeSymbol TypeOf(ISymbol m) => m switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, IParameterSymbol p => p.Type, _ => throw new InvalidOperationException() };

    private static IEnumerable<TypeDeclarationSyntax> Parts(Ctx c) =>
        c.Type.DeclaringSyntaxReferences.Select(r => r.GetSyntax(c.Ct)).OfType<TypeDeclarationSyntax>();

    private static IEnumerable<ConstructorDeclarationSyntax> ExplicitConstructors(Ctx c) =>
        Parts(c).SelectMany(p => p.Members.OfType<ConstructorDeclarationSyntax>()).Where(k => !k.Modifiers.Any(SyntaxKind.StaticKeyword));

    private static bool HasPrimary(Ctx c) => !c.Type.IsRecord && Parts(c).Any(p => p.ParameterList != null);

    private static SemanticModel ModelFor(Ctx c, SyntaxTree tree) => tree == c.Model.SyntaxTree ? c.Model : c.Model.Compilation.GetSemanticModel(tree);

    /// <summary>Is the member assigned in a constructor of any part (simple or compound assignment, ref/out argument)?</summary>
    private static bool AssignedInConstructor(Ctx c, ISymbol member)
    {
        foreach (var k in ExplicitConstructors(c))
        {
            if (k.Initializer is { ThisOrBaseKeyword.RawKind: (int)SyntaxKind.ThisKeyword }) continue;
            var model = ModelFor(c, k.SyntaxTree);
            foreach (var n in k.DescendantNodes())
            {
                ExpressionSyntax? target = n switch
                {
                    AssignmentExpressionSyntax a => a.Left,
                    ArgumentSyntax { RefKindKeyword.RawKind: (int)SyntaxKind.OutKeyword or (int)SyntaxKind.RefKeyword } arg => arg.Expression,
                    _ => null,
                };
                if (target is TupleExpressionSyntax tuple)
                {
                    if (tuple.Arguments.Any(x => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(x.Expression, c.Ct).Symbol, member))) return true;
                    continue;
                }
                if (target != null && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(target, c.Ct).Symbol, member)) return true;
            }
        }
        return false;
    }

    private static bool HasInitializer(ISymbol m, CancellationToken ct) => m.DeclaringSyntaxReferences.Select(r => r.GetSyntax(ct)).Any(s =>
        s is VariableDeclaratorSyntax { Initializer: not null } || s is PropertyDeclarationSyntax { Initializer: not null });

    private static bool IsAutoGetOnly(IPropertySymbol p, CancellationToken ct) =>
        p.SetMethod == null && !p.IsIndexer && p.DeclaringSyntaxReferences.Select(r => r.GetSyntax(ct)).OfType<PropertyDeclarationSyntax>().Any(pd =>
            pd.ExpressionBody == null && pd.AccessorList != null && pd.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null)
            && pd.AccessorList.Accessors.Count == 1 && pd.AccessorList.Accessors[0].IsKind(SyntaxKind.GetAccessorDeclaration));

    /// <summary>Readonly instance fields and get-only auto-properties without initialiser that no constructor assigns, in declaration order.</summary>
    private static List<ISymbol> UnassignedMembers(Ctx c)
    {
        var list = new List<ISymbol>();
        foreach (var m in Ordered(c, c.Type.GetMembers()))
        {
            if (m.IsStatic || m.IsImplicitlyDeclared || !m.Locations.Any(l => l.IsInSource)) continue;
            var ok = m switch
            {
                IFieldSymbol f => f.IsReadOnly && !f.IsConst && f.AssociatedSymbol == null,
                IPropertySymbol p => !p.IsAbstract && IsAutoGetOnly(p, c.Ct) && p.DeclaringSyntaxReferences.All(r => r.GetSyntax(c.Ct) is PropertyDeclarationSyntax),
                _ => false,
            };
            if (ok && !HasInitializer(m, c.Ct) && !AssignedInConstructor(c, m)) list.Add(m);
        }
        return list;
    }

    /// <summary>Members a constructor can take: instance fields (not const) and settable or get-only auto properties without initialiser.</summary>
    private static IEnumerable<ISymbol> ConstructorCandidates(Ctx c) => Ordered(c, c.Type.GetMembers()).Where(m =>
        !m.IsStatic && !m.IsImplicitlyDeclared && m.Locations.Any(l => l.IsInSource) && !HasInitializer(m, c.Ct) && m switch
        {
            IFieldSymbol f => !f.IsConst && f.AssociatedSymbol == null,
            IPropertySymbol p => !p.IsAbstract && !p.IsIndexer && (IsAutoGetOnly(p, c.Ct) || p.SetMethod != null && p.DeclaringSyntaxReferences.Any(r => r.GetSyntax(c.Ct) is PropertyDeclarationSyntax { AccessorList: { } al } && al.Accessors.All(a => a.Body == null && a.ExpressionBody == null))),
            _ => false,
        });

    private static IEnumerable<ISymbol> Ordered(Ctx c, IEnumerable<ISymbol> members) => members.OrderBy(m =>
    {
        var loc = m.Locations.FirstOrDefault(l => l.IsInSource);
        return (loc?.SourceTree == c.Decl.SyntaxTree ? 0 : 1, loc?.SourceTree?.FilePath ?? "", loc?.SourceSpan.Start ?? 0);
    });

    private static bool IsParameterUsed(Ctx c, ParamAt at)
    {
        var param = c.Model.GetDeclaredSymbol(at.Syntax, c.Ct);
        IEnumerable<SyntaxNode> scope = at.Ctor != null
            ? new SyntaxNode?[] { at.Ctor.Initializer, at.Ctor.Body, at.Ctor.ExpressionBody }.Where(n => n != null).Select(n => n!)
            : c.Decl.Members.Cast<SyntaxNode>().Concat(c.Decl.BaseList != null ? new SyntaxNode[] { c.Decl.BaseList } : Array.Empty<SyntaxNode>());
        return scope.SelectMany(n => n.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            .Any(id => id.Identifier.ValueText == at.Syntax.Identifier.ValueText && SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(id, c.Ct).Symbol, param));
    }

    private static List<ParameterSyntax> UnusedParameters(Ctx c, ConstructorDeclarationSyntax ctor) =>
        ctor.ParameterList.Parameters.Where(p => !IsParameterUsed(c, new ParamAt(p, ctor, false))).ToList();

    private static bool Taken(Ctx c, string name) =>
        c.Type.Name == name || c.Type.GetMembers(name).Any() || (c.Type.BaseType?.GetMembers(name).Any(m => !m.IsImplicitlyDeclared) ?? false);

    // ------------------------------------------------------------------ naming

    /// <summary>How private instance fields are named: the .editorconfig naming rules, then the type's (or file's) fields, then "_camelCase".</summary>
    internal sealed record Naming(string Prefix, bool Pascal, string Source);

    private static Naming NamingFor(Ctx c)
    {
        if (FromEditorConfig(c) is { } cfg) return cfg;
        var pool = c.Type.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic && !f.IsConst && !f.IsImplicitlyDeclared && f.AssociatedSymbol == null).Select(f => f.Name).ToList();
        if (pool.Count == 0)
            pool = c.Root.DescendantNodes().OfType<FieldDeclarationSyntax>()
                .Where(f => !f.Modifiers.Any(SyntaxKind.StaticKeyword) && !f.Modifiers.Any(SyntaxKind.ConstKeyword) && !f.Modifiers.Any(SyntaxKind.PublicKeyword))
                .SelectMany(f => f.Declaration.Variables.Select(v => v.Identifier.ValueText)).ToList();
        if (pool.Count == 0) return new Naming("_", false, "default");
        var underscore = pool.Count(n => n.StartsWith('_'));
        var m = pool.Count(n => n.StartsWith("m_", StringComparison.Ordinal));
        var camel = pool.Count(n => n.Length > 0 && char.IsLower(n[0]) && !n.StartsWith("m_", StringComparison.Ordinal));
        if (m > underscore && m >= camel) return new Naming("m_", false, "the existing fields");
        if (camel > underscore) return new Naming("", false, "the existing fields");
        return new Naming("_", false, "the existing fields");
    }

    /// <summary>The first .editorconfig naming rule (dotnet_naming_rule.*) that applies to private instance fields.</summary>
    private static Naming? FromEditorConfig(Ctx c)
    {
        var options = c.Doc.Project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GetOptions(c.Root.SyntaxTree);
        string? Get(string key) => options.TryGetValue(key, out var v) ? v.Split(':')[0].Trim() : null;
        var rules = new List<(string Rule, string Symbols)>();
        foreach (var key in options.Keys)
        {
            if (!key.StartsWith("dotnet_naming_rule.", StringComparison.OrdinalIgnoreCase) || !key.EndsWith(".symbols", StringComparison.OrdinalIgnoreCase)) continue;
            var rule = key["dotnet_naming_rule.".Length..^".symbols".Length];
            if (Get(key) is { } s) rules.Add((rule, s));
        }
        foreach (var (rule, symbols) in rules.OrderBy(r => r.Rule, StringComparer.Ordinal))
        {
            var kinds = Get($"dotnet_naming_symbols.{symbols}.applicable_kinds") ?? "";
            var access = Get($"dotnet_naming_symbols.{symbols}.applicable_accessibilities") ?? "*";
            var modifiers = Get($"dotnet_naming_symbols.{symbols}.required_modifiers") ?? "";
            if (!kinds.Split(',').Select(x => x.Trim()).Any(k => k is "field" or "*")) continue;
            if (!access.Split(',').Select(x => x.Trim()).Any(a => a is "private" or "*")) continue;
            if (modifiers.Split(',').Select(x => x.Trim()).Any(x => x is "const" or "static")) continue;
            var style = Get($"dotnet_naming_rule.{rule}.style");
            if (style == null) continue;
            var prefix = Get($"dotnet_naming_style.{style}.required_prefix");
            var cap = Get($"dotnet_naming_style.{style}.capitalization");
            if (prefix == null && cap == null) continue;
            return new Naming(prefix ?? "", cap == "pascal_case", ".editorconfig");
        }
        return null;
    }

    private static string Bare(string name)
    {
        var n = name.TrimStart('@');
        if (n.StartsWith("m_", StringComparison.Ordinal) || n.StartsWith("s_", StringComparison.Ordinal)) n = n[2..];
        n = n.TrimStart('_');
        return n.Length == 0 ? "value" : n;
    }

    private static string Upper(string s) => char.ToUpperInvariant(s[0]) + s[1..];
    private static string Lower(string s) => char.ToLowerInvariant(s[0]) + s[1..];

    internal static string FieldNameWith(string param, string prefix, bool pascal) => prefix + (pascal ? Upper(Bare(param)) : Lower(Bare(param)));
    private static string FieldName(string param, Naming n) => FieldNameWith(param, n.Prefix, n.Pascal);
    private static string PropertyName(string param) => Upper(Bare(param));
    private static string Esc(string name) => SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None ? "@" + name : name;
    internal static string ParameterName(string member) => Esc(Lower(Bare(member)));

    // ------------------------------------------------------------------ syntax builders

    private static TypeSyntax TypeSyntaxOf(ITypeSymbol t) =>
        SyntaxFactory.ParseTypeName(t.ToDisplayString(Full)).WithAdditionalAnnotations(Simplifier.Annotation, Imports);

    private static MemberDeclarationSyntax FieldSyntax(ITypeSymbol type, string name, string? initializer)
    {
        var code = $"private readonly {type.ToDisplayString(Full)} {Esc(name)}{(initializer != null ? " = " + initializer : "")};";
        return Annotate(SyntaxFactory.ParseMemberDeclaration(code)!);
    }

    private static MemberDeclarationSyntax PropertySyntax(ITypeSymbol type, string name, string? initializer)
    {
        var code = $"public {type.ToDisplayString(Full)} {Esc(name)} {{ get; }}{(initializer != null ? " = " + initializer + ";" : "")}";
        return Annotate(SyntaxFactory.ParseMemberDeclaration(code)!);
    }

    private static T Annotate<T>(T node) where T : SyntaxNode
    {
        if (node.ContainsDiagnostics) throw new Refusal("GenerationFailed", "The generated code could not be parsed: " + node.ToString().Split('\n')[0]);
        return node.WithAdditionalAnnotations(Formatter.Annotation, Simplifier.Annotation, Imports);
    }

    private static StatementSyntax Assignment(string member, string value) =>
        Annotate(SyntaxFactory.ParseStatement($"this.{Esc(member)} = {value};"));

    private static SyntaxTrivia Eol(SourceText text) => SyntaxFactory.EndOfLine(text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");

    /// <summary>Inserts members after the last member matching <paramref name="after"/> (else first), keeping blank lines between groups.</summary>
    private static TypeDeclarationSyntax InsertMembers(TypeDeclarationSyntax decl, IReadOnlyList<MemberDeclarationSyntax> members, Func<MemberDeclarationSyntax, bool> after, bool blankBefore, SyntaxTrivia eol)
    {
        if (members.Count == 0) return decl;
        decl = EnsureBody(decl, eol);
        var index = 0;
        for (var i = 0; i < decl.Members.Count; i++) if (after(decl.Members[i])) index = i + 1;
        var list = members.Select(m => m.GetTrailingTrivia().Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)) ? m : m.WithTrailingTrivia(m.GetTrailingTrivia().Add(eol)))
            .Select((m, i) => i == 0 && blankBefore && index > 0 ? m.WithLeadingTrivia(m.GetLeadingTrivia().Insert(0, eol)) : m).ToList();
        if (index < decl.Members.Count && (blankBefore || index == 0))
        {
            var next = decl.Members[index];
            if (!next.GetLeadingTrivia().Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)) && !(next is BaseFieldDeclarationSyntax && !blankBefore))
                decl = decl.ReplaceNode(next, next.WithLeadingTrivia(next.GetLeadingTrivia().Insert(0, eol)));
        }
        return decl.WithMembers(decl.Members.InsertRange(index, list));
    }

    private static TypeDeclarationSyntax EnsureBody(TypeDeclarationSyntax decl, SyntaxTrivia eol)
    {
        if (!decl.OpenBraceToken.IsMissing && decl.OpenBraceToken.RawKind != 0) return decl;
        var semicolon = decl.SemicolonToken;
        var lastBefore = semicolon.GetPreviousToken();
        decl = decl.ReplaceToken(lastBefore, lastBefore.WithTrailingTrivia(eol));
        return decl.WithSemicolonToken(default)
            .WithOpenBraceToken(SyntaxFactory.Token(SyntaxKind.OpenBraceToken).WithTrailingTrivia(eol))
            .WithCloseBraceToken(SyntaxFactory.Token(SyntaxKind.CloseBraceToken).WithTrailingTrivia(semicolon.TrailingTrivia));
    }

    private static bool IsFieldMember(MemberDeclarationSyntax m) => m is FieldDeclarationSyntax f && !f.Modifiers.Any(SyntaxKind.ConstKeyword);
    private static bool IsDataMember(MemberDeclarationSyntax m) => m is BaseFieldDeclarationSyntax or PropertyDeclarationSyntax;
    private static bool IsDataOrCtor(MemberDeclarationSyntax m) => m is BaseFieldDeclarationSyntax or PropertyDeclarationSyntax or ConstructorDeclarationSyntax;

    private static TypeDeclarationSyntax AddFields(TypeDeclarationSyntax decl, IReadOnlyList<MemberDeclarationSyntax> fields, SyntaxTrivia eol) =>
        InsertMembers(decl, fields, decl.Members.Any(IsFieldMember) ? IsFieldMember : m => m is BaseFieldDeclarationSyntax, false, eol);

    /// <summary>Adds parameters and assignments to a constructor (an expression body becomes a block).</summary>
    private static ConstructorDeclarationSyntax ExtendConstructor(ConstructorDeclarationSyntax ctor, IReadOnlyList<ParameterSyntax> parameters, IReadOnlyList<StatementSyntax> statements, SyntaxTrivia eol)
    {
        if (parameters.Count > 0) ctor = ctor.WithParameterList(ctor.ParameterList.AddParameters(parameters.Select(p => p.WithAdditionalAnnotations(Formatter.Annotation)).ToArray()));
        if (statements.Count == 0) return ctor;
        var stmts = statements.Select(s => s.WithTrailingTrivia(eol)).ToArray();
        if (ctor.Body != null)
        {
            var body = ctor.Body;
            var oneLine = !body.OpenBraceToken.TrailingTrivia.Any(t => t.IsKind(SyntaxKind.EndOfLineTrivia)) && body.Statements.Count == 0;
            body = body.AddStatements(stmts);
            if (oneLine) body = body.WithOpenBraceToken(body.OpenBraceToken.WithTrailingTrivia(eol)).WithAdditionalAnnotations(Formatter.Annotation);
            return ctor.WithBody(body);
        }
        if (ctor.ExpressionBody != null)
        {
            var first = SyntaxFactory.ExpressionStatement(ctor.ExpressionBody.Expression.WithoutTrivia()).WithTrailingTrivia(eol);
            var block = SyntaxFactory.Block(new[] { (StatementSyntax)first }.Concat(stmts)).WithOpenBraceToken(SyntaxFactory.Token(SyntaxKind.OpenBraceToken).WithTrailingTrivia(eol))
                .WithCloseBraceToken(SyntaxFactory.Token(SyntaxKind.CloseBraceToken).WithTrailingTrivia(ctor.SemicolonToken.TrailingTrivia))
                .WithAdditionalAnnotations(Formatter.Annotation);
            var withoutArrow = ctor.WithExpressionBody(null).WithSemicolonToken(default);
            withoutArrow = withoutArrow.Initializer != null
                ? withoutArrow.WithInitializer(withoutArrow.Initializer.WithTrailingTrivia(eol))
                : withoutArrow.WithParameterList(withoutArrow.ParameterList.WithTrailingTrivia(eol));
            return withoutArrow.WithBody(block);
        }
        throw new Refusal("NoBody", "The constructor has no body.");
    }

    private static ParameterSyntax Parameter(ITypeSymbol type, string name) =>
        SyntaxFactory.Parameter(SyntaxFactory.Identifier(name)).WithType(TypeSyntaxOf(type).WithTrailingTrivia(SyntaxFactory.Space)).WithAdditionalAnnotations(Simplifier.Annotation, Imports);

    // ------------------------------------------------------------------ call sites

    /// <summary>Refuses when the constructor is called (new, : this / : base) or, for a parameterless one, inherited implicitly.</summary>
    private static async Task CallSitesBlockAsync(Ctx c, IMethodSymbol? ctor)
    {
        if (c.Type.IsValueType && ctor == null) return;
        ctor ??= c.Type.InstanceConstructors.FirstOrDefault(k => k.IsImplicitlyDeclared);
        if (ctor == null) return;
        var count = 0;
        foreach (var r in await SymbolFinder.FindReferencesAsync(ctor, c.Solution, c.Ct).ConfigureAwait(false))
            count += r.Locations.Count();
        if (count == 0 && ctor.Parameters.Length == 0 && !c.Type.IsSealed && c.Type.TypeKind == TypeKind.Class)
            count += (await SymbolFinder.FindDerivedClassesAsync(c.Type, c.Solution, transitive: false, cancellationToken: c.Ct).ConfigureAwait(false)).Count();
        if (count > 0)
            throw new Refusal("CallSites", $"'{c.Type.Name}' is created with 'new' (or the constructor is called) in {count} place(s); adding constructor parameters would break them. Change the signature with Refyntra: Change Signature (it updates call sites) or add the arguments yourself.");
    }

    // ------------------------------------------------------------------ actions

    private static Solution Replace(Solution solution, SyntaxNode oldNode, SyntaxNode newNode)
    {
        var doc = solution.GetDocument(oldNode.SyntaxTree)!;
        var root = oldNode.SyntaxTree.GetRoot();
        return doc.WithSyntaxRoot(root.ReplaceNode(oldNode, newNode)).Project.Solution;
    }

    private static async Task<Solution> IntroduceAsync(Ctx c, CtorRequest r, Naming style)
    {
        var at = ParameterAt(c) ?? throw new Refusal("NotApplicable", "Place the cursor on a constructor parameter.");
        if (at.Primary && c.Type.IsRecord) throw new Refusal("NotApplicable", "Positional record parameters already are properties.");
        var param = c.Model.GetDeclaredSymbol(at.Syntax, c.Ct) ?? throw new Refusal("NotApplicable", "The parameter has no symbol.");
        var eol = Eol(c.Text);
        var pName = Esc(param.Name);
        if (r.ActionId == InitializeExisting)
        {
            if (at.Ctor == null) throw new Refusal("NotApplicable", "Initialise an existing member from a primary constructor parameter with '= parameter;'.");
            var existing = UnassignedMembers(c).FirstOrDefault(m => m.Name == r.Member) ?? throw new Refusal("UnknownMember", $"'{r.Member}' is not an unassigned field or property.");
            var ctor2 = ExtendConstructor(at.Ctor, Array.Empty<ParameterSyntax>(), new[] { Assignment(existing.Name, pName) }, eol);
            return Replace(c.Solution, at.Ctor, ctor2);
        }
        var property = r.ActionId == IntroduceProperty;
        var name = property ? PropertyName(param.Name) : FieldName(param.Name, style);
        if (Taken(c, name)) throw new Refusal("NameTaken", $"A member named '{name}' already exists.");
        if (at.Primary)
        {
            var member = property ? PropertySyntax(param.Type, name, pName) : FieldSyntax(param.Type, name, pName);
            var newDecl = property ? InsertMembers(c.Decl, new[] { member }, IsDataMember, false, eol) : AddFields(c.Decl, new[] { member }, eol);
            return Replace(c.Solution, c.Decl, newDecl);
        }
        var decl = c.Decl.TrackNodes(at.Ctor!);
        var ctor = decl.GetCurrentNode(at.Ctor!)!;
        decl = decl.ReplaceNode(ctor, ExtendConstructor(ctor, Array.Empty<ParameterSyntax>(), new[] { Assignment(name, pName) }, eol));
        var m2 = property ? PropertySyntax(param.Type, name, null) : FieldSyntax(param.Type, name, null);
        decl = property ? InsertMembers(decl, new[] { m2 }, IsDataMember, false, eol) : AddFields(decl, new[] { m2 }, eol);
        await Task.CompletedTask.ConfigureAwait(false);
        return Replace(c.Solution, c.Decl, decl);
    }

    private static Task<Solution> InitializeAllAsync(Ctx c, Naming style)
    {
        var at = ParameterAt(c);
        if (at?.Ctor == null) throw new Refusal("NotApplicable", "Place the cursor on a parameter of a constructor.");
        var unused = UnusedParameters(c, at.Ctor);
        if (unused.Count == 0) throw new Refusal("NothingToDo", "Every constructor parameter is already used.");
        var free = UnassignedMembers(c);
        var fields = new List<MemberDeclarationSyntax>();
        var statements = new List<StatementSyntax>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in unused)
        {
            var ps = c.Model.GetDeclaredSymbol(p, c.Ct)!;
            var existing = free.FirstOrDefault(m => SymbolEqualityComparer.Default.Equals(TypeOf(m), ps.Type));
            if (existing != null)
            {
                free.Remove(existing);
                statements.Add(Assignment(existing.Name, Esc(ps.Name)));
                continue;
            }
            var name = FieldName(ps.Name, style);
            if (Taken(c, name) || !names.Add(name)) throw new Refusal("NameTaken", $"A member named '{name}' already exists.");
            fields.Add(FieldSyntax(ps.Type, name, null));
            statements.Add(Assignment(name, Esc(ps.Name)));
        }
        var eol = Eol(c.Text);
        var decl = c.Decl.TrackNodes(at.Ctor);
        var ctor = decl.GetCurrentNode(at.Ctor)!;
        decl = decl.ReplaceNode(ctor, ExtendConstructor(ctor, Array.Empty<ParameterSyntax>(), statements, eol));
        decl = AddFields(decl, fields, eol);
        return Task.FromResult(Replace(c.Solution, c.Decl, decl));
    }

    /// <summary>Initialise members from a constructor: adds parameters and assignments, or creates the constructor.</summary>
    private static async Task<Solution> InitializeMembersAsync(Ctx c, CtorRequest r, Naming style)
    {
        var candidates = r.ActionId == AddParameters ? UnassignedMembers(c)
            : Ordered(c, UnassignedMembers(c).Concat(ConstructorCandidates(c)).Distinct(SymbolEqualityComparer.Default)).OrderBy(m => m is IFieldSymbol ? 0 : 1).ToList();
        if (r.Members == null || r.Members.Count == 0)
        {
            var unassigned = UnassignedMembers(c);
            if (candidates.Count == 0) throw new Refusal("NoMembers", $"'{c.Type.Name}' has no fields or properties a constructor can initialise.");
            throw new Question(CtorOutcome.Ask("members", candidates.Select(m => new CtorChoice(m.Name, m.Name,
                $"{TypeOf(m).ToMinimalDisplayString(c.Model, c.Pos, Short)} · {(m is IFieldSymbol ? "field" : "property")}{(unassigned.Contains(m, SymbolEqualityComparer.Default) ? " · not initialised" : "")}",
                unassigned.Contains(m, SymbolEqualityComparer.Default))).ToList(), "Fields and properties to initialise"));
        }
        var members = r.Members.Select(n => candidates.FirstOrDefault(m => m.Name == n) ?? throw new Refusal("UnknownMember", $"'{n}' cannot be initialised from a constructor.")).ToList();
        return await AddMembersToConstructorAsync(c, members, r.Constructor, style, extraField: null).ConfigureAwait(false);
    }

    /// <summary>
    /// Adds a parameter + assignment per member to the chosen constructor (asks when there are several; creates one when
    /// there is none; a primary constructor gets the parameters and the members initialisers). <paramref name="extraField"/>:
    /// a new field (Create field and inject) added to the part at the cursor.
    /// </summary>
    private static async Task<Solution> AddMembersToConstructorAsync(Ctx c, IReadOnlyList<ISymbol> members, string? ctorChoice, Naming style, (ITypeSymbol Type, string Name)? extraField)
    {
        var eol = Eol(c.Text);
        var solution = c.Solution;
        var memberList = members.Select(m => (Name: m.Name, Type: TypeOf(m), Symbol: (ISymbol?)m)).ToList();
        if (extraField is { } ef) memberList.Add((ef.Name, ef.Type, null));

        if (HasPrimary(c))
        {
            var primaryPart = Parts(c).First(p => p.ParameterList != null);
            var primary = c.Type.InstanceConstructors.FirstOrDefault(k => k.DeclaringSyntaxReferences.Any(s => s.GetSyntax(c.Ct) == primaryPart));
            await CallSitesBlockAsync(c, primary).ConfigureAwait(false);
            var names = new HashSet<string>(primaryPart.ParameterList!.Parameters.Select(p => p.Identifier.ValueText), StringComparer.Ordinal);
            var parameters = new List<ParameterSyntax>();
            var tracked = primaryPart.TrackNodes(members.SelectMany(m => m.DeclaringSyntaxReferences.Select(s => s.GetSyntax(c.Ct))).Where(s => s.SyntaxTree == primaryPart.SyntaxTree && primaryPart.Span.Contains(s.Span)));
            var newFields = new List<MemberDeclarationSyntax>();
            foreach (var m in memberList)
            {
                var p = ParameterName(m.Name);
                while (!names.Add(p.TrimStart('@'))) p += "1";
                parameters.Add(Parameter(m.Type, p));
                if (m.Symbol == null) { newFields.Add(FieldSyntax(m.Type, m.Name, p)); continue; }
                var syntax = m.Symbol.DeclaringSyntaxReferences.Select(s => s.GetSyntax(c.Ct)).First();
                if (syntax.SyntaxTree != primaryPart.SyntaxTree || !primaryPart.Span.Contains(syntax.Span))
                    throw new Refusal("PrimaryConstructorScope", $"'{m.Name}' is declared in another part of '{c.Type.Name}'; primary constructor parameters are only in scope in the part that declares them.");
                var current = tracked.GetCurrentNode(syntax)!;
                SyntaxNode replaced = current switch
                {
                    VariableDeclaratorSyntax v => v.WithInitializer(SyntaxFactory.EqualsValueClause(SyntaxFactory.IdentifierName(p)).WithAdditionalAnnotations(Formatter.Annotation)),
                    PropertyDeclarationSyntax pd => pd.WithInitializer(SyntaxFactory.EqualsValueClause(SyntaxFactory.IdentifierName(p))).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken).WithTrailingTrivia(pd.GetTrailingTrivia()))
                        .WithAccessorList(pd.AccessorList!.WithTrailingTrivia(SyntaxFactory.Space)).WithAdditionalAnnotations(Formatter.Annotation),
                    _ => throw new Refusal("NotApplicable", $"'{m.Name}' cannot be initialised."),
                };
                tracked = tracked.ReplaceNode(current, replaced);
            }
            tracked = tracked.WithParameterList(tracked.ParameterList!.AddParameters(parameters.Select(x => x.WithAdditionalAnnotations(Formatter.Annotation)).ToArray()));
            tracked = AddFields(tracked, newFields, eol);
            return Replace(solution, primaryPart, tracked);
        }

        var ctors = ExplicitConstructors(c).Where(k => k.Initializer is not { ThisOrBaseKeyword.RawKind: (int)SyntaxKind.ThisKeyword }).ToList();
        ConstructorDeclarationSyntax? target = null;
        if (ExplicitConstructors(c).Any())
        {
            if (ctors.Count == 0) throw new Refusal("NoConstructor", "Every constructor chains to another one with ': this(...)'.");
            if (ctors.Count == 1) target = ctors[0];
            else
            {
                string Id(ConstructorDeclarationSyntax k) => k.SyntaxTree.FilePath + "@" + k.SpanStart;
                target = ctors.FirstOrDefault(k => Id(k) == ctorChoice);
                if (target == null)
                    throw new Question(CtorOutcome.Ask("constructor", ctors.Select(k => new CtorChoice(Id(k), $"{c.Type.Name}{k.ParameterList.ToString().Trim()}", Path.GetFileName(k.SyntaxTree.FilePath), false)).ToList(), "Choose the constructor to extend"));
            }
        }

        if (target == null)
        {
            await CallSitesBlockAsync(c, null).ConfigureAwait(false);
            var access = c.Type.IsAbstract ? "protected" : "public";
            var ps = memberList.Select(m => $"{m.Type.ToDisplayString(Full)} {ParameterName(m.Name)}");
            var body = memberList.Select(m => $"this.{Esc(m.Name)} = {ParameterName(m.Name)};");
            var ctorSyntax = Annotate(SyntaxFactory.ParseMemberDeclaration($"{access} {Esc(c.Type.Name)}({string.Join(", ", ps)})\n{{\n{string.Join("\n", body)}\n}}\n")!);
            var decl = c.Decl;
            if (extraField is { } f0) decl = AddFields(decl, new[] { FieldSyntax(f0.Type, f0.Name, null) }, eol);
            decl = InsertMembers(decl, new[] { ctorSyntax }, IsDataOrCtor, true, eol);
            return Replace(solution, c.Decl, decl);
        }

        var ctorSymbol = (IMethodSymbol)ModelFor(c, target.SyntaxTree).GetDeclaredSymbol(target, c.Ct)!;
        var model = ModelFor(c, target.SyntaxTree);
        var usedNames = new HashSet<string>(target.ParameterList.Parameters.Select(p => p.Identifier.ValueText), StringComparer.Ordinal);
        var newParams = new List<ParameterSyntax>();
        var statements = new List<StatementSyntax>();
        var reused = new HashSet<string>(StringComparer.Ordinal);
        foreach (var m in memberList)
        {
            // An unused parameter of the same type is reused instead of adding one.
            var same = target.ParameterList.Parameters.FirstOrDefault(p => !reused.Contains(p.Identifier.ValueText)
                && model.GetDeclaredSymbol(p, c.Ct) is { } ps && SymbolEqualityComparer.Default.Equals(ps.Type, m.Type)
                && !IsParameterUsedIn(model, target, p, c.Ct));
            string pn;
            if (same != null)
            {
                pn = Esc(same.Identifier.ValueText);
                reused.Add(same.Identifier.ValueText);
            }
            else
            {
                pn = ParameterName(m.Name);
                while (!usedNames.Add(pn.TrimStart('@'))) pn += "1";
                newParams.Add(Parameter(m.Type, pn));
            }
            statements.Add(Assignment(m.Name, pn));
        }
        if (newParams.Count > 0) await CallSitesBlockAsync(c, ctorSymbol).ConfigureAwait(false);
        var newCtor = ExtendConstructor(target, newParams, statements, eol);
        if (extraField is { } f1 && target.Parent == c.Decl)
        {
            var decl = c.Decl.TrackNodes(target);
            decl = decl.ReplaceNode(decl.GetCurrentNode(target)!, newCtor);
            decl = AddFields(decl, new[] { FieldSyntax(f1.Type, f1.Name, null) }, eol);
            return Replace(solution, c.Decl, decl);
        }
        solution = Replace(solution, target, newCtor);
        if (extraField is { } f2)
        {
            // The constructor is in another part: the field goes into the part at the cursor.
            var doc = solution.GetDocument(c.Doc.Id)!;
            var root = await doc.GetSyntaxRootAsync(c.Ct).ConfigureAwait(false);
            var decl = root!.FindNode(c.Decl.Span).AncestorsAndSelf().OfType<TypeDeclarationSyntax>().First();
            solution = doc.WithSyntaxRoot(root.ReplaceNode(decl, AddFields(decl, new[] { FieldSyntax(f2.Type, f2.Name, null) }, eol))).Project.Solution;
        }
        return solution;
    }

    private static bool IsParameterUsedIn(SemanticModel model, ConstructorDeclarationSyntax ctor, ParameterSyntax p, CancellationToken ct)
    {
        var symbol = model.GetDeclaredSymbol(p, ct);
        return new SyntaxNode?[] { ctor.Initializer, ctor.Body, ctor.ExpressionBody }.Where(n => n != null)
            .SelectMany(n => n!.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            .Any(id => id.Identifier.ValueText == p.Identifier.ValueText && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id, ct).Symbol, symbol));
    }

    // ------------------------------------------------------------------ create field and inject

    private static async Task<(Solution, string?, INamedTypeSymbol?)> CreateInjectedAsync(Ctx c, CtorRequest r, Naming style)
    {
        var id = UndeclaredFieldAt(c);
        var name = id?.Identifier.ValueText ?? r.Member ?? throw new Refusal("NotApplicable", "Place the cursor on an undeclared field name such as '_repository'.");
        if (Taken(c, name)) throw new Refusal("NameTaken", $"A member named '{name}' already exists.");
        ITypeSymbol type;
        string? note = null;
        if (!string.IsNullOrWhiteSpace(r.Type))
            type = await ResolveTypeAsync(c, r.Type!).ConfigureAwait(false) ?? throw new Refusal("UnknownType", $"'{r.Type}' is not a type known in the solution.");
        else
        {
            var (inferred, why, choices) = await InferTypeAsync(c, name).ConfigureAwait(false);
            if (inferred == null) throw new Question(CtorOutcome.Ask("type", choices, why));
            type = inferred;
            note = why;
        }
        var solution = await AddMembersToConstructorAsync(c, Array.Empty<ISymbol>(), r.Constructor, style, (type, name)).ConfigureAwait(false);
        INamedTypeSymbol? register = null;
        if (type is INamedTypeSymbol nt && IsRegistrable(nt) && !await DiRegistrationPlanner.IsRegisteredAsync(c.Snap, nt, c.Ct).ConfigureAwait(false)) register = nt;
        return (solution, note, register);
    }

    private static async Task<ITypeSymbol?> ResolveTypeAsync(Ctx c, string text)
    {
        if (text.StartsWith("T:", StringComparison.Ordinal))
        {
            foreach (var project in c.Solution.Projects)
            {
                var comp = await project.GetCompilationAsync(c.Ct).ConfigureAwait(false);
                if (comp != null && DocumentationCommentId.GetFirstSymbolForDeclarationId(text, comp) is ITypeSymbol t && c.Model.Compilation.GetTypeByMetadataName(MetadataName(t)) is { } local)
                    return local;
            }
            return null;
        }
        var parsed = SyntaxFactory.ParseTypeName(text);
        if (parsed.ContainsDiagnostics) return null;
        var bound = c.Model.GetSpeculativeTypeInfo(c.Decl.SpanStart, parsed, SpeculativeBindingOption.BindAsTypeOrNamespace).Type;
        if (bound != null && bound.TypeKind != TypeKind.Error) return bound;
        // A simple name of a type that is not imported here: the unique source type with that name (a using is added).
        if (parsed is IdentifierNameSyntax simple)
        {
            var found = (await SymbolFinder.FindSourceDeclarationsAsync(c.Doc.Project, n => n == simple.Identifier.ValueText, SymbolFilter.Type, c.Ct).ConfigureAwait(false))
                .OfType<INamedTypeSymbol>().Where(t => t.Arity == 0 && c.Model.Compilation.IsSymbolAccessibleWithin(t, c.Type)).ToList();
            if (found.Count == 1) return found[0];
        }
        return null;
    }

    private static string MetadataName(ITypeSymbol t)
    {
        var ns = t.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : "";
        var outer = t.ContainingType != null ? MetadataName(t.ContainingType) + "+" : ns;
        return outer + t.MetadataName;
    }

    private static readonly (string Name, string Metadata, bool Generic)[] WellKnown =
    {
        ("logger", "Microsoft.Extensions.Logging.ILogger`1", true),
        ("mediator", "MediatR.IMediator", false),
        ("sender", "MediatR.ISender", false),
        ("publisher", "MediatR.IPublisher", false),
        ("configuration", "Microsoft.Extensions.Configuration.IConfiguration", false),
        ("config", "Microsoft.Extensions.Configuration.IConfiguration", false),
        ("httpClientFactory", "System.Net.Http.IHttpClientFactory", false),
        ("httpClient", "System.Net.Http.HttpClient", false),
        ("serviceProvider", "System.IServiceProvider", false),
        ("timeProvider", "System.TimeProvider", false),
        ("loggerFactory", "Microsoft.Extensions.Logging.ILoggerFactory", false),
    };

    /// <summary>
    /// The type of an undeclared field: a well-known name (<c>_logger</c> → ILogger&lt;T&gt; when Microsoft.Extensions.Logging
    /// is referenced), an assignment <c>_x = expr</c>, or the solution types that have every member used on it
    /// (interfaces first). Null with choices when the user has to pick.
    /// </summary>
    private static async Task<(ITypeSymbol? Type, string Why, IReadOnlyList<CtorChoice> Choices)> InferTypeAsync(Ctx c, string name)
    {
        var comp = c.Model.Compilation;
        var bare = Bare(name);
        foreach (var (n, metadata, generic) in WellKnown)
        {
            if (!string.Equals(n, bare, StringComparison.OrdinalIgnoreCase)) continue;
            if (comp.GetTypeByMetadataName(metadata) is { } wk)
                return (generic ? wk.Construct(c.Type) : wk, $"'{name}' is a {wk.Name}.", Array.Empty<CtorChoice>());
        }
        // Every use in every part of the type.
        var memberNames = new List<(string Name, bool Invoked, int Args)>();
        foreach (var part in Parts(c))
        {
            var model = ModelFor(c, part.SyntaxTree);
            foreach (var use in part.DescendantNodes().OfType<IdentifierNameSyntax>().Where(x => x.Identifier.ValueText == name))
            {
                if (use.Parent is AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a && a.Left == use
                    && model.GetTypeInfo(a.Right, c.Ct).Type is { TypeKind: not TypeKind.Error } assigned && assigned.SpecialType != SpecialType.System_Object)
                    return (assigned, $"'{name}' is assigned a {assigned.Name}.", Array.Empty<CtorChoice>());
                if (use.Parent is MemberAccessExpressionSyntax ma && ma.Expression == use)
                {
                    var invoked = ma.Parent is InvocationExpressionSyntax inv && inv.Expression == ma ? inv.ArgumentList.Arguments.Count : -1;
                    memberNames.Add((ma.Name.Identifier.ValueText, invoked >= 0, invoked));
                }
                else if (use.Parent is ConditionalAccessExpressionSyntax ca && ca.Expression == use && ca.WhenNotNull is InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax mb } inv2)
                    memberNames.Add((mb.Name.Identifier.ValueText, true, inv2.ArgumentList.Arguments.Count));
            }
        }
        var candidates = new List<INamedTypeSymbol>();
        if (memberNames.Count > 0)
        {
            var first = memberNames[0].Name;
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var project in c.Solution.Projects)
            {
                foreach (var s in await SymbolFinder.FindSourceDeclarationsAsync(project, x => x == first, SymbolFilter.Member, c.Ct).ConfigureAwait(false))
                {
                    if (s.ContainingType is not { } t || !seen.Add(t)) continue;
                    if (t.IsStatic || t.IsGenericType || t.TypeKind is not (TypeKind.Interface or TypeKind.Class or TypeKind.Struct)) continue;
                    if (memberNames.All(u => HasMember(t, u.Name, u.Invoked, u.Args))) candidates.Add(t);
                }
            }
            // Same-named types from several projects: keep the one this project sees.
            candidates = candidates.Select(t => comp.GetTypeByMetadataName(MetadataName(t)) ?? t).Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default)
                .Where(t => comp.IsSymbolAccessibleWithin(t, c.Type)).ToList();
            var interfaces = candidates.Where(t => t.TypeKind == TypeKind.Interface).ToList();
            if (interfaces.Count == 1) return (interfaces[0], $"{interfaces[0].Name} is the only interface with {string.Join(", ", memberNames.Select(m => m.Name).Distinct())}.", Array.Empty<CtorChoice>());
            if (interfaces.Count == 0 && candidates.Count == 1) return (candidates[0], $"{candidates[0].Name} is the only type with {string.Join(", ", memberNames.Select(m => m.Name).Distinct())}.", Array.Empty<CtorChoice>());
        }
        if (candidates.Count == 0)
        {
            // Nothing to go by: solution types whose name resembles the field, interfaces first.
            var lower = bare.ToLowerInvariant();
            foreach (var project in c.Solution.Projects)
                foreach (var s in await SymbolFinder.FindSourceDeclarationsAsync(project, x => x.Contains(lower, StringComparison.OrdinalIgnoreCase) || lower.Contains(x.TrimStart('I').ToLowerInvariant(), StringComparison.Ordinal) && x.Length > 3, SymbolFilter.Type, c.Ct).ConfigureAwait(false))
                    if (s is INamedTypeSymbol { IsStatic: false, IsGenericType: false, TypeKind: TypeKind.Interface or TypeKind.Class or TypeKind.Struct } t && comp.GetTypeByMetadataName(MetadataName(t)) is { } local
                        && comp.IsSymbolAccessibleWithin(local, c.Type))
                        candidates.Add(local);
        }
        var ranked = Rank(bare, candidates.Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default)).Take(MaxTypeChoices).ToList();
        var choices = ranked.Select((t, i) => new CtorChoice(t.GetDocumentationCommentId()!, t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            (t.TypeKind == TypeKind.Interface ? "interface" : t.TypeKind == TypeKind.Struct ? "struct" : "class") + (t.ContainingNamespace is { IsGlobalNamespace: false } ns ? " · " + ns.ToDisplayString() : ""), i == 0)).ToList();
        var why = memberNames.Count > 0 && ranked.Count > 0
            ? $"Several types have {string.Join(", ", memberNames.Select(m => m.Name).Distinct())}: choose the type of '{name}'"
            : $"Type of '{name}' (interfaces first; type a name to use another)";
        return (null, why, choices);
    }

    private static bool HasMember(INamedTypeSymbol t, string name, bool invoked, int args)
    {
        IEnumerable<INamedTypeSymbol> All()
        {
            for (var x = t; x != null; x = x.BaseType) yield return x;
            foreach (var i in t.AllInterfaces) yield return i;
        }
        return All().SelectMany(x => x.GetMembers(name)).Any(m => !m.IsStatic && (invoked
            ? m is IMethodSymbol ms && args >= ms.Parameters.Count(p => !p.IsOptional && !p.IsParams) && (args <= ms.Parameters.Length || ms.Parameters.Any(p => p.IsParams))
              || m is IPropertySymbol { Type: INamedTypeSymbol { TypeKind: TypeKind.Delegate } } || m is IFieldSymbol { Type: INamedTypeSymbol { TypeKind: TypeKind.Delegate } }
            : m is IPropertySymbol or IFieldSymbol or IEventSymbol || m is IMethodSymbol));
    }

    private static IEnumerable<INamedTypeSymbol> Rank(string bare, IEnumerable<INamedTypeSymbol> types)
    {
        var b = bare.ToLowerInvariant();
        int Score(INamedTypeSymbol t)
        {
            var n = t.Name.ToLowerInvariant();
            var core = t.TypeKind == TypeKind.Interface && n.Length > 1 && n[0] == 'i' ? n[1..] : n;
            var s = core == b ? 0 : core.EndsWith(b, StringComparison.Ordinal) || b.EndsWith(core, StringComparison.Ordinal) ? 1 : core.Contains(b, StringComparison.Ordinal) ? 2 : 3;
            return s * 2 + (t.TypeKind == TypeKind.Interface ? 0 : 1);
        }
        return types.OrderBy(Score).ThenBy(t => t.Name, StringComparer.Ordinal);
    }

    // ------------------------------------------------------------------ DI helpers

    /// <summary>Types the container supplies itself, value types and strings are never offered for registration.</summary>
    internal static bool IsRegistrable(INamedTypeSymbol t)
    {
        if (t.TypeKind is not (TypeKind.Interface or TypeKind.Class) || t.SpecialType != SpecialType.None || t.IsStatic) return false;
        if (t.TypeKind == TypeKind.Class && t.IsValueType) return false;
        var ns = t.ContainingNamespace?.ToDisplayString() ?? "";
        if (ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal)) return false;
        if (ns.StartsWith("Microsoft.Extensions.", StringComparison.Ordinal) || ns.StartsWith("Microsoft.AspNetCore.", StringComparison.Ordinal)) return false;
        if (ns == "MediatR" && t.Name is "IMediator" or "ISender" or "IPublisher") return false;
        return t.Locations.Any(l => l.IsInSource);
    }
}
