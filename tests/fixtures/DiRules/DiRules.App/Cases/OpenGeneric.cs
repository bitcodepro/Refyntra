namespace DiRules.App.Cases;

// Case "open generic" (abstain): closed constructions of an open generic registration are not tracked.
public interface IGenericRepository<T> { }
public sealed class GenericRepository<T> : IGenericRepository<T> { }
public sealed class GenericConsumer
{
    public GenericConsumer(IGenericRepository<int> repository) => _ = repository;
}

public static class OpenGenericCase
{
    public static IServiceCollection AddOpenGenericCase(this IServiceCollection services)
    {
        services.AddScoped(typeof(IGenericRepository<>), typeof(GenericRepository<>));
        services.AddSingleton<GenericConsumer>();
        return services;
    }
}
