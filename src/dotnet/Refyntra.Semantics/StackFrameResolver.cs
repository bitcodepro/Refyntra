using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Refyntra.Workspaces;

namespace Refyntra.Semantics;

/// <summary>One stack frame as the client decoded it (compiler names already mapped to the user method).</summary>
/// <param name="TypeName">Dotted type name as a .NET stack trace prints it ("Ns.Outer.Inner", "Ns.Repo`1"); nested types may use '.' or '+'.</param>
/// <param name="MethodName">The user method ("Get", ".ctor", "get_Name").</param>
/// <param name="LocalFunctionName">Set when the frame is a local function inside <paramref name="MethodName"/>.</param>
/// <param name="MethodArity">Generic arity of the method, when the trace shows it.</param>
/// <param name="ParameterTypes">Parameter type names as printed ("Int32", "String[]", "List`1"); null when unknown (async, lambdas).</param>
public sealed record FrameQuery(string TypeName, string MethodName, string? LocalFunctionName, int? MethodArity, IReadOnlyList<string>? ParameterTypes);

public sealed record FrameCandidate(ISymbol Symbol, Project Project, Location Location, string Confidence, string Reason);

/// <summary>
/// code/resolveFrame: finds the source symbol of a .NET stack frame. Read-only, no execution. "proven" only when the
/// type is found by its exact metadata name and exactly one overload has the printed parameter types; everything
/// found by name alone is "likely". Symbols that exist only in metadata are never returned (no source to open).
/// </summary>
public static class StackFrameResolver
{
    public const int MaxCandidates = 20;

