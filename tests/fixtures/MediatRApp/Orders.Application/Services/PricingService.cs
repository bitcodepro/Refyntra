using MediatR;
using Orders.Application.Features;

namespace Orders.Application.Services;

/// <summary>A service that sends a request itself (not only controllers do).</summary>
public sealed class PricingService
{
    private readonly ISender _sender;

    public PricingService(ISender sender) => _sender = sender;

    public async Task<decimal> TotalWithTaxAsync(int orderId)
    {
        var order = await _sender.Send(new GetOrderQuery(orderId));
        return (order?.Total ?? 0) * 1.2m;
    }
}
