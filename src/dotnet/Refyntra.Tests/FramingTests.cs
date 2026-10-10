using System.Text;
using Refyntra.Host.Rpc;

namespace Refyntra.Tests;

public sealed class FramingTests
{
    private static byte[] Frame(string json) => Encoding.UTF8.GetBytes($"Content-Length: {Encoding.UTF8.GetByteCount(json)}\r\n\r\n{json}");

    /// <summary>Returns at most <c>chunk</c> bytes per read to simulate frames split across reads.</summary>
    private sealed class TrickleStream : Stream
    {
        private readonly byte[] _data;
        private readonly int _chunk;
        private int _pos;
        public TrickleStream(byte[] data, int chunk) { _data = data; _chunk = chunk; }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = Math.Min(Math.Min(count, _chunk), _data.Length - _pos);
            Array.Copy(_data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _data.Length;
        public override long Position { get => _pos; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(7)]
    public async Task SplitFramesAreReassembled(int chunk)
    {
        var data = Frame("{\"a\":\"ünïcødé 🚀\"}").Concat(Frame("{\"b\":2}")).ToArray();
        var reader = new FrameReader(new TrickleStream(data, chunk), 1024);
        var f1 = await reader.ReadAsync(default);
        var f2 = await reader.ReadAsync(default);
        Assert.Equal("{\"a\":\"ünïcødé 🚀\"}", Encoding.UTF8.GetString(f1!.Value.Body!));
        Assert.Equal("{\"b\":2}", Encoding.UTF8.GetString(f2!.Value.Body!));
        Assert.Null(await reader.ReadAsync(default));
    }

    [Fact]
    public async Task MergedFramesInOneBufferAreSeparated()
    {
        var data = Frame("{\"x\":1}").Concat(Frame("{\"y\":2}")).Concat(Frame("{\"z\":3}")).ToArray();
        var reader = new FrameReader(new MemoryStream(data), 1024);
        var bodies = new List<string>();
        while (await reader.ReadAsync(default) is { } f) bodies.Add(Encoding.UTF8.GetString(f.Body!));
        Assert.Equal(new[] { "{\"x\":1}", "{\"y\":2}", "{\"z\":3}" }, bodies);
    }

    [Fact]
    public async Task OversizedFrameIsSkippedAndNextFrameIsRead()
    {
        var big = "{\"big\":\"" + new string('x', 5000) + "\"}";
        var data = Frame(big).Concat(Frame("{\"ok\":true}")).ToArray();
        var reader = new FrameReader(new TrickleStream(data, 333), 1024);
        var f1 = await reader.ReadAsync(default);
        Assert.Equal(FrameStatus.Oversized, f1!.Value.Status);
        var f2 = await reader.ReadAsync(default);
        Assert.Equal(FrameStatus.Ok, f2!.Value.Status);
        Assert.Equal("{\"ok\":true}", Encoding.UTF8.GetString(f2.Value.Body!));
    }

    [Fact]
    public async Task HeaderWithoutContentLengthIsMalformedAndReaderRecovers()
    {
        var data = Encoding.ASCII.GetBytes("Content-Type: x\r\n\r\n").Concat(Frame("{\"ok\":1}")).ToArray();
        var reader = new FrameReader(new MemoryStream(data), 1024);
        Assert.Equal(FrameStatus.Malformed, (await reader.ReadAsync(default))!.Value.Status);
        var ok = await reader.ReadAsync(default);
        Assert.Equal("{\"ok\":1}", Encoding.UTF8.GetString(ok!.Value.Body!));
    }

    [Fact]
    public async Task TruncatedBodyIsMalformed()
    {
        var data = Encoding.ASCII.GetBytes("Content-Length: 50\r\n\r\n{\"a\":1}");
        var reader = new FrameReader(new MemoryStream(data), 1024);
        Assert.Equal(FrameStatus.Malformed, (await reader.ReadAsync(default))!.Value.Status);
        Assert.Null(await reader.ReadAsync(default));
    }

    [Fact]
    public async Task EndlessGarbageWithoutHeaderTerminatorIsBounded()
    {
        var data = Enumerable.Repeat((byte)'a', FrameReader.MaxHeaderBytes * 2).Concat(Frame("{\"ok\":1}")).ToArray();
        var reader = new FrameReader(new MemoryStream(data), 1024);
        var statuses = new List<FrameStatus>();
        while (await reader.ReadAsync(default) is { } f) statuses.Add(f.Status);
        Assert.Contains(FrameStatus.Malformed, statuses);
    }
}
