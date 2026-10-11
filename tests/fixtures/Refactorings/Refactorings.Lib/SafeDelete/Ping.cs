using System.Threading;
using System.Threading.Tasks;
using MediatR;

namespace Refactorings.Lib.SafeDelete;

public sealed record Ping(string Text) : IRequest<string>;

public sealed class PingSender
{
    private readonly IMediator _mediator;

    public PingSender(IMediator mediator) => _mediator = mediator;

    public Task<string> SendAsync(CancellationToken ct) => _mediator.Send(new Ping("hello"), ct);
}
