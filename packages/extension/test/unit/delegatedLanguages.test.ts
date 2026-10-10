import { describe, expect, it } from 'vitest';
import type { AdapterHealth, HealthSummary } from '@refyntra/domain';
import { buildHealthPage, resolveMessage } from '../../src/healthPageModel';
import { capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import { delegatedProviderName, identifierPattern } from '../../src/renameSummary';
import { describeReason } from '../../src/terminology';

// Python and Rust delegated routes in the pure presentation layer (Health, Actions titles, rename input box).

const route = (adapterId: string, displayName: string, over: Partial<AdapterHealth> = {}): AdapterHealth => ({
  adapterId,
  providerRouteId: `${adapterId}.vscode-providers`,
  displayName,
  state: 'Ready',
  recoveryActions: [],
  projects: [],
  diagnostics: [],
  restartCount: 0,
  ...over,
});
const h = (a: AdapterHealth[]): HealthSummary => ({ adapters: a, workspaceTrusted: true });

describe('Health page: delegated Python and Rust', () => {
  it('ready: says which installed extension answers and that Refyntra bundles none', () => {
    const m = buildHealthPage({ health: h([route('python', 'Python'), route('rust', 'Rust')]) });
    expect(m.sections.map((s) => [s.icon, s.headline])).toEqual([
      ['ok', 'Python: ready (uses the installed Python language extension)'],
      ['ok', 'Rust: ready (uses the installed rust-analyzer)'],
    ]);
    expect(m.sections[0]!.meaning).toMatch(/Pyright, basedpyright or Jedi/);
    expect(m.sections.every((s) => !s.primary)).toBe(true);
  });

  it('missing provider: a warning with one recovery that only opens the Extensions view search', () => {
    const missing = route('rust', 'Rust', {
      reasonCode: 'ProviderMissing',
      message: 'No Rust language provider answered. Install the rust-analyzer extension.',
      recoveryActions: [{ command: 'workbench.extensions.search', title: 'Install rust-analyzer', args: ['rust-analyzer'] }],
    });
    const m = buildHealthPage({ health: h([missing]) });
    const s = m.sections[0]!;
    expect(s.icon).toBe('warning');
    expect(s.headline).toBe('Rust: no language provider installed');
    expect(s.meaning).toMatch(/rust-analyzer/);
    expect(s.primary).toMatchObject({ id: 'searchExtensions', label: 'Install rust-analyzer', arg: 'rust-analyzer' });
    expect(resolveMessage(m, { type: 'action', key: s.primary!.key })?.id).toBe('searchExtensions');
  });

  it('TS/JS keeps its own headline', () => {
    const m = buildHealthPage({ health: h([route('typescript', 'TS/JS')]) });
    expect(m.sections[0]!.headline).toMatch(/^TypeScript \/ JavaScript: ready/);
  });
});

describe('Actions titles and rename input', () => {
  it('capability titles and commands for python.* and rust.*', () => {
    for (const p of ['python', 'rust']) {
      expect(capabilityTitleOf(`${p}.find`)).toMatch(/delegated/);
      expect(capabilityTitleOf(`${p}.rename`)).toMatch(/provider-managed/);
      expect(commandForCapability(`${p}.rename`)).toBe('refyntra.rename');
      expect(commandForCapability(`${p}.related`)).toBe('refyntra.related');
    }
  });

  it('identifier patterns of the input box (the route checks keywords)', () => {
    expect(identifierPattern('python').test('größe')).toBe(true);
    expect(identifierPattern('python').test('get-order')).toBe(false);
    expect(identifierPattern('rust').test('r#match')).toBe(true);
    expect(identifierPattern('rust').test("'a")).toBe(true);
    expect(identifierPattern('rust').test('a b')).toBe(false);
    expect(identifierPattern('typescript').test('$x')).toBe(true);
  });

  it('delegated rename texts name the route language', () => {
    expect(delegatedProviderName('python.vscode-providers')).toBe('Python');
    expect(delegatedProviderName('rust.vscode-providers')).toBe('Rust');
    expect(delegatedProviderName('typescript.vscode-providers')).toBe('TypeScript/JavaScript');
    expect(describeReason('ProviderMissing')).toMatch(/no language provider installed/);
  });
});
