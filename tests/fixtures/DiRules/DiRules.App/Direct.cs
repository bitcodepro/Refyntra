namespace DiRules.App.Direct;

public interface IOrderRepository
{
    int Count();
}

public sealed class OrderRepository : IOrderRepository
{
    public int Count() => 0;
}

public interface IPriceCache
{
    decimal Price(int id);
}

public sealed class PriceCache : IPriceCache
{
    private readonly IOrderRepository _orders;

    public PriceCache(IOrderRepository orders) => _orders = orders;

    public decimal Price(int id) => _orders.Count() + id;
}

public sealed class OrderService
{
    private readonly IOrderRepository _orders;

    public OrderService(IOrderRepository orders) => _orders = orders;

    public int Total() => _orders.Count();
}
