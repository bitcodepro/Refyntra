namespace Sample.Orders;

public sealed class Repository<T>
{
    public Repository()
    {
    }

    public T Get<TKey>(TKey key, bool strict) => strict && key is null ? throw new ArgumentNullException(nameof(key)) : default!;

    public T[] All(List<T> items, string[] tags) => items.ToArray();
}
