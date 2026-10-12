import type { HealthSummary } from '@refyntra/domain';
import { formatAdapterHealth, projectCounts } from '@refyntra/domain';
import { MAIN_MENU, type MenuEntry } from './gettingStarted';

// The single status bar item: its state (loading / ready / problem) and the menu it opens. Pure: unit-tested.

export type StatusKind = 'loading' | 'ready' | 'problem' | 'idle';

/**
 * Loading wins (something is on its way), then a problem (Failed, Partial, TrustRequired, Unsupported), then ready.
 * Routes that have not started (no file of their language opened yet) do not count.
 */
export function statusKind(h: HealthSummary): StatusKind {
  const states = h.adapters.map((a) => a.state);
  if (states.some((s) => s === 'Loading' || s === 'Restarting')) return 'loading';
  if (states.some((s) => s === 'Failed' || s === 'Partial' || s === 'TrustRequired' || s === 'Unsupported')) return 'problem';
  if (states.some((s) => s === 'Ready')) return 'ready';
  return 'idle';
}

/** Progress message while a route loads: "C#: loading 3/8 projects" (or the route's state). */
export function loadingMessage(h: HealthSummary): string | undefined {
  const loading = h.adapters.filter((a) => a.state === 'Loading' || a.state === 'Restarting');
  if (loading.length === 0) return undefined;
  return loading
    .map((a) => {
      const { loaded, total } = projectCounts(a);
      return total > 0 ? `${a.displayName}: loading ${loaded}/${total} projects` : `${a.displayName}: ${a.state === 'Restarting' ? 'restarting' : 'loading the solution'}`;
    })
    .join(' · ');
}

const pick = (command: string): MenuEntry | undefined => MAIN_MENU.find((m) => m.command === command);

/**
 * The status menu: a state line first (what is going on, in words), then what helps now — on a problem the fixes
 * come first (Health, Restart, Select Solution), while loading the Health page, when ready the everyday commands —
 * and then "All Refyntra commands…".
 */
export function statusMenu(h: HealthSummary): { header: string; items: MenuEntry[] } {
  const kind = statusKind(h);
  const header = h.adapters.length ? h.adapters.map(formatAdapterHealth).join(' · ') : 'No language route is active.';
  const first: string[] =
    kind === 'problem'
      ? ['refyntra.showHealth', 'refyntra.restartBackend', 'refyntra.selectSolution', 'refyntra.exportDebugBundle']
      : kind === 'loading'
        ? ['refyntra.showHealth', 'refyntra.selectSolution']
        : ['refyntra.find', 'refyntra.related', 'refyntra.actions', 'refyntra.showHealth'];
  const items = first.flatMap((c) => pick(c) ?? []);
  if (!h.workspaceTrusted) items.unshift({ label: '$(shield) Manage Workspace Trust', detail: 'Refyntra does not start the C# host in Restricted Mode', command: 'workbench.trust.manage' });
  items.push({ label: '$(list-flat) All Refyntra commands…', detail: 'Find, Related, refactorings, Task Context, Stack Trace, Health', command: 'refyntra.showMenu' });
  return { header, items };
}
