using MediatR;
using Orders.Application.Services;

namespace Orders.Application.Features;

public sealed record CreateOrderCommand(string Customer, decimal Total) : IRequest<int>;

public sealed record OrderCreated(int Id, string Customer) : INotification;

public sealed class CreateOrderCommandHandler : IRequestHandler<CreateOrderCommand, int>
{
    private readonly IOrderRepository _orders;
    private readonly IPublisher _publisher;

    public CreateOrderCommandHandler(IOrderRepository orders, IPublisher publisher)
    {
        _orders = orders;
        _publisher = publisher;
    }

    public async Task<int> Handle(CreateOrderCommand request, CancellationToken cancellationToken)
    {
        var id = _orders.Add(request.Customer, request.Total);
        await _publisher.Publish(new OrderCreated(id, request.Customer), cancellationToken);
        return id;
    }
}

public sealed class SendConfirmationEmailHandler : INotificationHandler<OrderCreated>
{
    public Task Handle(OrderCreated notification, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class WriteAuditEntryHandler : INotificationHandler<OrderCreated>
{
    public Task Handle(OrderCreated notification, CancellationToken cancellationToken) => Task.CompletedTask;
}
