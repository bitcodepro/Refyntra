using Microsoft.Extensions.DependencyInjection;

namespace Mvc.Api.Di;

public interface IClock { }
public sealed class SystemClock : IClock { }
public interface ICache { }
public sealed class MemoryCache : ICache { }
public sealed class RedisCache : ICache { }
public interface IRepo<T> { }
public sealed class Repo<T> : IRepo<T> { }
public sealed class Widget { }
public sealed class Settings { }

public sealed class WidgetService
{
    public WidgetService(IRepo<Widget> widgets, [FromKeyedServices("redis")] ICache cache) { }
}

public static class DiForms
{
    public static IServiceCollection AddDiForms(this IServiceCollection services)
    {
        services.AddKeyedSingleton<ICache, MemoryCache>("memory");
        services.AddKeyedScoped<ICache, RedisCache>("redis");
        services.AddSingleton<IClock>(sp => new SystemClock());
        services.AddSingleton(new Settings());
        services.AddScoped(typeof(IRepo<>), typeof(Repo<>));
        services.AddTransient<WidgetService>();
        return services;
    }
}
