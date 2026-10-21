using MediatR;
using Orders.Application.Services;

namespace Orders.Application.Features;

public sealed record CancelOrderCommand(int Id) : IRequest<bool>;

public sealed class CancelOrderCommandHandler : IRequestHandler<CancelOrderCommand, bool>
{
    private readonly IOrderRepository _orders;

    public CancelOrderCommandHandler(IOrderRepository orders) => _orders = orders;

    public Task<bool> Handle(CancelOrderCommand request, CancellationToken cancellationToken) => Task.FromResult(_orders.Remove(request.Id));
}
