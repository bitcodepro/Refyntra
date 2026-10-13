using Calc;
using Xunit;

namespace XUnitTests;

public class CalculatorTests
{
    [Fact]
    public void AddsTwoNumbers()
    {
        var result = Calculator.Add(2, 3);
        Assert.Equal(5, result);
    }

    [Fact]
    public void FailsOnPurpose()
    {
        Console.WriteLine("output of FailsOnPurpose");
        Assert.Equal(4, Calculator.Add(2, 3));
    }

    [Fact(Skip = "skipped on purpose")]
    public void SkippedOnPurpose()
    {
    }

    [Theory]
    [InlineData(1, 2, 3)]
    [InlineData(2, 2, 4)]
    [InlineData(5, 5, 11)]
    public void AddTheory(int a, int b, int expected)
    {
        Assert.Equal(expected, Calculator.Add(a, b));
    }

    public static IEnumerable<object[]> Pairs => new[] { new object[] { 6, 3 }, new object[] { 9, 3 } };

    [Theory]
    [MemberData(nameof(Pairs))]
    public void DividesByThree(int a, int b)
    {
        Assert.True(Calculator.Divide(a, b) > 1);
    }

    public class Nested
    {
        [Fact]
        public void NestedPasses()
        {
            Assert.Equal(1, Calculator.Divide(3, 3));
        }
    }
}
