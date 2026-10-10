namespace DiRules.App.Cases;

// Case "conditional" (abstain): the scoped registration runs only when a runtime condition holds.
public interface ICondRepository { }
public sealed class CondRepository : ICondRepository { }
public sealed class CondConsumer
{
    public CondConsumer(ICondRepository repository) => _ = repository;
}

public static class ConditionalCase
{
    public static IServiceCollection AddConditionalCase(this IServiceCollection services, bool enabled)
    {
        if (enabled)
            services.AddScoped<ICondRepository, CondRepository>();
        services.AddSingleton<CondConsumer>();
        return services;
    }
}
