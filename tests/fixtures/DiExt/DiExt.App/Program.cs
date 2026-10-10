using DiExt.App;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(contextLifetime: ServiceLifetime.Transient, optionsAction: o => { });
builder.Services.AddDbContext<ReportsDbContext>();
builder.Services.AddDbContextPool<PooledDbContext>(o => { });
builder.Services.AddDbContextFactory<FactoryDbContext>();
builder.Services.AddHostedService<PollingWorker>();
builder.Services.AddHttpClient<WeatherClient>();
builder.Services.AddHttpClient<IGeoClient, GeoClient>();
builder.Services.AddOptions<BotOptions>();
builder.Services.AddScoped<IGeoClient, GeoClient>();
// A same-name method of a foreign type: not a framework registration.
Foreign.Registrations.AddDbContext<LocalOnlyContext>(builder.Services);

var app = builder.Build();
app.Run();
