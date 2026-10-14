using System;
using System.Linq;
using EfTools.App.Data;

namespace EfTools.App.Cases;

public static class NoEfUsing
{
    public static void Print(BloggingContext db)
    {
        foreach (var blog in db.Blogs.ToList())
            Console.WriteLine(blog.Owner?.Name);
    }
}
