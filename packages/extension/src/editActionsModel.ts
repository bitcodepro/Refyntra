// Rider-style C# edit actions (Convert / Inline / Introduce) computed by the C# host (protocol 1.9, code/editActions).
// Pure: unit-tested with vitest (no vscode). The provider (editActions.ts) turns these into vscode.CodeAction objects.

/** Command a code action runs: computes the action on the host and applies its edits as one undo step. */
export const EDIT_ACTION_COMMAND = 'refyntra.editAction';

/** Kinds Refyntra's edit actions are reported under (prefixes of the host's `kind`). */
export const EDIT_ACTION_KINDS = ['refactor.rewrite.refyntra', 'refactor.inline.refyntra', 'refactor.extract.refyntra'] as const;

export interface EditActionItem {
  actionId: string;
  title: string;
  kind: string;
}

/** True when `requested` (the `only` filter) includes `kind`: equal, a parent of it, or a child. */
export function editKindMatches(requested: string | undefined, kind: string): boolean {
  if (!requested) return true;
  return kind === requested || kind.startsWith(`${requested}.`) || requested.startsWith(`${kind}.`);
}

/** Valid host items of the edit-action families only, filtered by `only`, in host order, without duplicates. */
export function offerEditActions(items: readonly EditActionItem[], only?: string): EditActionItem[] {
  const seen = new Set<string>();
  const out: EditActionItem[] = [];
  for (const i of items) {
    if (!i || typeof i.actionId !== 'string' || !i.actionId.startsWith('csharp.edit.') || typeof i.title !== 'string' || typeof i.kind !== 'string') continue;
    if (!EDIT_ACTION_KINDS.some((k) => i.kind === k || i.kind.startsWith(`${k}.`))) continue;
    if (!editKindMatches(only, i.kind) || seen.has(i.actionId)) continue;
    seen.add(i.actionId);
    out.push(i);
  }
  return out;
}

/** The title shown in the editor (the host's title plus the product name). */
export function editActionTitle(i: EditActionItem): string {
  return `${i.title} (Refyntra)`;
}

/** Edit action listed by the host that runs as a previewed plan (refactor/prepare csharp.introduceParameter). */
export const INTRODUCE_PARAMETER_EDIT_ACTION = 'csharp.edit.introduceParameter';
/** Command of the Introduce Parameter plan (preview, revalidation, Undo). */
export const INTRODUCE_PARAMETER_COMMAND = 'refyntra.introduceParameter';

/** One choice of a grouped action (shown in a QuickPick). */
export interface EditActionChoice {
  actionId: string;
  label: string;
}

/** One code action: a single host item, or a family of choices ("Introduce field: …") asked for with a QuickPick. */
export interface EditActionGroup {
  title: string;
  kind: string;
  actionId: string;
  choices: EditActionChoice[];
}

/**
 * Groups host items whose titles share the prefix before ": " (Introduce field: initialize in …) into one action with
 * choices; a family with one valid choice stays a single action with its full title. Host order is kept.
 */
export function groupEditActions(items: readonly EditActionItem[]): EditActionGroup[] {
  const out: EditActionGroup[] = [];
  const byTitle = new Map<string, EditActionGroup>();
  for (const i of items) {
    const at = i.title.indexOf(': ');
    if (at <= 0) {
      out.push({ title: i.title, kind: i.kind, actionId: i.actionId, choices: [] });
      continue;
    }
    const head = i.title.slice(0, at);
    const choice = { actionId: i.actionId, label: i.title.slice(at + 2) };
    const g = byTitle.get(head);
    if (g) g.choices.push(choice);
    else {
      const ng = { title: head, kind: i.kind, actionId: i.actionId, choices: [choice] };
      byTitle.set(head, ng);
      out.push(ng);
    }
  }
  return out.map((g) => (g.choices.length === 0 ? g : g.choices.length === 1 ? { title: `${g.title}: ${g.choices[0]!.label}`, kind: g.kind, actionId: g.actionId, choices: [] } : { ...g, title: `${g.title}…` }));
}

/** QuickPick items of a group's choices (the first one is the default). */
export function choicePickItems(choices: readonly EditActionChoice[]): { label: string; actionId: string }[] {
  return choices.map((c) => ({ label: c.label.charAt(0).toUpperCase() + c.label.slice(1), actionId: c.actionId }));
}

export interface EditActionTarget {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  actionId: string;
  /** Document version the action was offered for (the edits are only applied to this version). */
  version: number;
  /** Choices of a grouped action: the user picks one (QuickPick) before it is computed. */
  choices?: EditActionChoice[];
}

const isPos = (p: unknown): p is { line: number; character: number } =>
  !!p && typeof p === 'object' && Number.isInteger((p as { line?: unknown }).line) && Number.isInteger((p as { character?: unknown }).character) && (p as { line: number }).line >= 0 && (p as { character: number }).character >= 0;

/** The argument of EDIT_ACTION_COMMAND, or undefined when malformed. */
export function parseEditActionTarget(arg: unknown): EditActionTarget | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { uri?: unknown; range?: { start?: unknown; end?: unknown }; actionId?: unknown; version?: unknown; choices?: unknown };
  if (typeof a.uri !== 'string' || !a.uri.startsWith('file:') || typeof a.actionId !== 'string' || !a.actionId.startsWith('csharp.edit.')) return undefined;
  if (!a.range || !isPos(a.range.start) || !isPos(a.range.end) || !Number.isInteger(a.version)) return undefined;
  const t: EditActionTarget = { uri: a.uri, range: { start: { ...a.range.start }, end: { ...a.range.end } }, actionId: a.actionId, version: a.version as number };
  if (Array.isArray(a.choices)) {
    const choices = a.choices.filter((c): c is EditActionChoice => !!c && typeof c === 'object' && typeof (c as EditActionChoice).actionId === 'string' && (c as EditActionChoice).actionId.startsWith('csharp.edit.') && typeof (c as EditActionChoice).label === 'string');
    if (choices.length) t.choices = choices.map((c) => ({ actionId: c.actionId, label: c.label }));
  }
  return t;
}

/** Edits are applied only while the document is still the version the host computed them for. */
export function canApply(expectedVersion: number, versionBefore: number, versionAfter: number): boolean {
  return expectedVersion === versionBefore && versionBefore === versionAfter;
}

/** Keyboard commands (ReSharper preset): the action each runs at the current selection. */
export const KEYBOARD_ACTIONS: Readonly<Record<string, { actionId: string; needsSelection: boolean; label: string }>> = {
  'refyntra.introduceVariable': { actionId: 'csharp.edit.introduceVariable', needsSelection: true, label: 'Introduce Variable' },
  'refyntra.inlineVariable': { actionId: 'csharp.edit.inlineVariable', needsSelection: false, label: 'Inline Variable' },
};
