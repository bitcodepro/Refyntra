using Microsoft.AspNetCore.Mvc;
using Orders.Application.Features;

namespace Orders.Api.Controllers;

/// <summary>Runs a request; its implementation lives elsewhere (a company package), so no Send is visible in source.</summary>
public interface IRequestRunner
{
    Task<object?> Run(object request, CancellationToken ct = default);
}

[ApiController]
[Route("api/invoices")]
public sealed class InvoicesController : ControllerBase
{
    private readonly IRequestRunner _runner;

    public InvoicesController(IRequestRunner runner) => _runner = runner;

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Get(int id) => Ok(await _runner.Run(new GetOrderQuery(id)));

    // Passing a request to a logger is not a dispatch... but the request object is the same: still listed (likely).
    [HttpGet("{id:int}/log")]
    public IActionResult Log(int id) => Ok(id.ToString());
}
