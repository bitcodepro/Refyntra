using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Refyntra.Host.Protocol;
using Refyntra.Refactorings;
using Refyntra.Refactorings.Structural;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>
/// Structural search and replace (protocol 1.19, ADR-012): code/structuralSearch, code/structuralReplace (a plan of
/// action csharp.structuralReplace, applied like every other plan), pattern inspections in analysis/run
/// (<c>structuralPatterns</c>: rule ids "ORS-name") and their quick fixes (edit actions "csharp.edit.fix.structural.ORS-name",
/// also through Fix in scope).
/// </summary>
public sealed partial class Engine
{
    private static readonly Regex RuleIdRx = new(@"^ORS-[A-Za-z0-9_.\-]{1,64}$", RegexOptions.CultureInvariant);
    /// <summary>The pattern inspections of the latest analysis/run, by rule id (their quick fixes look them up).</summary>
    private readonly ConcurrentDictionary<string, PatternSpec> _structuralRules = new(StringComparer.Ordinal);

    internal static PatternSpec ToSpec(StructuralPatternDto p) => new(
        p.Text ?? "",
        (p.Placeholders ?? new()).Where(x => x != null && !string.IsNullOrEmpty(x.Name))
            .Select(x => new PlaceholderSpec(x.Name, x.Kind, string.IsNullOrWhiteSpace(x.Type) ? null : x.Type, x.ExactType, x.MinCount, x.MaxCount, string.IsNullOrEmpty(x.Regex) ? null : x.Regex)).ToList(),
        p.Replacement,
        p.Imports is { Count: > 0 } i ? i : null);

    private static string KindName(PatternKind k) => k switch { PatternKind.Expression => "expression", PatternKind.Statements => "statements", _ => "members" };

    private async Task<StructuralSearchResultDto> StructuralSearchAsync(StructuralSearchParams p, CancellationToken ct)
    {
        var snap = RequireSnapshot(p.WorkspaceId, p.SnapshotId);
        var result = new StructuralSearchResultDto { SnapshotId = snap.Id };
        try
        {
            var o = await StructuralSearch.SearchAsync(snap, ToSpec(p.Pattern ?? new()), p.Scope ?? "solution", p.Uri != null ? PathOf(p.Uri) : null, p.Limit, ct).ConfigureAwait(false);
            result.PatternKind = KindName(o.Kind);
            result.Truncated = o.Truncated;
            result.FilesSearched = o.FilesSearched;
            result.FilesWithMatches = o.FilesWithMatches;
            result.Notes = o.Notes.ToList();
            result.ElapsedMs = o.ElapsedMs;
            result.Matches = o.Hits.Select(h => new StructuralMatchDto { Uri = UriPaths.ToUri(h.Path), Range = ToRange(h.Range), LineText = h.LineText, Values = h.Values.ToDictionary(kv => kv.Key, kv => kv.Value) }).ToList();
        }
        catch (PatternException ex)
        {
            result.ReasonCode = ex.Reason;
            result.Message = ex.Message;
        }
        return result;
    }

    /// <summary>code/structuralReplace is refactor/prepare of action csharp.structuralReplace with these params.</summary>
    private Task<PrepareResultDto> StructuralReplaceAsync(StructuralReplaceParams p, CancellationToken ct) =>
        PrepareAsync(new PrepareParams { TraceId = p.TraceId, WorkspaceId = p.WorkspaceId, SnapshotId = p.SnapshotId, ActionId = StructuralReplace.ActionId, Structural = p }, ct);

    private Task<RenameOutcome> PrepareStructuralAsync(Refyntra.Workspaces.Snapshot snap, StructuralReplaceParams? p, CancellationToken ct)
    {
        if (p == null) return Task.FromResult(RenameOutcome.Unavailable("InvalidParams", "Structural replace needs a pattern."));
        var only = p.Matches?.Select(m => new StructuralReplace.MatchRef(PathOf(m.Uri), new(m.Start.Line, m.Start.Character))).ToList();
        return StructuralReplace.PrepareAsync(snap, ToSpec(p.Pattern ?? new()), p.Scope ?? "solution", p.Uri != null ? PathOf(p.Uri) : null, only, ct);
    }

