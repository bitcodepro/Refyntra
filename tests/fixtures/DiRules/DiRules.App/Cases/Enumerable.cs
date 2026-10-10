namespace DiRules.App.Cases;

// Case "IEnumerable" (abstain): IEnumerable<T> resolves every registration of T; not followed in this version.
public interface IStepHandler { }
public sealed class StepHandlerA : IStepHandler { }
public sealed class StepDispatcher
{
    public StepDispatcher(IEnumerable<IStepHandler> handlers) => _ = handlers;
}

public static class EnumerableCase
{
    public static IServiceCollection AddEnumerableCase(this IServiceCollection services)
    {
        services.AddScoped<IStepHandler, StepHandlerA>();
        services.AddSingleton<StepDispatcher>();
        return services;
    }
}
