using System.Collections.Generic;
using System.Linq;

namespace Ssr.App.Cases;

public sealed class Bag
{
    public int Count() => 0;
}

public sealed class LinqCases
{
    public bool A(List<int> list) => list.Count() > 0; // m: any
    public bool B(IEnumerable<string> items) => items.Count() > 0; // m: any
    public bool C(List<int> list) => list.Count > 0;
    public bool D(Bag bag) => bag.Count() > 0;
}
