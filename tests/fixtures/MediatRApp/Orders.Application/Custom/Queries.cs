namespace Orders.Application.Custom;

public interface IQuery<TResult> { }

/// <summary>The project's own query handler interface (in another project than the controllers).</summary>
public interface IAppQueryHandler<in TQuery, TResult> where TQuery : IQuery<TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken ct);
}

public sealed record GetRatesQuery(string Currency) : IQuery<decimal[]>;

public sealed class GetRatesQueryHandler : IAppQueryHandler<GetRatesQuery, decimal[]>
{
    public Task<decimal[]> HandleAsync(GetRatesQuery query, CancellationToken ct) => Task.FromResult(new[] { 1m });
}

/// <summary>A query runner whose implementation is not in source (registered from a package).</summary>
public interface IQueryRunner
{
    Task<TResult> QueryAsync<TResult>(IQuery<TResult> query, CancellationToken ct = default);
}
