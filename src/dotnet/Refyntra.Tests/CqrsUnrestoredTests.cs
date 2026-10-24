using System.Text.Json;
using Refyntra.Tests.Infrastructure;

namespace Refyntra.Tests;

/// <summary>
/// The CQRS layer over MediatR in a project whose packages are not restored: MediatR's types are unresolved (error types),
/// as in large solutions that load partially. Controller actions must still reach their handlers.
/// </summary>
public sealed class CqrsUnrestoredFixture : IAsyncLifetime
{
    public TestClient Client { get; private set; } = null!;
    public string Sln { get; private set; } = "";
    public string File(params string[] parts) => Path.Combine(new[] { Path.GetDirectoryName(Sln)! }.Concat(parts).ToArray());

    public async Task InitializeAsync()
    {
        Sln = await Fixtures.CopyAsync("CqrsUnrestored", "CqrsUnrestored.sln");
        Client = TestClient.InProcess();
        await Client.InitializeAsync();
        await Client.OpenAsync(Sln);
    }

    public async Task DisposeAsync() => await Client.DisposeAsync();
}

public sealed class CqrsUnrestoredTests : IClassFixture<CqrsUnrestoredFixture>
{
    private readonly CqrsUnrestoredFixture _f;
    private TestClient C => _f.Client;

    public CqrsUnrestoredTests(CqrsUnrestoredFixture f) => _f = f;

    private string Billing => _f.File("Billing.Api", "Tickets.cs");

    private static List<JsonElement> Relations(JsonElement related, string kind) =>
        related.GetProperty("relations").EnumerateArray().Where(r => r.GetProperty("relationKind").GetString() == kind).ToList();

    private static string Label(JsonElement r) => r.GetProperty("target").GetProperty("label").GetString()!;

    private async Task<JsonElement> RelatedAsync(string needle, int offset = 0, string? file = null)
    {
        var snap = await C.BarrierAsync();
        var s = await C.SymbolAtTextAsync(snap, file ?? Billing, needle, offset);
        Assert.Equal(JsonValueKind.Object, s.ValueKind);
        return await C.RelatedAsync(snap, s.GetProperty("symbolId").GetString()!);
    }

    [Fact]
    public async Task ActionsReachTheirHandlersAlthoughMediatRIsUnresolved()
    {
        static string All(JsonElement r) => string.Join(" | ", r.GetProperty("relations").EnumerateArray().Select(x => x.GetProperty("relationKind").GetString() + ":" + Label(x)));
        var get = await RelatedAsync("Get(int id)");
        Assert.True(Relations(get, "handler.handler").Count == 1, All(get));
        Assert.Equal("GetTicketQuery → GetTicketQueryHandler", Label(Relations(get, "handler.handler")[0]));
        // A handler implementing the (unresolved) IRequestHandler directly.
        var archive = await RelatedAsync("Archive(int id)");
        Assert.True(Relations(archive, "handler.handler").Count == 1, All(archive));
        Assert.Equal("ArchiveTicketCommand → ArchiveTicketCommandHandler", Label(Relations(archive, "handler.handler")[0]));
        // A generic helper of a base controller with explicit type arguments (the request inline or built first).
        var notes = _f.File("Billing.Api", "Comments.cs");
        var get2 = await RelatedAsync("Get(int ticketId)", 0, notes);
        Assert.True(Relations(get2, "handler.handler").Count == 1, All(get2));
        Assert.Equal("GetCommentsQuery → GetCommentsQueryHandler", Label(Relations(get2, "handler.handler")[0]));
        var post = await RelatedAsync("Post(int ticketId)", 0, notes);
        Assert.True(Relations(post, "handler.handler").Count == 1, All(post));
        Assert.Equal("AddCommentCommand → AddCommentCommandHandler", Label(Relations(post, "handler.handler")[0]));
        var callers = Relations(await RelatedAsync("class GetTicketQueryHandler", 6), "handler.dispatch").Select(Label).ToList();
        Assert.Contains(callers, l => l.StartsWith("Send(GetTicketQuery) in") && l.Contains("TicketsController.Get"));
    }
    [Fact]
    public async Task AHandlerDispatchingAnotherRequestLeadsToItsHandler()
    {
        static string All(JsonElement r) => string.Join(" | ", r.GetProperty("relations").EnumerateArray().Select(x => x.GetProperty("relationKind").GetString() + ":" + Label(x)));
        var chains = _f.File("Billing.Api", "Chains.cs");
        var handle = await RelatedAsync("Handle(CloseTicketCommand", 0, chains);
        var next = Relations(handle, "handler.handler").Select(Label).ToList();
        Assert.True(next.Contains("NotifyWatchersCommand → NotifyWatchersCommandHandler"), All(handle));
        // Validate(request) passes the handler's own request on: no dispatch of CloseTicketCommand.
        Assert.DoesNotContain(next, l => l.StartsWith("CloseTicketCommand", StringComparison.Ordinal));
        var callers = Relations(await RelatedAsync("class NotifyWatchersCommandHandler", 6, chains), "handler.dispatch").Select(Label).ToList();
        Assert.Contains(callers, l => l.Contains("CloseTicketCommandHandler"));
    }

    [Fact]
    public async Task AResolvedAndAnUnresolvedHandlerInterfaceOnOneClassBothCount()
    {
        static string All(JsonElement r) => string.Join(" | ", r.GetProperty("relations").EnumerateArray().Select(x => x.GetProperty("relationKind").GetString() + ":" + Label(x)));
        var chains = _f.File("Billing.Api", "Chains.cs");
        var hide = await RelatedAsync("Hide(int commentId)", 0, chains);
        Assert.True(Relations(hide, "handler.handler").Select(Label).Contains("HideCommentCommand → HideCommentHandler"), All(hide));
        var handler = await RelatedAsync("class HideCommentHandler", 6, chains);
        var requests = Relations(handler, "handler.request").Select(Label).ToList();
        Assert.True(requests.Contains("CommentAudit") && requests.Contains("HideCommentCommand"), All(handler));
    }
}
