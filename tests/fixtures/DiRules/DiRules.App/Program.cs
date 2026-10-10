using DiRules.App.Cases;
using DiRules.App.Direct;

var builder = WebApplication.CreateBuilder(args);

// Case "direct" (positive): a singleton whose only constructor takes a scoped service of the same root.
builder.Services.AddScoped<IOrderRepository, OrderRepository>();
builder.Services.AddSingleton<IPriceCache, PriceCache>();
builder.Services.AddScoped<OrderService>();

// Every other case is its own composition root (an extension method).
builder.Services.AddTransitiveCase();
builder.Services.AddTypeofCase();
builder.Services.AddSplitSingletonRoot();
builder.Services.AddSplitScopedRoot();
builder.Services.AddConditionalCase(builder.Environment.IsDevelopment());
builder.Services.AddFactoryCase();
builder.Services.AddEnumerableCase();
builder.Services.AddTryAddCase();
builder.Services.AddOpenGenericCase();
builder.Services.AddKeyedCase();
builder.Services.AddSameNameCase();
builder.Services.AddMultipleConstructorsCase();
builder.Services.AddCleanCase();
builder.Services.AddOverriddenCase();
builder.Services.AddDuplicateCase();

var app = builder.Build();
app.Run();
