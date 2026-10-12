using Lib;

var greeting = Greeter.Greeting("Run");
var count = args.Length + 41;
Console.WriteLine($"{greeting} {count}");
return count == 41 ? 7 : 1;
