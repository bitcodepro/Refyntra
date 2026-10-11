using System;
using System.Linq;

namespace Refactorings.Lib.ChangeSignature;

public interface IGreeter
{
    string Greet(string name, int times);
}

public class Greeter : IGreeter
{
    /// <summary>Greets someone.</summary>
    /// <param name="name">Who is greeted.</param>
    /// <param name="times">How often.</param>
    public virtual string Greet(string name, int times) => string.Concat(Enumerable.Repeat("Hi " + name, times));
}

public class LoudGreeter : Greeter
{
    public override string Greet(string who, int times) => base.Greet(who, times).ToUpperInvariant();
}

public static class GreeterUse
{
    public static string Use(IGreeter greeter) => greeter.Greet("a", 2) + greeter.Greet(times: 3, name: "b");

    public static string UseConcrete() => new Greeter().Greet("c", 1);
}

public static class Calc
{
    private static int _counter;

    public static int Next() => ++_counter;

    public static int Twice(int x) => x * 2;

    public static int[] All(int[] xs) => Array.ConvertAll(xs, Twice);

    public static int Combine(int a, int b) => a - b;

    public static int UseCombine() => Combine(Next(), Next());

    public static int Ignore(int a, int unused) => a;

    public static int UseIgnore() => Ignore(1, Next());

    public static int Plus(this int x, int y) => x + y;

    public static int UsePlus() => 5.Plus(3);

    public static int SumAll(string label, params int[] values) => label.Length + values.Sum();

    public static int UseSumAll() => SumAll("x", 1, 2, 3);

    public static string Show(int v) => v.ToString();

    public static string Show(int v, int pad) => v.ToString().PadLeft(pad);

    public static string UseShow() => Show(1) + Show(2, 3);
}

public class Point
{
    public Point(int x, int y)
    {
        X = x;
        Y = y;
    }

    public int X { get; }

    public int Y { get; }

    public static Point Origin() => new Point(0, 1);
}

public class Point3 : Point
{
    public Point3() : base(2, 3)
    {
    }
}

public class Dyn
{
    public void Run(int a)
    {
    }

    public static void CallDynamic()
    {
        dynamic d = new Dyn();
        d.Run(1);
        new Dyn().Run(2);
    }
}
