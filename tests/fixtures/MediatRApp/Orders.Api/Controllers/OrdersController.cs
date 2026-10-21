using MediatR;
using Microsoft.AspNetCore.Mvc;
using Orders.Application.Features;
using Orders.Application.Services;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/orders")]
public sealed class OrdersController : ControllerBase
{
    private readonly ISender _sender;
    private readonly IMediator _mediator;
    private readonly IRequestHandler<CancelOrderCommand, bool> _cancel;
    private readonly PricingService _pricing;

    public OrdersController(ISender sender, IMediator mediator, IRequestHandler<CancelOrderCommand, bool> cancel, PricingService pricing)
    {
        _sender = sender;
        _mediator = mediator;
        _cancel = cancel;
        _pricing = pricing;
    }

    // ISender: the handler is found by the request type at run time.
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetOrder(int id) => Ok(await _sender.Send(new GetOrderQuery(id)));

    // IMediator, the command built first.
    [HttpPost]
    public async Task<IActionResult> CreateOrder(string customer, decimal total)
    {
        var command = new CreateOrderCommand(customer, total);
        var id = await _mediator.Send(command);
        return Ok(id);
    }

    // The handler interface injected directly: DI picks the implementation at run time.
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> CancelOrder(int id, CancellationToken ct) => Ok(await _cancel.Handle(new CancelOrderCommand(id), ct));

    // No MediatR here: a service that sends GetOrderQuery itself.
    [HttpGet("{id:int}/total")]
    public async Task<IActionResult> Total(int id) => Ok(await _pricing.TotalWithTaxAsync(id));
}
