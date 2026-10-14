namespace Refyntra.Host.Protocol;

// code/structuralSearch and code/structuralReplace (protocol 1.19): structural search and replace (ADR-012,
// packages/contracts/src/protocol.ts).

public sealed class StructuralPlaceholderDto
{
    public string Name { get; set; } = "";
    /// <summary>"any" (default), "expression", "statement", "identifier", "type", "argument", "member".</summary>
    public string? Kind { get; set; }
    /// <summary>The expression's type is this type or derives from / implements it ("System.Threading.Tasks.Task", "IEnumerable&lt;T&gt;").</summary>
    public string? Type { get; set; }
    public bool ExactType { get; set; }
    public int? MinCount { get; set; }
    public int? MaxCount { get; set; }
    /// <summary>The matched text (an identifier's name) must match this whole regular expression.</summary>
    public string? Regex { get; set; }
}

public sealed class StructuralPatternDto
{
    public string Text { get; set; } = "";
    public List<StructuralPlaceholderDto> Placeholders { get; set; } = new();
    public string? Replacement { get; set; }
    /// <summary>Namespaces the pattern and the replacement use (default: System, System.Collections.Generic, System.Linq, System.Threading.Tasks).</summary>
    public List<string>? Imports { get; set; }
    /// <summary>Pattern inspections (analysis/run): the rule id "ORS-name", its severity and message.</summary>
    public string? RuleId { get; set; }
    public string? Severity { get; set; }
    public string? Message { get; set; }
    /// <summary>The quick fix title (default: "Replace with pattern replacement").</summary>
    public string? FixTitle { get; set; }
}

public sealed class StructuralSearchParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public StructuralPatternDto Pattern { get; set; } = new();
    /// <summary>"document" | "project" | "solution" (document and project are around <see cref="Uri"/>).</summary>
    public string Scope { get; set; } = "solution";
    public string? Uri { get; set; }
    /// <summary>At most this many matches (default 200, at most 5000); "show more" asks again with a larger limit.</summary>
    public int Limit { get; set; } = 200;
}

public sealed class StructuralMatchDto
{
    public string Uri { get; set; } = "";
    public RangeDto Range { get; set; } = new();
    public string LineText { get; set; } = "";
    /// <summary>What each placeholder matched (shortened to one line).</summary>
    public Dictionary<string, string> Values { get; set; } = new();
}

public sealed class StructuralSearchResultDto
{
    /// <summary>"expression" | "statements" | "members"; null when the pattern is invalid (see reasonCode / message).</summary>
    public string? PatternKind { get; set; }
    public List<StructuralMatchDto> Matches { get; set; } = new();
    public bool Truncated { get; set; }
    public int FilesSearched { get; set; }
    public int FilesWithMatches { get; set; }
    public List<string> Notes { get; set; } = new();
    public string? ReasonCode { get; set; }
    public string? Message { get; set; }
    public long ElapsedMs { get; set; }
    public string SnapshotId { get; set; } = "";
}

/// <summary>One match to replace: its document and start (from a code/structuralSearch result).</summary>
public sealed class StructuralMatchRefDto
{
    public string Uri { get; set; } = "";
    public PositionDto Start { get; set; } = new();
}

/// <summary>code/structuralReplace: answers like refactor/prepare (a plan of action csharp.structuralReplace).</summary>
public sealed class StructuralReplaceParams : WorkspaceParams
{
    public string SnapshotId { get; set; } = "";
    public StructuralPatternDto Pattern { get; set; } = new();
    public string Scope { get; set; } = "solution";
    public string? Uri { get; set; }
    /// <summary>Only these matches (absent: every match of the scope).</summary>
    public List<StructuralMatchRefDto>? Matches { get; set; }
}
