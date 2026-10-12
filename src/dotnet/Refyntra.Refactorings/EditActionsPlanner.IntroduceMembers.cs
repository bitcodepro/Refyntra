using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Introduce Field, Introduce Constant (single-document edit actions) and Introduce Parameter (a multi-file plan built
/// on the Change Signature machinery). Every choice is its own action id; ids of one family share the title prefix
/// before ": " so the client can ask with one QuickPick when several are valid.
/// </summary>
public static partial class EditActionsPlanner
{
    public const string IntroduceFieldInitializer = Prefix + "introduceField.initializer";
    public const string IntroduceFieldInitializerAll = Prefix + "introduceField.initializerAll";
    public const string IntroduceFieldConstructor = Prefix + "introduceField.constructor";
    public const string IntroduceFieldConstructorAll = Prefix + "introduceField.constructorAll";
    public const string IntroduceFieldMember = Prefix + "introduceField.member";
    public const string IntroduceConstantLocal = Prefix + "introduceConstant.local";
    public const string IntroduceConstantClass = Prefix + "introduceConstant.class";
    /// <summary>Listed as an edit action; the client runs it as the plan <see cref="IntroduceParameterAction"/> (preview first).</summary>
    public const string IntroduceParameter = Prefix + "introduceParameter";
    /// <summary>refactor/prepare action id of Introduce Parameter (documentUri + range).</summary>
    public const string IntroduceParameterAction = "csharp.introduceParameter";

    private const string ExtractKind = "refactor.extract.refyntra.";

    private static void AddIntroduceMembers(Ctx c, Action<string, string, string, Func<Task<Document>>?> add)
    {
        var expr = SelectedExpression(c);
        if (expr == null) return;
        var type = c.Model.GetTypeInfo(expr, c.Ct).Type!;
        var typeDecl = expr.FirstAncestorOrSelf<TypeDeclarationSyntax>();
        var member = MemberOf(expr);
        var stmt = expr.Ancestors().OfType<StatementSyntax>().FirstOrDefault();
        var inBlock = stmt != null && stmt.Parent is BlockSyntax or SwitchSectionSyntax && stmt is not LocalFunctionStatementSyntax;
        if (typeDecl is null or InterfaceDeclarationSyntax || member == null) return;
        var deps = DependenciesOf(c, expr);
        if (expr.Ancestors().Any(a => a is AttributeArgumentSyntax or ParameterSyntax)) return;

        // ---------------- Introduce Field
        var typeText = DisplayLocalType(c, type, typeDecl.SpanStart);
        if (typeText != null && !UsesMethodTypeParameters(type) && member is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax)
        {
            var isStatic = IsStaticContext(member, typeDecl);
            if (!deps.Locals && (isStatic || !deps.Instance))
            {
                add(IntroduceFieldInitializer, "Introduce field: initialize in the field initializer", ExtractKind + "field", () => IntroduceFieldAsync(c, expr, typeText, isStatic, FieldInit.Initializer, all: false));
                if (!deps.Unstable)
                    add(IntroduceFieldInitializerAll, "Introduce field: initialize in the field initializer, replace all occurrences in the type", ExtractKind + "field", () => IntroduceFieldAsync(c, expr, typeText, isStatic, FieldInit.Initializer, all: true));
            }
            if (!deps.Locals && CanInitializeInConstructors(c, typeDecl, isStatic))
            {
                add(IntroduceFieldConstructor, isStatic ? "Introduce field: initialize in the static constructor" : "Introduce field: initialize in the constructor(s)", ExtractKind + "field", () => IntroduceFieldAsync(c, expr, typeText, isStatic, FieldInit.Constructor, all: false));
                if (!deps.Unstable)
                    add(IntroduceFieldConstructorAll, (isStatic ? "Introduce field: initialize in the static constructor" : "Introduce field: initialize in the constructor(s)") + ", replace all occurrences in the type", ExtractKind + "field", () => IntroduceFieldAsync(c, expr, typeText, isStatic, FieldInit.Constructor, all: true));
            }
            if (inBlock && member is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax)
                add(IntroduceFieldMember, "Introduce field: initialize in the current member", ExtractKind + "field", () => IntroduceFieldAsync(c, expr, typeText, isStatic, FieldInit.Member, all: false));
        }

        // ---------------- Introduce Constant
        if (ConstantType(c, expr, type) is { } constType)
        {
            if (inBlock && member is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax)
                add(IntroduceConstantLocal, "Introduce constant: local constant in this member", ExtractKind + "constant", () => IntroduceConstantAsync(c, expr, type, constType, local: true));
            if (!deps.Locals)
                add(IntroduceConstantClass, "Introduce constant: constant of the type, replace all occurrences in the type", ExtractKind + "constant", () => IntroduceConstantAsync(c, expr, type, constType, local: false));
        }

        // ---------------- Introduce Parameter (a plan: computed through refactor/prepare)
        if (member is MethodDeclarationSyntax && expr.FirstAncestorOrSelf<LocalFunctionStatementSyntax>() == null)
            add(IntroduceParameter, "Introduce parameter (updates every call site; preview first)", ExtractKind + "parameter",
                () => throw new Refusal("UsePlan", $"Introduce Parameter is prepared as a plan: refactor/prepare with actionId {IntroduceParameterAction}."));
    }

    // ------------------------------------------------------------------ shared analysis

    /// <summary>The expression exactly covered by the selection that can become a member (or null).</summary>
    private static ExpressionSyntax? SelectedExpression(Ctx c)
    {
        var node = c.Root.FindNode(c.Span, getInnermostNodeForTie: true);
        while (node.Parent != null && node.Parent.Span == node.Span && node is not ExpressionSyntax) node = node.Parent;
        while (node is ExpressionSyntax && node.Parent is ExpressionSyntax pp && pp.Span == node.Span) node = pp;
        if (node is not ExpressionSyntax expr || expr.Span != c.Span) return null;
        if (expr is IdentifierNameSyntax or LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression or (int)SyntaxKind.DefaultLiteralExpression }
            or AssignmentExpressionSyntax or DeclarationExpressionSyntax or ThrowExpressionSyntax or AnonymousFunctionExpressionSyntax or RefExpressionSyntax
            || expr.Parent is NameColonSyntax || expr.Parent is MemberAccessExpressionSyntax { Name: var nm } && nm == expr
            || expr.Parent is AssignmentExpressionSyntax asg && asg.Left == expr || expr.Parent is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None }
            || expr.Parent is PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.PreIncrementExpression or (int)SyntaxKind.PreDecrementExpression or (int)SyntaxKind.AddressOfExpression }
            || expr.Parent is PostfixUnaryExpressionSyntax || InNameOf(expr))
            return null;
        var type = c.Model.GetTypeInfo(expr, c.Ct).Type;
        if (type == null || type.SpecialType == SpecialType.System_Void || type is IErrorTypeSymbol || type.IsRefLikeType
            || c.Model.GetSymbolInfo(expr, c.Ct).Symbol is INamespaceOrTypeSymbol)
            return null;
        if (expr is MemberAccessExpressionSyntax or GenericNameSyntax && c.Model.GetSymbolInfo(expr, c.Ct).Symbol is IMethodSymbol) return null; // method group
        return expr;
    }

    /// <summary>The member of the type that contains the expression (method, constructor, operator, property, indexer).</summary>
    private static MemberDeclarationSyntax? MemberOf(ExpressionSyntax expr) =>
        expr.Ancestors().OfType<MemberDeclarationSyntax>().FirstOrDefault(m => m.Parent is TypeDeclarationSyntax) is { } m
        && m is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax ? m : null;

    private static bool IsStaticContext(MemberDeclarationSyntax member, TypeDeclarationSyntax type) =>
        member.Modifiers.Any(SyntaxKind.StaticKeyword) || type.Modifiers.Any(SyntaxKind.StaticKeyword);

    private static bool UsesMethodTypeParameters(ITypeSymbol t) => t switch
    {
        ITypeParameterSymbol tp => tp.TypeParameterKind == TypeParameterKind.Method,
        INamedTypeSymbol n => n.TypeArguments.Any(UsesMethodTypeParameters),
        IArrayTypeSymbol a => UsesMethodTypeParameters(a.ElementType),
        _ => false,
    };

    /// <summary>What the expression depends on: locals/parameters, the instance, and values that may change.</summary>
    private sealed record Dependencies(bool Locals, bool Instance, bool Unstable);

    private static Dependencies DependenciesOf(Ctx c, ExpressionSyntax expr)
    {
        bool locals = false, instance = false, unstable = !CodeFacts.IsSideEffectFree(expr, c.Model, c.Ct);
        foreach (var n in expr.DescendantNodesAndSelf())
        {
            if (n is ThisExpressionSyntax or BaseExpressionSyntax) { instance = true; unstable = true; continue; }
            if (n is not SimpleNameSyntax id || InNameOf(id)) continue;
            var sym = c.Model.GetSymbolInfo(id, c.Ct).Symbol;
            if (sym == null || sym.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == expr.SyntaxTree && expr.Span.Contains(r.Span))) continue;
            var implicitThis = !(id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id) && id.Parent is not MemberBindingExpressionSyntax;
            switch (sym)
            {
                case ILocalSymbol l:
                    locals = true;
                    if (!l.IsConst) unstable = true;
                    break;
                case IParameterSymbol or IRangeVariableSymbol:
                    locals = true; unstable = true;
                    break;
                case IMethodSymbol { MethodKind: MethodKind.LocalFunction }:
                    locals = true; unstable = true;
                    break;
                case IFieldSymbol f:
                    if (!f.IsStatic && !f.IsConst && implicitThis) instance = true;
                    if (!f.IsConst && !f.IsReadOnly) unstable = true;
                    break;
                case IPropertySymbol or IEventSymbol or IMethodSymbol:
                    if (!sym.IsStatic && implicitThis) instance = true;
                    unstable = true;
                    break;
            }
        }
        return new Dependencies(locals, instance, unstable);
    }

    /// <summary>The free name <c>prefix + base</c> (2, 3, …): not declared in the type, not visible at the expression, not an identifier used in the type.</summary>
    private static string FreeMemberName(Ctx c, TypeDeclarationSyntax typeDecl, ExpressionSyntax expr, string name)
    {
        var used = new HashSet<string>(typeDecl.DescendantTokens().Where(t => t.IsKind(SyntaxKind.IdentifierToken)).Select(t => t.ValueText), StringComparer.Ordinal);
        var typeSymbol = c.Model.GetDeclaredSymbol(typeDecl, c.Ct);
        bool Free(string n) => !used.Contains(n) && c.Model.LookupSymbols(expr.SpanStart, name: n).IsEmpty
            && (typeSymbol == null || typeSymbol.GetMembers(n).IsEmpty) && n != typeDecl.Identifier.ValueText;
        var candidate = name;
        for (var i = 2; !Free(candidate); i++) candidate = name + i;
        return candidate;
    }

    /// <summary>Other occurrences of <paramref name="expr"/> in the type (same syntax, same symbols) that can use the new member.</summary>
    private static List<ExpressionSyntax> OccurrencesInType(Ctx c, TypeDeclarationSyntax typeDecl, ExpressionSyntax expr, bool instanceMember, bool constant)
    {
        var list = new List<ExpressionSyntax> { expr };
        foreach (var e in typeDecl.DescendantNodes().OfType<ExpressionSyntax>())
        {
            if (e == expr || !SyntaxFactory.AreEquivalent(e, expr) || list.Any(o => o.Span.Contains(e.Span) || e.Span.Contains(o.Span))) continue;
            if (e.Ancestors().OfType<TypeDeclarationSyntax>().First() != typeDecl || InNameOf(e)) continue;
            if (e.Parent is AssignmentExpressionSyntax a && a.Left == e || e.Parent is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None }) continue;
            if (!constant && e.Ancestors().Any(x => x is AttributeArgumentSyntax or CaseSwitchLabelSyntax or ConstantPatternSyntax or ParameterSyntax
                || x is FieldDeclarationSyntax || x is PropertyDeclarationSyntax { Initializer: { } pi } && pi.Span.Contains(e.Span)
                || x is LocalDeclarationStatementSyntax { IsConst: true } || x is ConstructorInitializerSyntax)) continue;
            if (instanceMember && e.Ancestors().OfType<MemberDeclarationSyntax>().FirstOrDefault(m => m.Parent == typeDecl) is { } owner && owner.Modifiers.Any(SyntaxKind.StaticKeyword)) continue;
            if (!SameMeaning(c, expr, e)) continue;
            list.Add(e);
        }
        return list;
    }

    private static bool SameMeaning(Ctx c, ExpressionSyntax a, ExpressionSyntax b)
    {
        var na = a.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().ToList();
        var nb = b.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().ToList();
        if (na.Count != nb.Count) return false;
        for (var i = 0; i < na.Count; i++)
            if (!SymbolEqualityComparer.Default.Equals(c.Model.GetSymbolInfo(na[i], c.Ct).Symbol, c.Model.GetSymbolInfo(nb[i], c.Ct).Symbol)) return false;
        return SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(a, c.Ct).Type, c.Model.GetTypeInfo(b, c.Ct).Type)
            && SymbolEqualityComparer.Default.Equals(c.Model.GetTypeInfo(a, c.Ct).ConvertedType, c.Model.GetTypeInfo(b, c.Ct).ConvertedType);
    }

    private static MemberDeclarationSyntax? LastField(TypeDeclarationSyntax t, bool constants) =>
        t.Members.LastOrDefault(m => m is FieldDeclarationSyntax f && (!constants || f.Modifiers.Any(SyntaxKind.ConstKeyword)));

    private static void InsertMember(SyntaxEditor editor, TypeDeclarationSyntax typeDecl, MemberDeclarationSyntax? last, MemberDeclarationSyntax newMember)
    {
        if (last != null) editor.InsertAfter(last, newMember);
        else editor.InsertBefore(typeDecl.Members.First(), newMember);
    }

    // ------------------------------------------------------------------ introduce field

    private enum FieldInit { Initializer, Constructor, Member }

    /// <summary>Instance: every instance constructor of the type is declared in this part (or there is none and the type is a class); static: always.</summary>
    private static bool CanInitializeInConstructors(Ctx c, TypeDeclarationSyntax typeDecl, bool isStatic)
    {
        if (typeDecl.ParameterList != null && !isStatic) return false;
        if (c.Model.GetDeclaredSymbol(typeDecl, c.Ct) is not INamedTypeSymbol t) return false;
        var ctors = isStatic ? t.StaticConstructors : t.InstanceConstructors;
        var declared = ctors.Where(x => !x.IsImplicitlyDeclared).ToList();
        if (declared.Any(x => x.DeclaringSyntaxReferences.Any(r => r.SyntaxTree != typeDecl.SyntaxTree || !typeDecl.Span.Contains(r.Span))
            || x.DeclaringSyntaxReferences.Any(r => r.GetSyntax(c.Ct) is ConstructorDeclarationSyntax { Body: null, ExpressionBody: null }))) return false;
        if (declared.Count == 0 && !isStatic && typeDecl is not ClassDeclarationSyntax) return false;
        return true;
    }

    private static Task<Document> IntroduceFieldAsync(Ctx c, ExpressionSyntax expr, string typeText, bool isStatic, FieldInit init, bool all)
    {
        var typeDecl = expr.FirstAncestorOrSelf<TypeDeclarationSyntax>()!;
        StatementSyntax? stmt = null;
        if (init == FieldInit.Member)
        {
            stmt = expr.Ancestors().OfType<StatementSyntax>().First();
            CheckIntroducibleBefore(c, expr, stmt);
        }
        else if (expr.Ancestors().Any(a => a is CaseSwitchLabelSyntax or ConstantPatternSyntax || a is LocalDeclarationStatementSyntax { IsConst: true }))
            throw new Refusal("ConstantContext", "The expression must stay constant here.");
        var baseName = SuggestBaseName(expr, c.Model.GetTypeInfo(expr, c.Ct).Type!);
        var name = FreeMemberName(c, typeDecl, expr, "_" + baseName);
        var readOnly = init != FieldInit.Member;
        var occurrences = all ? OccurrencesInType(c, typeDecl, expr, !isStatic, constant: false) : new List<ExpressionSyntax> { expr };

        var modifiers = new List<SyntaxToken> { SyntaxFactory.Token(SyntaxKind.PrivateKeyword) };
        if (isStatic) modifiers.Add(SyntaxFactory.Token(SyntaxKind.StaticKeyword));
        if (readOnly) modifiers.Add(SyntaxFactory.Token(SyntaxKind.ReadOnlyKeyword));
        var declarator = SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(name));
        if (init == FieldInit.Initializer) declarator = declarator.WithInitializer(SyntaxFactory.EqualsValueClause(expr.WithoutTrivia()));
        var field = SyntaxFactory.FieldDeclaration(SyntaxFactory.VariableDeclaration(SyntaxFactory.ParseTypeName(typeText), SyntaxFactory.SingletonSeparatedList(declarator)))
            .WithModifiers(SyntaxFactory.TokenList(modifiers)).WithAdditionalAnnotations(Formatter.Annotation);

        var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
        foreach (var o in occurrences) editor.ReplaceNode(o, SyntaxFactory.IdentifierName(name).WithTriviaFrom(o));
        InsertMember(editor, typeDecl, LastField(typeDecl, constants: false), field);

        StatementSyntax Assign() => SyntaxFactory.ExpressionStatement(SyntaxFactory.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression,
            SyntaxFactory.IdentifierName(name), expr.WithoutTrivia())).WithAdditionalAnnotations(Formatter.Annotation);
        if (init == FieldInit.Member) editor.InsertBefore(stmt!, Assign());
        else if (init == FieldInit.Constructor)
        {
            var ctors = typeDecl.Members.OfType<ConstructorDeclarationSyntax>().Where(x => x.Modifiers.Any(SyntaxKind.StaticKeyword) == isStatic).ToList();
            var targets = ctors.Where(x => x.Initializer is not { RawKind: (int)SyntaxKind.ThisConstructorInitializer }).ToList();
            if (ctors.Count == 0)
            {
                var ctor = SyntaxFactory.ConstructorDeclaration(typeDecl.Identifier.WithoutTrivia())
                    .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(isStatic ? SyntaxKind.StaticKeyword : SyntaxKind.PublicKeyword)))
                    .WithBody(SyntaxFactory.Block(Assign())).WithAdditionalAnnotations(Formatter.Annotation);
                var anchor = typeDecl.Members.LastOrDefault(m => m is FieldDeclarationSyntax);
                if (anchor != null) editor.InsertAfter(anchor, ctor);
                else editor.InsertBefore(typeDecl.Members.First(), ctor);
            }
            foreach (var ctor in targets)
                editor.ReplaceNode(ctor, (current, _) =>
                {
                    var cd = (ConstructorDeclarationSyntax)current;
                    if (cd.Body != null) return cd.WithBody(cd.Body.WithStatements(cd.Body.Statements.Insert(0, Assign())));
                    var body = SyntaxFactory.Block(Assign(), SyntaxFactory.ExpressionStatement(cd.ExpressionBody!.Expression.WithoutTrivia()));
                    return cd.WithExpressionBody(null).WithSemicolonToken(default).WithBody(body).WithAdditionalAnnotations(Formatter.Annotation);
                });
        }
        return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
    }

    // ------------------------------------------------------------------ introduce constant

    /// <summary>The type text of a constant of the expression's value, or null when the expression is not a compile-time constant of a const type.</summary>
    private static string? ConstantType(Ctx c, ExpressionSyntax expr, ITypeSymbol type)
    {
        var value = c.Model.GetConstantValue(expr, c.Ct);
        if (!value.HasValue) return null;
        var ok = type.TypeKind == TypeKind.Enum || type.SpecialType is SpecialType.System_Boolean or SpecialType.System_Char or SpecialType.System_SByte or SpecialType.System_Byte
            or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64
            or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal or SpecialType.System_String;
        if (!ok || value.Value == null && type.SpecialType != SpecialType.System_String) return null;
        if (expr is MemberAccessExpressionSyntax && c.Model.GetSymbolInfo(expr, c.Ct).Symbol is IFieldSymbol) return null; // already a named constant
        return DisplayLocalType(c, type, expr.SpanStart);
    }

    private static Task<Document> IntroduceConstantAsync(Ctx c, ExpressionSyntax expr, ITypeSymbol type, string typeText, bool local)
    {
        var typeDecl = expr.FirstAncestorOrSelf<TypeDeclarationSyntax>()!;
        var editor = new SyntaxEditor(c.Root, c.Doc.Project.Solution.Services);
        var declarator = (string n) => SyntaxFactory.VariableDeclaration(SyntaxFactory.ParseTypeName(typeText),
            SyntaxFactory.SingletonSeparatedList(SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(n)).WithInitializer(SyntaxFactory.EqualsValueClause(expr.WithoutTrivia()))));
        if (local)
        {
            var stmt = expr.Ancestors().OfType<StatementSyntax>().First();
            var name = SuggestName(c, expr, type, stmt);
            editor.ReplaceNode(expr, SyntaxFactory.IdentifierName(name).WithTriviaFrom(expr));
            editor.InsertBefore(stmt, SyntaxFactory.LocalDeclarationStatement(declarator(name))
                .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.ConstKeyword))).WithAdditionalAnnotations(Formatter.Annotation));
        }
        else
        {
            var b = SuggestBaseName(expr, type);
            var name = FreeMemberName(c, typeDecl, expr, char.ToUpperInvariant(b[0]) + b[1..]);
            foreach (var o in OccurrencesInType(c, typeDecl, expr, instanceMember: false, constant: true))
                editor.ReplaceNode(o, SyntaxFactory.IdentifierName(name).WithTriviaFrom(o));
            var field = SyntaxFactory.FieldDeclaration(declarator(name))
                .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword), SyntaxFactory.Token(SyntaxKind.ConstKeyword)))
                .WithAdditionalAnnotations(Formatter.Annotation);
            InsertMember(editor, typeDecl, LastField(typeDecl, constants: true), field);
        }
        return Task.FromResult(c.Doc.WithSyntaxRoot(editor.GetChangedRoot()));
    }

    // ------------------------------------------------------------------ introduce parameter (plan)

    /// <summary>
    /// Introduce Parameter: the selected expression becomes a new parameter of the containing method, and every call site
    /// (in any file, the whole override/interface hierarchy included) passes the expression. Built on Change Signature
    /// (hierarchy, call sites, overload safety, compilation delta); refused when the expression uses locals, parameters or
    /// instance members, when a name in it would mean something else (or is not accessible) at a call site, for method
    /// groups/delegates, and for methods visible outside the solution (their external callers cannot be updated).
    /// </summary>
    public static async Task<RenameOutcome> PrepareIntroduceParameterAsync(Snapshot snapshot, string path, LinePositionSpan range, CancellationToken ct)
    {
        var c = await ContextAsync(snapshot, path, range, ct).ConfigureAwait(false);
        if (c == null) return RenameOutcome.Unavailable("NoDocument", "The file is not an editable C# document of the loaded solution.");
        if (RenamePlanner.IsReadOnly(path)) return RenameOutcome.Unavailable("ReadOnlyFile", "The file is read-only.");
        try
        {
            var expr = SelectedExpression(c) ?? throw new Refusal("NotApplicable", "Select an expression inside a method.");
            if (MemberOf(expr) is not MethodDeclarationSyntax decl || expr.FirstAncestorOrSelf<LocalFunctionStatementSyntax>() != null
                || c.Model.GetDeclaredSymbol(decl, ct) is not IMethodSymbol method)
                throw new Refusal("NotApplicable", "Introduce Parameter applies to an expression in the body of a method.");
            if (decl.Body == null && decl.ExpressionBody == null) throw new Refusal("NotApplicable", "The method has no body.");
            if (!decl.Body?.Span.Contains(expr.Span) ?? !decl.ExpressionBody!.Span.Contains(expr.Span))
                throw new Refusal("NotApplicable", "Select an expression in the method body.");
            var deps = DependenciesOf(c, expr);
            if (deps.Locals) throw new Refusal("UsesLocals", "The expression uses local variables or parameters of the method; the call sites cannot pass it.");
            if (deps.Instance) throw new Refusal("InstanceDependency", "The expression uses members of the instance; the call sites cannot pass it.");
            if (expr.Ancestors().Any(a => a is CaseSwitchLabelSyntax or ConstantPatternSyntax || a is LocalDeclarationStatementSyntax { IsConst: true }))
                throw new Refusal("ConstantContext", "The expression must stay constant here.");
            if (expr.Ancestors().TakeWhile(a => a != decl).Any(a => a is AnonymousFunctionExpressionSyntax || a is QueryExpressionSyntax))
                throw new Refusal("EvaluationOrder", "The expression is inside a lambda or query; passing it once per call would change how often it runs.");
            if (!CodeFacts.IsSideEffectFree(expr, c.Model, ct) && (ConditionallyEvaluated(expr, decl) || expr.Ancestors().TakeWhile(a => a != decl).Any(a => a is WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax or ForEachStatementSyntax)))
                throw new Refusal("EvaluationOrder", "The expression may have side effects and runs conditionally or repeatedly; evaluating it once at the call would change that.");
            if (IsVisibleOutsideAssembly(method))
                throw new Refusal("ExternalCallers", $"{method.Name} is visible outside its assembly; callers outside the loaded solution could not be updated.");
            var type = c.Model.GetTypeInfo(expr, ct).Type!;
            var typeText = DisplayLocalType(c, type, decl.SpanStart) ?? throw new Refusal("AnonymousType", "The type of the expression cannot be written.");
            if (UsesMethodTypeParameters(type) && !method.IsGenericMethod) throw new Refusal("Generic", "The type of the expression cannot be written in the signature.");

            // Every name of the expression must mean the same (and be accessible) at every call site.
            foreach (var r in await SymbolFinder.FindReferencesAsync(method, snapshot.Solution, ct).ConfigureAwait(false))
            foreach (var loc in r.Locations)
            {
                var model = await loc.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
                CheckNamesAt(c, expr, model!, loc.Location.SourceSpan.Start, CodeFacts.Label(loc.Location));
            }

            // The name: free in the method and in every implementation of the hierarchy.
            var baseName = SuggestBaseName(expr, type);
            var (set, hierarchyRefusal) = await ChangeSignaturePlanner.HierarchyAsync(snapshot.Solution, method, ct).ConfigureAwait(false);
            if (hierarchyRefusal is { } hr) throw new Refusal(hr.Item1, hr.Item2);
            var used = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in set)
            foreach (var sr in s.DeclaringSyntaxReferences)
                used.UnionWith(sr.GetSyntax(ct).DescendantTokens().Where(t => t.IsKind(SyntaxKind.IdentifierToken)).Select(t => t.ValueText));
            var name = baseName;
            for (var i = 2; used.Contains(name) || !c.Model.LookupSymbols(expr.SpanStart, name: name).IsEmpty; i++) name = baseName + i;

            // The new parameter goes before the first optional / params parameter.
            var ps = method.Parameters;
            var at = ps.Length;
            for (var i = 0; i < ps.Length; i++) if (ps[i].IsOptional || ps[i].IsParams) { at = i; break; }
            var callSiteText = CallSiteText(c, expr);
            var spec = new List<ParameterSpec>();
            for (var i = 0; i < ps.Length; i++)
            {
                if (i == at) spec.Add(new ParameterSpec(null, name, typeText, null, callSiteText));
                spec.Add(new ParameterSpec(i, ps[i].Name));
            }
            if (at == ps.Length) spec.Add(new ParameterSpec(null, name, typeText, null, callSiteText));

            // Annotate the expression in a fork of the solution (no text change) so it can be found after the signature change.
            var mark = new SyntaxAnnotation("refyntra.introduceParameter");
            var marked = snapshot.Solution.WithDocumentSyntaxRoot(c.Doc.Id, c.Root.ReplaceNode(expr, expr.WithAdditionalAnnotations(mark)));
            var markedDoc = marked.GetDocument(c.Doc.Id)!;
            var markedRoot = (await markedDoc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
            var markedModel = (await markedDoc.GetSemanticModelAsync(ct).ConfigureAwait(false))!;
            var markedDecl = markedRoot.GetAnnotatedNodes(mark).Single().Ancestors().OfType<MethodDeclarationSyntax>().First();
            var markedMethod = markedModel.GetDeclaredSymbol(markedDecl, ct)!;
            var forked = new Snapshot { Id = snapshot.Id, Solution = marked, Sequence = snapshot.Sequence, Revision = snapshot.Revision, Session = snapshot.Session, Generation = snapshot.Generation };
            var result = await ChangeSignaturePlanner.ChangeAsync(forked, markedMethod, spec, ct).ConfigureAwait(false);
            if (result.Refusal is { } rr) return RenameOutcome.Unavailable(rr.reason, rr.message);
            var after = result.After!;
            var afterRoot = (await after.GetDocument(c.Doc.Id)!.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
            var target = afterRoot.GetAnnotatedNodes(mark).SingleOrDefault()
                ?? throw new Refusal("RecursiveCall", "The expression contains a call of the method itself; it cannot become its parameter.");
            if (!SyntaxFactory.AreEquivalent(target, expr)) throw new Refusal("RecursiveCall", "The expression contains a call of the method itself; it cannot become its parameter.");
            after = after.WithDocumentSyntaxRoot(c.Doc.Id, afterRoot.ReplaceNode(target, SyntaxFactory.IdentifierName(name).WithTriviaFrom(target)));

            var limitations = result.Limitations;
            limitations.Insert(0, "Only call sites the compiler binds to the method are updated; reflection, dynamic calls and string-based uses are not.");
            limitations.Add($"Each call site now evaluates {expr.WithoutTrivia()} before the call (the method evaluated it where it was used).");
            result.Evidence.Insert(0, ($"{expr.WithoutTrivia()} becomes parameter {typeText} {name} of {ChangeSignaturePlanner.DisplayName(method)}", expr.GetLocation()));
            var title = $"Introduce parameter {name} in {ChangeSignaturePlanner.DisplayName(method)}";
            return await SolutionPlanBuilder.BuildAsync(snapshot, after, new SolutionPlanBuilder.Options(IntroduceParameterAction, title, limitations, result.Evidence, result.LimitedReasons,
                OwnerProjects: result.Projects), ct).ConfigureAwait(false);
        }
        catch (Refusal r)
        {
            return RenameOutcome.Unavailable(r.Reason, r.Message);
        }
    }

    private static bool IsVisibleOutsideAssembly(IMethodSymbol m)
    {
        for (ISymbol? s = m; s is IMethodSymbol or INamedTypeSymbol; s = s.ContainingType)
            if (s.DeclaredAccessibility is not (Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal)) return false;
        return true;
    }

    /// <summary>Static members used without a receiver: their names and the type that qualifies them at the call sites.</summary>
    private static bool IsUnqualifiedStaticMember(Ctx c, SimpleNameSyntax id, out ISymbol? sym)
    {
        sym = c.Model.GetSymbolInfo(id, c.Ct).Symbol;
        return sym is IFieldSymbol or IPropertySymbol or IMethodSymbol or IEventSymbol && sym.IsStatic && sym.ContainingType != null
            && !(id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id) && id.Parent is not MemberBindingExpressionSyntax && !InNameOf(id);
    }

    /// <summary>The expression as passed at the call sites: static members used without a receiver get their type.</summary>
    private static string CallSiteText(Ctx c, ExpressionSyntax expr)
    {
        var map = new Dictionary<SyntaxNode, SyntaxNode>();
        foreach (var id in expr.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
            if (IsUnqualifiedStaticMember(c, id, out var sym))
                map[id] = SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression,
                    SyntaxFactory.ParseExpression(sym!.ContainingType.ToMinimalDisplayString(c.Model, expr.SpanStart)), id.WithoutTrivia()).WithTriviaFrom(id);
        var qualified = map.Count == 0 ? expr : expr.ReplaceNodes(map.Keys, (o, _) => map[o]);
        return qualified.WithoutTrivia().ToFullString();
    }

    /// <summary>Refuses when a name of <paramref name="expr"/> is not accessible, or would mean something else, at <paramref name="position"/> of another model.</summary>
    private static void CheckNamesAt(Ctx c, ExpressionSyntax expr, SemanticModel model, int position, string label)
    {
        foreach (var id in expr.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
        {
            if (id.Parent is NameColonSyntax || id.Parent is NameEqualsSyntax || id.IsVar || InNameOf(id)) continue;
            var sym = c.Model.GetSymbolInfo(id, c.Ct).Symbol;
            if (sym == null || sym.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == expr.SyntaxTree && expr.Span.Contains(r.Span))) continue;
            if (!model.IsAccessible(position, sym))
                throw new Refusal("NotAccessible", $"'{id.Identifier.ValueText}' is not accessible at the call site {label}.");
            if (IsUnqualifiedStaticMember(c, id, out _))
            {
                var typeText = sym.ContainingType.ToMinimalDisplayString(c.Model, expr.SpanStart);
                if (sym.ContainingType.ToMinimalDisplayString(model, position) != typeText && !model.LookupNamespacesAndTypes(position, name: sym.ContainingType.Name).Contains(sym.ContainingType, SymbolEqualityComparer.Default))
                    throw new Refusal("NameConflict", $"'{typeText}' would not mean the same at the call site {label}.");
                continue;
            }
            if (id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id || id.Parent is MemberBindingExpressionSyntax || id.Parent is QualifiedNameSyntax q && q.Right == id) continue;
            var visible = model.LookupSymbols(position, name: id.Identifier.ValueText);
            var same = visible.Any(v => SymbolEqualityComparer.Default.Equals(v.OriginalDefinition, sym.OriginalDefinition));
            if (!same || visible.Any(v => v is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol))
                throw new Refusal("NameConflict", $"'{id.Identifier.ValueText}' would not mean the same at the call site {label}.");
        }
    }
}
