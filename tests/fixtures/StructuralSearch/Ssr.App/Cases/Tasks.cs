using System.Threading.Tasks;

namespace Ssr.App.Cases;

public sealed class Box
{
    public int Result;
}

public sealed class Tasks
{
    public int Sync(Task<int> t) => t.Result; // m: result
    public string Nested(Task<string> t) => t.Result.Trim(); // m: result
    public int Parens(Task<int> t) => (t).Result; // m: result
    public int NotATask(Box b) => b.Result;

    public async Task<int> InAsync(Task<int> t)
    {
        await Task.Yield();
        var n = t.Result.ToString().Length; // m: result accumulate
        return n;
    }
}
