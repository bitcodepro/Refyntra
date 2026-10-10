using MediatR;
using Shop.Api.Services;
using Shop.Contracts.Orders;

namespace Shop.Api.Handlers;

public sealed class GetOrderQueryHandler : IRequestHandler<GetOrderQuery, OrderDto>
{
    private readonly IOrderService _orders;

    public GetOrderQueryHandler(IOrderService orders) => _orders = orders;

    public Task<OrderDto> Handle(GetOrderQuery request, CancellationToken cancellationToken) =>
        Task.FromResult(_orders.Find(request.Id) ?? new OrderDto(request.Id, "unknown", 0m));
}

public sealed class CreateOrderCommandHandler : IRequestHandler<CreateOrderCommand, int>
{
    private readonly IOrderService _orders;
    private readonly IPublisher _publisher;

    public CreateOrderCommandHandler(IOrderService orders, IPublisher publisher)
    {
        _orders = orders;
        _publisher = publisher;
    }

    public async Task<int> Handle(CreateOrderCommand request, CancellationToken cancellationToken)
    {
        var id = _orders.Create(request.Customer, request.Total);
        await _publisher.Publish(new OrderPlaced(id, request.Customer), cancellationToken);
        return id;
    }
}

public sealed class CancelOrderCommandHandler : IRequestHandler<CancelOrderCommand>
{
    public Task Handle(CancelOrderCommand request, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class OrderPlacedEmailHandler : INotificationHandler<OrderPlaced>
{
    public Task Handle(OrderPlaced notification, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class OrderPlacedAuditHandler : INotificationHandler<OrderPlaced>
{
    private readonly IAuditLog _audit;

    public OrderPlacedAuditHandler(IAuditLog audit) => _audit = audit;

    public Task Handle(OrderPlaced notification, CancellationToken cancellationToken)
    {
        _audit.Write("order placed");
        return Task.CompletedTask;
    }
}
