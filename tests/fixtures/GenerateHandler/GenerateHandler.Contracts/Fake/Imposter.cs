namespace GenerateHandler.Contracts.Fake
{
    /// <summary>Same name as the MediatR interface, different assembly identity: never a MediatR request.</summary>
    public interface IRequest<T>
    {
    }

    public sealed class Imposter : IRequest<int>
    {
    }
}