    public static async Task<IReadOnlyList<FrameCandidate>> ResolveAsync(Snapshot snap, FrameQuery q, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(q.TypeName) || string.IsNullOrWhiteSpace(q.MethodName)) return Array.Empty<FrameCandidate>();
        var exact = new List<(INamedTypeSymbol type, Project project)>();
        var byName = new List<(INamedTypeSymbol type, Project project)>();
        var variants = MetadataNameVariants(q.TypeName.Replace('/', '+')).ToList();
        foreach (var project in snap.Solution.Projects)
        {
            ct.ThrowIfCancellationRequested();
            if (project.Language != LanguageNames.CSharp) continue;
            var comp = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (comp == null) continue;
            foreach (var v in variants)
                if (comp.Assembly.GetTypeByMetadataName(v) is { } t && IsSource(t)) exact.Add((t, project));
        }
        if (exact.Count == 0)
        {
            var (simple, arity) = SimpleTypeName(q.TypeName);
            foreach (var project in snap.Solution.Projects)
            {
                if (project.Language != LanguageNames.CSharp) continue;
                var comp = await project.GetCompilationAsync(ct).ConfigureAwait(false);
                if (comp == null) continue;
                foreach (var s in comp.GetSymbolsWithName(simple, SymbolFilter.Type, ct).OfType<INamedTypeSymbol>())
                    if (s.Arity == arity && IsSource(s)) byName.Add((s, project));
            }
        }
        var exactType = exact.Count > 0;
        var types = Distinct(exactType ? exact : byName);
        var result = new List<FrameCandidate>();
        foreach (var (type, project) in types)
        {
            var methods = Methods(type, q.MethodName).Where(m => q.MethodArity == null || m.Arity == q.MethodArity).ToList();
            if (methods.Count == 0)
            {
                // The method is gone or renamed: the type is the best we can show.
                if (SymbolFacts.PrimaryLocation(type) is { } tl)
                    result.Add(new FrameCandidate(type, project, tl, "likely", $"The type exists but has no method {q.MethodName} (the code may have changed)."));
                continue;
            }
            List<IMethodSymbol> matched = q.ParameterTypes == null ? new() : methods.Where(m => ParametersMatch(m, q.ParameterTypes)).ToList();
            var proven = exactType && matched.Count == 1;
            var chosen = matched.Count > 0 ? matched : methods;
            foreach (var m in chosen)
            {
                var loc = SymbolFacts.PrimaryLocation(m);
                if (loc == null) continue;
                string reason;
                if (proven) reason = "Exact type name and parameter types.";
                else if (matched.Count > 0) reason = exactType ? "Exact type name and parameter types, but several overloads match." : "Type found by name only; the parameter types match.";
                else if (q.ParameterTypes == null) reason = exactType ? "Exact type name; method matched by name only (the trace shows no parameters for this frame)." : "Type and method matched by name only.";
                else reason = "Method matched by name; the parameter types differ (the code may have changed).";
                if (q.LocalFunctionName is { Length: > 0 } local)
                {
                    var lf = await LocalFunctionAsync(m, local, ct).ConfigureAwait(false);
                    if (lf != null) { loc = lf; reason = $"Local function {local} in {m.Name}. " + reason; }
                    else reason = $"Local function {local} not found in {m.Name}; showing the method. " + reason;
                }
                result.Add(new FrameCandidate(m, project, loc, proven ? "proven" : "likely", reason));
            }
        }
        return result
            .GroupBy(c => (c.Location.SourceTree?.FilePath, c.Location.SourceSpan.Start))
            .Select(g => g.First())
            .OrderBy(c => c.Confidence == "proven" ? 0 : 1)
            .Take(MaxCandidates)
            .ToList();
    }

    private static bool IsSource(ISymbol s) => s.Locations.Any(l => l.IsInSource);

    private static List<(INamedTypeSymbol, Project)> Distinct(List<(INamedTypeSymbol type, Project project)> list) =>
        list.GroupBy(x => (x.type.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree?.FilePath, x.type.ToDisplayString()))
            .Select(g => g.First()).ToList();

    private static IEnumerable<IMethodSymbol> Methods(INamedTypeSymbol type, string name) => name switch
    {
        ".ctor" => type.InstanceConstructors.Where(IsSource),
        ".cctor" => type.StaticConstructors.Where(IsSource),
        _ => type.GetMembers(name).OfType<IMethodSymbol>().Where(IsSource),
    };

    /// <summary>"A.B.C`1" → "A.B.C`1", "A.B+C`1", "A+B+C`1": a stack trace prints nested types with dots.</summary>
    public static IEnumerable<string> MetadataNameVariants(string typeName)
    {
        var parts = typeName.Replace('+', '.').Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) yield break;
        // k = number of trailing parts that are nested types joined with '+'.
        for (var k = 0; k < parts.Length; k++)
        {
            var ns = string.Join('.', parts.Take(parts.Length - k));
            var nested = parts.Skip(parts.Length - k);
            yield return k == 0 ? ns : ns + "+" + string.Join('+', nested);
        }
    }

    private static (string name, int arity) SimpleTypeName(string typeName)
    {
        var last = typeName.Replace('+', '.').Replace('/', '.').Split('.', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? typeName;
        var tick = last.IndexOf('`');
        if (tick < 0) return (last, 0);
        return (last[..tick], int.TryParse(last[(tick + 1)..], out var a) ? a : 0);
    }

    private static bool ParametersMatch(IMethodSymbol m, IReadOnlyList<string> printed)
    {
        if (m.Parameters.Length != printed.Count) return false;
        for (var i = 0; i < printed.Count; i++)
            if (!string.Equals(NormalizePrinted(printed[i]), NormalizeSymbol(m.Parameters[i].Type), StringComparison.Ordinal)) return false;
        return true;
    }

    private static readonly Dictionary<string, string> Keywords = new(StringComparer.Ordinal)
    {
        ["bool"] = "Boolean", ["byte"] = "Byte", ["sbyte"] = "SByte", ["char"] = "Char", ["decimal"] = "Decimal", ["double"] = "Double",
        ["float"] = "Single", ["int"] = "Int32", ["uint"] = "UInt32", ["long"] = "Int64", ["ulong"] = "UInt64", ["short"] = "Int16",
        ["ushort"] = "UInt16", ["object"] = "Object", ["string"] = "String", ["nint"] = "IntPtr", ["nuint"] = "UIntPtr",
    };

    /// <summary>"System.Collections.Generic.List`1[System.Int32]" / "List`1" / "Int32&amp;" / "int" → "List`1" / "Int32".</summary>
    public static string NormalizePrinted(string printed)
    {
        var s = printed.Trim();
        foreach (var prefix in new[] { "ref ", "out ", "in ", "params ", "this " })
            if (s.StartsWith(prefix, StringComparison.Ordinal)) s = s[prefix.Length..].Trim();
        s = s.TrimEnd('&').Trim();
        var suffix = "";
        // Array/pointer suffixes ("[]", "[,]", "*") stay; generic arguments ("[...]" with letters, "<...>") go.
        while (true)
        {
            if (s.EndsWith('*')) { suffix = "*" + suffix; s = s[..^1]; continue; }
            if (s.EndsWith(']'))
            {
                var open = MatchingOpen(s, '[', ']');
                if (open < 0) break;
                var inner = s[(open + 1)..^1];
                if (inner.All(c => c == ',' || c == ' ')) suffix = "[" + inner.Replace(" ", "") + "]" + suffix;
                s = s[..open];
                continue;
            }
            if (s.EndsWith('>'))
            {
                var open = MatchingOpen(s, '<', '>');
                if (open < 0) break;
                var args = s[(open + 1)..^1];
                s = s[..open];
                if (!s.Contains('`')) s += "`" + (args.Count(c => c == ',') + 1);
                continue;
            }
            if (s.EndsWith('?')) { s = "Nullable`1"; continue; }
            break;
        }
        var lastDot = s.LastIndexOf('.');
        if (lastDot >= 0) s = s[(lastDot + 1)..];
        s = s.Replace('+', '.');
        if (Keywords.TryGetValue(s, out var clr)) s = clr;
        return s + suffix;
    }

    private static int MatchingOpen(string s, char open, char close)
    {
        var depth = 0;
        for (var i = s.Length - 1; i >= 0; i--)
        {
            if (s[i] == close) depth++;
            else if (s[i] == open && --depth == 0) return i;
        }
        return -1;
    }

    public static string NormalizeSymbol(ITypeSymbol t) => t switch
    {
        IArrayTypeSymbol a => NormalizeSymbol(a.ElementType) + "[" + new string(',', a.Rank - 1) + "]",
        IPointerTypeSymbol p => NormalizeSymbol(p.PointedAtType) + "*",
        INamedTypeSymbol n => n.MetadataName,
        _ => t.MetadataName.Length > 0 ? t.MetadataName : t.Name,
    };

    private static async Task<Location?> LocalFunctionAsync(IMethodSymbol m, string name, CancellationToken ct)
    {
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            var node = await r.GetSyntaxAsync(ct).ConfigureAwait(false);
            var lf = node.DescendantNodes().OfType<LocalFunctionStatementSyntax>().FirstOrDefault(f => f.Identifier.ValueText == name);
            if (lf != null) return lf.Identifier.GetLocation();
        }
        return null;
    }
}
