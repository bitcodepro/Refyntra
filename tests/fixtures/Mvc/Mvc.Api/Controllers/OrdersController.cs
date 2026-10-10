using MediatR;
using Microsoft.AspNetCore.Mvc;
using Mvc.Api.Features;

namespace Mvc.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class OrdersController : ControllerBase
{
    private readonly ISender _sender;

    public OrdersController(ISender sender) => _sender = sender;

    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetOrder(int id) => Ok(await _sender.Send(new GetOrderQuery(id)));

    [HttpPost]
    public IActionResult Create() => Ok();

    [HttpPut("{id:int}")]
    [HttpPatch("{id:int}/partial")]
    public IActionResult Update(int id) => Ok(id);

    [HttpDelete("/api/legacy/orders/{id}")]
    public IActionResult Remove(int id) => Ok(id);

    [AcceptVerbs("HEAD", "OPTIONS", Route = "probe")]
    public IActionResult Probe() => Ok();

    [HttpGet("[action]")]
    [ApiExplorerSettings(IgnoreApi = true)]
    public IActionResult Internal() => Ok();

    [NonAction]
    public IActionResult Helper() => Ok();
}
