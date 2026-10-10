namespace DiRules.App.Cases;

// Case "overridden by a later call" (abstain): AddOverrideLater registers the dependency again (as a singleton),
// and the last registration wins at run time.
public interface IOverriddenRepository { }
public sealed class OverriddenRepository : IOverriddenRepository { }
public sealed class OverriddenConsumer
{
    public OverriddenConsumer(IOverriddenRepository repository) => _ = repository;
}

public static class OverriddenCase
{
    public static IServiceCollection AddOverriddenCase(this IServiceCollection services)
    {
        services.AddScoped<IOverriddenRepository, OverriddenRepository>();
        services.AddSingleton<OverriddenConsumer>();
        services.AddOverrideLater();
        return services;
    }

    public static IServiceCollection AddOverrideLater(this IServiceCollection services)
    {
        services.AddSingleton<IOverriddenRepository, OverriddenRepository>();
        return services;
    }
}
