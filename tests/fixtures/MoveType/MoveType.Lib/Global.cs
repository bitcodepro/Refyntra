public class GlobalOne
{
}

public class GlobalTwo
{
    public GlobalOne One { get; } = new();
}
