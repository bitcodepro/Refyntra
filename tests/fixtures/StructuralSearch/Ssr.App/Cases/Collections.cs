using System.Collections.Generic;

namespace Ssr.App.Cases;

public sealed class Collections
{
    public bool IsEmpty(List<int> list) => list.Count == 0; // m: countzero
    public bool Sized(Dictionary<string, int> map) => map.Count == 0; // m: countzero
    public bool Other(Counter c) => c.Count == 0;
}

public sealed class Counter
{
    public int Count;
}
