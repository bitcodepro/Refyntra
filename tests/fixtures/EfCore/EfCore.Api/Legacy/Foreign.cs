namespace EfCore.Api.Legacy;

// Same simple names as EF Core, declared in this project: none of this is EF Core.
public class DbContext
{
    public virtual void OnModelCreating(ModelBuilder modelBuilder) { }
}

public class DbSet<T> : List<T> { }

public class ModelBuilder
{
    public ModelBuilder Entity<T>() => this;
}

public class Widget
{
    public int Id { get; set; }
}

public class LegacyContext : DbContext
{
    public DbSet<Widget> Widgets { get; set; } = new();

    public override void OnModelCreating(ModelBuilder modelBuilder) => modelBuilder.Entity<Widget>();

    public int Count() => Widgets.Count;
}
