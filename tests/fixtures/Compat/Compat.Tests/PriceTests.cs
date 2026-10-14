using Compat.Contracts;
using Compat.Shared;
using Xunit;

namespace Compat.Tests;

public class PriceTests
{
    [Fact]
    public void DiscountsLargeOrders() => Assert.Equal(180m, OrderRules.Discount(200m));

    [Theory]
    [InlineData(0, "empty")]
    [InlineData(2, "many")]
    public void Sizes(int count, string expected) => Assert.Equal(expected, PriceFormatter.Size(count));

    [Fact]
    public void RunsOnNet8() => Assert.Equal(8, Environment.Version.Major);
}
