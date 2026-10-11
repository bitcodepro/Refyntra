using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Refactorings.Lib.ExtractMethod;

public class Calculator
{
    private int _offset = 10;

    public int Sum(int a, int b)
    {
        var total = a + b;
        total *= 2;
        Console.WriteLine(total);
        return total;
    }

    public int Shift(int a)
    {
        var shifted = a + _offset;
        return shifted;
    }

    public int Product(int a, int b)
    {
        return a * b + 1;
    }

    public void Pair(int x)
    {
        int lo = x - 1;
        int hi = x + 1;
        Console.WriteLine(lo + hi);
    }

    public int Accumulate(int seed)
    {
        var acc = seed;
        acc += 5;
        acc *= 3;
        return acc;
    }

    public string Classify(int n)
    {
        if (n < 0) throw new ArgumentOutOfRangeException(nameof(n));
        if (n == 0) return "zero";
        return n > 10 ? "big" : "small";
    }

    public int FirstNegative(List<int> items)
    {
        var index = -1;
        for (var i = 0; i < items.Count; i++)
        {
            if (items[i] < 0)
            {
                index = i;
                break;
            }
        }
        return index;
    }

    public async Task<int> LoadAsync(int id)
    {
        await Task.Delay(1);
        var value = id * 2;
        await Task.Yield();
        return value;
    }

    public IEnumerable<int> Numbers()
    {
        yield return 1;
        yield return 2;
    }

    public T First<T>(List<T> items) where T : class
    {
        var head = items[0];
        return head;
    }
}
