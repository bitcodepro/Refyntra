namespace DiRules.App.Cases;

// Case "transitive" (positive): singleton -> transient -> scoped, all in one root.
public interface IUnitOfWork { void Commit(); }
public sealed class UnitOfWork : IUnitOfWork { public void Commit() { } }
public interface IReportBuilder { string Build(); }
public sealed class ReportBuilder : IReportBuilder
{
    private readonly IUnitOfWork _uow;
    public ReportBuilder(IUnitOfWork uow) => _uow = uow;
    public string Build() { _uow.Commit(); return ""; }
}
public sealed class ReportScheduler
{
    public ReportScheduler(IReportBuilder builder, ILogger<ReportScheduler> logger) { _ = builder; _ = logger; }
}

public static class TransitiveCase
{
    public static IServiceCollection AddTransitiveCase(this IServiceCollection services)
    {
        services.AddScoped<IUnitOfWork, UnitOfWork>();
        services.AddTransient<IReportBuilder, ReportBuilder>();
        services.AddSingleton<ReportScheduler>();
        return services;
    }
}
