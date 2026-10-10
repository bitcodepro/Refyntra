using MediatR;

namespace Shop.Contracts.Orders;

public sealed record OrderPlaced(int OrderId, string Customer) : INotification;
