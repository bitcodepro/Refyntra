using Shop.Contracts.Orders;

namespace Shop.Api.Services;

public interface IOrderService
{
    OrderDto? Find(int id);
    int Create(string customer, decimal total);
}

public sealed class OrderService : IOrderService
{
    private readonly Dictionary<int, OrderDto> _orders = new();

    public OrderDto? Find(int id) => _orders.TryGetValue(id, out var order) ? order : null;

    public int Create(string customer, decimal total)
    {
        var id = _orders.Count + 1;
        _orders[id] = new OrderDto(id, customer, total);
        return id;
    }
}

public sealed class CachedOrderService : IOrderService
{
    public OrderDto? Find(int id) => null;

    public int Create(string customer, decimal total) => 0;
}

public interface IClock
{
    DateTimeOffset Now { get; }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset Now => DateTimeOffset.UtcNow;
}

public interface IAuditLog
{
    void Write(string entry);
}

public sealed class AuditLog : IAuditLog
{
    public void Write(string entry)
    {
    }
}
