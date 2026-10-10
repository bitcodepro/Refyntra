using System.Text;
using System.Text.Json;
using Refyntra.Tests.Infrastructure;
using Refyntra.Workspaces;

namespace Refyntra.Tests;

/// <summary>Protocol-level behaviour that needs no loaded workspace.</summary>
public sealed class ProtocolTests
{
    [Fact]
    public async Task InitializeReturnsVersionsEpochAndLimits()
    {
        await using var c = TestClient.InProcess();
        var r = await c.InitializeAsync();
        Assert.Equal(1, r.GetProperty("protocolMajor").GetInt32());
        Assert.Equal(3, r.GetProperty("protocolMinor").GetInt32());
        Assert.False(string.IsNullOrEmpty(r.GetProperty("sessionEpoch").GetString()));
        Assert.Equal(32L * 1024 * 1024, r.GetProperty("limits").GetProperty("maxMessageBytes").GetInt64());
        Assert.Contains("csharp.related", r.GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()));
    }

    [Fact]
    public async Task ProtocolMajorMismatchIsRejected()
    {
        await using var c = TestClient.InProcess();
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.InitializeAsync(major: 2));
        Assert.Equal(-33001, ex.Code);
        Assert.Equal("ProtocolMismatch", ex.ReasonCode);
    }

    [Fact]
    public async Task RequestsBeforeInitializeAreRejected()
    {
        await using var c = TestClient.InProcess();
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.RequestAsync("engine/status", new { traceId = "t" }));
        Assert.Equal(-33002, ex.Code);
    }

    [Fact]
    public async Task UntrustedWorkspaceIsRefusedWithoutLoading()
    {
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.OpenAsync(Fixtures.ShopSln, trusted: false));
        Assert.Equal(-33003, ex.Code);
        Assert.Equal("TrustRequired", ex.ReasonCode);
        var status = await c.RequestAsync("engine/status", new { traceId = "t" });
        Assert.Equal("NotStarted", status.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("solutionPath").ValueKind);
        Assert.Empty(status.GetProperty("projects").EnumerateArray());
    }

    [Fact]
    public async Task UnknownMethodIsMethodNotFound()
    {
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.RequestAsync("code/doesNotExist", new { traceId = "t" }));
        Assert.Equal(-32601, ex.Code);
    }

    [Fact]
    public async Task SemanticRequestWithoutWorkspaceIsWorkspaceNotLoaded()
    {
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        var ex = await Assert.ThrowsAsync<RpcError>(() => c.SymbolAtAsync("snap-1", @"C:\x.cs", 0, 0));
        Assert.Equal(-33006, ex.Code);
    }

    [Fact]
    public async Task MalformedJsonWithRecoverableIdGetsParseErrorAndServerKeepsWorking()
    {
        await using var c = TestClient.InProcess();
        await c.InitializeAsync();
        await c.SendRawAsync(Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"id\":4242,\"method\":\"initialize\",\"params\":{"));
        await c.SendRawAsync(Encoding.UTF8.GetBytes("this is not json at all"));
        var deadline = DateTime.UtcNow.AddSeconds(10);
        JsonElement parseError = default;
        while (DateTime.UtcNow < deadline)
        {
            if (c.Unsolicited.TryDequeue(out var msg) && msg.GetProperty("id").ValueKind == JsonValueKind.Number && msg.GetProperty("id").GetInt64() == 4242)
            {
                parseError = msg;
                break;
            }
            await Task.Delay(20);
        }
        Assert.Equal(-32700, parseError.GetProperty("error").GetProperty("code").GetInt32());
        var status = await c.RequestAsync("engine/status", new { traceId = "t" });
        Assert.Equal("NotStarted", status.GetProperty("state").GetString());
    }

    [Fact]
    public async Task OversizedFrameIsDroppedAndServerKeepsWorking()
    {
        await using var c = TestClient.InProcess(maxMessageBytes: 4096);
        await c.InitializeAsync();
        var big = JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc = "2.0", id = 99, method = "engine/status", @params = new { traceId = new string('x', 10_000) } });
        await c.SendRawAsync(big);
        var status = await c.RequestAsync("engine/status", new { traceId = "t" });
        Assert.Equal("NotStarted", status.GetProperty("state").GetString());
        Assert.DoesNotContain(c.Unsolicited, m => m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.GetInt64() == 99);
    }

    [Fact]
    public async Task ShutdownThenExitStopsTheServerWithCodeZero()
    {
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        var r = await c.RawRequestAsync("shutdown", new { traceId = "t" });
        Assert.Equal(JsonValueKind.Null, r.GetProperty("result").ValueKind);
        await c.NotifyAsync("exit", new { });
        Assert.Equal(0, await c.ServerTask!.WaitAsync(TimeSpan.FromSeconds(10)));
        await c.DisposeAsync();
    }

    [Fact]
    public async Task ExitWithoutShutdownReturnsNonZero()
    {
        var c = TestClient.InProcess();
        await c.InitializeAsync();
        await c.NotifyAsync("exit", new { });
        Assert.Equal(1, await c.ServerTask!.WaitAsync(TimeSpan.FromSeconds(10)));
        await c.DisposeAsync();
    }

    [Theory]
    [InlineData(@"E:\Temp\My Project\Program.cs", "file:///e%3A/Temp/My%20Project/Program.cs")]
    [InlineData(@"C:\src\Grüße#1.cs", "file:///c%3A/src/Gr%C3%BC%C3%9Fe%231.cs")]
    public void UrisMatchVsCodeFormatAndRoundTrip(string path, string uri)
    {
        if (!OperatingSystem.IsWindows()) return;
        Assert.Equal(uri, UriPaths.ToUri(path));
        Assert.Equal(path, UriPaths.ToPath(uri));
        Assert.Equal(path, UriPaths.ToPath(new Uri(path).AbsoluteUri));
    }
}
