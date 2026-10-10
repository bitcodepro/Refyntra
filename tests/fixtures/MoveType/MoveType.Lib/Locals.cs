namespace MoveType.Lib;

file sealed class Hidden
{
}

public sealed class UsesHidden
{
    public static object Make() => new Hidden();
}

public sealed class Plain
{
}
