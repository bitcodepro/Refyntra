using System.Collections.Generic;
using GenerateHandler.Contracts.Dtos;
using MediatR;

namespace GenerateHandler.Contracts.Requests
{
    public sealed record GetThing(int Id) : IRequest<ThingDto>;

    public sealed record DoThing(int Id) : IRequest;

    public sealed record ListThings : IRequest<List<ThingDto>>;

    public sealed record Generic<T>(T Value) : IRequest<T>;

    public sealed record Handled(int Id) : IRequest<int>;

    internal sealed record Secret(int Id) : IRequest<string?>;
}
