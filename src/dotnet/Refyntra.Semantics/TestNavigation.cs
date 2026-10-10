using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>
/// Code ↔ tests navigation. A test is a method carrying an attribute whose type (or a base type)
/// is a known test attribute, identified by full metadata name AND declaring assembly (never by simple name):
/// xUnit (verified by the DiRules fixture), NUnit and MSTest (identities from their public packages, not exercised by a
/// fixture in this version). A reference from a test to a symbol is reported as "references the symbol — not coverage".
/// </summary>
public static class TestNavigation
{
    public const string TestKind = RelationKinds.Test;
    public const string TestSubjectKind = "test.subject";
    public const int MaxItems = 50;
    public const string NotCoverage = "A static reference is not coverage: it does not show that the test executes this code.";

    private static readonly (string framework, KnownType attribute)[] TestAttributes =
    {
        ("xUnit", new KnownType("Xunit.FactAttribute", "xunit.core", "xunit.v3.core")),
        ("NUnit", new KnownType("NUnit.Framework.TestAttribute", "nunit.framework")),
        ("NUnit", new KnownType("NUnit.Framework.TestCaseAttribute", "nunit.framework")),
        ("NUnit", new KnownType("NUnit.Framework.TestCaseSourceAttribute", "nunit.framework")),
        ("NUnit", new KnownType("NUnit.Framework.TheoryAttribute", "nunit.framework")),
        ("MSTest", new KnownType("Microsoft.VisualStudio.TestTools.UnitTesting.TestMethodAttribute",
            "Microsoft.VisualStudio.TestPlatform.TestFramework", "MSTest.TestFramework")),
    };

    /// <summary>The test framework of a test method (attribute identity, base attribute types included), or null.</summary>
    public static string? TestFramework(IMethodSymbol method)
    {
        foreach (var a in method.GetAttributes())
            for (var t = a.AttributeClass; t != null; t = t.BaseType)
                foreach (var (fw, known) in TestAttributes)
                    if (known.Matches(t)) return fw;
        return null;
    }

    public static bool IsTestClass(INamedTypeSymbol type) =>
        type.GetMembers().OfType<IMethodSymbol>().Any(m => TestFramework(m) != null);

    public static bool IsTestSymbol(ISymbol symbol) => symbol switch
    {
        IMethodSymbol m => TestFramework(m) != null,
        INamedTypeSymbol t => IsTestClass(t),
        _ => false,
    };

    private static IMethodSymbol? EnclosingTestMethod(SemanticModel model, SyntaxNode node, CancellationToken ct)
    {
        var decl = node.AncestorsAndSelf().OfType<MethodDeclarationSyntax>().FirstOrDefault();
        if (decl == null) return null;
        return model.GetDeclaredSymbol(decl, ct) is IMethodSymbol m && TestFramework(m) != null ? m : null;
    }

    /// <summary>Tests that reference the subject (proven) and test classes named after it (heuristic).</summary>
    public static async Task<List<FrameworkRelation>> TestsForAsync(Snapshot snapshot, ISymbol subject, IReadOnlyList<LocationHit> references, CancellationToken ct)
    {
        var result = new List<FrameworkRelation>();
        var byTest = new Dictionary<IMethodSymbol, Location>(SymbolEqualityComparer.Default);
        foreach (var r in references)
        {
            var tree = r.Location.SourceTree;
            if (tree == null) continue;
            var doc = snapshot.Solution.GetDocument(tree);
            if (doc == null) continue;
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
            if (model == null) continue;
            var node = root.FindNode(r.Location.SourceSpan, getInnermostNodeForTie: true);
            var test = EnclosingTestMethod(model, node, ct);
            if (test == null || SymbolEqualityComparer.Default.Equals(test, subject)) continue;
            if (!byTest.ContainsKey(test)) byTest[test] = r.Location;
        }
        var provenClasses = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (test, at) in byTest.OrderBy(kv => kv.Key.ContainingType?.Name, StringComparer.Ordinal).ThenBy(kv => kv.Key.Name, StringComparer.Ordinal).Take(MaxItems))
        {
            var fw = TestFramework(test)!;
            provenClasses.Add(test.ContainingType?.ToDisplayString() ?? "");
            var line = at.GetLineSpan().StartLinePosition.Line + 1;
            result.Add(new FrameworkRelation(TestKind, RelationGroups.Tests,
                new RelationTarget($"{test.ContainingType?.Name}.{test.Name} — references the symbol — not coverage", Symbol: test),
                new[] { new EvidenceItem($"{fw} test {test.ContainingType?.Name}.{test.Name} references {subject.Name} ({Path.GetFileName(at.SourceTree?.FilePath)}:{line})", at) },
                Confidences.Proven, new[] { NotCoverage }, SemanticService.ProviderRouteId));
        }
        if (byTest.Count > MaxItems)
            result.Add(new FrameworkRelation(TestKind, RelationGroups.Tests, new RelationTarget($"{byTest.Count - MaxItems} more tests reference the symbol (not listed)"),
                Array.Empty<EvidenceItem>(), Confidences.Proven, new[] { NotCoverage }, SemanticService.ProviderRouteId));

