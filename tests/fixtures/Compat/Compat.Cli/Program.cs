using Compat.Contracts;
using Compat.Multi;

var order = new OrderDto(8, 200m);
var price = Greeter.Price(order);
Console.WriteLine(Greeter.Hello("cli") + " " + price.ToString(System.Globalization.CultureInfo.InvariantCulture) + " on " + Environment.Version.Major);
return 8;
