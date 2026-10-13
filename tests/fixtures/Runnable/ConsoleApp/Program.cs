using Lib;

var greeting = Greeter.Greeting("Run");
var count = args.Length + 41;
var version = new Version(1, 2);
Console.WriteLine($"{greeting} {count}");
var total = 0;
for (var i = 0; i < 4; i++)
{
    total += Calc.Square(i);
}
total += Calc.Add(Calc.Square(2), Calc.Twice(3));
var big = total < 0 && Calc.Check(total);
Calc.TryFail();
Console.Out.WriteLine($"Total {total} {big}");
return count == 41 ? 7 : 1;
