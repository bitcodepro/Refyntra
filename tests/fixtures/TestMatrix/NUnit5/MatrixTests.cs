using NUnit.Framework;

namespace NUnit5;

public class MatrixTests
{
    [Test]
    public void Passes() => Assert.That(2 + 2, Is.EqualTo(4));

    [Test]
    public void Fails() => Assert.That(2 + 2, Is.EqualTo(5));

    [Test, Ignore("skipped on purpose")]
    public void Skipped() { }

    [TestCase(1, 2, 3)]
    [TestCase(2, 2, 5)]
    public void Adds(int a, int b, int sum) => Assert.That(a + b, Is.EqualTo(sum));
}
