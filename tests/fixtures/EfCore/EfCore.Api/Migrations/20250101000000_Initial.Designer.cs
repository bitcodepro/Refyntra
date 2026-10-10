using EfCore.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace EfCore.Api.Migrations;

[DbContext(typeof(ShopDbContext))]
[Migration("20250101000000_Initial")]
partial class Initial
{
    protected override void BuildTargetModel(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity("EfCore.Domain.Order", b =>
        {
            b.Property<int>("Id");
            b.ToTable("orders");
        });
    }
}
