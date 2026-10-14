import { STRUCTURAL_PLACEHOLDER_KINDS, type StructuralMatch, type StructuralPattern, type StructuralPlaceholder, type StructuralPlaceholderKind, type StructuralScope, type StructuralSearchResult } from '@refyntra/contracts';

// Structural Search and Replace (protocol 1.19, ADR-012): the pure model of the search panel, the saved patterns
// (workspace .refyntra/patterns.json and the user's patterns) and the results. No vscode import: unit-tested.

export const PATTERNS_FILE = '.refyntra/patterns.json';
export const PATTERN_SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
export type PatternSeverity = (typeof PATTERN_SEVERITIES)[number];
export const SCOPES: readonly StructuralScope[] = ['document', 'project', 'solution'];
export const SCOPE_TITLES: Record<StructuralScope, string> = { document: 'Current file', project: 'Current project', solution: 'Solution' };
export const DEFAULT_RESULT_LIMIT = 200;
const PLACEHOLDER_RE = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g;
const RULE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export type PatternOrigin = 'builtin' | 'workspace' | 'user';

export interface PatternInspection {
  enabled: boolean;
  severity: PatternSeverity;
  message?: string;
}

/** A saved pattern: the search text, the replacement, the placeholder constraints and (optionally) its inspection. */
export interface SavedPattern {
  id: string;
  name: string;
  text: string;
  replacement?: string;
  placeholders: StructuralPlaceholder[];
  description?: string;
  inspection?: PatternInspection;
  origin: PatternOrigin;
}

/** The built-in examples (read-only; "Save" stores a copy in the workspace or user patterns). */
export const BUILTIN_PATTERNS: readonly SavedPattern[] = [
  {
    id: 'builtin.taskResult',
    name: 'Task.Result to await',
    text: '$x$.Result',
    replacement: 'await $x$',
    placeholders: [{ name: 'x', kind: 'expression', type: 'System.Threading.Tasks.Task' }],
    description: 'Blocking .Result on a task; the replacement is refused where the method cannot await.',
    origin: 'builtin',
  },
  {
    id: 'builtin.isNullOrEmpty',
    name: 'Null or empty check',
    text: '$s$ == null || $s$ == ""',
    replacement: 'string.IsNullOrEmpty($s$)',
    placeholders: [{ name: 's', kind: 'expression', type: 'string', exactType: true }],
    description: 'The same string compared with null and "" becomes string.IsNullOrEmpty.',
    origin: 'builtin',
  },
  {
    id: 'builtin.returnCondition',
    name: 'Return the condition',
    text: 'if ($c$) return true; else return false;',
    replacement: 'return $c$;',
    placeholders: [{ name: 'c', kind: 'expression', type: 'bool', exactType: true }],
    description: 'An if/else that returns true or false returns the condition itself (braces or not).',
    origin: 'builtin',
  },
  {
    id: 'builtin.countAny',
    name: 'Count() > 0 to Any()',
    text: '$list$.Count() > 0',
    replacement: '$list$.Any()',
    placeholders: [{ name: 'list', kind: 'expression', type: 'System.Collections.Generic.IEnumerable<T>' }],
    description: 'Enumerable.Count() compared with 0 enumerates everything; Any() stops at the first element.',
    origin: 'builtin',
  },
];

/** Placeholder names of a pattern or template, in order of first use. */
export function placeholderNames(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** The placeholder table for a pattern text: one row per name in the text, keeping the settings of rows that remain. */
export function syncPlaceholders(text: string, existing: readonly StructuralPlaceholder[]): StructuralPlaceholder[] {
  return placeholderNames(text).map((name) => existing.find((p) => p.name === name) ?? { name, kind: 'any' });
}

function isKind(k: unknown): k is StructuralPlaceholderKind {
  return typeof k === 'string' && (STRUCTURAL_PLACEHOLDER_KINDS as readonly string[]).includes(k);
}

/** A placeholder from untrusted input (a patterns file, the webview), or undefined. */
export function cleanPlaceholder(raw: unknown): StructuralPlaceholder | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) return undefined;
  const p: StructuralPlaceholder = { name: r.name };
  if (isKind(r.kind)) p.kind = r.kind;
  if (typeof r.type === 'string' && r.type.trim()) p.type = r.type.trim().slice(0, 300);
  if (r.exactType === true) p.exactType = true;
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : undefined);
  const min = count(r.minCount);
  const max = count(r.maxCount);
  if (min !== undefined) p.minCount = min;
  if (max !== undefined) p.maxCount = max;
  if (typeof r.regex === 'string' && r.regex) p.regex = r.regex.slice(0, 500);
  return p;
}

