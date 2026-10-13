using System.Collections.Generic;

namespace Inspections.App.Cases;

public class ConcatInLoop
{
    public string Join(IEnumerable<string> parts)
    {
        var s = "";
        foreach (var p in parts)
        {
            s += p; // expect: OR1007
            s += ",";
        }
        return s;
    }

    public string Count(int n)
    {
        string text = "x";
        for (var i = 0; i < n; i++) text += i; // expect: OR1007
        return text;
    }

    // ---- false-positive guards

    public string Once(string a)
    {
        var s = "";
        s += a;
        return s;
    }

    public void InnerLocal(IEnumerable<string> parts)
    {
        foreach (var p in parts)
        {
            var line = p;
            line += "!";
            System.Console.WriteLine(line);
        }
    }

    private string _field = "";

    public void Field(IEnumerable<string> parts)
    {
        foreach (var p in parts) _field += p;
    }

    public string Unique(HashSet<string> names, string p)
    {
        var name = p;
        while (!names.Add(name)) name += "1";
        return name;
    }

    public int Numbers(int n)
    {
        var sum = 0;
        for (var i = 0; i < n; i++) sum += i;
        return sum;
    }
}
