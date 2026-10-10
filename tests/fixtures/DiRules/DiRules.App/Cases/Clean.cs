namespace DiRules.App.Cases;

// Case "clean" (no warning, no abstention): scoped -> scoped, singleton -> singleton, singleton -> transient.
public interface ICleanRepository { }
public sealed class CleanRepository : ICleanRepository { }
public sealed class CleanScopedConsumer
{
    public CleanScopedConsumer(ICleanRepository repository) => _ = repository;
}
public interface ICleanClock { }
public sealed class CleanClock : ICleanClock { }
public sealed class CleanSingleton
{
    public CleanSingleton(ICleanClock clock) => _ = clock;
}
public interface ICleanFormatter { }
public sealed class CleanFormatter : ICleanFormatter { }
public sealed class CleanPrinter
{
    public CleanPrinter(ICleanFormatter formatter) => _ = formatter;
}

public static class CleanCase
{
    public static IServiceCollection AddCleanCase(this IServiceCollection services)
    {
        services.AddScoped<ICleanRepository, CleanRepository>();
        services.AddScoped<CleanScopedConsumer>();
        services.AddSingleton<ICleanClock, CleanClock>();
        services.AddSingleton<CleanSingleton>();
        services.AddTransient<ICleanFormatter, CleanFormatter>();
        services.AddSingleton<CleanPrinter>();
        return services;
    }
}
