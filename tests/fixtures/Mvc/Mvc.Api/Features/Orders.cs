using MediatR;

namespace Mvc.Api.Features;

public sealed record OrderDto(int Id);
public sealed record GetOrderQuery(int Id) : IRequest<OrderDto>;

public sealed class GetOrderQueryHandler : IRequestHandler<GetOrderQuery, OrderDto>
{
    public Task<OrderDto> Handle(GetOrderQuery request, CancellationToken cancellationToken) => Task.FromResult(new OrderDto(request.Id));
}

/// <summary>Open generic: applies to every request.</summary>
public sealed class LoggingBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse> where TRequest : notnull
{
    public Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken) => next();
}

/// <summary>Closed: applies to GetOrderQuery only.</summary>
public sealed class GetOrderCachingBehavior : IPipelineBehavior<GetOrderQuery, OrderDto>
{
    public Task<OrderDto> Handle(GetOrderQuery request, RequestHandlerDelegate<OrderDto> next, CancellationToken cancellationToken) => next();
}

public interface ICommandMarker { }

/// <summary>Open generic with a constraint GetOrderQuery does not satisfy.</summary>
public sealed class CommandOnlyBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse> where TRequest : ICommandMarker
{
    public Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken) => next();
}

public sealed record CountdownStream(int From) : IStreamRequest<int>;

public sealed class CountdownStreamHandler : IStreamRequestHandler<CountdownStream, int>
{
    public async IAsyncEnumerable<int> Handle(CountdownStream request, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        for (var i = request.From; i > 0; i--) { await Task.Yield(); yield return i; }
    }
}

public class OrderEvent : INotification { }
public sealed class OrderShipped : OrderEvent { }

public sealed class OrderShippedHandler : INotificationHandler<OrderShipped>
{
    public Task Handle(OrderShipped notification, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class AnyOrderEventHandler : INotificationHandler<OrderEvent>
{
    public Task Handle(OrderEvent notification, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class StreamClient
{
    public IAsyncEnumerable<int> Run(ISender sender) => sender.CreateStream(new CountdownStream(3));
}
