using Refyntra.Workspaces;
using Xunit;

namespace Refyntra.Tests;

public class GeneratedSolutionTests
{
    [Fact]
    public void SameNamedProjectsOfTwoRepositoriesGoIntoSeparateSolutionFolders()
    {
        var root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gs");
        var a = System.IO.Path.Combine(root, "repo-a", "Api", "Api.csproj");
        var b = System.IO.Path.Combine(root, "repo-b", "Api", "Api.csproj");
        var core = System.IO.Path.Combine(root, "repo-a", "Core", "Core.csproj");
        var sln = WorkspaceSession.GeneratedSolution(new[] { a, b, core });
        // Two folders, the repeated project once in each; the unique one at the root.
        Assert.Contains("= \"repo-a\", \"repo-a\"", sln);
        Assert.Contains("= \"repo-b\", \"repo-b\"", sln);
        Assert.Equal(2, CountOf(sln, "\"Api\", "));
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(sln, "\"Core\", "));
        Assert.Contains("GlobalSection(NestedProjects)", sln);
        Assert.Equal(2, CountOf(sln, " = {000186A"));
    }

    [Fact]
    public void UniqueNamesNeedNoFolders()
    {
        var sln = WorkspaceSession.GeneratedSolution(new[] { System.IO.Path.Combine(System.IO.Path.GetTempPath(), "x", "A", "A.csproj") });
        Assert.DoesNotContain("NestedProjects", sln);
        Assert.DoesNotContain("2150E333", sln);
    }

    private static int CountOf(string text, string needle)
    {
        var n = 0;
        for (var i = text.IndexOf(needle, StringComparison.Ordinal); i >= 0; i = text.IndexOf(needle, i + 1, StringComparison.Ordinal)) n++;
        return n;
    }
}
