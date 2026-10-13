using Ctor.App;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<Ctor.Lib.Contracts.IAuditTrail, Ctor.Lib.Data.AuditTrail>();
builder.Services.AddInfrastructure();

var app = builder.Build();
app.Run();
