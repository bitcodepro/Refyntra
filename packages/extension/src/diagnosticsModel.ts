import type { RuleAbstention, RuleDiagnostic } from '@refyntra/contracts';

// Pure part of the rule diagnostics (no vscode import): settings, grouping and the explanation text. Unit-tested.

export type RuleLevel = 'off' | 'hint' | 'info' | 'information' | 'warning' | 'error';
/** OR1001's levels (its setting predates the inspections). */
export const RULE_LEVELS: readonly RuleLevel[] = ['off', 'information', 'warning'];
/** Levels of the inspections OR1002–OR1010 (setting `refyntra.rules.ORxxxx`). */
export const INSPECTION_LEVELS: readonly RuleLevel[] = ['off', 'hint', 'info', 'warning', 'error'];
export const RULE_SETTING_DEFAULTS: Readonly<Record<string, RuleLevel>> = {
  OR1001: 'warning',
  OR1002: 'warning',
  OR1003: 'warning',
  OR1004: 'warning',
  OR1005: 'info',
  OR1006: 'info',
  OR1007: 'info',
  OR1008: 'hint',
  OR1009: 'hint',
  OR1010: 'info',
};

/** An unknown or missing setting value falls back to the rule's default (never to a stronger level). */
export function ruleLevel(ruleId: string, configured: unknown): RuleLevel {
  // Pattern inspections (protocol 1.19, "ORS-<name>"): on unless a setting turns them off; their severity is the pattern's.
  if (ruleId.startsWith('ORS-')) return typeof configured === 'string' && (INSPECTION_LEVELS as readonly string[]).includes(configured) ? (configured as RuleLevel) : 'warning';
  const allowed = ruleId === 'OR1001' ? RULE_LEVELS : INSPECTION_LEVELS;
  if (typeof configured === 'string' && (allowed as readonly string[]).includes(configured)) return configured as RuleLevel;
  return RULE_SETTING_DEFAULTS[ruleId] ?? 'off';
}

/** The severity a level is shown with (Problems shows everything but hints). */
export function severityOf(level: RuleLevel): 'hint' | 'information' | 'warning' | 'error' | undefined {
  switch (level) {
    case 'off':
      return undefined;
    case 'hint':
      return 'hint';
    case 'info':
    case 'information':
      return 'information';
    case 'error':
      return 'error';
    default:
      return 'warning';
  }
}

/** A quick fix offered for a diagnostic: an edit action computed at the diagnostic's start. */
export interface QuickFixOffer {
  actionId: string;
  title: string;
}

export const ADD_AWAIT_FIX = 'csharp.edit.fix.addAwait';
export const DISCARD_TASK_FIX = 'csharp.edit.fix.discardTask';

/** Valid quick fixes of a Refyntra inspection result (edit actions `csharp.edit.fix.*` only, without duplicates). */
export function quickFixesOf(fixes: unknown): QuickFixOffer[] {
  if (!Array.isArray(fixes)) return [];
  const seen = new Set<string>();
  const out: QuickFixOffer[] = [];
  for (const f of fixes) {
    if (!f || typeof f.actionId !== 'string' || !f.actionId.startsWith('csharp.edit.fix.') || typeof f.title !== 'string' || seen.has(f.actionId)) continue;
    seen.add(f.actionId);
    out.push({ actionId: f.actionId, title: f.title });
  }
  return out;
}

/** Quick fixes Refyntra adds to another tool's diagnostic: the compiler's CS4014 (an unawaited call in an async method). */
export function compilerQuickFixes(code: unknown): QuickFixOffer[] {
  const value = code && typeof code === 'object' ? (code as { value?: unknown }).value : code;
  if (value !== 'CS4014') return [];
  return [
    { actionId: ADD_AWAIT_FIX, title: "Add 'await'" },
    { actionId: DISCARD_TASK_FIX, title: "Discard the task explicitly ('_ =')" },
  ];
}

/** Diagnostics per document URI, rules that are switched off removed, sorted by position. */
export function groupByUri(diagnostics: readonly RuleDiagnostic[], level: (ruleId: string) => RuleLevel): Map<string, RuleDiagnostic[]> {
  const out = new Map<string, RuleDiagnostic[]>();
  for (const d of diagnostics) {
    if (level(d.id) === 'off') continue;
    const list = out.get(d.location.uri) ?? [];
    list.push(d);
    out.set(d.location.uri, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.location.range.start.line - b.location.range.start.line || a.location.range.start.character - b.location.range.start.character);
  return out;
}

export function countByReason(abstentions: readonly RuleAbstention[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const a of abstentions) m.set(a.reason, (m.get(a.reason) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const onLine = (uri: string, line: number | undefined) => (l: { uri: string; range: { start: { line: number }; end: { line: number } } } | undefined) =>
  !!l && l.uri === uri && (line === undefined || (l.range.start.line <= line && line <= l.range.end.line));

/**
 * Markdown explanation: the proven paths (warnings) and why nothing was reported elsewhere (abstentions).
 * With `uri`/`line`, only the results whose primary location is there; otherwise everything.
 */
export function explain(diagnostics: readonly RuleDiagnostic[], abstentions: readonly RuleAbstention[], completeness: string, uri?: string, line?: number, shortPath: (u: string) => string = (u) => u): string {
  const at = uri ? onLine(uri, line) : () => true;
  const ds = diagnostics.filter((d) => at(d.location));
  const as = abstentions.filter((a) => (uri ? at(a.location) : true));
  const lines: string[] = ['# Refyntra rule analysis', '', `Scope: ${uri ? shortPath(uri) + (line !== undefined ? `:${line + 1}` : '') : 'whole workspace'} — analysis completeness: ${completeness}.`, ''];
  lines.push(`## Warnings (proven paths): ${ds.length}`, '');
  for (const d of ds) {
    lines.push(`### ${d.id} — ${shortPath(d.location.uri)}:${d.location.range.start.line + 1}`, '', d.message, '', 'Proof path:', '');
    d.relatedLocations.forEach((r, i) => lines.push(`${i + 1}. ${r.message} (${shortPath(r.location.uri)}:${r.location.range.start.line + 1})`));
    if (d.helpUri) lines.push('', `Help: ${d.helpUri}`);
    lines.push('');
  }
  lines.push(`## Not checked (abstentions): ${as.length}`, '');
  if (as.length) {
    lines.push('These are not problems. The rule could not prove a path and stays silent:', '');
    for (const [reason, n] of countByReason(as)) lines.push(`- ${reason}: ${n}`);
    lines.push('');
    for (const a of as) lines.push(`- ${a.ruleId} ${a.reason}${a.location ? ` (${shortPath(a.location.uri)}:${a.location.range.start.line + 1})` : ''}: ${a.message ?? ''}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * The severity of a pattern inspection result ("ORS-<name>"): a `refyntra.rules.ORS-<name>` setting wins, else the
 * severity saved with the pattern (the host passes it on).
 */
export function structuralSeverity(hostSeverity: unknown, configured: unknown): 'hint' | 'information' | 'warning' | 'error' | undefined {
  if (typeof configured === 'string' && (INSPECTION_LEVELS as readonly string[]).includes(configured)) return severityOf(configured as RuleLevel);
  return hostSeverity === 'error' || hostSeverity === 'hint' || hostSeverity === 'information' ? hostSeverity : 'warning';
}
