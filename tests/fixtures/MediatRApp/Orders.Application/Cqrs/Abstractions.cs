using MediatR;

namespace Orders.Application.Cqrs;

// The usual CQRS layer over MediatR: marker interfaces for commands and queries, handler interfaces deriving from
// MediatR's (they declare no method of their own).
public interface ICommand : IRequest { }

public interface IQuery<TResult> : IRequest<TResult> { }

public interface ICommandHandler<in TCommand> : IRequestHandler<TCommand> where TCommand : ICommand { }

public interface IQueryHandler<in TQuery, TResult> : IRequestHandler<TQuery, TResult> where TQuery : IQuery<TResult> { }

public sealed record GetProductPricesQuery(string Code) : IQuery<decimal[]>;

public sealed class GetProductPricesQueryHandler : IQueryHandler<GetProductPricesQuery, decimal[]>
{
    public Task<decimal[]> Handle(GetProductPricesQuery request, CancellationToken cancellationToken) => Task.FromResult(new[] { 1m });
}

public sealed record ArchiveProductCommand(string Code) : ICommand;

public sealed class ArchiveProductCommandHandler : ICommandHandler<ArchiveProductCommand>
{
    public Task Handle(ArchiveProductCommand request, CancellationToken cancellationToken) => Task.CompletedTask;
}
