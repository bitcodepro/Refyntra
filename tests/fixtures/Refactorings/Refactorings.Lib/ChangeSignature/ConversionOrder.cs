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

    public static int TuplePair((CountedValue, int) a, (CountedValue, int) b) => a.Item1.N * 10 + b.Item1.N;

    public static int TupleLocals()
    {
        (int, int) x = (1, 0), y = (2, 0);
        CountedValue.Count = 0;
        return TuplePair(x, y);
    }

    public static int TupleDropped((CountedValue, int) unused, int kept) => kept;

    public static int TupleDrop()
    {
        (int, int) x = (1, 0);
        CountedValue.Count = 0;
        return TupleDropped(x, 2) + CountedValue.Count * 100;
    }

    public static int Dropped(CountedValue unused, int kept) => kept;

    public static int Drop()
    {
        CountedValue.Count = 0;
        return Dropped(1, 2) + CountedValue.Count * 100;
    }
}
