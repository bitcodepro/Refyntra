using System;
using System.Collections.Generic;

namespace Refactorings.Lib.EditActions;

public class InlineSamples
{
    private const int Limit = 10;
    private const long Wide = 5;
    private static readonly string Greeting = "hi";
    private readonly int _seed = 7;
    private int _state;
    private readonly List<int> _items = new List<int>();

    private int Add(int a, int b) => a + b;

    private int Doubled(int v)
    {
        return v + v;
    }

    private void Report(string text) => Console.WriteLine(text);

    private int Fact(int n) => n <= 1 ? 1 : n * Fact(n - 1);

    private int Sign(int v)
    {
        if (v < 0) return -1;
        return 1;
    }

    private void Bump(ref int v) => v++;

    public virtual int Hook(int v) => v + 1;

    private int Grouped(int v) => v * 3;

    private int Next() => ++_state;

    private int Scaled(int v, int factor) => v * factor;

    private int Once(int v) => v * 4;

    public int UseAdd()
    {
        var x = Add(1, 2);
        return x + Add(3, 4);
    }

    public int UseDoubled()
    {
        var r = Doubled(Next());
        return r;
    }

    public void UseReport(int n) => Report("n=" + n);

    public int UseFact() => Fact(4);

    public int UseSign() => Sign(-2);

    public void UseBump()
    {
        var v = 1;
        Bump(ref v);
    }

    public int UseHook() => Hook(1);

    public Func<int, int> UseGrouped() => Grouped;

    public int UseGroupedCall() => Grouped(2);

    public int UseScaled() => Scaled(2, 10) + Scaled(3, 10);

    public int UseScaledOther(int k) => Scaled(k, 10);

    public int UseOnce()
    {
        var a = Once(2);
        var b = Once(5);
        return a + b;
    }

    public int UseLimit(int v) => v > Limit ? Limit : v;

    public long UseWide() => Wide * 2;

    public string UseGreeting() => Greeting + "!";

    public int UseSeed() => _seed + 1;

    public int UseItems() => _items.Count;

    public int UseState() => _state;
}
