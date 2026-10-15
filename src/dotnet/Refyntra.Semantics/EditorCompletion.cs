using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Tags;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Semantics;

/// <summary>One completion item as the editor shows it (protocol 1.22, code/completion).</summary>
public sealed record CompletionEntry(string Label, string? LabelDetail, string InsertText, string Kind, string SortText, string FilterText, bool Preselect, int Index);

public sealed record CompletionModel(string ListId, LinePositionSpan Span, List<CompletionEntry> Items);

/// <summary>What resolving an item adds: its description and the edits besides the inserted text (a using directive).</summary>
public sealed record CompletionDetail(string? Documentation, string? Detail, string? NewText, LinePositionSpan? Span, List<(LinePositionSpan Span, string NewText)> AdditionalEdits);

/// <summary>
/// C# completion of the editor from Roslyn's CompletionService (the one Visual Studio uses): members, locals, types,
/// keywords, overrides, types of namespaces not imported yet (the using directive is added on commit). The last list
/// of each document is kept so an item can be resolved (description, extra edits) when the editor selects it.
/// </summary>
public static class EditorCompletion
{
    private sealed record Kept(Document Document, CompletionList List);

    private static readonly ConcurrentDictionary<string, Kept> Lists = new();
    private static long _next;

    public static async Task<CompletionModel?> ComputeAsync(Document doc, LinePosition at, char? triggerCharacter, CancellationToken ct)
    {
        var service = CompletionService.GetService(doc);
        if (service == null) return null;
        var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
        if (at.Line >= text.Lines.Count) return null;
        var line = text.Lines[at.Line];
        var position = Math.Min(line.Start + at.Character, line.End);
        var trigger = triggerCharacter is { } ch ? CompletionTrigger.CreateInsertionTrigger(ch) : CompletionTrigger.Invoke;
        if (triggerCharacter != null && !service.ShouldTriggerCompletion(text, position, trigger)) return new CompletionModel("", new LinePositionSpan(at, at), new());
        var list = await service.GetCompletionsAsync(doc, position, trigger, cancellationToken: ct).ConfigureAwait(false);
        var id = "cl-" + Interlocked.Increment(ref _next);
        // Only the newest list of a document is kept (the editor asks again on the next keystroke anyway).
        foreach (var key in Lists.Where(kv => kv.Value.Document.Id == doc.Id).Select(kv => kv.Key).ToList()) Lists.TryRemove(key, out _);
        Lists[id] = new Kept(doc, list);
        var items = new List<CompletionEntry>(list.ItemsList.Count);
        for (var i = 0; i < list.ItemsList.Count; i++)
        {
            var item = list.ItemsList[i];
            var label = item.DisplayTextPrefix + item.DisplayText + item.DisplayTextSuffix;
            items.Add(new CompletionEntry(label, string.IsNullOrEmpty(item.InlineDescription) ? null : item.InlineDescription, item.DisplayText,
                KindOf(item.Tags), item.SortText, item.FilterText, item.Rules.MatchPriority > 0 && i == 0, i));
        }
        return new CompletionModel(id, text.Lines.GetLinePositionSpan(list.Span), items);
    }

    public static async Task<CompletionDetail?> ResolveAsync(string listId, int index, CancellationToken ct)
    {
        if (!Lists.TryGetValue(listId, out var kept) || index < 0 || index >= kept.List.ItemsList.Count) return null;
        var service = CompletionService.GetService(kept.Document);
        if (service == null) return null;
        var item = kept.List.ItemsList[index];
        var text = await kept.Document.GetTextAsync(ct).ConfigureAwait(false);
        var description = await service.GetDescriptionAsync(kept.Document, item, cancellationToken: ct).ConfigureAwait(false);
        var change = await service.GetChangeAsync(kept.Document, item, commitCharacter: null, ct).ConfigureAwait(false);
        string? newText = null;
        LinePositionSpan? span = null;
        var additional = new List<(LinePositionSpan, string)>();
        // The change of the item: the part over the completion span replaces the typed word, the rest (a using) goes before.
        var listSpan = kept.List.Span;
        foreach (var c in change.TextChanges)
        {
            if (c.Span.End >= listSpan.Start && c.Span.Start <= listSpan.End && newText == null)
            {
                newText = c.NewText;
                span = text.Lines.GetLinePositionSpan(c.Span);
            }
            else additional.Add((text.Lines.GetLinePositionSpan(c.Span), c.NewText ?? ""));
        }
        var parts = description?.TaggedParts ?? default;
        var detail = parts.IsDefaultOrEmpty ? null : string.Concat(parts.Select(p => p.Text));
        string? docs = null;
        if (detail != null)
        {
            var nl = detail.IndexOf('\n');
            if (nl > 0)
            {
                docs = detail[(nl + 1)..].Trim();
                detail = detail[..nl].Trim();
            }
        }
        return new CompletionDetail(string.IsNullOrEmpty(docs) ? null : docs, detail, newText, span, additional);
    }

    private static string KindOf(IReadOnlyList<string> tags)
    {
        foreach (var t in tags)
        {
            switch (t)
            {
                case WellKnownTags.Method or WellKnownTags.ExtensionMethod: return "method";
                case WellKnownTags.Property: return "property";
                case WellKnownTags.Field: return "field";
                case WellKnownTags.Constant: return "constant";
                case WellKnownTags.Local or WellKnownTags.RangeVariable: return "variable";
                case WellKnownTags.Parameter: return "variable";
                case WellKnownTags.Class: return "class";
                case WellKnownTags.Interface: return "interface";
                case WellKnownTags.Structure: return "struct";
                case WellKnownTags.Enum: return "enum";
                case WellKnownTags.EnumMember: return "enumMember";
                case WellKnownTags.Delegate: return "class";
                case WellKnownTags.Event: return "event";
                case WellKnownTags.Namespace: return "module";
                case WellKnownTags.Keyword: return "keyword";
                case WellKnownTags.TypeParameter: return "typeParameter";
                case WellKnownTags.Snippet: return "snippet";
                case WellKnownTags.Operator: return "operator";
            }
        }
        return "text";
    }
}
