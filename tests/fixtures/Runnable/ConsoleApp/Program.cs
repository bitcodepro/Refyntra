using Lib;

var greeting = Greeter.Greeting("Run");
var count = args.Length + 41;
var version = new Version(1, 2);
Console.WriteLine($"{greeting} {count}");
return count == 41 ? 7 : 1;
