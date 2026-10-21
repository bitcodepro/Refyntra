namespace Orders.Application.Custom;

/// <summary>The project's own handler abstractions (no MediatR).</summary>
public interface ICommandHandler<in TCommand>
{
    Task HandleAsync(TCommand command, CancellationToken ct);
}

public interface IQueryHandler<in TQuery, TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken ct);
}

public interface ICommandDispatcher
{
    Task DispatchAsync<TCommand>(TCommand command, CancellationToken ct);
}

/// <summary>Resolves the handler from DI: the call inside is generic, not a dispatch of one request.</summary>
public sealed class CommandDispatcher : ICommandDispatcher
{
    private readonly IServiceProvider _services;

    public CommandDispatcher(IServiceProvider services) => _services = services;

    public Task DispatchAsync<TCommand>(TCommand command, CancellationToken ct) =>
        ((ICommandHandler<TCommand>)_services.GetService(typeof(ICommandHandler<TCommand>))!).HandleAsync(command, ct);
}