/** "ORS-" + a name made of letters, digits, '_', '.', '-'. */
export function ruleIdOf(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `ORS-${slug || 'pattern'}`;
}

/** Problems that keep a pattern from being searched, replaced or saved (empty: usable). */
export function patternProblems(p: { text: string; replacement?: string; placeholders: readonly StructuralPlaceholder[]; name?: string; inspection?: PatternInspection }, need: 'search' | 'replace' | 'save'): string[] {
  const out: string[] = [];
  if (!p.text.trim()) out.push('Enter a pattern.');
  // Interpolated strings ($"…", $@"…", @$"…") are C#, not placeholders.
  const stray = p.text.replace(PLACEHOLDER_RE, '').replace(/\$@?"|@\$"/g, '"').replace(/"(?:[^"\\]|\\.)*"/g, '');
  if (stray.includes('$')) out.push('A "$" does not start a placeholder: write placeholders as $name$.');
  const names = placeholderNames(p.text);
  if (p.replacement !== undefined) {
    for (const n of placeholderNames(p.replacement)) if (!names.includes(n)) out.push(`The replacement uses $${n}$, which the pattern does not have.`);
  }
  if (need === 'replace' && (p.replacement === undefined || (!p.replacement.trim() && !/;\s*$/.test(p.text.trim())))) out.push('Enter a replacement.');
  for (const ph of p.placeholders) {
    if (ph.minCount !== undefined && ph.maxCount !== undefined && ph.minCount > ph.maxCount) out.push(`$${ph.name}$: the minimum count is larger than the maximum.`);
    if (ph.regex) {
      try {
        new RegExp(ph.regex);
      } catch {
        out.push(`$${ph.name}$: the regular expression is not valid.`);
      }
    }
  }
  if (need === 'save') {
    if (!p.name?.trim()) out.push('Enter a name.');
    else if (p.inspection?.enabled && !RULE_NAME_RE.test(ruleIdOf(p.name).slice(4))) out.push('The inspection name must use letters, digits, ".", "_" or "-".');
  }
  return out;
}

/** The protocol form of a pattern (with the inspection fields when it is an enabled inspection). */
export function toProtocol(p: { text: string; replacement?: string; placeholders: readonly StructuralPlaceholder[]; name?: string; inspection?: PatternInspection }, asInspection = false): StructuralPattern {
  const out: StructuralPattern = { text: p.text, placeholders: syncPlaceholders(p.text, p.placeholders) };
  if (p.replacement !== undefined) out.replacement = p.replacement;
  if (asInspection && p.inspection?.enabled && p.name) {
    out.ruleId = ruleIdOf(p.name);
    out.severity = p.inspection.severity;
    out.message = p.inspection.message?.trim() || `${p.name} (structural pattern ${out.ruleId})`;
    if (p.replacement !== undefined) out.fixTitle = `Replace: ${p.name}`;
  }
  return out;
}

/** The enabled inspections among the patterns, as protocol patterns (one per rule id; workspace patterns win). */
export function inspectionPatterns(patterns: readonly SavedPattern[]): StructuralPattern[] {
  const seen = new Set<string>();
  const out: StructuralPattern[] = [];
  for (const p of patterns) {
    if (!p.inspection?.enabled || patternProblems(p, 'search').length) continue;
    const id = ruleIdOf(p.name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(toProtocol(p, true));
  }
  return out;
}

/** Saved patterns from a patterns file (JSON `{ "version": 1, "patterns": [...] }`); malformed entries are reported and skipped. */
export function parsePatternsFile(text: string, origin: Exclude<PatternOrigin, 'builtin'>): { patterns: SavedPattern[]; errors: string[] } {
  const errors: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { patterns: [], errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { patterns?: unknown }).patterns) ? (json as { patterns: unknown[] }).patterns : undefined;
  if (!list) return { patterns: [], errors: ['Expected { "patterns": [ ... ] }.'] };
  const patterns: SavedPattern[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return void errors.push(`Pattern ${i + 1}: not an object.`);
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) return void errors.push(`Pattern ${i + 1}: "name" is missing.`);
    if (typeof r.text !== 'string' || !r.text.trim()) return void errors.push(`Pattern ${r.name}: "text" is missing.`);
    const placeholders = Array.isArray(r.placeholders) ? r.placeholders.map(cleanPlaceholder).filter((x): x is StructuralPlaceholder => !!x) : [];
    const p: SavedPattern = { id: `${origin}.${typeof r.id === 'string' && r.id ? r.id : ruleIdOf(r.name).slice(4)}`, name: r.name.trim().slice(0, 100), text: r.text, placeholders: syncPlaceholders(r.text, placeholders), origin };
    if (typeof r.replacement === 'string') p.replacement = r.replacement;
    if (typeof r.description === 'string' && r.description.trim()) p.description = r.description.trim().slice(0, 500);
    const insp = r.inspection as Record<string, unknown> | undefined;
    if (insp && typeof insp === 'object') {
      const severity = (PATTERN_SEVERITIES as readonly string[]).includes(insp.severity as string) ? (insp.severity as PatternSeverity) : 'warning';
      p.inspection = { enabled: insp.enabled !== false, severity, ...(typeof insp.message === 'string' && insp.message.trim() ? { message: insp.message.trim().slice(0, 300) } : {}) };
    }
    if (patterns.some((x) => x.id === p.id)) return void errors.push(`Pattern ${r.name}: the id is used twice.`);
    patterns.push(p);
  });
  return { patterns, errors };
}

