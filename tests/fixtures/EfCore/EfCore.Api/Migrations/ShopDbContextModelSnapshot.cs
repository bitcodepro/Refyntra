using EfCore.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

#nullable disable

namespace EfCore.Api.Migrations;

[DbContext(typeof(ShopDbContext))]
partial class ShopDbContextModelSnapshot : ModelSnapshot
{
    protected override void BuildModel(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity("EfCore.Domain.Customer", b =>
        {
            b.Property<int>("Id");
            b.ToTable("customers");
        });
        modelBuilder.Entity("EfCore.Domain.Order", b =>
        {
            b.Property<int>("Id");
            b.ToTable("orders");
        });
    }
}
