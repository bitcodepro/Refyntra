using Compat.Contracts;

namespace Compat.Multi;

public static class Greeter
{
    public static string Hello(string name) => $"Hello {name} from {Runtime()}";

#if NET10_0_OR_GREATER
    public static string Runtime() => "net10";
#else
    public static string Runtime() => "net8";
#endif

    public static decimal Price(OrderDto order) => OrderRules.Discount(order.Total);
}
