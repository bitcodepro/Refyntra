using Microsoft.AspNetCore.Mvc;
using Orders.Application.Features;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class SettingsController : AppBaseController
{
    [HttpPost("refreshSettings")]
    public async Task<IActionResult> RefreshSettings(bool force)
    {
        if (!force) return Ok();
        return await HandleRequest(new RefreshSettingsCommand());
    }
}
