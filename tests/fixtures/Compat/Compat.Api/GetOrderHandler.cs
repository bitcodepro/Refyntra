using Compat.Contracts;
using MediatR;

namespace Compat.Api;

// C# 12 (the net8.0 default): a primary constructor and a collection expression.
public sealed class GetOrderHandler(IClock clock) : IRequestHandler<GetOrderQuery, OrderDto>
{
    private static readonly int[] Factors = [10, 20, 30];

    public Task<OrderDto> Handle(GetOrderQuery request, CancellationToken cancellationToken)
    {
        var total = Factors.Sum() * request.Id + clock.Now.Year * 0;
        return Task.FromResult(new OrderDto(request.Id, total));
    }
}

public sealed class SystemClock : IClock
{
    public DateTime Now => DateTime.UtcNow;
}

public sealed class OrderNotes
{
    private readonly IClock _clock;

    public OrderNotes(IClock clock)
    {
        _clock = clock;
    }

    public List<string> Lines(string? note)
    {
        var lines = new List<string> { "created " + _clock.Now.Year };
        if (note != null)
        {
            lines.Add(note);
        }
        return lines;
    }

    public int ReadAll(string path)
    {
        var reader = new StreamReader(path);
        return reader.ReadToEnd().Length;
    }
}
