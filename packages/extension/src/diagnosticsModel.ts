import type { RuleAbstention, RuleDiagnostic } from '@refyntra/contracts';

// Pure part of the rule diagnostics (no vscode import): settings, grouping and the explanation text. Unit-tested.

export type RuleLevel = 'off' | 'information' | 'warning';
export const RULE_LEVELS: readonly RuleLevel[] = ['off', 'information', 'warning'];
export const RULE_SETTING_DEFAULTS: Readonly<Record<string, RuleLevel>> = { OR1001: 'warning' };

/** An unknown or missing setting value falls back to the rule's default (never to a stronger level). */
export function ruleLevel(ruleId: string, configured: unknown): RuleLevel {
  if (typeof configured === 'string' && (RULE_LEVELS as readonly string[]).includes(configured)) return configured as RuleLevel;
  return RULE_SETTING_DEFAULTS[ruleId] ?? 'off';
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
