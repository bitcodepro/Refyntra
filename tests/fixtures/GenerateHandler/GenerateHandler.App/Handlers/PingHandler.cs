using GenerateHandler.App.Features;
using MediatR;

namespace GenerateHandler.App.Handlers;

public sealed class PingHandler : IRequestHandler<Ping, string>
{
    public Task<string> Handle(Ping request, CancellationToken cancellationToken) => Task.FromResult("pong");
}
