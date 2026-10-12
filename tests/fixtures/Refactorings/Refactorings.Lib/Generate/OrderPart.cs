namespace Refactorings.Lib.Generate;

public partial class Order
{
    private readonly decimal _total;
}

public class Box<T>
{
    private readonly T _value = default!;
    private readonly int _size;
}
