using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace EfCore.Domain;

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Order> Orders { get; set; } = new();
}

public class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer? Customer { get; set; }
    public List<OrderLine> Lines { get; set; } = new();
    public Address ShippingAddress { get; set; } = new();
    public decimal Total { get; set; }
}

public class OrderLine
{
    [Key]
    public int LineId { get; set; }
    public int OrderId { get; set; }
    [ForeignKey(nameof(OrderId))]
    public Order? Order { get; set; }
    public int ProductId { get; set; }
    public Product? Product { get; set; }
}

[Table("catalog_products", Schema = "catalog")]
public class Product
{
    public int Id { get; set; }
    public string Sku { get; set; } = "";
    public Supplier? Supplier { get; set; }
    [NotMapped]
    public Product? Suggested { get; set; }
}

/// <summary>Not mapped explicitly: reachable from Product.Supplier, so EF discovers it by convention.</summary>
public class Supplier
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

/// <summary>Owned by Order (OwnsOne); no key of its own.</summary>
public class Address
{
    public string Street { get; set; } = "";
    public string City { get; set; } = "";
}

/// <summary>Mapped only through ApplyConfigurationsFromAssembly in ReportingDbContext.</summary>
public class AuditEntry
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

/// <summary>Never mapped: not an entity.</summary>
public class OrderSummary
{
    public int OrderId { get; set; }
    public decimal Total { get; set; }
}
