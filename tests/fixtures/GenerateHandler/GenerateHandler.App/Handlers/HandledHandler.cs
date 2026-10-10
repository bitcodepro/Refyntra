using GenerateHandler.Contracts.Requests;
using MediatR;

namespace GenerateHandler.App.Handlers;

public sealed class HandledHandler : IRequestHandler<Handled, int>
{
    public Task<int> Handle(Handled request, CancellationToken cancellationToken) => Task.FromResult(request.Id);
}
