using System;
using System.Globalization;
using Compat.Contracts;

namespace Compat.Shared
{
    public static class PriceFormatter
    {
        public static string Format(OrderDto order)
        {
            var total = OrderRules.Discount(order.Total);
            return "Order " + order.Id + ": " + total.ToString("0.00", CultureInfo.InvariantCulture);
        }

        public static string Size(int count) => count switch
        {
            0 => "empty",
            1 => "one",
            _ => "many",
        };

        public static int Sum(ReadOnlySpan<int> values)
        {
            var sum = 0;
            foreach (var v in values) sum += v;
            return sum;
        }
    }
}
