namespace Refactorings.Lib.SafeDelete;

/// <summary>Nothing uses this type; it is the only type of its file.</summary>
public sealed class UnusedType
{
    public int Value { get; set; }

    public UnusedType Copy() => new UnusedType { Value = Value };
}
