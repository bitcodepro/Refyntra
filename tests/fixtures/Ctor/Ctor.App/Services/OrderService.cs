using Ctor.Lib.Contracts;

namespace Ctor.App.Services;

public class OrderService
{
    private readonly IAuditTrail _audit;

    public OrderService(IAuditTrail audit, IOrderRepository orders, INotifier notifier)
    {
        _audit = audit;
    }

    public void Place(int id) => _audit.Record("place", id);
}
