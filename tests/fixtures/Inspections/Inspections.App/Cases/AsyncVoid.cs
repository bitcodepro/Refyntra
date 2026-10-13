using System;
using System.Threading.Tasks;

namespace Inspections.App.Cases;

public class AsyncVoid
{
    public async void Fire() // expect: OR1003
    {
        await Task.Yield();
    }

    public void Local()
    {
        async void Inner() // expect: OR1003
        {
            await Task.Yield();
        }
        Inner();
    }

    // ---- false-positive guards

    public async void OnClick(object sender, EventArgs e)
    {
        await Task.Yield();
    }

    public async void OnCustom(object? sender, CustomEventArgs e)
    {
        await Task.Yield();
    }

    public async Task Proper()
    {
        await Task.Yield();
    }

    public void NotAsync()
    {
    }

    public class CustomEventArgs : EventArgs
    {
    }
}

public abstract class AsyncVoidBase
{
    public abstract void Run();
}

public class AsyncVoidOverride : AsyncVoidBase
{
    public override async void Run()
    {
        await Task.Yield();
    }
}

public interface IStarter
{
    void Start();
}

public class AsyncVoidImplementation : IStarter
{
    public async void Start()
    {
        await Task.Yield();
    }
}
