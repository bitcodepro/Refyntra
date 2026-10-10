namespace Shop.Api.Legacy;

// A home-grown messaging contract that only looks like MediatR. It must never be treated as MediatR.
public interface IRequest<TResponse>
{
}

public interface IRequestHandler<TRequest, TResponse> where TRequest : IRequest<TResponse>
{
    TResponse Handle(TRequest request);
}

public sealed class LegacyPing : IRequest<string>
{
}

public sealed class LegacyPingHandler : IRequestHandler<LegacyPing, string>
{
    public string Handle(LegacyPing request) => "pong";
}

public sealed class LegacyBus
{
    public TResponse Send<TResponse>(IRequest<TResponse> request) => default!;
}
