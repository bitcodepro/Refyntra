using MediatR;

namespace Billing.Api;

/// <summary>The project's own dispatcher (no MediatR): a handler sends a further command through it.</summary>
public interface ICommandDispatcher
{
    Task Dispatch(object command, CancellationToken cancellationToken = default);
}

public sealed record CloseTicketCommand(int TicketId) : IRequest<bool>;

public sealed record NotifyWatchersCommand(int TicketId) : IRequest<bool>;

/// <summary>Handler A: validates its own request (no dispatch) and dispatches NotifyWatchersCommand (handler B).</summary>
public sealed class CloseTicketCommandHandler : IRequestHandler<CloseTicketCommand, bool>
{
    private readonly ICommandDispatcher _dispatcher;

    public CloseTicketCommandHandler(ICommandDispatcher dispatcher) => _dispatcher = dispatcher;

    public async Task<bool> Handle(CloseTicketCommand request, CancellationToken cancellationToken)
    {
        Validate(request);
        await _dispatcher.Dispatch(new NotifyWatchersCommand(request.TicketId), cancellationToken);
        return true;
    }

    private static void Validate(CloseTicketCommand request) { }
}

public sealed class NotifyWatchersCommandHandler : IRequestHandler<NotifyWatchersCommand, bool>
{
    public Task<bool> Handle(NotifyWatchersCommand request, CancellationToken cancellationToken) => Task.FromResult(true);
}

/// <summary>A resolved own handler interface next to an unresolved MediatR one on the same class.</summary>
public interface IAuditHandler<T>
{
    Task Audit(T item);
}

public sealed record CommentAudit(int CommentId);

public sealed record HideCommentCommand(int CommentId) : IRequest<bool>;

public sealed class HideCommentHandler : IAuditHandler<CommentAudit>, IRequestHandler<HideCommentCommand, bool>
{
    public Task Audit(CommentAudit item) => Task.CompletedTask;

    public Task<bool> Handle(HideCommentCommand request, CancellationToken cancellationToken) => Task.FromResult(true);
}

public sealed class ModerationController
{
    private readonly ICommandDispatcher _dispatcher;

    public ModerationController(ICommandDispatcher dispatcher) => _dispatcher = dispatcher;

    public Task Hide(int commentId) => _dispatcher.Dispatch(new HideCommentCommand(commentId));
}
