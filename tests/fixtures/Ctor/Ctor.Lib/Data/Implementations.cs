using Ctor.Lib.Contracts;

namespace Ctor.Lib.Data;

public sealed class SqlOrderRepository : IOrderRepository
{
    public Order? Find(int id) => null;
    public void Save(Order order) { }
}

public sealed class AuditTrail : IAuditTrail
{
    public void Record(string what, int id) { }
}

public sealed class EmailNotifier : INotifier
{
    public void Notify(string message) { }
}

public sealed class SmsNotifier : INotifier
{
    public void Notify(string message) { }
}
