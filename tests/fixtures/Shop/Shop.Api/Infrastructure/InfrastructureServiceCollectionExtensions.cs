using Shop.Api.Services;

namespace Shop.Api.Infrastructure;

// A second composition root: registrations here belong to whatever host calls AddShopInfrastructure.
public static class InfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddShopInfrastructure(this IServiceCollection services)
    {
        services.AddScoped<IOrderService, CachedOrderService>();
        services.AddSingleton<IClock, SystemClock>();
        return services;
    }
}
