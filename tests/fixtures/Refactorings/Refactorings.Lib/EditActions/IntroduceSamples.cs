using System;
using System.Collections.Generic;

namespace Refactorings.Lib.EditActions;

public class IntroduceSamples
{
    private readonly int _scale = 3;
    private int _counter;

    public IntroduceSamples()
    {
        _counter = 1;
    }

    public IntroduceSamples(int start) : this()
    {
        _counter = start;
    }

    public string Greet(string who)
    {
        var prefix = "Hello, " + Environment.NewLine;
        return prefix + who;
    }

    public int Area(int width)
    {
        return width * (60 * 60);
    }

    public int Seconds() => 60 * 60 + Math.Max(1, 2);

    public int Scaled(int v)
    {
        return v * _scale + _counter;
    }

    public int Tick()
    {
        _counter++;
        return _counter + DateTime.Now.Second;
    }

    public static string Banner()
    {
        return string.Join(", ", new List<string> { "a", "b" });
    }

    public int Twice(int v)
    {
        var doubled = v * 2;
        return doubled;
    }
}

internal sealed class PriceCalculator
{
    public const decimal TaxRate = 0.2m;

    internal decimal Gross(decimal net)
    {
        return net * (1 + TaxRate) + Fee();
    }

    internal decimal Net(decimal net) => net - Math.Round(10m / 3, 2);

    private static decimal Fee() => 1.5m;

    internal int Count(int x) => x + Seed * 2;

    private int Seed => 4;

}

internal sealed class GroupUser
{
    internal Func<decimal, decimal> Pick(PriceCalculator calc) => calc.Net;
}

internal interface IShape
{
    double Size(double unit);
}

internal sealed class Square : IShape
{
    public double Size(double unit) => unit * Math.Sqrt(16);
}
