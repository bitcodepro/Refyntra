using System.Threading;
using System.Threading.Tasks;
using MediatR;

namespace Refactorings.Lib.SafeDelete;

/// <summary>Found by MediatR assembly scanning at run time; no code references it.</summary>
public sealed class PingHandler : IRequestHandler<Ping, string>
{
    public Task<string> Handle(Ping request, CancellationToken cancellationToken) => Task.FromResult(request.Text);
}
