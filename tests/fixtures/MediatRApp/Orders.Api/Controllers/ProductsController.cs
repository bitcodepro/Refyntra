using MediatR;
using Microsoft.AspNetCore.Mvc;
using Orders.Application.Cqrs;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class ProductsController : ControllerBase
{
    private readonly IMediator _mediator;

    public ProductsController(IMediator mediator) => _mediator = mediator;

    [HttpGet("prices")]
    public async Task<IActionResult> GetProductPrices(string code) => Ok(await _mediator.Send(new GetProductPricesQuery(code)));

    [HttpPost("archive")]
    public async Task<IActionResult> Archive(string code)
    {
        var command = new ArchiveProductCommand(code);
        await _mediator.Send(command);
        return NoContent();
    }
}
