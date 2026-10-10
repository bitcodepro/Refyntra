using System.Text;

namespace Refyntra.Host.Rpc;

public enum FrameStatus { Ok, Oversized, Malformed }

public readonly record struct Frame(FrameStatus Status, byte[]? Body, string? Error);

/// <summary>Reads LSP-style frames: "Content-Length: N\r\n\r\n" + N bytes. Returns null at end of stream.</summary>
public sealed class FrameReader
{
    public const int MaxHeaderBytes = 8 * 1024;
    private readonly Stream _stream;
    private readonly long _maxBody;
    private readonly byte[] _buffer = new byte[64 * 1024];
    private int _start, _end;

    public FrameReader(Stream stream, long maxBody)
    {
        _stream = stream;
        _maxBody = maxBody;
    }

    private async Task<bool> FillAsync(CancellationToken ct)
    {
        if (_start > 0 && _start == _end) { _start = _end = 0; }
        if (_end == _buffer.Length)
        {
            Buffer.BlockCopy(_buffer, _start, _buffer, 0, _end - _start);
            _end -= _start;
            _start = 0;
        }
        var n = await _stream.ReadAsync(_buffer.AsMemory(_end, _buffer.Length - _end), ct).ConfigureAwait(false);
        if (n <= 0) return false;
        _end += n;
        return true;
    }

    public async Task<Frame?> ReadAsync(CancellationToken ct)
    {
        // Header block.
        int headerEnd;
        while (true)
        {
            headerEnd = IndexOfHeaderEnd();
            if (headerEnd >= 0) break;
            if (_end - _start >= MaxHeaderBytes)
            {
                _start = _end; // discard garbage
                return new Frame(FrameStatus.Malformed, null, "Header block too large or missing terminator");
            }
            if (_start > 0 && _end == _buffer.Length)
            {
                Buffer.BlockCopy(_buffer, _start, _buffer, 0, _end - _start);
                _end -= _start;
                _start = 0;
            }
            if (!await FillAsync(ct).ConfigureAwait(false))
            {
                if (_end > _start)
                {
                    _start = _end;
                    return new Frame(FrameStatus.Malformed, null, "Truncated header at end of stream");
                }
                return null;
            }
        }
        var header = Encoding.ASCII.GetString(_buffer, _start, headerEnd - _start);
        _start = headerEnd + 4;
        long length = -1;
        foreach (var line in header.Split("\r\n"))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            if (line.Substring(0, colon).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase)
                && long.TryParse(line.Substring(colon + 1).Trim(), out var v) && v >= 0)
                length = v;
        }
        if (length < 0) return new Frame(FrameStatus.Malformed, null, "Missing or invalid Content-Length");
        if (length > _maxBody)
        {
            var remaining = length;
            while (remaining > 0)
            {
                if (_start == _end && !await FillAsync(ct).ConfigureAwait(false)) return null;
                var take = (int)Math.Min(remaining, _end - _start);
                _start += take;
                remaining -= take;
            }
            return new Frame(FrameStatus.Oversized, null, $"Frame of {length} bytes exceeds the limit of {_maxBody}");
        }
        var body = new byte[length];
        var copied = 0;
        while (copied < length)
        {
            if (_start == _end && !await FillAsync(ct).ConfigureAwait(false))
                return new Frame(FrameStatus.Malformed, null, "Truncated body at end of stream");
            var take = (int)Math.Min(length - copied, _end - _start);
            Buffer.BlockCopy(_buffer, _start, body, copied, take);
            _start += take;
            copied += take;
        }
        return new Frame(FrameStatus.Ok, body, null);
    }

    private int IndexOfHeaderEnd()
    {
        for (var i = _start; i + 3 < _end; i++)
            if (_buffer[i] == '\r' && _buffer[i + 1] == '\n' && _buffer[i + 2] == '\r' && _buffer[i + 3] == '\n')
                return i;
        return -1;
    }
}

/// <summary>Serialized frame writer (one frame at a time).</summary>
public sealed class FrameWriter
{
    private readonly Stream _stream;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public FrameWriter(Stream stream) => _stream = stream;

    public async Task WriteAsync(byte[] body, CancellationToken ct = default)
    {
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(header, ct).ConfigureAwait(false);
            await _stream.WriteAsync(body, ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _lock.Release();
        }
    }
}
