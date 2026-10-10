using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace EfCore.Api.Migrations;

public partial class Initial : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "customers",
            columns: table => new { Id = table.Column<int>(nullable: false), Name = table.Column<string>(nullable: false) },
            constraints: table => table.PrimaryKey("PK_customers", x => x.Id));
        migrationBuilder.CreateTable(
            name: "orders",
            columns: table => new { Id = table.Column<int>(nullable: false), CustomerId = table.Column<int>(nullable: false) },
            constraints: table => table.PrimaryKey("PK_orders", x => x.Id));
        migrationBuilder.CreateIndex(name: "IX_orders_CustomerId", table: "orders", column: "CustomerId");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "orders");
        migrationBuilder.DropTable(name: "customers");
    }
}
