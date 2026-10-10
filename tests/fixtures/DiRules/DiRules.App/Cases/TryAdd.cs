using Microsoft.Extensions.DependencyInjection.Extensions;

namespace DiRules.App.Cases;

// Case "TryAdd" (abstain): an earlier registration made elsewhere may win.
public interface ITryRepository { }
public sealed class TryRepository : ITryRepository { }
public sealed class TryConsumer
{
    public TryConsumer(ITryRepository repository) => _ = repository;
}

public static class TryAddCase
{
    public static IServiceCollection AddTryAddCase(this IServiceCollection services)
    {
        services.TryAddScoped<ITryRepository, TryRepository>();
        services.AddSingleton<TryConsumer>();
        return services;
    }
}
