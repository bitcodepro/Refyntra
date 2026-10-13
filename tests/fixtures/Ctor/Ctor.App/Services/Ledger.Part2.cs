using Ctor.Lib.Contracts;

namespace Ctor.App.Services;

public partial class Ledger
{
    private readonly IAuditTrail _audit;

    public Ledger(IAuditTrail audit)
    {
        _audit = audit;
    }
}
