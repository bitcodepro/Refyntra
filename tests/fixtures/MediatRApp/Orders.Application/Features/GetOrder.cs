using MediatR;
using Orders.Application.Services;

namespace Orders.Application.Features;

public sealed record OrderDto(int Id, string Customer, decimal Total);

public sealed record GetOrderQuery(int Id) : IRequest<OrderDto?>;

public sealed class GetOrderQueryHandler : IRequestHandler<GetOrderQuery, OrderDto?>
{
    private readonly IOrderRepository _orders;

    public GetOrderQueryHandler(IOrderRepository orders) => _orders = orders;

    public Task<OrderDto?> Handle(GetOrderQuery request, CancellationToken cancellationToken) =>
        Task.FromResult(_orders.Find(request.Id));
}
