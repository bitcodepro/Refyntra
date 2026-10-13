namespace Ctor.Lib.Contracts;

public sealed class Order
{
    public int Id { get; set; }
}

public interface IOrderRepository
{
    Order? Find(int id);
    void Save(Order order);
}

public interface IAuditTrail
{
    void Record(string what, int id);
}

public interface INotifier
{
    void Notify(string message);
}

public interface IClock
{
    System.DateTime Now { get; }
}

public interface IRepo<T>
{
    T Get(int id);
}
