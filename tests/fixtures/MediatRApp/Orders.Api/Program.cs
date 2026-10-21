using Orders.Application.Features;
using Orders.Application.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddMediatR(cfg => cfg.RegisterServicesFromAssemblyContaining<GetOrderQuery>());
builder.Services.AddSingleton<IOrderRepository, InMemoryOrderRepository>();
builder.Services.AddScoped<PricingService>();

var app = builder.Build();
app.MapControllers();
app.Run();