/** The patterns file text (stable order and keys, so that the file diffs well). */
export function serializePatterns(patterns: readonly SavedPattern[]): string {
  const list = patterns.map((p) => ({
    id: p.id.replace(/^(workspace|user)\./, ''),
    name: p.name,
    text: p.text,
    ...(p.replacement !== undefined ? { replacement: p.replacement } : {}),
    placeholders: syncPlaceholders(p.text, p.placeholders),
    ...(p.description ? { description: p.description } : {}),
    ...(p.inspection ? { inspection: p.inspection } : {}),
  }));
  return `${JSON.stringify({ version: 1, patterns: list }, null, 2)}\n`;
}

/** Built-in, user and workspace patterns in one list (workspace first, then user, then built-in). */
export function mergePatterns(workspace: readonly SavedPattern[], user: readonly SavedPattern[]): SavedPattern[] {
  return [...workspace, ...user, ...BUILTIN_PATTERNS];
}

/** The list with `p` added or replacing the pattern of the same name. */
export function upsertPattern(list: readonly SavedPattern[], p: SavedPattern): SavedPattern[] {
  const i = list.findIndex((x) => x.id === p.id || x.name.toLowerCase() === p.name.toLowerCase());
  if (i < 0) return [...list, p];
  const out = [...list];
  out[i] = { ...p, id: list[i]!.id };
  return out;
}

export function removePattern(list: readonly SavedPattern[], id: string): SavedPattern[] {
  return list.filter((p) => p.id !== id);
}

/** A saved pattern for `origin` from the editor state. */
export function patternFromEditor(state: EditorState, name: string, origin: Exclude<PatternOrigin, 'builtin'>, inspection?: PatternInspection): SavedPattern {
  const p: SavedPattern = { id: `${origin}.${ruleIdOf(name).slice(4)}`, name: name.trim(), text: state.text, placeholders: syncPlaceholders(state.text, state.placeholders), origin };
  if (state.replacement.trim() || /;\s*$/.test(state.text.trim())) p.replacement = state.replacement;
  if (inspection) p.inspection = inspection;
  return p;
}

// ---------------------------------------------------------------- results

export interface MatchRow {
  index: number;
  line: number;
  character: number;
  preview: string;
  values: string;
}

export interface FileGroup {
  uri: string;
  label: string;
  count: number;
  rows: MatchRow[];
}

/** Matches grouped by file (in result order), each with its line preview and placeholder values. */
export function groupMatches(matches: readonly StructuralMatch[], label: (uri: string) => string): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  matches.forEach((m, index) => {
    let g = groups.get(m.uri);
    if (!g) groups.set(m.uri, (g = { uri: m.uri, label: label(m.uri), count: 0, rows: [] }));
    g.count++;
    g.rows.push({ index, line: m.range.start.line + 1, character: m.range.start.character + 1, preview: previewOf(m.lineText), values: valuesText(m.values) });
  });
  return [...groups.values()];
}

export function previewOf(line: string, max = 160): string {
  const t = line.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function valuesText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `$${k}$ = ${v}`)
    .join(', ');
}

/** "12 matches in 4 files", "200+ matches in 31 files (more available)", or the reason there are none. */
export function resultsHeadline(r: Pick<StructuralSearchResult, 'matches' | 'truncated' | 'filesWithMatches' | 'filesSearched' | 'reasonCode' | 'message'>): string {
  if (r.reasonCode) return r.message ?? 'The pattern cannot be searched.';
  const n = r.matches.length;
  const files = new Set(r.matches.map((m) => m.uri)).size;
  if (n === 0) return `No matches in ${r.filesSearched} file${r.filesSearched === 1 ? '' : 's'}.`;
  return `${n}${r.truncated ? '+' : ''} match${n === 1 && !r.truncated ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${r.truncated ? ' (more available)' : ''}.`;
}

