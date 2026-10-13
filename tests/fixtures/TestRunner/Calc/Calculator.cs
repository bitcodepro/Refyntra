namespace Calc;

public static class Calculator
{
    public static int Add(int a, int b)
    {
        var sum = a + b;
        return sum;
    }

    public static int Divide(int a, int b)
    {
        if (b == 0) throw new DivideByZeroException("b must not be zero");
        return a / b;
    }
}
