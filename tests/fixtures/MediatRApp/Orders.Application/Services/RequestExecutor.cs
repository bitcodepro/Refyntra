using MediatR;

namespace Orders.Application.Services;

/// <summary>A base class in a shared project that hides MediatR: classes in other projects call Execute(request).</summary>
public abstract class RequestExecutor
{
    protected RequestExecutor(ISender sender) => Sender = sender;

    protected ISender Sender { get; }

    protected Task<TResponse> Execute<TResponse>(IRequest<TResponse> request) => Sender.Send(request);
}
