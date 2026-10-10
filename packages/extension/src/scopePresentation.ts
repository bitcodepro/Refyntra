import type { ScopeDetails } from '@refyntra/contracts';

// Completeness notes under the Related results, in plain language (pure: unit-tested with vitest, no vscode import).
// Rules: nothing when the scope is complete; real incompleteness is never hidden; technical evidence (assembly
// identities, raw host notes) only in tooltips.

export interface ScopeLine {
  text: string;
  icon: 'warning' | 'info' | 'tools' | 'pulse';
  tooltip?: string;
  command?: { command: string; title: string; args: unknown[] };
}

export interface ScopeInput {
  completeness: 'complete' | 'partial' | 'unknown';
  scopeNotes: readonly string[];
  scopeDetails?: ScopeDetails | undefined;
  /** Notes not covered by scopeDetails (framework adapter failures). */
  additionalNotes: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function causeSummary(d: ScopeDetails): string[] {
  const c = d.causes;
  const out: string[] = [];
  if (c.missingAssets > 0) out.push('NuGet packages not restored');
  if (c.missingPackages > 0) out.push('NuGet packages missing');
  if (c.missingProjectReferences > 0) out.push(c.missingProjectReferences === 1 ? 'referenced project not found' : 'referenced projects not found');
  if (c.loadFailures > 0) out.push(`${plural(c.loadFailures, 'project')} failed to load`);
  if (c.otherErrors > 0) out.push('project load errors');
  return out;
}

export function scopeLines(o: ScopeInput, opts: { trusted: boolean }): ScopeLine[] {
  const lines: ScopeLine[] = [];
  const d = o.scopeDetails;
  const showHealth: ScopeLine = { text: 'Show Health', icon: 'pulse', tooltip: 'Open the Refyntra health page: every project and its load diagnostics.', command: { command: 'refyntra.showHealth', title: 'Show Health', args: [] } };
  const incomplete = d ? d.projectsComplete < d.projectsTotal : false;
  if (d && incomplete) {
    const affected = d.projectsTotal - d.projectsComplete;
    const how = d.projectsFailed === 0 ? 'loaded only partially' : d.projectsPartial === 0 ? 'not loaded' : 'not loaded completely';
    const causes = causeSummary(d);
    const tooltip = [
      `${d.projectsComplete} of ${d.projectsTotal} projects loaded completely; ${d.projectsPartial} loaded partially, ${d.projectsFailed} not loaded.`,
      'Relations found in or through these projects may be missing or shown with lower confidence.',
      d.restoreRecommended ? 'Recovery: run "dotnet restore" for the solution, then the backend reloads it.' : 'See the health page for the load diagnostics of each project.',
    ].join('\n');
    lines.push({ text: `Results may be incomplete: ${affected} of ${d.projectsTotal} projects ${how}${causes.length ? ` (${causes.join(', ')})` : ''}`, icon: 'warning', tooltip });
    if (d.restoreRecommended && opts.trusted && d.solutionPath) {
      lines.push({ text: 'Run dotnet restore', icon: 'tools', tooltip: `dotnet restore "${d.solutionPath}" (runs in a terminal)`, command: { command: 'refyntra.runRestore', title: 'Run dotnet restore', args: [d.solutionPath] } });
    }
    lines.push(showHealth);
  } else if (o.completeness !== 'complete') {
    lines.push({ text: `Results may be incomplete (search scope ${o.completeness})`, icon: 'warning', ...(o.scopeNotes.length ? { tooltip: o.scopeNotes.join('\n') } : {}) });
  }
  if (d) {
    const limited = d.frameworks.filter((f) => !f.versionVerified);
    if (limited.length) {
      lines.push({
        text: `${limited.map((f) => f.name).join(' and ')}: relations shown as likely (version not verified)`,
        icon: 'info',
        tooltip: ['Refyntra verified its analysis against other versions of this framework, so these relations are marked "likely" instead of "proven".', ...limited.map((f) => `${f.name}: ${f.evidence}`)].join('\n'),
      });
    }
    for (const n of o.additionalNotes) lines.push({ text: n, icon: 'info' });
  } else {
    for (const n of o.scopeNotes) lines.push({ text: n, icon: 'info' });
  }
  return lines;
}
