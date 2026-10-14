namespace Ssr.App.Cases;

public sealed class Blocks
{
    public int A()
    {
        var total = 0; // m: accumulate
        total += 1;
        total += 2;
        return total;
    }

    public int B()
    {
        var other = 1; // m: accumulate
        return other;
    }

    public int C()
    {
        var x = 1;
        var y = 2; // m: accumulate
        return y;
    }
}
