using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MSTest2;

[TestClass]
public class MatrixTests
{
    [TestMethod]
    public void Passes() => Assert.AreEqual(4, 2 + 2);

    [TestMethod]
    public void Fails() => Assert.AreEqual(5, 2 + 2);

    [TestMethod, Ignore("skipped on purpose")]
    public void Skipped() { }

    [TestMethod]
    [DataRow(1, 2, 3)]
    [DataRow(2, 2, 5)]
    public void Adds(int a, int b, int sum) => Assert.AreEqual(sum, a + b);
}
