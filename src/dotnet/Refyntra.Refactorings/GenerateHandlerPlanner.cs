using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Frameworks.Abstractions;
using Refyntra.Frameworks.MediatR;
using Refyntra.Semantics;
using Refyntra.Workspaces;

namespace Refyntra.Refactorings;

/// <summary>
/// Generate handler (MediatR): for a request type (IRequest&lt;T&gt; / IRequest, verified MediatR identity) without a
/// source handler, creates &lt;Request&gt;Handler.cs implementing IRequestHandler with a Handle that throws
/// NotImplementedException (an honest placeholder). The folder is the one where most handlers of the solution live (or
/// one the user picks from the existing handler folders, or the request's folder); the namespace follows RootNamespace
/// and the folders; the namespace style follows the project. No DI registration is generated (MediatR scans assemblies).
/// Never writes files.
/// </summary>
public static class GenerateHandlerPlanner
{
    public const string ActionId = "csharp.generateHandler";

    public sealed record Analysis(ActionApplicability Applicability, INamedTypeSymbol? Request, ITypeSymbol? Response, bool VoidRequest, IReadOnlyList<FolderChoice> Folders);

    private static Analysis Hidden => new(ActionApplicability.Hidden, null, null, false, Array.Empty<FolderChoice>());
    private static Analysis Refused(string code, string message) => new(ActionApplicability.Unavailable(code, message), null, null, false, Array.Empty<FolderChoice>());

