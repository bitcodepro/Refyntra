using System;
using System.Collections.Generic;
using System.Linq;

namespace Inspections.App.Cases;

public class MultipleEnumeration
{
    public int Twice(IEnumerable<int> items)
    {
        if (!items.Any()) return 0;
        return items.Sum(); // expect: OR1006
    }

    public int ForeachThenCount(IEnumerable<string> names)
    {
        var n = 0;
        foreach (var s in names) n += s.Length;
        return n + names.Count(); // expect: OR1006
    }

    public int Local(int[] source)
    {
        IEnumerable<int> query = source.Where(x => x > 1);
        var first = query.First();
        return first + query.Count(); // expect: OR1006
    }

    // ---- false-positive guards

    public int Once(IEnumerable<int> items) => items.Sum();

    public int Branches(IEnumerable<int> items, bool flag)
    {
        if (flag) return items.Count();
        else return items.Sum();
    }

    public int EarlyReturn(IEnumerable<int> items, bool flag)
    {
        if (flag)
        {
            return items.First();
        }
        return items.Last();
    }

    public int Conditional(IEnumerable<int> items, bool flag) => flag ? items.Min() : items.Max();

    public int Materialized(IEnumerable<int> items)
    {
        var list = items.ToList();
        return list.Count + list.Sum();
    }

    public int DeclaredButList()
    {
        IEnumerable<int> xs = new List<int> { 1, 2 };
        return xs.Count() + xs.Sum();
    }

    public int Collection(List<int> items) => items.Count() + items.Sum();

    public int Reassigned(IEnumerable<int> items)
    {
        var a = items.Count();
        items = items.ToArray();
        return a + items.Sum();
    }

    public Func<int> InLambda(IEnumerable<int> items)
    {
        var c = items.Count();
        return () => items.Sum() + c;
    }

    public IEnumerable<int> Deferred(IEnumerable<int> items) => items.Where(x => x > 0).Select(x => x * 2);
}
