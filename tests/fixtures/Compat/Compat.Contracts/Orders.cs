using System;
using MediatR;

namespace Compat.Contracts
{
    public sealed class OrderDto
    {
        public OrderDto(int id, decimal total)
        {
            Id = id;
            Total = total;
        }

        public int Id { get; }
        public decimal Total { get; }
    }

    public sealed class GetOrderQuery : IRequest<OrderDto>
    {
        public GetOrderQuery(int id)
        {
            Id = id;
        }

        public int Id { get; }
    }

    public interface IClock
    {
        DateTime Now { get; }
    }

    public static class OrderRules
    {
        public static decimal Discount(decimal total)
        {
            return total > 100m ? total * 0.9m : total;
        }
    }
}
