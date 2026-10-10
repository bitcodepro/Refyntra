using DiRules.App.Direct;

namespace DiRules.Tests.Fake
{
    // A same-name attribute that is not xUnit's: methods marked with it are not tests.
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class FactAttribute : Attribute { }

    public class NotRealTests
    {
        [Fact]
        public void LooksLikeATest() => _ = new OrderService(new OrderRepository()).Total();
    }
}