    public static async Task<Analysis> AnalyzeAsync(Snapshot snapshot, ISymbol symbol, CancellationToken ct)
    {
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor) symbol = ctor.ContainingType;
        if (symbol is not INamedTypeSymbol type || type.TypeKind is not (TypeKind.Class or TypeKind.Struct) || !type.Locations.Any(l => l.IsInSource))
            return Hidden;
        var requests = type.AllInterfaces.Where(i => MediatRModule.IRequest1.Matches(i)).ToList();
        var isVoid = type.AllInterfaces.Any(i => MediatRModule.IRequest0.Matches(i));
        if (requests.Count == 0 && !isVoid) return Hidden; // not a MediatR request (a same-name interface elsewhere never matches)
        var name = type.Name;
        var facts = (MediatRModule.Facts)await SemanticService.GetFactsAsync(snapshot, SemanticService.MediatR, ct).ConfigureAwait(false);
        if (!facts.VersionVerified)
            return Refused("MediatRVersionUnverified", $"The MediatR version is not verified ({SemanticService.MediatR.Detection(facts)}); Refyntra generates handlers only for MediatR 10–12.");
        if (type.IsGenericType || type.IsUnboundGenericType || ContainingTypes(type).Any(t => t.IsGenericType))
            return Refused("GenericRequest", $"{name} is generic (an open request); a handler for it cannot be generated.");
        if (type.IsAbstract) return Refused("AbstractRequest", $"{name} is abstract; MediatR sends concrete requests.");
        if (type.DeclaredAccessibility is Accessibility.Private or Accessibility.Protected or Accessibility.ProtectedAndInternal
            || ContainingTypes(type).Any(t => t.DeclaredAccessibility is Accessibility.Private or Accessibility.Protected or Accessibility.ProtectedAndInternal))
            return Refused("InaccessibleRequest", $"{name} is not accessible outside its containing type.");
        if (type.Locations.Where(l => l.IsInSource).Any(l => SymbolFacts.IsGeneratedTree(snapshot.Solution, l.SourceTree!, ct)))
            return Refused("GeneratedCode", $"{name} is declared in generated code.");
        var responses = requests.Select(r => r.TypeArguments[0]).Distinct<ITypeSymbol>(SymbolEqualityComparer.Default).ToList();
        // MediatR 10/11: IRequest : IRequest<Unit>. A void request is IRequestHandler<TRequest>.
        if (isVoid) responses.Clear();
        if (responses.Count > 1) return Refused("AmbiguousRequest", $"{name} implements IRequest<T> more than once.");
        var existing = facts.Handlers.FirstOrDefault(h => !h.IsNotification && SymbolIdentity.SameDefinition(h.Request.OriginalDefinition, type.OriginalDefinition));
        if (existing != null)
        {
            var file = existing.HandlerType.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree?.FilePath;
            return Refused("HandlerExists", $"{name} already has a handler: {existing.HandlerType.Name}{(file != null ? " (" + Path.GetFileName(file) + ")" : "")}.");
        }
        var folders = Folders(snapshot, type, facts, ct);
        if (folders.Count == 0)
            return Refused("NoHandlerProject", $"No loaded project that references MediatR can see {name}.");
        return new Analysis(ActionApplicability.Available, type, responses.FirstOrDefault(), isVoid, folders);
    }

    private static IEnumerable<INamedTypeSymbol> ContainingTypes(INamedTypeSymbol t)
    {
        for (var c = t.ContainingType; c != null; c = c.ContainingType) yield return c;
    }

    /// <summary>Folders of existing source handlers (most handlers first), then the request's own folder.</summary>
    private static List<FolderChoice> Folders(Snapshot snapshot, INamedTypeSymbol request, MediatRModule.Facts facts, CancellationToken ct)
    {
        var solution = snapshot.Solution;
        var requestProject = SymbolFacts.OwningProject(solution, request);
        var graph = solution.GetProjectDependencyGraph();
        bool Hosts(Project p)
        {
            if (p.FilePath == null) return false;
            if (requestProject == null) return false;
            if (p.Id != requestProject.Id)
            {
                if (!graph.GetProjectsThatThisProjectTransitivelyDependsOn(p.Id).Contains(requestProject.Id)) return false;
                if (EffectiveAccessibility(request) != Accessibility.Public) return false;
            }
            var compilation = p.GetCompilationAsync(ct).GetAwaiter().GetResult();
            return compilation?.GetTypeByMetadataName("MediatR.IRequestHandler`2") is { } h && MediatRModule.IRequestHandler2.Matches(h);
        }
        var counts = new Dictionary<(string folder, ProjectId project), (int count, string anchor)>();
        foreach (var h in facts.Handlers.Where(h => !h.IsNotification))
        {
            var loc = h.HandlerType.Locations.FirstOrDefault(l => l.IsInSource);
            var path = loc?.SourceTree?.FilePath;
            if (string.IsNullOrEmpty(path) || SymbolFacts.IsGeneratedTree(solution, loc!.SourceTree!, ct)) continue;
            var key = (Path.GetDirectoryName(path)!, h.ProjectId);
            counts[key] = counts.TryGetValue(key, out var c)
                ? (c.count + 1, string.CompareOrdinal(path, c.anchor) < 0 ? path : c.anchor)
                : (1, path);
        }
        var result = new List<FolderChoice>();
        foreach (var ((folder, pid), (count, anchor)) in counts.OrderByDescending(kv => kv.Value.count).ThenBy(kv => kv.Key.folder, StringComparer.Ordinal))
        {
            var p = solution.GetProject(pid);
            if (p == null || !Hosts(p) || result.Any(r => UriPaths.PathComparer.Equals(r.Folder, folder))) continue;
            result.Add(Choice(p, folder, count, anchor));
        }
        var requestFile = request.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree?.FilePath;
        if (requestProject != null && requestFile != null && Hosts(requestProject))
        {
            var folder = Path.GetDirectoryName(requestFile)!;
            if (!result.Any(r => UriPaths.PathComparer.Equals(r.Folder, folder))) result.Add(Choice(requestProject, folder, 0, requestFile));
        }
        return result;
    }

    private static FolderChoice Choice(Project p, string folder, int count, string anchor) =>
        new(folder, p.FilePath!, p.Name, count, NamespaceFor(p, folder), anchor);

    private static Accessibility EffectiveAccessibility(ISymbol s)
    {
        var a = s.DeclaredAccessibility;
        for (var c = s.ContainingType; c != null; c = c.ContainingType)
            if (c.DeclaredAccessibility < a) a = c.DeclaredAccessibility;
        return a;
    }

    /// <summary>RootNamespace (or the assembly name) plus the folders below the project directory, as identifiers.</summary>
    public static string NamespaceFor(Project project, string folder)
    {
        var root = string.IsNullOrWhiteSpace(project.DefaultNamespace) ? project.AssemblyName : project.DefaultNamespace!;
        var parts = root.Split('.', StringSplitOptions.RemoveEmptyEntries).Select(Identifier).ToList();
        var rel = Path.GetRelativePath(Path.GetDirectoryName(project.FilePath!)!, folder);
        if (rel != ".")
            foreach (var seg in rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                parts.AddRange(seg.Split('.', StringSplitOptions.RemoveEmptyEntries).Select(Identifier));
        return string.Join(".", parts);
    }

    /// <summary>A folder or namespace segment as a C# identifier: invalid characters become '_', a leading digit gets '_', keywords get '@'.</summary>
    public static string Identifier(string segment)
    {
        var sb = new StringBuilder();
        foreach (var ch in segment) sb.Append(char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_');
        var s = sb.Length == 0 ? "_" : sb.ToString();
        if (char.IsDigit(s[0])) s = "_" + s;
        if (SyntaxFacts.GetKeywordKind(s) != SyntaxKind.None) s = "@" + s;
        return s;
    }

    /// <summary>True when the project's sources use file-scoped namespaces at least as often as block namespaces.</summary>
    public static bool UsesFileScopedNamespaces(Project project, CancellationToken ct)
    {
        if (project.ParseOptions is CSharpParseOptions o && o.LanguageVersion < LanguageVersion.CSharp10) return false;
        int fileScoped = 0, block = 0;
        foreach (var doc in project.Documents)
        {
            if (doc.FilePath == null || !doc.TryGetSyntaxRoot(out var root) && (root = doc.GetSyntaxRootAsync(ct).GetAwaiter().GetResult()) == null) continue;
            if (SymbolFacts.IsGeneratedTree(project.Solution, root!.SyntaxTree, ct)) continue;
            var cu = (CompilationUnitSyntax)root;
            if (cu.Members.OfType<FileScopedNamespaceDeclarationSyntax>().Any()) fileScoped++;
            else if (cu.Members.OfType<NamespaceDeclarationSyntax>().Any()) block++;
        }
        return fileScoped > 0 && fileScoped >= block;
    }

    public static async Task<RenameOutcome> PrepareAsync(Snapshot snapshot, ISymbol symbol, string? targetFolder, CancellationToken ct)
    {
        var a = await AnalyzeAsync(snapshot, symbol, ct).ConfigureAwait(false);
        if (!a.Applicability.Show) return RenameOutcome.Unavailable("NotARequest", "Generate handler works on a MediatR request type (IRequest<T> or IRequest).");
        if (a.Applicability.ReasonCode is { } code) return RenameOutcome.Unavailable(code, a.Applicability.Message!);
        var request = a.Request!;
        var choice = targetFolder == null ? a.Folders[0] : a.Folders.FirstOrDefault(f => UriPaths.PathComparer.Equals(f.Folder, Path.TrimEndingDirectorySeparator(targetFolder)));
        if (choice == null) return RenameOutcome.Unavailable("UnknownFolder", "The chosen folder is not one of the handler folders offered for this request.");
        var project = snapshot.Solution.Projects.First(p => UriPaths.PathComparer.Equals(p.FilePath, choice.ProjectPath));
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation == null) return RenameOutcome.Unavailable("NotInWorkspace", "The project has no compilation.");

        var className = request.Name + "Handler";
        var newPath = Path.Combine(choice.Folder, className + ".cs");
        var anchorDoc = snapshot.Session.DocumentIdsForPath(choice.AnchorPath).Select(snapshot.Solution.GetDocument).FirstOrDefault(d => d != null);
        var eol = anchorDoc != null ? CreateFilePlanner.LineBreak((await anchorDoc.GetTextAsync(ct).ConfigureAwait(false)).ToString()) : "\n";
        var fileScoped = UsesFileScopedNamespaces(project, ct);

        var namespaces = new SortedSet<string>(StringComparer.Ordinal) { "MediatR", "System", "System.Threading", "System.Threading.Tasks" };
        var requestName = Render(request, namespaces);
        string handlerInterface, returnType;
        var publicSignature = EffectiveAccessibility(request) == Accessibility.Public;
        if (a.VoidRequest)
        {
            handlerInterface = $"IRequestHandler<{requestName}>";
            // MediatR 12: IRequestHandler<TRequest>.Handle returns Task; 10/11: it inherits IRequestHandler<TRequest, Unit>.
            var h1 = compilation.GetTypeByMetadataName("MediatR.IRequestHandler`1");
            returnType = h1 != null && MediatRModule.IRequestHandler1.Matches(h1) && h1.GetMembers("Handle").OfType<IMethodSymbol>().Any(m => m.ReturnType is INamedTypeSymbol { IsGenericType: false })
                ? "Task" : "Task<Unit>";
        }
        else
        {
            var response = Render(a.Response!, namespaces);
            publicSignature &= TypesIn(a.Response!).All(t => EffectiveAccessibility(t) == Accessibility.Public || t.SpecialType != SpecialType.None);
            handlerInterface = $"IRequestHandler<{requestName}, {response}>";
            returnType = $"Task<{response}>";
        }
        var access = publicSignature ? "public" : "internal";
        var ns = choice.Namespace;

        string Compose(IReadOnlyList<string> usings)
        {
            var sb = new StringBuilder();
            var visible = usings.Where(u => !(ns == u || ns.StartsWith(u + ".", StringComparison.Ordinal))).ToList();
            foreach (var u in visible) sb.Append("using ").Append(u).Append(';').Append(eol);
            if (visible.Count > 0) sb.Append(eol);
            var indent = fileScoped ? "" : "    ";
            if (fileScoped) sb.Append("namespace ").Append(ns).Append(';').Append(eol).Append(eol);
            else sb.Append("namespace ").Append(ns).Append(eol).Append('{').Append(eol);
            sb.Append(indent).Append(access).Append(" sealed class ").Append(className).Append(" : ").Append(handlerInterface).Append(eol);
            sb.Append(indent).Append('{').Append(eol);
            sb.Append(indent).Append("    public ").Append(returnType).Append(" Handle(").Append(requestName).Append(" request, CancellationToken cancellationToken)").Append(eol);
            sb.Append(indent).Append("    {").Append(eol);
            sb.Append(indent).Append("        throw new NotImplementedException();").Append(eol);
            sb.Append(indent).Append("    }").Append(eol);
            sb.Append(indent).Append('}').Append(eol);
            if (!fileScoped) sb.Append('}').Append(eol);
            return sb.ToString();
        }

        var owners = CreateFilePlanner.ProjectIds(snapshot.Solution, new[] { choice.ProjectPath });
        async Task<int> ErrorsAsync(IReadOnlyList<string> usings)
        {
            var sol = CreateFilePlanner.AddDocument(snapshot.Solution, owners.Take(1), newPath, Compose(usings));
            return (await CreateFilePlanner.DocumentErrorsAsync(sol, newPath, ct).ConfigureAwait(false)).Count;
        }
        var all = namespaces.ToList();
        if (await ErrorsAsync(all).ConfigureAwait(false) > 0)
            return RenameOutcome.Unavailable("CompilationErrors", $"The generated {className} would not compile in {project.Name} (e.g. a name conflict); nothing is generated.");
        var keep = await CreateFilePlanner.MinimiseAsync<string>(all, async k => await ErrorsAsync(k).ConfigureAwait(false) == 0).ConfigureAwait(false);
        var text = Compose(keep);

        var create = new PlannedFileCreate(newPath, text, Hashing.Sha256Text(text), choice.AnchorPath, FileRenamePlanner.ProjectsOf(snapshot, choice.AnchorPath));
        var limitations = new List<string>
        {
            "No DI registration is generated: MediatR finds handlers by scanning assemblies (AddMediatR with RegisterServicesFromAssembly...). If the assembly of this project is not scanned, register the handler yourself.",
            "Handle throws NotImplementedException until you implement it (an honest placeholder; nothing is invented).",
        };
        var evidence = new List<(string, Location?)>
        {
            ($"{request.Name} implements {(a.VoidRequest ? "MediatR.IRequest" : "MediatR.IRequest<T>")} (verified MediatR identity) and no source handler handles it", SymbolFacts.PrimaryLocation(request)),
            ($"Folder: {choice.ProjectName}/{Path.GetRelativePath(Path.GetDirectoryName(choice.ProjectPath)!, choice.Folder).Replace('\\', '/')} ({choice.HandlerCount} existing handler(s)); namespace {ns} ({(fileScoped ? "file-scoped, as in the project" : "block")})", null),
        };
        var offer = new CreateFileOffer(newPath, a.Folders, choice.Folder);
        return await CreateFilePlanner.BuildPlanAsync(snapshot, ActionId, $"Generate {className}", create, null, Array.Empty<Microsoft.CodeAnalysis.Text.TextChange>(),
            limitations, evidence, offer, ct).ConfigureAwait(false);
    }

    /// <summary>Every named type in <paramref name="t"/> (generic arguments, array elements, tuple elements).</summary>
    private static IEnumerable<ITypeSymbol> TypesIn(ITypeSymbol t)
    {
        switch (t)
        {
            case IArrayTypeSymbol arr:
                foreach (var x in TypesIn(arr.ElementType)) yield return x;
                break;
            case INamedTypeSymbol named:
                yield return named;
                foreach (var arg in named.TypeArguments)
                foreach (var x in TypesIn(arg)) yield return x;
                break;
        }
    }

    /// <summary>The type as C# source with short names; the namespaces it needs are added to <paramref name="namespaces"/>.</summary>
    public static string Render(ITypeSymbol t, ISet<string> namespaces)
    {
        switch (t)
        {
            case IArrayTypeSymbol arr:
                return Render(arr.ElementType, namespaces) + "[" + new string(',', arr.Rank - 1) + "]" + Nullable(t);
            case INamedTypeSymbol { IsTupleType: true } tuple:
                return "(" + string.Join(", ", tuple.TupleElements.Select(e => Render(e.Type, namespaces) + (e.IsExplicitlyNamedTupleElement ? " " + e.Name : ""))) + ")" + Nullable(t);
            case INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n:
                return Render(n.TypeArguments[0], namespaces) + "?";
            case INamedTypeSymbol named when named.SpecialType != SpecialType.None:
                return named.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat.WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.UseSpecialTypes)).TrimEnd('?') + Nullable(t);
            case INamedTypeSymbol named:
            {
                var chain = new List<string>();
                INamedTypeSymbol outer = named;
                for (var c = named; c != null; c = c.ContainingType)
                {
                    chain.Insert(0, c.Name + (c.TypeArguments.Length > 0 ? "<" + string.Join(", ", c.TypeArguments.Select(x => Render(x, namespaces))) + ">" : ""));
                    outer = c;
                }
                if (outer.ContainingNamespace is { IsGlobalNamespace: false } ns) namespaces.Add(ns.ToDisplayString());
                return string.Join(".", chain) + Nullable(t);
            }
            default:
                return t.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        }
    }

    private static string Nullable(ITypeSymbol t) => t.IsReferenceType && t.NullableAnnotation == NullableAnnotation.Annotated ? "?" : "";
}
