using Microsoft.AspNetCore.Mvc;

namespace Mvc.Api.Controllers;

/// <summary>Abstract: never an endpoint itself; its route and actions are inherited.</summary>
[Route("api/v1/[controller]")]
public abstract class ApiBaseController : ControllerBase
{
    [HttpGet("ping")]
    public IActionResult Ping() => Ok();
}

public sealed class CustomersController : ApiBaseController
{
    [HttpGet("{id:guid}")]
    public IActionResult Find(Guid id) => Ok(id);
}

[Area("Admin")]
[Route("[area]/[controller]/[action]")]
public sealed class DashboardController : Controller
{
    public IActionResult Index() => View();
}

/// <summary>No attribute routes: reachable only through conventional routing.</summary>
public sealed class HomeController : Controller
{
    public IActionResult Index() => View();
}

/// <summary>Plain [Controller] marker without a base type.</summary>
[Controller]
[Route("plain")]
public sealed class PlainApi
{
    [HttpGet]
    public string Get() => "plain";
}
