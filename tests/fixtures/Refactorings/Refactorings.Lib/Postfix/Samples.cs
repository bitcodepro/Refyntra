using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace Refactorings.Lib.Postfix;

// Postfix template samples: the tests replace a /*X*/ marker with "expr.name" in an overlay and ask for templates.
public class Samples
{
    private readonly List<string> _names = new();

    public void Statements(List<int> numbers, int[] array, bool ready, string? maybe, int? count, int plain, Stream stream, IEnumerable<string> lines)
    {
        /*S*/
    }

    public async Task Awaiting()
    {
        /*A*/
        await Task.CompletedTask;
    }

    public IEnumerable<int> Iterator(int x)
    {
        /*Y*/
        yield break;
    }

    public int Value(int x)
    {
        /*R*/
        return x;
    }

    public void Throwing(string reason)
    {
        /*T*/
    }

    public void Generic<T>(T value, Dictionary<string, T> map)
    {
        /*G*/
    }

    public Task<int> LoadAsync() => Task.FromResult(_names.Count);
}
