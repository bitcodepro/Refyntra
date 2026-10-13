using Calc;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MSTestTests;

[TestClass]
public class AddTests
{
    [TestMethod]
    public void AddsZero()
    {
        Assert.AreEqual(7, Calculator.Add(7, 0));
    }

    [TestMethod]
    [DataRow(1, 1, 2)]
    [DataRow(3, 4, 7)]
    public void AddRows(int a, int b, int expected)
    {
        Assert.AreEqual(expected, Calculator.Add(a, b));
    }
}
