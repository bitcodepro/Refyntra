using MediatR;

namespace GenerateHandler.App.Features;

public sealed record Ping : IRequest<string>;
