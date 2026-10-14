using System;
using System.IO;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace EfTools.App.Data;

public class BloggingContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();
    public DbSet<Review> Reviews => Set<Review>();

    /// <summary>A SQLite file in the temp folder (or EFTOOLS_DB): tests never use a server database.</summary>
    public static string DbPath => Environment.GetEnvironmentVariable("EFTOOLS_DB") ?? Path.Combine(Path.GetTempPath(), "eftools-fixture.db");

    protected override void OnConfiguring(DbContextOptionsBuilder options)
    {
        if (!options.IsConfigured) options.UseSqlite($"Data Source={DbPath}");
        // The hand-written migrations cover only part of the model (the e2e adds the rest): let database update run.
        options.ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Blog>().OwnsOne(b => b.Settings);
        modelBuilder.Entity<Post>().Navigation(p => p.Tags).AutoInclude();
    }
}
