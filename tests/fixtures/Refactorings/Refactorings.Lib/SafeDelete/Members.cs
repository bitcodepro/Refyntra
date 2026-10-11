using System;

namespace Refactorings.Lib.SafeDelete;

public class Members
{
    private int _unusedField = 1, _usedField = 2;

    public int UsedField => _usedField;

    /// <summary>Nothing calls this method.</summary>
    public void UnusedMethod()
    {
        Console.WriteLine("unused");
    }

    public void UsedMethod()
    {
    }

    public void CallsUsed()
    {
        UsedMethod();
    }

    public int Recursive(int n) => n <= 0 ? 0 : Recursive(n - 1);

    public void Locals()
    {
        var unusedLocal = 42;
        var sideEffect = Compute();
        Console.WriteLine("done");
    }

    private static int Compute() => 7;

    public void WithParam(int keep, int unusedParam)
    {
        Console.WriteLine(keep);
    }

    public void CallWithParam()
    {
        WithParam(1, 2);
        WithParam(unusedParam: 4, keep: 3);
    }

    public void SideEffectParam(int keep, int drop)
    {
        Console.WriteLine(keep);
    }

    public void CallSideEffectParam()
    {
        SideEffectParam(1, Compute());
    }

    public void UsedParam(int a, int b)
    {
        Console.WriteLine(a + b);
    }

    public void ReflectedMethod()
    {
    }

    public object? FindReflected() => typeof(Members).GetMethod("ReflectedMethod");
}
