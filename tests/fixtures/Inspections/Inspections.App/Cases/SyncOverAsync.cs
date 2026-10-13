using System.Threading.Tasks;

namespace Inspections.App.Cases;

// OR1002: every line marked "expect" must be reported; nothing else in this file may be.
public class SyncOverAsync
{
    private static Task<int> GetAsync() => Task.FromResult(42);
    private static Task WorkAsync() => Task.Delay(1);

    public int Result() => GetAsync().Result; // expect: OR1002

    public void Wait() => WorkAsync().Wait(); // expect: OR1002

    public int GetResult() => GetAsync().GetAwaiter().GetResult(); // expect: OR1002

    public int Configured() => GetAsync().ConfigureAwait(false).GetAwaiter().GetResult(); // expect: OR1002

    public async Task<int> InAsync()
    {
        var t = GetAsync();
        await Task.Yield();
        return t.Result; // expect: OR1002
    }

    public int Property => GetAsync().Result; // expect: OR1002

    public SyncOverAsync()
    {
        WorkAsync().Wait(); // expect: OR1002
    }

    // ---- false-positive guards: none of these is reported

    public async Task<int> AfterAwait()
    {
        var t = GetAsync();
        await t;
        return t.Result;
    }

    public async Task<int> AfterWhenAll()
    {
        var a = GetAsync();
        var b = GetAsync();
        await Task.WhenAll(a, b);
        return a.Result + b.Result;
    }

    public int Checked()
    {
        var t = GetAsync();
        return t.IsCompletedSuccessfully ? t.Result : 0;
    }

    public Task<int> Continuation() => GetAsync().ContinueWith(t => t.Result + 1);

    public int AlreadyCompleted() => Task.FromResult(1).Result;

    public int WaitWithTimeout()
    {
        var t = WorkAsync();
        return t.Wait(1000) ? 1 : 0;
    }

    public int Unrelated(Holder h) => h.Result;

    public class Holder
    {
        public int Result { get; set; }
    }
}
