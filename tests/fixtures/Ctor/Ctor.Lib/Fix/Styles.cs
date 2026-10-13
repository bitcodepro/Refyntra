using System.Collections.Generic;

namespace Ctor.Lib.Fix;

public static class Styles
{
    public static int Sum()
    {
        var a = 1;
        var name = "x";
        var list = new List<int>();
        return a + name.Length + list.Count;
    }
}