/** The next limit of "Show more": double, at most 5000. */
export function nextResultLimit(limit: number): number {
  return Math.min(5000, Math.max(DEFAULT_RESULT_LIMIT, limit * 2));
}

// ---------------------------------------------------------------- panel

export interface EditorState {
  text: string;
  replacement: string;
  placeholders: StructuralPlaceholder[];
  scope: StructuralScope;
}

export const EMPTY_EDITOR: EditorState = { text: '', replacement: '', placeholders: [], scope: 'solution' };

export function editorFromPattern(p: SavedPattern, scope: StructuralScope): EditorState {
  return { text: p.text, replacement: p.replacement ?? '', placeholders: syncPlaceholders(p.text, p.placeholders), scope };
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'change'; editor: EditorState }
  | { type: 'search' }
  | { type: 'replaceAll' }
  | { type: 'showMore' }
  | { type: 'load'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'save'; target: 'workspace' | 'user'; name: string; inspection: boolean; severity: PatternSeverity }
  | { type: 'openMatch'; index: number }
  | { type: 'replaceMatch'; index: number };

/** One message of the webview, validated (anything malformed is undefined). */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'search':
    case 'replaceAll':
    case 'showMore':
      return { type: m.type };
    case 'load':
    case 'delete':
      return typeof m.id === 'string' && m.id.length < 200 ? { type: m.type, id: m.id } : undefined;
    case 'openMatch':
    case 'replaceMatch':
      return typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 ? { type: m.type, index: m.index } : undefined;
    case 'save': {
      if ((m.target !== 'workspace' && m.target !== 'user') || typeof m.name !== 'string') return undefined;
      const severity = (PATTERN_SEVERITIES as readonly string[]).includes(m.severity as string) ? (m.severity as PatternSeverity) : 'warning';
      return { type: 'save', target: m.target, name: m.name.slice(0, 100), inspection: m.inspection === true, severity };
    }
    case 'change': {
      const e = m.editor as Record<string, unknown> | undefined;
      if (!e || typeof e.text !== 'string' || typeof e.replacement !== 'string') return undefined;
      const scope = SCOPES.includes(e.scope as StructuralScope) ? (e.scope as StructuralScope) : 'solution';
      const rows = Array.isArray(e.placeholders) ? e.placeholders.map(cleanPlaceholder).filter((x): x is StructuralPlaceholder => !!x) : [];
      const text = e.text.slice(0, 20000);
      return { type: 'change', editor: { text, replacement: e.replacement.slice(0, 20000), placeholders: syncPlaceholders(text, rows), scope } };
    }
    default:
      return undefined;
  }
}

/** What the page renders. */
export interface PanelView {
  editor: EditorState;
  patterns: { id: string; name: string; origin: PatternOrigin; inspection: string; description: string }[];
  selectedId?: string;
  problems: string[];
  replaceProblems: string[];
  busy: boolean;
  headline: string;
  notes: string[];
  groups: FileGroup[];
  canShowMore: boolean;
  kinds: readonly string[];
  severities: readonly string[];
}

export function panelView(o: { editor: EditorState; patterns: readonly SavedPattern[]; selectedId?: string; busy: boolean; result?: StructuralSearchResult; message?: string; label: (uri: string) => string; maxRows?: number }): PanelView {
  const max = o.maxRows ?? 500;
  const matches = o.result?.matches.slice(0, max) ?? [];
  return {
    editor: o.editor,
    patterns: o.patterns.map((p) => ({ id: p.id, name: p.name, origin: p.origin, inspection: p.inspection?.enabled ? `inspection ${ruleIdOf(p.name)} (${p.inspection.severity})` : '', description: p.description ?? '' })),
    ...(o.selectedId ? { selectedId: o.selectedId } : {}),
    problems: patternProblems({ ...o.editor }, 'search'),
    replaceProblems: patternProblems({ ...o.editor }, 'replace'),
    busy: o.busy,
    headline: o.message ?? (o.result ? resultsHeadline(o.result) : 'Enter a pattern and choose Search.'),
    notes: o.result?.notes ?? [],
    groups: groupMatches(matches, o.label),
    canShowMore: !!o.result?.truncated,
    kinds: STRUCTURAL_PLACEHOLDER_KINDS,
    severities: PATTERN_SEVERITIES,
  };
}
