using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>One data case written in source: [InlineData], [TestCase] or [DataRow] (positional arguments only).</summary>
public sealed record DiscoveredCase(string Label, IReadOnlyList<string> Arguments, LinePositionSpan Range);

/// <summary>A class that contains the test (outermost first) and its declaration range in this document.</summary>
public sealed record DiscoveredClass(string Name, LinePositionSpan Range, LinePositionSpan NameRange);

/// <summary>A test method found in source (code/tests, protocol 1.15).</summary>
public sealed record DiscoveredTest(
    string FilePath,
    string Framework,
    string Namespace,
    IReadOnlyList<DiscoveredClass> Classes,
    string Method,
    /// <summary>"Ns.Outer+Inner.Method": the FullyQualifiedName test adapters report (without data arguments).</summary>
    string FullyQualifiedName,
    LinePositionSpan Range,
    LinePositionSpan NameRange,
    IReadOnlyList<DiscoveredCase> Cases,
    /// <summary>Cases computed at run time ([MemberData], [ClassData], [TestCaseSource], [DynamicData], a theory without data).</summary>
    bool DynamicCases,
    string? SkipReason);

/// <summary>
/// Test discovery for the Test Explorer: test methods of xUnit ([Fact], [Theory] with [InlineData] / [MemberData]),
/// NUnit ([Test], [TestCase], [TestCaseSource]) and MSTest ([TestMethod], [DataRow], [DynamicData]), identified by
/// attribute identity (<see cref="TestNavigation.TestFramework"/>), with exact ranges, namespaces and nested classes.
/// Syntax first: only methods with attributes get a semantic model look-up. Abstract and generic classes are left out
/// (their tests run through derived or constructed classes, whose names the source does not show).
/// </summary>
public static class TestDiscovery
{
    private static readonly string[] FrameworkAssemblies =
    {
        "xunit.core", "xunit.v3.core", "nunit.framework", "Microsoft.VisualStudio.TestPlatform.TestFramework", "MSTest.TestFramework",
    };

    private static readonly HashSet<string> StaticCaseAttributes = new(StringComparer.Ordinal)
    {
        "Xunit.InlineDataAttribute", "NUnit.Framework.TestCaseAttribute", "Microsoft.VisualStudio.TestTools.UnitTesting.DataRowAttribute",
    };

    private static readonly HashSet<string> DynamicCaseAttributes = new(StringComparer.Ordinal)
    {
        "Xunit.MemberDataAttribute", "Xunit.ClassDataAttribute", "NUnit.Framework.TestCaseSourceAttribute",
        "Microsoft.VisualStudio.TestTools.UnitTesting.DynamicDataAttribute",
    };

    /// <summary>True when the project references a test framework assembly (a test project).</summary>
    public static bool IsTestProject(Project project) =>
        project.Language == LanguageNames.CSharp &&
        project.MetadataReferences.OfType<PortableExecutableReference>().Any(r =>
            r.FilePath != null && FrameworkAssemblies.Contains(Path.GetFileNameWithoutExtension(r.FilePath), StringComparer.OrdinalIgnoreCase));

