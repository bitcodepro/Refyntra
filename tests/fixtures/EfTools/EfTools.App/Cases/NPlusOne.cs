using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Threading.Tasks;
using EfTools.App.Data;
using Microsoft.EntityFrameworkCore;

namespace EfTools.App.Cases;

/// <summary>OR1011 cases: every line marked "expect" is reported, everything else is a false-positive guard.</summary>
public class NPlusOne
{
    private readonly BloggingContext _db;

    public NPlusOne(BloggingContext db) => _db = db;

    // ------------------------------------------------------------------ reported

    public void LoopOverInlineQuery()
    {
        foreach (var blog in _db.Blogs.Where(b => b.Rating > 1).ToList())
            Console.WriteLine(blog.Owner!.Name); // expect: OR1011
    }

    public void LoopOverLocal()
    {
        var posts = _db.Posts.AsNoTracking().ToList();
        foreach (var post in posts)
            Console.WriteLine(post.Blog?.Name); // expect: OR1011
    }

    public async Task LoopAfterAwait()
    {
        var blogs = await _db.Blogs.OrderBy(b => b.Name).ToListAsync();
        foreach (var b in blogs)
            Console.WriteLine(b.Posts.Count); // expect: OR1011
    }

    public List<string?> SelectInMemory() =>
        _db.Blogs.ToList().Select(b => b.Owner?.Name).ToList(); // expect: OR1011

    public void ReportedOncePerNavigation()
    {
        foreach (var blog in _db.Set<Blog>().ToList())
        {
            Console.WriteLine(blog.Owner?.Name); // expect: OR1011
            Console.WriteLine(blog.Owner?.Id);
        }
    }

    public void OtherNavigationThanIncluded()
    {
        foreach (var blog in _db.Blogs.Include(b => b.Posts).ToList())
            Console.WriteLine(blog.Owner?.Name); // expect: OR1011
    }

    // ------------------------------------------------------------------ silent

    public void Included()
    {
        foreach (var blog in _db.Blogs.Include(b => b.Owner).ToList())
            Console.WriteLine(blog.Owner?.Name);
    }

    public void IncludedByString()
    {
        foreach (var blog in _db.Blogs.Include("Owner").ToList())
            Console.WriteLine(blog.Owner?.Name);
    }

    public void FilteredInclude()
    {
        foreach (var blog in _db.Blogs.Include(b => b.Posts.Where(p => p.Id > 1)).ToList())
            Console.WriteLine(blog.Posts.Count);
    }

    public void ThenIncluded()
    {
        foreach (var post in _db.Posts.Include(p => p.Blog).ThenInclude(b => b!.Owner).ToList())
            Console.WriteLine(post.Blog?.Owner?.Name);
    }

    public List<string?> ProjectedInTheQuery() => _db.Blogs.Select(b => (string?)b.Owner!.Name).ToList();

    public void ProjectionThenLoop()
    {
        foreach (var x in _db.Blogs.Select(b => new { b.Name, Owner = b.Owner!.Name }).ToList())
            Console.WriteLine(x.Owner);
    }

    public void ScalarsOnly()
    {
        foreach (var blog in _db.Blogs.ToList())
            Console.WriteLine(blog.Name + blog.Rating + blog.Title);
    }

    public void SourceIsAParameter(List<Blog> blogs)
    {
        foreach (var b in blogs)
            Console.WriteLine(b.Owner?.Name);
    }

    public void ExplicitLoading()
    {
        foreach (var b in _db.Blogs.ToList())
        {
            _db.Entry(b).Reference(x => x.Owner).Load();
            Console.WriteLine(b.Owner?.Name);
        }
    }

    public void LocalReassigned()
    {
        var blogs = _db.Blogs.ToList();
        blogs = blogs.Where(b => b.Rating > 2).ToList();
        foreach (var b in blogs)
            Console.WriteLine(b.Owner?.Name);
    }

    public void OnlyWritten()
    {
        foreach (var b in _db.Blogs.ToList())
            b.Owner = null;
    }

    public void NotMappedProperty()
    {
        foreach (var b in _db.Blogs.ToList())
            Console.WriteLine(b.Featured?.Title);
    }

    public void OwnedType()
    {
        foreach (var b in _db.Blogs.ToList())
            Console.WriteLine(b.Settings.Theme);
    }

    public void AutoIncluded()
    {
        foreach (var p in _db.Posts.ToList())
            Console.WriteLine(p.Tags.Count);
    }

    public void LazyLoaderEntity()
    {
        foreach (var r in _db.Reviews.ToList())
            Console.WriteLine(r.Blog?.Name);
    }

    public int InsideTheQuery() => _db.Blogs.Count(b => b.Posts.Any());

    public void UnknownOperator()
    {
        foreach (var b in _db.Blogs.FromSqlRaw("SELECT * FROM Blogs").ToList())
            Console.WriteLine(b.Owner?.Name);
    }

    public void GroupedQuery()
    {
        foreach (var g in _db.Blogs.GroupBy(b => b.Rating).ToList())
            Console.WriteLine(g.Key);
    }

    public void NameOfOnly()
    {
        foreach (var b in _db.Blogs.ToList())
            Console.WriteLine(nameof(b.Owner));
    }

    public void Pragma()
    {
#pragma warning disable OR1011
        foreach (var b in _db.Blogs.ToList())
            Console.WriteLine(b.Owner?.Name);
#pragma warning restore OR1011
    }

    [SuppressMessage("Refyntra", "OR1011")]
    public void Attribute()
    {
        foreach (var b in _db.Blogs.ToList())
            Console.WriteLine(b.Owner?.Name);
    }
}
