using System;
using System.IO;
using Microsoft.EntityFrameworkCore;

namespace EfTools.App.Audit;

public class AuditRecord
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

/// <summary>A second context whose migrations live in a custom folder and namespace (Audit/Schema, EfTools.App.Audit.Schema).</summary>
public class AuditContext : DbContext
{
    public DbSet<AuditRecord> Records => Set<AuditRecord>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
    {
        var path = Environment.GetEnvironmentVariable("EFTOOLS_AUDIT_DB") ?? Path.Combine(Path.GetTempPath(), "eftools-audit.db");
        if (!options.IsConfigured) options.UseSqlite("Data Source=" + path);
    }
}
