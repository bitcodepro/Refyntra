// Calls for the debugger e2e (Smart Step Into, conditional breakpoints, exception types).
public static class Calc
{
    public static int Square(int x) => x * x;

    public static int Twice(int x)
    {
        return x * 2;
    }

    public static int Add(int a, int b)
    {
        return a + b;
    }

    public static bool Check(int x)
    {
        return x > 100;
    }

    public static void TryFail()
    {
        try
        {
            throw new InvalidOperationException("thrown and caught on purpose");
        }
        catch (InvalidOperationException)
        {
        }
    }
}
