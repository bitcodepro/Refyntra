using System;
using System.Collections.Generic;

namespace Refactorings.Lib.EditActions;

public class Samples
{
    private readonly int _factor = 3;
    private int _counter;

    public int Twice(int x) => x * 2;

    public void Log(string m) => Console.WriteLine(m);

    public string Name => "samples";

    public int Square(int x)
    {
        return x * x;
    }

    public int Count
    {
        get { return _counter; }
    }

    public int Next() => ++_counter;

    public void Locals(List<int> items)
    {
        var list = new List<string>();
        Dictionary<string, int> map = new Dictionary<string, int>();
        foreach (var item in items) Console.WriteLine(item);
        Console.WriteLine(list.Count + map.Count);
    }

    public int Sign(int value)
    {
        if (value > 0)
        {
            return 1;
        }
        else
        {
            return -1;
        }
    }

    public double FloatSign(double d)
    {
        if (d < 0) { return -1; } else { return 1; }
    }

    public string Pick(bool flag)
    {
        return flag ? "yes" : "no";
    }

    public object Mixed(bool flag)
    {
        if (flag) return 1; else return 2.5;
    }

    public void Nested(bool a, bool b)
    {
        if (a)
        {
            if (b)
            {
                Console.WriteLine("both");
            }
        }
        if (a && b) Console.WriteLine("and");
    }

    public string Greet(string name, int age)
    {
        return "Hello " + name + ", age " + age + " {ok}";
    }

    public int InlineMe(int a, int b)
    {
        var sum = a + b;
        return sum * sum;
    }

    public int InlineCall()
    {
        var n = Next();
        Console.WriteLine("between");
        return n;
    }

    public int InlineWritten()
    {
        var w = 1;
        w = 2;
        return w;
    }

    public long Widen(int a)
    {
        long big = a;
        return big * 1000000;
    }

    public int Introduce(int a, int b)
    {
        Console.WriteLine(a * b + _factor);
        return a * b - 1;
    }

    public int IntroduceOrder()
    {
        return Next() + Next();
    }
}
