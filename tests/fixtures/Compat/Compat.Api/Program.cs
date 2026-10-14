using Compat.Api;
using Compat.Contracts;
using Compat.Shared;
using MediatR;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddMediatR(cfg => cfg.RegisterServicesFromAssemblyContaining<GetOrderHandler>());
builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddDbContext<CompatDbContext>(o => o.UseInMemoryDatabase("compat"));
var app = builder.Build();

app.MapGet("/", () => "Compat API on " + Compat.Multi.Greeter.Runtime() + " " + Environment.Version.Major);
app.MapGet("/orders/{id}", async (int id, IMediator mediator) => PriceFormatter.Format(await mediator.Send(new GetOrderQuery(id))));

app.Run();
