using MediatR;

namespace Billing.Api;

/// <summary>A base controller as a company package ships it: a generic helper that sends (MediatR unresolved here).</summary>
public abstract class AppBaseController
{
    protected Task<object?> HandleRequest<TRequest, TResponse>(TRequest request, CancellationToken cancelToken = default)
        where TRequest : IRequest<TResponse> => throw new NotImplementedException();
}

public sealed record CommentDto(int Id, string Text);

public sealed record GetCommentsQuery(int TicketId) : IRequest<IEnumerable<CommentDto>>;

public sealed class GetCommentsQueryHandler : IRequestHandler<GetCommentsQuery, IEnumerable<CommentDto>>
{
    public Task<IEnumerable<CommentDto>> Handle(GetCommentsQuery request, CancellationToken cancellationToken) => Task.FromResult<IEnumerable<CommentDto>>(Array.Empty<CommentDto>());
}

public sealed class AddCommentCommand : IRequest<CommentDto>
{
    public int TicketId { get; set; }
}

public sealed class AddCommentCommandHandler : IRequestHandler<AddCommentCommand, CommentDto>
{
    public Task<CommentDto> Handle(AddCommentCommand request, CancellationToken cancellationToken) => Task.FromResult(new CommentDto(1, ""));
}

public sealed class CommentsController : AppBaseController
{
    // Explicit type arguments, the request built inline.
    public Task<object?> Get(int ticketId) => HandleRequest<GetCommentsQuery, IEnumerable<CommentDto>>(new GetCommentsQuery(ticketId));

    // The command built first (as from a mapper), then handed over.
    public Task<object?> Post(int ticketId)
    {
        var command = new AddCommentCommand();
        command.TicketId = ticketId;
        return HandleRequest<AddCommentCommand, CommentDto>(command);
    }
}
