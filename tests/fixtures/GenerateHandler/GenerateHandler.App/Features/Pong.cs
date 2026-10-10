using MediatR;

namespace GenerateHandler.App.Features;

public sealed record Pong : IRequest<int>;

public sealed class PongHandler : IRequestHandler<Pong, int>
{
    public Task<int> Handle(Pong request, CancellationToken cancellationToken) => Task.FromResult(1);
}
