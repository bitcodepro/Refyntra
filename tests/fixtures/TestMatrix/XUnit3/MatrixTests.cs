using Xunit;

namespace XUnit3;

public class MatrixTests
{
    [Fact]
    public void Passes() => Assert.Equal(4, 2 + 2);

    [Fact]
    public void Fails() => Assert.Equal(5, 2 + 2);

    [Fact(Skip = "skipped on purpose")]
    public void Skipped() { }

    [Theory]
    [InlineData(1, 2, 3)]
    [InlineData(2, 2, 5)]
    public void Adds(int a, int b, int sum) => Assert.Equal(sum, a + b);
}
