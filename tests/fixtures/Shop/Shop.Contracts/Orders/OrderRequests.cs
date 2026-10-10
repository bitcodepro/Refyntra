using MediatR;

namespace Shop.Contracts.Orders;

public sealed record OrderDto(int Id, string Customer, decimal Total);

public sealed record GetOrderQuery(int Id) : IRequest<OrderDto>;

public sealed record CreateOrderCommand(string Customer, decimal Total) : IRequest<int>;

public sealed record CancelOrderCommand(int Id) : IRequest;
