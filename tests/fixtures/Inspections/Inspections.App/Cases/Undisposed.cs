using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Inspections.App.Cases;

public class Undisposed
{
    private Stream? _kept;

    public string Read(string path)
    {
        var reader = new StreamReader(path); // expect: OR1005
        return reader.ReadToEnd();
    }

    public long Size(string path)
    {
        var stream = File.OpenRead(path); // expect: OR1005
        return stream.Length;
    }

    public async Task<string> ReadAsync(string path)
    {
        var reader = new StreamReader(path); // expect: OR1005
        return await reader.ReadToEndAsync();
    }

    // ---- false-positive guards: ownership transferred, disposed, or not owned

    public StreamReader Returned(string path)
    {
        var reader = new StreamReader(path);
        return reader;
    }

    public void Stored(string path)
    {
        var s = new FileStream(path, FileMode.Open);
        _kept = s;
    }

    public void Passed(string path, List<IDisposable> bag)
    {
        var s = new FileStream(path, FileMode.Open);
        bag.Add(s);
    }

    public void Disposed(string path)
    {
        var s = new FileStream(path, FileMode.Open);
        s.ReadByte();
        s.Dispose();
    }

    public void UsingAlready(string path)
    {
        using var s = new FileStream(path, FileMode.Open);
        s.ReadByte();
    }

    public void Captured(string path, List<Action> later)
    {
        var s = new FileStream(path, FileMode.Open);
        later.Add(() => s.ReadByte());
    }

    public Task Token(Func<CancellationToken, Task> run)
    {
        var cts = new CancellationTokenSource();
        cts.CancelAfter(1000);
        return run(cts.Token);
    }

    public string Memory()
    {
        var ms = new MemoryStream();
        ms.WriteByte(1);
        return ms.Length.ToString();
    }

    public Stream Inner(string path)
    {
        var w = new StreamWriter(path);
        return w.BaseStream;
    }

    public void Unused(string path)
    {
        var timer = new Timer(_ => { }, null, 0, 1000);
        timer.Change(0, 500);
    }
}
