var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Hello from WebApp in " + app.Environment.EnvironmentName);

app.Run();
