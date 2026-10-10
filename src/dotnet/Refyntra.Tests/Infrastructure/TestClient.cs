using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Refyntra.Host;
using Refyntra.Host.Rpc;
using Refyntra.Workspaces;

namespace Refyntra.Tests.Infrastructure;

public sealed class RpcError : Exception
{
    public int Code { get; }
    public string? ReasonCode { get; }

    public RpcError(int code, string? reasonCode, string message) : base($"{code} {reasonCode}: {message}")
    {
        Code = code;
        ReasonCode = reasonCode;
    }
}

/// <summary>A JSON-RPC client over framed streams, used both in-process and against the real host process.</summary>
public sealed class TestClient : IAsyncDisposable
{
    private readonly Stream _output;
    private readonly FrameReader _reader;
    private readonly FrameWriter _writer;
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly Task _readLoop;
    private long _nextId;
    private long _sequence = -1; // zero-based like the extension: the first event is 0
    private Task<int>? _serverTask;
    private Engine? _engine;
    private readonly List<IDisposable> _owned = new();

    public string WorkspaceId { get; } = "ws-" + Guid.NewGuid().ToString("N").Substring(0, 6);
    public Task<int>? ServerTask => _serverTask;

    public TestClient(Stream input, Stream output)
    {
        _output = output;
        _reader = new FrameReader(input, 64L * 1024 * 1024);
        _writer = new FrameWriter(output);
        _readLoop = Task.Run(ReadLoopAsync);
    }

    /// <summary>An in-process host (Engine + RpcServer) connected with anonymous pipes.</summary>
    public static TestClient InProcess(long maxMessageBytes = RpcServer.MaxMessageBytes)
    {
        var toServer = new AnonymousPipeServerStream(PipeDirection.Out);
        var serverIn = new AnonymousPipeClientStream(PipeDirection.In, toServer.ClientSafePipeHandle);
        var toClient = new AnonymousPipeServerStream(PipeDirection.Out);
        var clientIn = new AnonymousPipeClientStream(PipeDirection.In, toClient.ClientSafePipeHandle);
        var engine = new Engine();
        var server = new RpcServer(serverIn, toClient, engine, maxMessageBytes);
        var client = new TestClient(clientIn, toServer) { _engine = engine };
        client._serverTask = Task.Run(async () =>
        {
            var code = await server.RunAsync();
            toClient.Dispose();
            return code;
        });
        client._owned.Add(serverIn);
        client._owned.Add(engine);
        return client;
    }

    public Engine? Engine => _engine;

    private async Task ReadLoopAsync()
    {
        while (true)
        {
            Frame? frame;
            try { frame = await _reader.ReadAsync(CancellationToken.None); }
            catch (Exception) { break; }
            if (frame == null) break;
            if (frame.Value.Status != FrameStatus.Ok) throw new InvalidOperationException("Host sent a malformed frame: " + frame.Value.Error);
            using var doc = JsonDocument.Parse(frame.Value.Body!);
            var root = doc.RootElement.Clone();
            if (root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && _pending.TryRemove(id.GetInt64(), out var tcs))
                tcs.TrySetResult(root);
            else
                Unsolicited.Enqueue(root);
        }
        foreach (var t in _pending.Values) t.TrySetException(new EndOfStreamException("host closed the stream"));
    }

    public ConcurrentQueue<JsonElement> Unsolicited { get; } = new();

    public async Task SendRawAsync(byte[] body) => await _writer.WriteAsync(body);

    public async Task SendBytesAsync(byte[] bytes)
    {
        await _output.WriteAsync(bytes);
        await _output.FlushAsync();
    }

    public long NextId() => Interlocked.Increment(ref _nextId);

