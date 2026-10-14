using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Refyntra.Semantics.Rules;
using SF = Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace Refyntra.Refactorings;

public static partial class EditActionsPlanner
{
    // ------------------------------------------------------------------ OR1011: .Include(x => x.Nav)

    /// <summary>
    /// Adds <c>.Include(x => x.Nav)</c> right after the DbSet of the query OR1011 traced (always in the same function),
    /// and <c>using Microsoft.EntityFrameworkCore;</c> when the document has none. Compile-checked like every fix.
    /// </summary>
    private static Func<Task<Document>>? AddInclude(Ctx c)
    {
        var f = FindingFor(c, CodeInspections.FixAddInclude);
        if (f == null) return null;
        var r = EfNPlusOne.At(c.Model, c.Root, f.Span, c.Ct);
        if (r == null) return null;
        var p = r.ParameterName;
        var lambda = SF.ParseExpression($"{p} => {p}.{r.Navigation}");
        var include = SF.InvocationExpression(
                SF.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, r.DbSet.WithoutTrivia(), SF.IdentifierName("Include")),
                SF.ArgumentList(SF.SingletonSeparatedList(SF.Argument(lambda))))
            .WithTriviaFrom(r.DbSet);
        return () =>
        {
            var root = c.Root.ReplaceNode(r.DbSet, include);
            if (root is CompilationUnitSyntax cu && !cu.Usings.Any(u => u.Name?.ToString() == "Microsoft.EntityFrameworkCore" && u.Alias == null && u.StaticKeyword.IsKind(SyntaxKind.None))
                && !HasGlobalUsing(c.Model.Compilation, "Microsoft.EntityFrameworkCore"))
            {
                var directive = SF.UsingDirective(SF.ParseName("Microsoft.EntityFrameworkCore")).WithAdditionalAnnotations(Formatter.Annotation)
                    .WithTrailingTrivia(SF.ElasticCarriageReturnLineFeed);
                root = cu.Usings.Count > 0 ? cu.WithUsings(cu.Usings.Add(directive.WithTrailingTrivia(cu.Usings.Last().GetTrailingTrivia()))) : cu.WithUsings(cu.Usings.Add(directive));
            }
            return Task.FromResult(c.Doc.WithSyntaxRoot(root));
        };
    }

    private static bool HasGlobalUsing(Compilation compilation, string ns) =>
        compilation.SyntaxTrees.Any(t => t.GetRoot() is CompilationUnitSyntax u && u.Usings.Any(x => !x.GlobalKeyword.IsKind(SyntaxKind.None) && x.Name?.ToString() == ns && x.Alias == null));
}
