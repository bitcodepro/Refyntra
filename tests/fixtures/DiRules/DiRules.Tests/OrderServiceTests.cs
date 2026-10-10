using DiRules.App.Direct;
using Xunit;

namespace DiRules.Tests;

// References OrderService and OrderRepository directly: a proven reference (not coverage).
public class OrderServiceTests
{
    [Fact]
    public void TotalIsZeroForAnEmptyRepository()
    {
        var service = new OrderService(new OrderRepository());
        Assert.Equal(0, service.Total());
    }

    [Theory]
    [InlineData(1)]
    public void PriceUsesTheRepository(int id)
    {
        IPriceCache cache = new PriceCache(new OrderRepository());
        Assert.Equal(id, cache.Price(id));
    }
}

// Matches PriceCache by name only (it never mentions PriceCache): heuristic.
public class PriceCacheTests
{
    [Fact]
    public void Placeholder() => Assert.True(true);
}

// A helper in the test project that is not a test: never listed.
public static class OrderBuilders
{
    public static OrderService Make() => new(new OrderRepository());
}
