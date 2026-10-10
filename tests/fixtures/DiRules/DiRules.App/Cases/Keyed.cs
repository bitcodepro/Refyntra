namespace DiRules.App.Cases;

// Case "keyed" (abstain): keyed services are not followed. The non-keyed registration of the same service does not
// satisfy a [FromKeyedServices] parameter.
public interface IKeyedRepository { }
public sealed class KeyedRepository : IKeyedRepository { }
public sealed class KeyedConsumer
{
    public KeyedConsumer([FromKeyedServices("main")] IKeyedRepository repository) => _ = repository;
}

public static class KeyedCase
{
    public static IServiceCollection AddKeyedCase(this IServiceCollection services)
    {
        services.AddKeyedScoped<IKeyedRepository, KeyedRepository>("main");
        services.AddScoped<IKeyedRepository, KeyedRepository>();
        services.AddSingleton<KeyedConsumer>();
        return services;
    }
}
