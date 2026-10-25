public static class SignatureEvaluationOrder
{
    private static int _counter;
    public static int Combine(int a, int b) => a * 10 + b;
    private static int Next() => ++_counter;

    public static int ReadBeforeMutation()
    {
        _counter = 0;
        return Combine(_counter, Next());
    }

    public static int MutationBeforeRead()
    {
        _counter = 0;
        return Combine(Next(), _counter);
    }

    public static int CapturedLocal()
    {
        int value = 0;
        int Bump() => ++value;
        return Combine(value, Bump());
    }
}
