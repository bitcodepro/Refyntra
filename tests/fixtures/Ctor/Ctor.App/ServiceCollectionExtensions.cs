using Microsoft.Extensions.DependencyInjection;

namespace Ctor.App;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        services.AddTransient<Services.ReportFormatter>();
        return services;
    }
}
