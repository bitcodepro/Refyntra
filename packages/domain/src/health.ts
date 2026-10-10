import type { AdapterState, LoadDiagnostic, ProjectContextInfo, RecoveryAction } from '@refyntra/contracts';

/** Health of one adapter route: kept per adapter and per project, never one global red light. */
export interface AdapterHealth {
  adapterId: string;
  providerRouteId: string;
  /** Short user-facing name, e.g. "C#". */
  displayName: string;
  state: AdapterState;
  reasonCode?: string;
  message?: string;
  recoveryActions: RecoveryAction[];
  /** The backend's recovery text for a startup failure (e.g. the .NET SDK download link and global.json advice). */
  recoveryHint?: string;
  sessionEpoch?: string;
  sdk?: { version: string | null; path: string | null };
  solutionPath?: string | null;
  projects: ProjectContextInfo[];
  diagnostics: LoadDiagnostic[];
  restartCount: number;
  /** Host launch description (no environment values). */
  hostDescription?: string;
  /** Backend engine version and protocol from `initialize` (debug bundle, Health). */
  backend?: { engineVersion?: string; protocol: string };
  /** Duration of the last backend start (spawn → workspace/open answered), in ms. */
  lastLoadDurationMs?: number;
}

export interface HealthSummary {
  adapters: AdapterHealth[];
  workspaceTrusted: boolean;
}

export function projectCounts(h: AdapterHealth): { loaded: number; total: number } {
  const total = h.projects.length;
  const loaded = h.projects.filter((p) => p.state === 'loaded').length;
  return { loaded, total };
}

/** e.g. "C#: Partial, 7/8 projects" or "C#: TrustRequired". */
export function formatAdapterHealth(h: AdapterHealth): string {
  const { loaded, total } = projectCounts(h);
  if ((h.state === 'Ready' || h.state === 'Partial') && total > 0) {
    return `${h.displayName}: ${h.state}, ${loaded}/${total} projects`;
  }
  return `${h.displayName}: ${h.state}`;
}

/** Status bar text: "Refyntra: C# Ready" / "Refyntra: C# Partial 7/8". */
export function formatStatusBar(summary: HealthSummary): string {
  if (summary.adapters.length === 0) return 'Refyntra: no adapters';
  const parts = summary.adapters.map((h) => {
    const { loaded, total } = projectCounts(h);
    if (h.state === 'Partial' && total > 0) return `${h.displayName} Partial ${loaded}/${total}`;
    return `${h.displayName} ${h.state}`;
  });
  return `Refyntra: ${parts.join(' · ')}`;
}

const SEVERITY: Record<AdapterState, number> = {
  Ready: 0,
  NotStarted: 1,
  Loading: 1,
  Restarting: 2,
  Partial: 2,
  Unsupported: 2,
  TrustRequired: 2,
  Failed: 3,
};

/** Worst state across adapters (for status bar colour); a single failure does not hide others' states. */
export function worstState(summary: HealthSummary): AdapterState | undefined {
  let worst: AdapterState | undefined;
  for (const a of summary.adapters) if (!worst || SEVERITY[a.state] > SEVERITY[worst]) worst = a.state;
  return worst;
}

/** Whether semantic requests can be issued to an adapter in this state. */
export function acceptsSemanticRequests(state: AdapterState): boolean {
  return state === 'Ready' || state === 'Partial';
}
