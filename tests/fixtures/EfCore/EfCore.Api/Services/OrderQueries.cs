using EfCore.Api.Data;
using EfCore.Domain;

namespace EfCore.Api.Services;

public class OrderQueries
{
    private readonly ShopDbContext _db;

    public OrderQueries(ShopDbContext db) => _db = db;

    public List<Order> Open() => _db.Orders.Where(o => o.Total > 0).ToList();

    public int CountWithLines() => _db.Orders.Count(o => o.Lines.Count > 0) + _db.Set<Order>().Count();

    public List<OrderSummary> Summaries() => _db.Orders.Select(o => new OrderSummary { OrderId = o.Id, Total = o.Total }).ToList();
}
