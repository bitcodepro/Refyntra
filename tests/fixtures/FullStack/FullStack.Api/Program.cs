using FullStack.Api.Products;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();

app.MapGet("/api/products", ProductHandlers.List);
app.MapGet("/api/products/{id:int}", ProductHandlers.Get);
app.MapPost("/api/products", ProductHandlers.Create);
app.MapGet("/api/tags/{name}", ProductHandlers.TagByName);
app.MapControllers();

app.Run();
