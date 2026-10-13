using Microsoft.CodeAnalysis;

namespace Refyntra.Semantics;

/// <summary>
/// Navigate To (protocol 1.12, <c>code/hierarchy</c> directions <c>bases</c> and <c>containing</c>): the base symbols of a
/// type or member and its containing type. Only symbols declared in source are returned (each target is opened).
/// </summary>
public static class NavigationTargets
{
    /// <summary>
    /// A type: its base classes (System.Object, ValueType and Enum left out) and every interface it implements, nearest
    /// first. A method, property or event: the member it overrides (the whole chain) and the interface members it
    /// implements, implicitly or explicitly.
    /// </summary>
    public static List<ISymbol> Bases(ISymbol symbol)
    {
        var result = new List<ISymbol>();
        switch (symbol)
        {
            case INamedTypeSymbol t:
                for (var b = t.BaseType; b != null && b.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum); b = b.BaseType)
                    result.Add(b.OriginalDefinition);
                result.AddRange(t.AllInterfaces.Select(i => (ISymbol)i.OriginalDefinition));
                break;
            case IMethodSymbol or IPropertySymbol or IEventSymbol:
                var chain = new List<ISymbol> { symbol };
                for (var o = Overridden(symbol); o != null; o = Overridden(o)) chain.Add(o.OriginalDefinition);
                result.AddRange(chain.Skip(1));
                // The interface members implemented by the member or by a member it overrides.
                foreach (var m in chain) result.AddRange(ImplementedInterfaceMembers(m));
                break;
        }
        return Distinct(result).Where(InSource).ToList();
    }

    /// <summary>The type that declares a member or a nested type; empty for a top-level type or a namespace.</summary>
    public static List<ISymbol> Containing(ISymbol symbol)
    {
        if (symbol is INamespaceSymbol) return new();
        var c = symbol.ContainingType;
        // Locals and parameters belong to a member: its type is the containing type that can be opened.
        if (symbol is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol) c = symbol.ContainingSymbol?.ContainingType;
        return c != null && InSource(c) ? new List<ISymbol> { c.OriginalDefinition } : new();
    }

    private static ISymbol? Overridden(ISymbol s) => s switch
    {
        IMethodSymbol m => m.OverriddenMethod,
        IPropertySymbol p => p.OverriddenProperty,
        IEventSymbol e => e.OverriddenEvent,
        _ => null,
    };

    private static IEnumerable<ISymbol> ImplementedInterfaceMembers(ISymbol member)
    {
        var explicitly = member switch
        {
            IMethodSymbol m => m.ExplicitInterfaceImplementations.Cast<ISymbol>(),
            IPropertySymbol p => p.ExplicitInterfaceImplementations.Cast<ISymbol>(),
            IEventSymbol e => e.ExplicitInterfaceImplementations.Cast<ISymbol>(),
            _ => Enumerable.Empty<ISymbol>(),
        };
        foreach (var x in explicitly) yield return x.OriginalDefinition;
        var type = member.ContainingType;
        if (type == null) yield break;
        foreach (var iface in type.AllInterfaces)
        foreach (var candidate in iface.GetMembers(member.Name))
        {
            var impl = type.FindImplementationForInterfaceMember(candidate);
            if (impl != null && SymbolEqualityComparer.Default.Equals(impl.OriginalDefinition, member.OriginalDefinition)) yield return candidate.OriginalDefinition;
        }
    }

    private static bool InSource(ISymbol s) => s.Locations.Any(l => l.IsInSource);

    private static IEnumerable<ISymbol> Distinct(IEnumerable<ISymbol> list)
    {
        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var s in list) if (seen.Add(s)) yield return s;
    }
}
