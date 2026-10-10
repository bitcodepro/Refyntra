namespace Refyntra.Host.Protocol;

// code/resolveFrame (protocol 1.4): the source symbol of a .NET stack frame (packages/contracts/src/protocol.ts).

public sealed class ResolveFrameParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public string TypeName { get; set; } = "";
    public string MethodName { get; set; } = "";
    public string? LocalFunctionName { get; set; }
    public int? MethodArity { get; set; }
    public List<string>? ParameterTypes { get; set; }
}

public sealed class FrameCandidateDto
{
    public SymbolRefDto Symbol { get; set; } = new();
    public LocationDto Location { get; set; } = new();
    public string Confidence { get; set; } = "likely";
    public string Reason { get; set; } = "";
}

public sealed class ResolveFrameResultDto
{
    public List<FrameCandidateDto> Candidates { get; set; } = new();
    public string SnapshotId { get; set; } = "";
}
