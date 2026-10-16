// Change Impact: what a change reaches, grouped for the Impact view. Pure (no vscode import).

import type { ChangeImpactResult, Location } from '@refyntra/contracts';

export interface ImpactEntry {
  label: string;
  /** The changed symbol it was found from. */
  via: string;
  location?: Location;
  confidence: string;
}

export interface ImpactGroup {
  id: string;
  label: string;
  icon: string;
  entries: ImpactEntry[];
}

const GROUPS: readonly { id: string; label: string; icon: string }[] = [
  { id: 'handlers', label: 'Handlers', icon: 'symbol-event' },
  { id: 'callers', label: 'Callers', icon: 'call-incoming' },
  { id: 'endpoints', label: 'Endpoints', icon: 'globe' },
  { id: 'data', label: 'Data (EF Core)', icon: 'database' },
  { id: 'registrations', label: 'DI registrations', icon: 'plug' },
  { id: 'implementations', label: 'Implementations', icon: 'symbol-class' },
  { id: 'references', label: 'Uses', icon: 'references' },
];

/** The groups of the Impact view in a fixed order (empty groups left out); tests come separately. */
export function impactGroups(r: ChangeImpactResult): ImpactGroup[] {
  const out: ImpactGroup[] = [];
  for (const g of GROUPS) {
    const entries = r.relations
      .filter((x) => x.relation.group === g.id)
      .map((x) => ({
        label: x.relation.target.label,
        via: x.via,
        ...(x.relation.target.location ?? x.relation.target.endpoint?.location ?? x.relation.target.symbol?.location ? { location: (x.relation.target.location ?? x.relation.target.endpoint?.location ?? x.relation.target.symbol?.location)! } : {}),
        confidence: x.relation.confidence,
      }));
    if (entries.length) out.push({ ...g, entries });
  }
  return out;
}

/** The changed C# files of a working tree from `git status --porcelain` output (added, modified, renamed, untracked). */
export function changedCSharpFiles(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status.includes('D')) continue;
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4);
    file = file.replace(/^"(.*)"$/, '$1');
    if (/\.(cs|razor|cshtml)$/i.test(file)) out.push(file);
  }
  return out;
}

/** "3 changed symbols · 5 uses · 2 tests" for the view's message. */
export function impactSummary(r: ChangeImpactResult): string {
  const parts = [`${r.changed.length} changed symbol${r.changed.length === 1 ? '' : 's'}`, `${r.relations.length} relation${r.relations.length === 1 ? '' : 's'}`, `${r.tests.length} test${r.tests.length === 1 ? '' : 's'}`];
  return parts.join(' · ') + (r.truncated ? ' · cut at a limit: the impact may be larger' : '');
}
