public struct CountedValue
{
    public static int Count;
    public int N;
    public static implicit operator CountedValue(int value) => new CountedValue { N = ++Count };
}

public static class SignatureConversionOrder
{
    public static int Pair(CountedValue a, CountedValue b) => a.N * 10 + b.N;

    public static int Literals()
    {
        CountedValue.Count = 0;
        return Pair(1, 2);
    }

    public static int Locals()
    {
        CountedValue.Count = 0;
        int x = 1, y = 2;
        return Pair(x, y);
    }

    public static int Dropped(CountedValue unused, int kept) => kept;

    public static int Drop()
    {
        CountedValue.Count = 0;
        return Dropped(1, 2) + CountedValue.Count * 100;
    }
}
