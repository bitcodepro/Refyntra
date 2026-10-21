namespace Orders.Application.Custom;

public sealed record ArchiveOrderCommand(int Id);

public sealed record CountArchivedQuery;

public sealed record ShipOrderCommand(int Id);

public sealed class ArchiveOrderHandler : ICommandHandler<ArchiveOrderCommand>
{
    public Task HandleAsync(ArchiveOrderCommand command, CancellationToken ct) => Task.CompletedTask;
}

public sealed class ShipOrderHandler : ICommandHandler<ShipOrderCommand>
{
    public Task HandleAsync(ShipOrderCommand command, CancellationToken ct) => Task.CompletedTask;
}

public sealed class CountArchivedHandler : IQueryHandler<CountArchivedQuery, int>
{
    public Task<int> HandleAsync(CountArchivedQuery query, CancellationToken ct) => Task.FromResult(0);
}