    /// <summary>The test projects of the solution, one per project file (the first instance of a multi-targeted project).</summary>
    public static List<Project> TestProjects(Solution solution)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<Project>();
        foreach (var p in solution.Projects)
        {
            if (!IsTestProject(p)) continue;
            if (p.FilePath != null && !seen.Add(p.FilePath)) continue;
            list.Add(p);
        }
        return list;
    }

    public static async Task<List<DiscoveredTest>> DiscoverProjectAsync(Project project, CancellationToken ct)
    {
        var result = new List<DiscoveredTest>();
        foreach (var doc in project.Documents)
        {
            ct.ThrowIfCancellationRequested();
            result.AddRange(await DiscoverDocumentAsync(doc, ct).ConfigureAwait(false));
        }
        return result;
    }

    public static async Task<List<DiscoveredTest>> DiscoverDocumentAsync(Document doc, CancellationToken ct)
    {
        var result = new List<DiscoveredTest>();
        if (doc.FilePath == null || doc.SourceCodeKind != SourceCodeKind.Regular) return result;
        var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root == null) return result;
        var candidates = root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax)
            .OfType<MethodDeclarationSyntax>().Where(m => m.AttributeLists.Count > 0).ToList();
        if (candidates.Count == 0) return result;
        var model = await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model == null) return result;
        foreach (var decl in candidates)
        {
            if (model.GetDeclaredSymbol(decl, ct) is not IMethodSymbol method) continue;
            var framework = TestNavigation.TestFramework(method);
            if (framework == null) continue;
            if (method.IsAbstract || method.IsGenericMethod) continue;
            var types = new List<(INamedTypeSymbol symbol, TypeDeclarationSyntax syntax)>();
            var ok = true;
            for (SyntaxNode? n = decl.Parent; n != null; n = n.Parent)
            {
                if (n is not TypeDeclarationSyntax td) continue;
                if (model.GetDeclaredSymbol(td, ct) is not INamedTypeSymbol t || t.IsAbstract && !t.IsStatic || t.IsGenericType) { ok = false; break; }
                types.Insert(0, (t, td));
            }
            if (!ok || types.Count == 0) continue;
            var ns = types[0].symbol.ContainingNamespace is { IsGlobalNamespace: false } nsSym ? nsSym.ToDisplayString() : "";
            var classPath = string.Join("+", types.Select(t => t.symbol.MetadataName));
            var fqn = (ns.Length > 0 ? ns + "." : "") + classPath + "." + method.Name;
            var cases = new List<DiscoveredCase>();
            var dynamic = false;
            string? skip = null;
            var parameterized = method.Parameters.Length > 0;
            foreach (var a in method.GetAttributes())
            {
                var name = a.AttributeClass is { } ac ? ac.ToDisplayString() : "";
                if (StaticCaseAttributes.Contains(name))
                {
                    if (a.ApplicationSyntaxReference?.GetSyntax(ct) is AttributeSyntax syn)
                    {
                        var args = (syn.ArgumentList?.Arguments ?? default).Where(x => x.NameEquals == null && x.NameColon == null).Select(x => x.Expression.ToString()).ToList();
                        cases.Add(new DiscoveredCase("(" + string.Join(", ", args) + ")", args.Select(NormalizeArgument).ToList(), syn.GetLocation().GetLineSpan().Span));
                    }
                }
                else if (DynamicCaseAttributes.Contains(name) || InheritsFrom(a.AttributeClass, "Xunit.Sdk.DataAttribute") && name != "Xunit.InlineDataAttribute")
                    dynamic = true;
                else if (name is "NUnit.Framework.IgnoreAttribute" or "Microsoft.VisualStudio.TestTools.UnitTesting.IgnoreAttribute")
                    skip = a.ConstructorArguments.FirstOrDefault().Value as string ?? "Ignored";
                if (skip == null && a.NamedArguments.FirstOrDefault(n => n.Key == "Skip").Value.Value is string s && s.Length > 0
                    && a.AttributeClass != null && InheritsFrom(a.AttributeClass, "Xunit.FactAttribute"))
                    skip = s;
            }
            if (parameterized && cases.Count == 0) dynamic = true;
            var classes = types.Select(t => new DiscoveredClass(t.symbol.Name, t.syntax.GetLocation().GetLineSpan().Span, t.syntax.Identifier.GetLocation().GetLineSpan().Span)).ToList();
            result.Add(new DiscoveredTest(doc.FilePath, framework, ns, classes, method.Name, fqn,
                decl.GetLocation().GetLineSpan().Span, decl.Identifier.GetLocation().GetLineSpan().Span, cases, dynamic, skip));
        }
        return result;
    }

    private static bool InheritsFrom(INamedTypeSymbol? type, string fullName)
    {
        for (var t = type; t != null; t = t.BaseType)
            if (t.ToDisplayString() == fullName) return true;
        return false;
    }

    /// <summary>
    /// A data argument in the form test adapters print it, for matching results to source cases: no quotes, no
    /// numeric suffixes, enum members without their type, lower case, no blanks ("Color.Red" → "red", "1.5d" → "1.5").
    /// The client applies the same normalisation to the display names in the results.
    /// </summary>
    public static string NormalizeArgument(string text)
    {
        var t = text.Trim();
        if (t.StartsWith('@')) t = t[1..];
        if (t.Length >= 2 && (t[0] == '"' && t[^1] == '"' || t[0] == '\'' && t[^1] == '\'')) t = t[1..^1];
        else
        {
            var num = System.Text.RegularExpressions.Regex.Match(t, @"^([-+]?\d[\d_]*(\.\d+)?([eE][-+]?\d+)?)[dDfFmMlLuU]{0,2}$");
            if (num.Success) t = num.Groups[1].Value.Replace("_", "");
            else if (System.Text.RegularExpressions.Regex.IsMatch(t, @"^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)+$")) t = t[(t.LastIndexOf('.') + 1)..];
        }
        return new string(t.Where(c => !char.IsWhiteSpace(c)).ToArray()).ToLowerInvariant();
    }
}
