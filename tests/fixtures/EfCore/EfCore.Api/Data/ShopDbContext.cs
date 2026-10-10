using EfCore.Domain;
using Microsoft.EntityFrameworkCore;

namespace EfCore.Api.Data;

public class ShopDbContext : DbContext
{
    public ShopDbContext(DbContextOptions<ShopDbContext> options) : base(options) { }

    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders { get; set; } = null!;
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new OrderConfiguration());
        modelBuilder.Entity<Customer>(b =>
        {
            b.ToTable("customers");
            b.HasKey(c => c.Id);
            b.HasMany(c => c.Orders).WithOne(o => o.Customer).HasForeignKey(o => o.CustomerId);
        });
        modelBuilder.Entity<OrderLine>().HasOne(l => l.Product).WithMany();
    }
}
