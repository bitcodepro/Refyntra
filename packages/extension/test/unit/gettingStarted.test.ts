import { describe, expect, it } from 'vitest';
import type { AdapterHealth, HealthSummary } from '@refyntra/domain';
import { MAIN_MENU, welcomeContext } from '../../src/gettingStarted';

const cs = (over: Partial<AdapterHealth>): AdapterHealth => ({ adapterId: 'csharp', providerRouteId: 'csharp.roslyn', displayName: 'C#', state: 'Ready', recoveryActions: [], projects: [], diagnostics: [], restartCount: 0, ...over });
const h = (a: AdapterHealth, trusted = true): HealthSummary => ({ adapters: [a, { ...cs({}), adapterId: 'typescript', displayName: 'TS/JS' }], workspaceTrusted: trusted });

describe('welcome view context keys (exactly one welcome variant applies)', () => {
  it('ready / loading: the default welcome', () => {
    expect(welcomeContext(h(cs({})))).toEqual({ 'refyntra.welcome': 'ready' });
    expect(welcomeContext(h(cs({ state: 'Loading' })))).toEqual({ 'refyntra.welcome': 'ready' });
    expect(welcomeContext(h(cs({ state: 'Partial' })))).toEqual({ 'refyntra.welcome': 'ready' });
  });
  it('untrusted wins over everything else', () => {
    expect(welcomeContext(h(cs({ state: 'TrustRequired', reasonCode: 'TrustRequired' }), false))).toEqual({ 'refyntra.welcome': 'untrusted' });
    expect(welcomeContext(h(cs({ state: 'Failed' }), false))).toEqual({ 'refyntra.welcome': 'untrusted' });
  });
  it('no solution found', () => {
    expect(welcomeContext(h(cs({ state: 'NotStarted', reasonCode: 'NoSolutionFound' })))).toEqual({ 'refyntra.welcome': 'noSolution' });
  });
  it('host failed', () => {
    expect(welcomeContext(h(cs({ state: 'Failed', reasonCode: 'HostNotFound' })))).toEqual({ 'refyntra.welcome': 'hostFailed' });
    expect(welcomeContext(h(cs({ state: 'Unsupported', reasonCode: 'SdkNotFound' })))).toEqual({ 'refyntra.welcome': 'hostFailed' });
  });
  it('no C# adapter registered: default welcome', () => {
    expect(welcomeContext({ adapters: [], workspaceTrusted: true })).toEqual({ 'refyntra.welcome': 'ready' });
  });
});

describe('status bar menu', () => {
  it('lists every main command once, all Refyntra commands', () => {
    const cmds = MAIN_MENU.map((m) => m.command);
    for (const c of ['refyntra.find', 'refyntra.related', 'refyntra.actions', 'refyntra.rename', 'refyntra.showHealth', 'refyntra.selectSolution', 'refyntra.restartBackend', 'refyntra.getStarted', 'refyntra.keyboardShortcuts']) expect(cmds).toContain(c);
    expect(new Set(cmds).size).toBe(cmds.length);
    for (const m of MAIN_MENU) {
      expect(m.command).toMatch(/^refyntra\./);
      expect(m.label).toMatch(/^\$\([a-z-]+\) \S/);
    }
  });
});
