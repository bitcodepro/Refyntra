using EfCore.Domain;
using Microsoft.EntityFrameworkCore;

namespace EfCore.Api.Data;

/// <summary>Scans its assembly for configurations and adds more entity types in a loop (dynamic model building).</summary>
public class ReportingDbContext : DbContext
{
    public ReportingDbContext(DbContextOptions<ReportingDbContext> options) : base(options) { }

    public DbSet<Order> Orders { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(ReportingDbContext).Assembly);
        foreach (var type in typeof(AuditEntry).Assembly.GetTypes().Where(t => t.Name.EndsWith("Snapshot")))
            modelBuilder.Entity(type);
    }
}
