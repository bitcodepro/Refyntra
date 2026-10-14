using System;
using System.Linq;
using EfTools.App.Data;
using Microsoft.EntityFrameworkCore;

namespace EfTools.App;

public static class Program
{
    public static int Main()
    {
        // Builds a query and translates it; no database is opened (ToQueryString only translates).
        using var db = new BloggingContext();
        var minRating = 3;
        var query = db.Blogs.Where(b => b.Rating > minRating).OrderBy(b => b.Name);
        var sql = query.ToQueryString();
        Console.WriteLine(sql.Length > 0 ? "query translated" : "no sql");
        return 0;
    }
}
