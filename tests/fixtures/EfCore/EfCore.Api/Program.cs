using EfCore.Api.Data;
using EfCore.Api.Services;
using EfCore.Domain;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopDbContext>();
builder.Services.AddDbContext<ReportingDbContext>();
builder.Services.AddScoped<OrderQueries>();

var app = builder.Build();

app.MapGet("/orders/{id}", async (int id, ShopDbContext db) => await db.Orders.Where(o => o.Id == id).ToListAsync());
app.MapGet("/customers", (ShopDbContext db) => db.Set<Customer>().ToList());

app.Run();
