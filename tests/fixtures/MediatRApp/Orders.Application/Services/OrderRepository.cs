namespace Orders.Application.Services;

using Orders.Application.Features;

public interface IOrderRepository
{
    OrderDto? Find(int id);
    int Add(string customer, decimal total);
    bool Remove(int id);
}

public sealed class InMemoryOrderRepository : IOrderRepository
{
    private readonly Dictionary<int, OrderDto> _orders = new();

    public OrderDto? Find(int id) => _orders.TryGetValue(id, out var o) ? o : null;

    public int Add(string customer, decimal total)
    {
        var id = _orders.Count + 1;
        _orders[id] = new OrderDto(id, customer, total);
        return id;
    }

    public bool Remove(int id) => _orders.Remove(id);
}