        // Name-based matches: OrderService → OrderServiceTests / OrderServiceTest (a hint only, never proof).
        if (subject is INamedTypeSymbol type && !IsTestClass(type))
        {
            foreach (var project in snapshot.Solution.Projects.Where(p => p.Language == LanguageNames.CSharp))
            {
                foreach (var name in new[] { type.Name + "Tests", type.Name + "Test" })
                {
                    var found = await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder.FindSourceDeclarationsAsync(project, name, ignoreCase: false, SymbolFilter.Type, ct).ConfigureAwait(false);
                    foreach (var t in found.OfType<INamedTypeSymbol>())
                    {
                        if (!IsTestClass(t) || provenClasses.Contains(t.ToDisplayString())) continue;
                        if (result.Any(r => r.Target.Symbol is INamedTypeSymbol x && SymbolIdentity.SameDefinition(x, t))) continue;
                        result.Add(new FrameworkRelation(TestKind, RelationGroups.Tests,
                            new RelationTarget($"{t.Name} — name match only (heuristic)", Symbol: t),
                            new[] { new EvidenceItem($"Test class name {t.Name} matches {type.Name}; it does not reference {type.Name}", t.Locations.FirstOrDefault(l => l.IsInSource)) },
                            Confidences.Heuristic, new[] { "Matched by name only: not a proof that the class tests this type.", NotCoverage }, SemanticService.ProviderRouteId));
                    }
                }
            }
        }
        return result;
    }

    /// <summary>Reverse direction: the production symbols a test method (or every test of a test class) references.</summary>
    public static async Task<List<FrameworkRelation>> SubjectsOfTestAsync(Snapshot snapshot, ISymbol subject, CancellationToken ct)
    {
        var result = new List<FrameworkRelation>();
        var tests = subject switch
        {
            IMethodSymbol m when TestFramework(m) != null => new List<IMethodSymbol> { m },
            INamedTypeSymbol t when IsTestClass(t) => t.GetMembers().OfType<IMethodSymbol>().Where(m => TestFramework(m) != null).ToList(),
            _ => new List<IMethodSymbol>(),
        };
        if (tests.Count == 0) return result;
        var testProjects = new HashSet<ProjectId>();
        var seen = new Dictionary<string, (ISymbol symbol, Location at)>(StringComparer.Ordinal);
        foreach (var test in tests)
        foreach (var syntaxRef in test.DeclaringSyntaxReferences)
        {
            var doc = snapshot.Solution.GetDocument(syntaxRef.SyntaxTree);
            if (doc == null) continue;
            testProjects.Add(doc.Project.Id);
            var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model == null) continue;
            var node = await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);
            foreach (var name in node.DescendantNodes().OfType<SimpleNameSyntax>())
            {
                var s = model.GetSymbolInfo(name, ct).Symbol;
                if (s == null) continue;
                if (s is IMethodSymbol { MethodKind: MethodKind.ReducedExtension } red) s = red.ReducedFrom ?? red;
                if (s is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) s = ctor.ContainingType;
                s = s.OriginalDefinition;
                if (s is not (INamedTypeSymbol or IMethodSymbol or IPropertySymbol or IFieldSymbol or IEventSymbol)) continue;
                if (!s.Locations.Any(l => l.IsInSource)) continue;
                var owner = SymbolFacts.OwningProject(snapshot.Solution, s);
                if (owner == null || testProjects.Contains(owner.Id)) continue;
                var key = (DocumentationCommentId.CreateDeclarationId(s) ?? s.Name) + "|" + s.ContainingAssembly?.Name;
                if (!seen.ContainsKey(key)) seen[key] = (s, name.GetLocation());
            }
        }
        foreach (var (s, at) in seen.Values.OrderBy(v => SymbolFacts.DisplayName(v.symbol), StringComparer.Ordinal).Take(MaxItems))
        {
            result.Add(new FrameworkRelation(TestSubjectKind, RelationGroups.Tests,
                new RelationTarget($"{SymbolFacts.DisplayName(s)} — referenced by this test — not coverage", Symbol: s),
                new[] { new EvidenceItem($"The test references {s.Name}", at) },
                Confidences.Proven, new[] { NotCoverage }, SemanticService.ProviderRouteId));
        }
        return result;
    }
}
