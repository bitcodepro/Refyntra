using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Refyntra.Host.Protocol;
using Refyntra.Workspaces;

namespace Refyntra.Host.Rpc;

public interface IRpcHandler
{
    /// <summary>Methods whose synchronous prefix must run on the reader thread (ordering with later notifications).</summary>
    bool RunsInline(string method);
    Task<object?> HandleRequestAsync(string method, JsonElement @params, string traceId, CancellationToken ct);
    /// <summary>Notifications run on the reader thread, strictly in arrival order.</summary>
    void HandleNotification(string method, JsonElement @params);
    bool ShutdownRequested { get; }
}

/// <summary>JSON-RPC 2.0 over Content-Length framed streams. Requests run concurrently; responses are serialized.</summary>
public sealed partial class RpcServer
{
    public const long MaxMessageBytes = 32L * 1024 * 1024;
    private readonly FrameReader _reader;
    private readonly FrameWriter _writer;
    private readonly IRpcHandler _handler;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Task, byte> _running = new();

    public RpcServer(Stream input, Stream output, IRpcHandler handler, long maxMessageBytes = MaxMessageBytes)
    {
        _reader = new FrameReader(input, maxMessageBytes);
        _writer = new FrameWriter(output);
        _handler = handler;
    }

    /// <summary>Runs until stdin closes or an exit notification arrives. Returns the process exit code.</summary>
    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var exitCode = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                Frame? frame;
                try
                {
                    frame = await _reader.ReadAsync(ct).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    break;
                }
                if (frame == null) break; // EOF
                var f = frame.Value;
                if (f.Status != FrameStatus.Ok)
                {
                    Log.Warn("rpc", "dropped frame: " + f.Error);
                    continue;
                }
                bool stop;
                int exit;
                try
                {
                    stop = ProcessFrame(f.Body!, out exit);
                }
                catch (Exception ex)
                {
                    // A single bad frame must never take the host down.
                    Log.Warn("rpc", "dropped frame: " + ex.GetType().Name);
                    continue;
                }
                if (stop)
                {
                    exitCode = exit;
                    break;
                }
            }
        }
        finally
        {
            foreach (var cts in _pending.Values)
            {
                try { cts.Cancel(); }
                catch (ObjectDisposedException) { }
            }
            try { await Task.WhenAll(_running.Keys).WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false); }
            catch { /* best effort */ }
        }
        return exitCode;
    }

    [GeneratedRegex("\"id\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+)")]
    private static partial Regex IdRegex();

    /// <returns>true when the server must stop (exit notification).</returns>
    private bool ProcessFrame(byte[] body, out int exitCode)
    {
        exitCode = 0;
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            // Reply only when an id can be recovered from the raw text; otherwise drop.
            var text = System.Text.Encoding.UTF8.GetString(body);
            var m = IdRegex().Match(text);
            Log.Warn("rpc", "malformed JSON frame" + (m.Success ? " (id recovered)" : " (dropped)"));
            if (m.Success)
            {
                JsonElement recovered;
                try
                {
                    using var idDoc = JsonDocument.Parse(m.Groups[1].Value);
                    recovered = idDoc.RootElement.Clone();
                }
                catch (JsonException)
                {
                    Log.Warn("rpc", "recovered id is not valid JSON (dropped)");
                    return false;
                }
                _ = SendErrorAsync(recovered, ErrorCodes.ParseError, "ParseError", "Malformed JSON.");
            }
            return false;
        }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                Log.Warn("rpc", "dropped non-object message");
                return false;
            }
            var hasId = root.TryGetProperty("id", out var idEl) && idEl.ValueKind is JsonValueKind.Number or JsonValueKind.String;
            var id = hasId ? idEl.Clone() : default;
            if (!root.TryGetProperty("method", out var methodEl) || methodEl.ValueKind != JsonValueKind.String)
            {
                if (hasId && !root.TryGetProperty("result", out _) && !root.TryGetProperty("error", out _))
                    _ = SendErrorAsync(id, ErrorCodes.InvalidRequest, "InvalidRequest", "Missing method.");
                return false;
            }
            if (!root.TryGetProperty("jsonrpc", out var ver) || ver.ValueKind != JsonValueKind.String || ver.GetString() != "2.0")
            {
                if (hasId) _ = SendErrorAsync(id, ErrorCodes.InvalidRequest, "InvalidRequest", "jsonrpc must be \"2.0\".");
                return false;
            }
            var method = methodEl.GetString()!;
            var @params = root.TryGetProperty("params", out var p) ? p.Clone() : JsonDocument.Parse("{}").RootElement.Clone();

            if (!hasId)
            {
                if (method == "exit")
                {
                    exitCode = _handler.ShutdownRequested ? 0 : 1;
                    return true;
                }
                if (method == "$/cancelRequest")
                {
                    if (@params.ValueKind == JsonValueKind.Object && @params.TryGetProperty("id", out var cancelId)
                        && _pending.TryGetValue(cancelId.GetRawText(), out var cts))
                    {
                        // The request may complete (and dispose its source) between the lookup and Cancel.
                        try { cts.Cancel(); }
                        catch (ObjectDisposedException) { }
                    }
                    return false;
                }
                try
                {
                    _handler.HandleNotification(method, @params);
                }
                catch (Exception ex)
                {
                    Log.Warn("rpc", $"notification {method} failed: {ex.GetType().Name}: {ex.Message}");
                }
                return false;
            }

            var key = id.GetRawText();
            var requestCts = new CancellationTokenSource();
            if (!_pending.TryAdd(key, requestCts))
            {
                _ = SendErrorAsync(id, ErrorCodes.InvalidRequest, "DuplicateId", "A request with this id is still running.");
                return false;
            }
            var traceId = @params.ValueKind == JsonValueKind.Object && @params.TryGetProperty("traceId", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()! : "";
            Task task = _handler.RunsInline(method)
                ? ExecuteAsync(id, key, method, @params, traceId, requestCts)
                : Task.Run(() => ExecuteAsync(id, key, method, @params, traceId, requestCts));
            _running.TryAdd(task, 0);
            task.ContinueWith(x => _running.TryRemove(x, out _), TaskScheduler.Default);
            return false;
        }
    }

    private async Task ExecuteAsync(JsonElement id, string key, string method, JsonElement @params, string traceId, CancellationTokenSource cts)
    {
        var sw = Stopwatch.StartNew();
        var status = "ok";
        try
        {
            object? result;
            try
            {
                result = await _handler.HandleRequestAsync(method, @params, traceId, cts.Token).ConfigureAwait(false);
                cts.Token.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (cts.IsCancellationRequested)
            {
                status = "cancelled";
                await SendErrorAsync(id, ErrorCodes.Cancelled, "Cancelled", "The request was cancelled.").ConfigureAwait(false);
                return;
            }
            catch (EngineException ex)
            {
                status = ex.ReasonCode;
                await SendErrorAsync(id, ex.Code, ex.ReasonCode, ex.Message, ex.Recovery).ConfigureAwait(false);
                return;
            }
            catch (JsonException ex)
            {
                status = "InvalidParams";
                await SendErrorAsync(id, ErrorCodes.InvalidParams, "InvalidParams", "Invalid params: " + ex.Message).ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                status = "InternalError";
                Log.Write("error", "rpc", $"{method} failed: {ex.GetType().Name}: {ex.Message}", traceId, method);
                await SendErrorAsync(id, ErrorCodes.InternalError, "InternalError", ex.GetType().Name + ": " + ex.Message).ConfigureAwait(false);
                return;
            }
            await SendResultAsync(id, result).ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(key, out _);
            cts.Dispose();
            Log.Write("info", "rpc", "request", traceId, method, sw.Elapsed.TotalMilliseconds, status);
        }
    }

    private Task SendResultAsync(JsonElement id, object? result)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("jsonrpc", "2.0");
            w.WritePropertyName("id");
            id.WriteTo(w);
            w.WritePropertyName("result");
            if (result == null) w.WriteNullValue();
            else JsonSerializer.Serialize(w, result, result.GetType(), Json.Options);
            w.WriteEndObject();
        }
        return SafeWrite(ms.ToArray());
    }

    private Task SendErrorAsync(JsonElement id, int code, string reasonCode, string message, string? recovery = null)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("jsonrpc", "2.0");
            w.WritePropertyName("id");
            if (id.ValueKind == JsonValueKind.Undefined) w.WriteNullValue();
            else id.WriteTo(w);
            w.WritePropertyName("error");
            w.WriteStartObject();
            w.WriteNumber("code", code);
            w.WriteString("message", message);
            w.WritePropertyName("data");
            JsonSerializer.Serialize(w, new RpcErrorData { ReasonCode = reasonCode, Message = message, Recovery = recovery }, Json.Options);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return SafeWrite(ms.ToArray());
    }

    private async Task SafeWrite(byte[] body)
    {
        try
        {
            await _writer.WriteAsync(body).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            Log.Warn("rpc", "output closed: " + ex.GetType().Name);
        }
    }
}
