using System;
using System.Threading.Tasks;

for (var i = 0; i < 3; i++)
{
    Console.WriteLine($"Worker tick {i}");
    await Task.Delay(100);
}
