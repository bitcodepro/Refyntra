using Calc;
using NUnit.Framework;

namespace NUnitTests.Arithmetic;

[TestFixture]
public class DivideTests
{
    [Test]
    public void DividesEvenly()
    {
        Assert.That(Calculator.Divide(6, 3), Is.EqualTo(2));
    }

    [TestCase(8, 2, 4)]
    [TestCase(9, 3, 3)]
    public void DivideCases(int a, int b, int expected)
    {
        Assert.That(Calculator.Divide(a, b), Is.EqualTo(expected));
    }

    private static readonly object[] Sources = { new object[] { 4, 2 } };

    [TestCaseSource(nameof(Sources))]
    public void DivideSource(int a, int b)
    {
        Assert.That(Calculator.Divide(a, b), Is.EqualTo(2));
    }

    [Test]
    [Ignore("ignored on purpose")]
    public void IgnoredOnPurpose()
    {
    }
}
