using Microsoft.EntityFrameworkCore;

namespace Compat.Api;

public sealed class CompatDbContext(DbContextOptions<CompatDbContext> options) : DbContext(options)
{
    public DbSet<OrderRow> Orders => Set<OrderRow>();
}

public sealed class OrderRow
{
    public int Id { get; set; }
    public decimal Total { get; set; }
}
