using Ctor.Lib.Contracts;

namespace Ctor.App.Services;

public class ReportFormatter
{
    private readonly IOrderRepository _orders;
    private readonly IClock _clock;
}

public class Created
{
    private readonly IClock _clock;

    public Created(int seed)
    {
    }

    public static Created Make() => new Created(1);
}

public class Cache(IClock clock)
{
    public int Size => 1;
}

public record Invoice(int Id);

public record Bill
{
    public Bill(IClock clock)
    {
    }
}

public class Generic
{
    public Generic(IRepo<Order> repo)
    {
    }
}

public class Qualified
{
    public Qualified(Ctor.Lib.Data.SqlOrderRepository repository)
    {
    }
}

public class CamelFields
{
    private readonly IAuditTrail audit;

    public CamelFields(IAuditTrail audit, IClock clock)
    {
        this.audit = audit;
    }
}
