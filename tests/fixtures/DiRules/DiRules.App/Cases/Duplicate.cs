namespace DiRules.App.Cases;

// Case "duplicate registrations" (abstain): two registrations of the dependency in the same root.
public interface IDuplicateRepository { }
public sealed class DuplicateRepository : IDuplicateRepository { }
public sealed class DuplicateConsumer
{
    public DuplicateConsumer(IDuplicateRepository repository) => _ = repository;
}

public static class DuplicateCase
{
    public static IServiceCollection AddDuplicateCase(this IServiceCollection services)
    {
        services.AddScoped<IDuplicateRepository, DuplicateRepository>();
        services.AddSingleton<IDuplicateRepository, DuplicateRepository>();
        services.AddSingleton<DuplicateConsumer>();
        return services;
    }
}
