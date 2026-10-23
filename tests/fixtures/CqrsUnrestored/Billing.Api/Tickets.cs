using MediatR;

namespace Billing.Api;

public interface ICommand : IRequest { }
public interface IQuery<TResult> : IRequest<TResult> { }
public interface ICommandHandler<in TCommand> : IRequestHandler<TCommand> where TCommand : ICommand { }
public interface IQueryHandler<in TQuery, TResult> : IRequestHandler<TQuery, TResult> where TQuery : IQuery<TResult> { }

public sealed record TicketDto(int Id);

public sealed record GetTicketQuery(int Id) : IQuery<TicketDto>;

public sealed class GetTicketQueryHandler : IQueryHandler<GetTicketQuery, TicketDto>
{
    public Task<TicketDto> Handle(GetTicketQuery request, CancellationToken cancellationToken) => Task.FromResult(new TicketDto(request.Id));
}

public sealed record ArchiveTicketCommand(int Id) : ICommand;

public sealed class ArchiveTicketCommandHandler : IRequestHandler<ArchiveTicketCommand>
{
    public Task Handle(ArchiveTicketCommand request, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class TicketsController
{
    private readonly ISender _sender;

    public TicketsController(ISender sender) => _sender = sender;

    public Task<TicketDto> Get(int id) => _sender.Send(new GetTicketQuery(id));

    public Task Archive(int id) => _sender.Send(new ArchiveTicketCommand(id));
}
