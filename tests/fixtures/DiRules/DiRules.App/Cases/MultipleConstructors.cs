namespace DiRules.App.Cases;

// Case "multiple constructors" (abstain): constructor selection between several public constructors is not modelled.
public interface IMultiRepository { }
public sealed class MultiRepository : IMultiRepository { }
public sealed class MultiConsumer
{
    public MultiConsumer() { }
    public MultiConsumer(IMultiRepository repository) => _ = repository;
}

public static class MultipleConstructorsCase
{
    public static IServiceCollection AddMultipleConstructorsCase(this IServiceCollection services)
    {
        services.AddScoped<IMultiRepository, MultiRepository>();
        services.AddSingleton<MultiConsumer>();
        return services;
    }
}
