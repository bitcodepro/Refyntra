using MediatR;

namespace Orders.Application.Features;

public sealed record RefreshSettingsCommand : IRequest<bool>;

public sealed class RefreshSettingsCommandHandler : IRequestHandler<RefreshSettingsCommand, bool>
{
    public Task<bool> Handle(RefreshSettingsCommand request, CancellationToken cancellationToken) => Task.FromResult(true);
}
