using MediatR;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Shop.Api.Legacy;
using Shop.Api.Services;
using Shop.Contracts.Orders;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddMediatR(cfg => cfg.RegisterServicesFromAssemblyContaining<Program>());
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSingleton(typeof(IClock), typeof(SystemClock));
builder.Services.TryAddTransient<IAuditLog, AuditLog>();
builder.Services.AddSingleton<LegacyBus>();

var app = builder.Build();

var orders = app.MapGroup("/api/orders");
orders.MapGet("/{id:int}", async (int id, ISender sender) => await sender.Send(new GetOrderQuery(id)));
orders.MapPost("/", async (CreateOrderCommand command, ISender sender) => Results.Ok(await sender.Send(command)));
orders.MapDelete("/{id:int}", async (int id, IMediator mediator) =>
{
    await mediator.Send(new CancelOrderCommand(id));
    return Results.NoContent();
});

app.MapGet("/health", () => "ok");
app.MapGet("/legacy/ping", (LegacyBus bus) => bus.Send(new LegacyPing()));

var version = Environment.GetEnvironmentVariable("API_VERSION") ?? "v1";
app.MapGet($"/api/{version}/status", () => "running");

app.Run();

public partial class Program
{
}
