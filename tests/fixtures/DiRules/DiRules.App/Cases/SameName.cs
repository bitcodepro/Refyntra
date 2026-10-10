namespace DiRules.App.Cases.Foreign
{
    // A type with the same simple name as DiRules.App.Direct.IOrderRepository.
    public interface IOrderRepository { }
}

namespace DiRules.App.Cases
{
    // Case "same-name foreign type" (no warning): the constructor asks for a different IOrderRepository.
    public sealed class ForeignConsumer
    {
        public ForeignConsumer(Foreign.IOrderRepository repository) => _ = repository;
    }

    public static class SameNameCase
    {
        public static IServiceCollection AddSameNameCase(this IServiceCollection services)
        {
            services.AddScoped<Direct.IOrderRepository, Direct.OrderRepository>();
            services.AddSingleton<ForeignConsumer>();
            return services;
        }
    }
}
