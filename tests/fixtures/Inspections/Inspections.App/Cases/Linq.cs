using System.Collections.Generic;
using System.Linq;

namespace Inspections.App.Cases;

public class Linq
{
    public int First(List<int> xs) => xs.Where(x => x > 1).First(); // expect: OR1008

    public bool Any(IEnumerable<string> xs) => xs.Where(s => s.Length > 2).Any(); // expect: OR1008

    public int Count(int[] xs) => xs.Where(x => x % 2 == 0).Count(); // expect: OR1008

    public bool CopyThenAny(IEnumerable<int> xs) => xs.ToList().Any(); // expect: OR1009

    public int CopyThenSum(int[] xs) => xs.ToArray().Sum(); // expect: OR1009

    public int LoopOverCopy(List<int> items)
    {
        var total = 0;
        foreach (var i in items.ToList()) total += i; // expect: OR1009
        return total;
    }

    public int LoopOverFilteredCopy(List<int> items)
    {
        var total = 0;
        foreach (var i in items.Where(x => x > 0).ToList()) total += i; // expect: OR1009
        return total;
    }

    // ---- false-positive guards

    public int IndexedWhere(List<int> xs) => xs.Where((x, i) => i > 0).First();

    public int WhereThenSelect(List<int> xs) => xs.Where(x => x > 1).Select(x => x * 2).First();

    public int FirstWithPredicate(List<int> xs) => xs.First(x => x > 1);

    public void LoopRemoves(List<int> items)
    {
        foreach (var i in items.ToList())
            if (i < 0) items.Remove(i);
    }

    public void LoopMutatesAlias(List<int> items, List<int> alias)
    {
        foreach (var i in items.ToList()) alias.Add(i);
    }

    public List<int> CopyKept(IEnumerable<int> xs)
    {
        var copy = xs.ToList();
        return copy;
    }

    public IEnumerable<int> CopyThenDeferred(IEnumerable<int> xs) => xs.ToList().Where(x => x > 0);

    public void LoopOverLazySource(IEnumerable<int> source)
    {
        foreach (var i in source.ToList()) System.Console.WriteLine(i);
    }

    public bool ListContains(List<int> xs) => xs.ToList().Contains(3);

    public bool Queryable(IQueryable<int> q) => q.ToList().Any();
}
