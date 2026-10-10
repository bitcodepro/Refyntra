using Microsoft.AspNetCore.Mvc;

namespace FullStack.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult GetOrder(int id) => Ok(id);

    [HttpGet("recent")]
    public IActionResult Recent() => Ok();

    [HttpPost]
    public IActionResult Create() => Ok();

    [HttpPost("{id:int}/cancel")]
    public IActionResult Cancel(int id) => Ok(id);
}

[ApiController]
public sealed class TagsController : ControllerBase
{
    // Same shape as the Minimal API route /api/tags/{name}: a client call to it is ambiguous.
    [HttpGet("/api/tags/{slug}")]
    public IActionResult BySlug(string slug) => Ok(slug);
}
