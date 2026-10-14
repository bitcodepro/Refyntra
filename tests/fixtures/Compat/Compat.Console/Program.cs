using Compat.Contracts;
using Compat.Shared;

var order = new OrderDto(9, 50m);
Console.WriteLine(PriceFormatter.Format(order) + " on " + Environment.Version.Major);
return 9;