    /// <summary>Fix in scope of a pattern inspection's quick fix: the pattern replaced in the document, project or solution.</summary>
    private Task<RenameOutcome>? PrepareStructuralFixAll(Refyntra.Workspaces.Snapshot snap, string path, string actionId, string scope, CancellationToken ct)
    {
        if (!actionId.StartsWith(StructuralReplace.FixPrefix, StringComparison.Ordinal)) return null;
        if (!_structuralRules.TryGetValue(actionId.Substring(StructuralReplace.FixPrefix.Length), out var spec))
            return Task.FromResult(RenameOutcome.Unavailable("UnknownRule", "The pattern inspection is no longer active; run the inspections again."));
        return StructuralReplace.PrepareAsync(snap, spec, scope, path, null, ct);
    }

    /// <summary>The quick fix of a pattern inspection (code/editActions), or null for other actions.</summary>
    private Task<EditActionOutcome>? StructuralFix(Refyntra.Workspaces.Snapshot snap, string path, Microsoft.CodeAnalysis.Text.LinePosition at, string actionId, CancellationToken ct)
    {
        if (!actionId.StartsWith(StructuralReplace.FixPrefix, StringComparison.Ordinal)) return null;
        if (!_structuralRules.TryGetValue(actionId.Substring(StructuralReplace.FixPrefix.Length), out var spec))
            return Task.FromResult(EditActionOutcome.Refused("UnknownRule", "The pattern inspection is no longer active; run the inspections again."));
        return StructuralReplace.ComputeFixAsync(snap, path, at, spec, ct);
    }

    /// <summary>Pattern inspections of analysis/run on the requested documents: every match is a diagnostic of rule "ORS-name".</summary>
    private async Task AddStructuralInspectionsAsync(Refyntra.Workspaces.Snapshot snap, IReadOnlyList<Document> docs, List<StructuralPatternDto>? patterns, AnalysisRunResultDto result, CancellationToken ct)
    {
        if (patterns == null) return;
        foreach (var p in patterns)
        {
            ct.ThrowIfCancellationRequested();
            if (p?.RuleId is not { } ruleId || !RuleIdRx.IsMatch(ruleId))
            {
                result.Abstentions.Add(new RuleAbstentionDto { RuleId = p?.RuleId ?? "ORS-", Reason = "InvalidRuleId", Message = "A pattern inspection needs a rule id ORS-<name> (letters, digits, '_', '.', '-')." });
                continue;
            }
            var spec = ToSpec(p);
            ParsedPattern parsed;
            try
            {
                parsed = ParsedPattern.Parse(spec);
                if (spec.Replacement != null) _ = new StructuralReplace.Template(parsed);
            }
            catch (PatternException ex)
            {
                result.Abstentions.Add(new RuleAbstentionDto { RuleId = ruleId, Reason = ex.Reason, Message = ex.Message });
                continue;
            }
            _structuralRules[ruleId] = spec;
            var binder = new StructuralSearch.Binder(parsed);
            var severity = p.Severity is "error" or "warning" or "information" or "hint" ? p.Severity : p.Severity == "info" ? "information" : "warning";
            foreach (var doc in docs)
            {
                List<StructuralMatch> matches;
                try
                {
                    matches = await StructuralSearch.MatchDocumentAsync(snap, doc, binder, ct).ConfigureAwait(false);
                }
                catch (PatternException ex)
                {
                    result.Abstentions.Add(new RuleAbstentionDto { RuleId = ruleId, Reason = ex.Reason, Message = ex.Message });
                    break;
                }
                foreach (var m in matches)
                {
                    var loc = Mapper.Location(Location.Create(m.Nodes[0].SyntaxTree, m.Span));
                    if (loc == null) continue;
                    result.Diagnostics.Add(new RuleDiagnosticDto
                    {
                        Id = ruleId,
                        Severity = severity!,
                        Message = string.IsNullOrWhiteSpace(p.Message) ? $"Matches the pattern {ruleId}" : p.Message!,
                        Location = loc,
                        Confidence = "proven",
                        Completeness = "complete",
                        Fixes = spec.Replacement == null ? new() : new() { new RuleFixDto { ActionId = StructuralReplace.FixPrefix + ruleId, Title = string.IsNullOrWhiteSpace(p.FixTitle) ? "Replace with the pattern's replacement" : p.FixTitle! } },
                    });
                }
            }
        }
    }
}
