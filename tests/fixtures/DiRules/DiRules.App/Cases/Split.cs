namespace DiRules.App.Cases;

// Case "different roots" (abstain): the singleton and the scoped dependency are registered in two composition roots.
// At run time both roots fill the same container, so this IS a capture; OR1001 only proves paths inside one root.
public interface ISplitDependency { }
public sealed class SplitDependency : ISplitDependency { }
public sealed class SplitConsumer
{
    public SplitConsumer(ISplitDependency dependency) => _ = dependency;
}

public static class SplitRoots
{
    public static IServiceCollection AddSplitSingletonRoot(this IServiceCollection services)
    {
        services.AddSingleton<SplitConsumer>();
        return services;
    }

    public static IServiceCollection AddSplitScopedRoot(this IServiceCollection services)
    {
        services.AddScoped<ISplitDependency, SplitDependency>();
        return services;
    }
}
