using MediatR;
using Orders.Application.Features;
using Orders.Application.Services;

namespace Orders.Api.Controllers;

/// <summary>Derives from a base class of another project (Orders.Application) and dispatches through its helper.</summary>
public sealed class ReportsController : RequestExecutor
{
    public ReportsController(ISender sender) : base(sender) { }

    public Task<int> CreateReportOrder() => Execute(new CreateOrderCommand("report", 1m));
}
