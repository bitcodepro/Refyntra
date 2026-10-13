using System.Threading.Tasks;

namespace Inspections.App.Cases;

public class DiscardedTask
{
    private static Task SaveAsync() => Task.Delay(1);
    private static ValueTask FlushAsync() => default;
    private Worker? _worker = new();

    public void Sync()
    {
        SaveAsync(); // expect: OR1004
        FlushAsync(); // expect: OR1004
    }

    public async Task ConditionalInAsync()
    {
        _worker?.RunAsync(); // expect: OR1004
        await Task.Yield();
    }

    // ---- false-positive guards

    public void Started()
    {
        Task.Run(() => 1);
        Task.Factory.StartNew(() => 1);
        SaveAsync().ContinueWith(_ => 0);
    }

    public void Explicit()
    {
        _ = SaveAsync();
        var t = SaveAsync();
        t.Wait(1);
    }

    public Task Returned() => SaveAsync();

    public async Task Awaited()
    {
        await SaveAsync();
    }

    public async Task CompilerReports()
    {
        SaveAsync(); // the compiler's CS4014, not OR1004
        await Task.Yield();
    }

    public class Worker
    {
        public Task RunAsync() => Task.CompletedTask;
    }
}
