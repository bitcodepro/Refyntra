using Microsoft.EntityFrameworkCore;

namespace DiExt.App;

public sealed class AppDbContext : DbContext { }
public sealed class ReportsDbContext : DbContext { }
public sealed class PooledDbContext : DbContext { public PooledDbContext(DbContextOptions<PooledDbContext> o) : base(o) { } }
public sealed class FactoryDbContext : DbContext { }
public sealed class LocalOnlyContext { }

public sealed class PollingWorker : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}

public sealed class WeatherClient { public WeatherClient(HttpClient http) { } }
public interface IGeoClient { }
public sealed class GeoClient : IGeoClient { public GeoClient(HttpClient http) { } }
public sealed class BotOptions { public string Token { get; set; } = ""; }
