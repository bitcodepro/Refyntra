using Mvc.Api.Di;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllersWithViews();
builder.Services.AddDiForms();
var app = builder.Build();

app.MapControllers();
app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");
var area = args.Length > 0 ? args[0] : "admin";
app.MapControllerRoute(name: "dyn", pattern: $"{area}/{{controller}}/{{action}}");

app.Run();
