using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Inspections.App.Fixes;

// Inputs of the quick-fix tests (InspectionsTests); the "expect" markers keep the whole-file expectations exact.
public class FixSamples
{
    private static Task<int> GetAsync() => Task.FromResult(41);
    private static Task WorkAsync() => Task.Delay(1);

    public Task<int> Wrapped()
    {
        var x = GetAsync().Result; // fix: await-make-async; expect: OR1002
        return Task.FromResult(x + 1);
    }

    public async Task Awaiting()
    {
        WorkAsync().GetAwaiter().GetResult(); // fix: getresult; expect: OR1002
        var s = GetAsync().Result.ToString(); // fix: parenthesized; expect: OR1002
        await Task.Yield();
    }

    public async void UsedAsCallback() // expect: OR1003
    {
        await Task.Yield();
    }

    public Action Callback() => UsedAsCallback;

    public string ReadInLoop(IEnumerable<string> items)
    {
        var acc = "";
        foreach (var item in items)
        {
            if (acc.Length > 100) break;
            acc += item; // not reported: the loop reads 'acc'
        }
        return acc;
    }
}
