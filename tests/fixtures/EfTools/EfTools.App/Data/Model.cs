using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore.Infrastructure;

namespace EfTools.App.Data;

public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public int? OwnerId { get; set; }
    public Author? Owner { get; set; }
    public List<Post> Posts { get; set; } = new();
    public BlogSettings Settings { get; set; } = new();
    [NotMapped]
    public Post? Featured { get; set; }
    public string Title => Name + " (" + Rating + ")";
}

/// <summary>Owned by Blog (OwnsOne): always loaded with it.</summary>
public class BlogSettings
{
    public string Theme { get; set; } = "";
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog? Blog { get; set; }
    public List<Tag> Tags { get; set; } = new();
}

public class Tag
{
    public int Id { get; set; }
    public string Label { get; set; } = "";
}

/// <summary>Lazy loading by injection (an ILazyLoader constructor): OR1011 stays silent for it.</summary>
public class Review
{
    private readonly ILazyLoader? _loader;
    private Blog? _blog;
    public Review() { }
    private Review(ILazyLoader loader) => _loader = loader;
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog? Blog { get => _blog; set => _blog = value; }
}
