namespace FullStack.Api.Products;

public sealed record Product(int Id, string Name);

public static class ProductHandlers
{
    public static IResult List() => Results.Ok(Array.Empty<Product>());

    public static IResult Get(int id) => Results.Ok(new Product(id, "sample"));

    public static IResult Create(Product product) => Results.Created($"/api/products/{product.Id}", product);

    public static IResult TagByName(string name) => Results.Ok(name);
}
