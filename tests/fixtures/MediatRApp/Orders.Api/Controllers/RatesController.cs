using Microsoft.AspNetCore.Mvc;
using Orders.Application.Custom;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/rates")]
public sealed class RatesController : ControllerBase
{
    private readonly IQueryRunner _queries;

    public RatesController(IQueryRunner queries) => _queries = queries;

    // An unusual method name (QueryAsync) and no Send anywhere: the query object says which handler serves it.
    [HttpGet]
    public async Task<IActionResult> GetRates(string currency) => Ok(await _queries.QueryAsync(new GetRatesQuery(currency)));
}
