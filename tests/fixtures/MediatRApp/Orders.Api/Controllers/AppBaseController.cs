using MediatR;
using Microsoft.AspNetCore.Mvc;

namespace Orders.Api.Controllers;

/// <summary>A base controller that hides MediatR behind a helper: derived controllers call HandleRequest(command).</summary>
public abstract class AppBaseController : ControllerBase
{
    private ISender? _sender;

    protected ISender Sender => _sender ??= HttpContext.RequestServices.GetRequiredService<ISender>();

    protected async Task<IActionResult> HandleRequest<TResponse>(IRequest<TResponse> request)
    {
        var result = await Sender.Send(request);
        return Ok(result);
    }
}
