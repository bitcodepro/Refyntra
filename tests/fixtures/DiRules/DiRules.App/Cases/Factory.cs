namespace DiRules.App.Cases;

// Case "factory" (abstain): factory registrations (the implementation type and its constructor are not proven).
public interface IFactRepository { }
public sealed class FactRepository : IFactRepository { }
public sealed class FactConsumer
{
    public FactConsumer(IFactRepository repository) => _ = repository;
}
public interface IFactCache { }
public sealed class FactCache : IFactCache
{
    public FactCache(IFactRepository repository) => _ = repository;
}

public static class FactoryCase
{
    public static IServiceCollection AddFactoryCase(this IServiceCollection services)
    {
        services.AddScoped<IFactRepository>(_ => new FactRepository());
        services.AddSingleton<FactConsumer>();
        services.AddSingleton<IFactCache>(sp => new FactCache(sp.GetRequiredService<IFactRepository>()));
        return services;
    }
}
