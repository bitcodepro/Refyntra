using System.Collections.Generic;
using System.Linq;

namespace Refactorings.Lib.EditActions;

public class ConvertLinqSamples
{
    public bool AnyBig(int[] values)
    {
        return values.Any(v => v > 100);
    }

    public bool AllSmall(int[] values) => values.All(v => v < 100);

    public string? FirstShort(List<string> items)
    {
        return items.FirstOrDefault(s => s.Length < 3);
    }

    public int CountOdd(int[] values)
    {
        var odd = values.Count(v => v % 2 == 1);
        return odd;
    }

    public double Doubled(double[] values)
    {
        var sum = values.Sum(v => v * 2);
        return sum;
    }

    public List<string> Upper(List<string> items)
    {
        var upper = items.Where(s => s.Length > 1).Select(t => t.ToUpperInvariant()).ToList();
        return upper;
    }

    public List<int> Sorted(List<int> items)
    {
        var sorted = items.OrderBy(x => x).ToList();
        return sorted;
    }
}
