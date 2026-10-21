using Microsoft.AspNetCore.Mvc;
using Orders.Application.Custom;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/archive")]
public sealed class ArchiveController : ControllerBase
{
    private readonly ICommandHandler<ArchiveOrderCommand> _archive;
    private readonly IQueryHandler<CountArchivedQuery, int> _count;
    private readonly ICommandDispatcher _dispatcher;

    public ArchiveController(ICommandHandler<ArchiveOrderCommand> archive, IQueryHandler<CountArchivedQuery, int> count, ICommandDispatcher dispatcher)
    {
        _archive = archive;
        _count = count;
        _dispatcher = dispatcher;
    }

    // The handler interface injected: DI picks the implementation.
    [HttpPost("{id:int}")]
    public async Task<IActionResult> Archive(int id, CancellationToken ct)
    {
        await _archive.HandleAsync(new ArchiveOrderCommand(id), ct);
        return NoContent();
    }

    [HttpGet("count")]
    public async Task<IActionResult> Count(CancellationToken ct) => Ok(await _count.HandleAsync(new CountArchivedQuery(), ct));

    // Through the project's own dispatcher.
    [HttpPost("{id:int}/ship")]
    public async Task<IActionResult> Ship(int id, CancellationToken ct)
    {
        await _dispatcher.DispatchAsync(new ShipOrderCommand(id), ct);
        return NoContent();
    }
}