    /// <summary>Sends a request and returns the full response object (with result or error).</summary>
    public async Task<JsonElement> RawRequestAsync(string method, object? @params, long? id = null, TimeSpan? timeout = null)
    {
        var rid = id ?? NextId();
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[rid] = tcs;
        var body = JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = rid, ["method"] = method, ["params"] = @params });
        await _writer.WriteAsync(body);
        return await tcs.Task.WaitAsync(timeout ?? TimeSpan.FromMinutes(3));
    }

    public async Task<JsonElement> RequestAsync(string method, object? @params, TimeSpan? timeout = null)
    {
        var response = await RawRequestAsync(method, @params, null, timeout);
        if (response.TryGetProperty("error", out var error))
        {
            string? reason = error.TryGetProperty("data", out var data) && data.TryGetProperty("reasonCode", out var r) ? r.GetString() : null;
            throw new RpcError(error.GetProperty("code").GetInt32(), reason, error.GetProperty("message").GetString() ?? "");
        }
        return response.GetProperty("result");
    }

    public async Task NotifyAsync(string method, object? @params)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["method"] = method, ["params"] = @params });
        await _writer.WriteAsync(body);
    }

    // ------------------------------------------------------------------ protocol helpers

    public Task<JsonElement> InitializeAsync(int major = 1) =>
        RequestAsync("initialize", new { traceId = "t", protocolMajor = major, protocolMinor = 0, clientName = "tests", clientVersion = "0" });

    public Task<JsonElement> OpenAsync(string path, bool trusted = true) =>
        RequestAsync("workspace/open", new { traceId = "t", workspaceId = WorkspaceId, path, trusted }, TimeSpan.FromMinutes(5));

    public long NextSequence() => Interlocked.Increment(ref _sequence);

    public async Task<string> BarrierAsync()
    {
        var r = await RequestAsync("workspace/snapshotBarrier", new { traceId = "t", workspaceId = WorkspaceId, sequence = Interlocked.Read(ref _sequence) });
        return r.GetProperty("snapshotId").GetString()!;
    }

    public Task DidOpenAsync(string path, string text) => NotifyAsync("textDocument/didOpen",
        new { workspaceId = WorkspaceId, uri = UriPaths.ToUri(path), languageId = "csharp", version = 1, text, sequence = NextSequence(), workspaceRevision = _sequence });

    public Task DidChangeAsync(string path, string text, int version = 2) => NotifyAsync("textDocument/didChange",
        new { workspaceId = WorkspaceId, uri = UriPaths.ToUri(path), version, text, sequence = NextSequence(), workspaceRevision = _sequence });

    public Task DidCloseAsync(string path) => NotifyAsync("textDocument/didClose",
        new { workspaceId = WorkspaceId, uri = UriPaths.ToUri(path), sequence = NextSequence(), workspaceRevision = _sequence });

    public async Task<JsonElement> SymbolAtAsync(string snapshotId, string path, int line, int character) =>
        await RequestAsync("code/symbolAt", new { traceId = "t", workspaceId = WorkspaceId, snapshotId, uri = UriPaths.ToUri(path), position = new { line, character } });

    public async Task<JsonElement> RelatedAsync(string snapshotId, string symbolId) =>
        await RequestAsync("code/related", new { traceId = "t", workspaceId = WorkspaceId, snapshotId, symbolId });

    public async Task<JsonElement> PrepareRenameAsync(string snapshotId, string symbolId, string newName) =>
        await RequestAsync("refactor/prepare", new { traceId = "t", workspaceId = WorkspaceId, snapshotId, actionId = "csharp.rename", symbolId, newName });

    public async Task<JsonElement> RevalidateAsync(string snapshotId, string planId) =>
        await RequestAsync("refactor/revalidate", new { traceId = "t", workspaceId = WorkspaceId, snapshotId, planId });

    /// <summary>symbolAt on the first occurrence of <paramref name="needle"/> (plus offset) in the file on disk.</summary>
    public async Task<JsonElement> SymbolAtTextAsync(string snapshotId, string path, string needle, int offset = 0, string? text = null)
    {
        text ??= await File.ReadAllTextAsync(path);
        var (line, ch) = Position(text, needle, offset);
        return await SymbolAtAsync(snapshotId, path, line, ch);
    }

    public static (int line, int character) Position(string text, string needle, int offset = 0)
    {
        var idx = text.IndexOf(needle, StringComparison.Ordinal);
        if (idx < 0) throw new InvalidOperationException("needle not found: " + needle);
        idx += offset;
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < idx; i++)
        {
            if (text[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }
        return (line, idx - lineStart);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_serverTask != null && !_serverTask.IsCompleted)
            {
                await NotifyAsync("exit", new { });
                await _serverTask.WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        catch
        {
            // best effort
        }
        _output.Dispose();
        foreach (var d in _owned) d.Dispose();
        try { await _readLoop.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
    }
}
