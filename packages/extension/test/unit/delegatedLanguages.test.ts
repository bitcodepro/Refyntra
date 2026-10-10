import { describe, expect, it } from 'vitest';
import type { AdapterHealth, HealthSummary } from '@refyntra/domain';
import { RUSTUP_URL, buildHealthPage, resolveMessage } from '../../src/healthPageModel';
import { capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import { delegatedProviderName, identifierPattern } from '../../src/renameSummary';
import { describeReason } from '../../src/terminology';

// Python and Rust delegated routes in the pure presentation layer (Health, Actions titles, rename input box).

const route = (adapterId: string, displayName: string, over: Partial<AdapterHealth> = {}): AdapterHealth => ({
  adapterId,
  providerRouteId: `${adapterId}.lsp`,
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
  it('ready: names the bundled server; no other extension is mentioned or needed', () => {
    const m = buildHealthPage({ health: h([route('python', 'Python'), route('rust', 'Rust')]) });
    expect(m.sections.map((s) => [s.icon, s.headline])).toEqual([
      ['ok', 'Python: ready (Pyright, bundled with Refyntra)'],
      ['ok', 'Rust: ready (rust-analyzer, bundled with Refyntra)'],
    ]);
    expect(m.sections[0]!.meaning).toMatch(/no other extension is needed/);
    expect(m.sections.every((s) => !s.primary)).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/extensions\.search|Install a Python language extension/);
  });

  it('cargo missing: Rust works partially, the only fix opens rustup.rs (never installs)', () => {
    const m = buildHealthPage({ health: h([route('rust', 'Rust', { state: 'Partial', reasonCode: 'CargoNotFound', message: 'cargo (the Rust toolchain) was not found.' })]) });
    const s = m.sections[0]!;
    expect(s.icon).toBe('warning');
    expect(s.headline).toMatch(/cargo/);
    expect(s.primary).toMatchObject({ id: 'installRust', arg: RUSTUP_URL });
    expect(resolveMessage(m, { type: 'action', key: s.primary!.key })?.id).toBe('installRust');
  });

  it('Restricted Mode, not started, server missing for the platform', () => {
    const m = buildHealthPage({
      health: h([route('python', 'Python', { state: 'TrustRequired', reasonCode: 'TrustRequired' }), route('rust', 'Rust', { state: 'Failed', reasonCode: 'ServerNotFound', message: 'rust-analyzer is not bundled for this platform' })]),
    });
    expect(m.sections[0]).toMatchObject({ icon: 'locked', primary: { id: 'trustWorkspace' } });
    expect(m.sections[0]!.meaning).toMatch(/Pyright/);
    expect(m.sections[1]).toMatchObject({ icon: 'error', headline: 'Rust is not available' });
    const n = buildHealthPage({ health: h([route('python', 'Python', { state: 'NotStarted', message: 'starts later' })]) });
    expect(n.sections[0]!.headline).toBe('Python: starts when you open a Python file');
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
    expect(delegatedProviderName('python.pyright')).toBe('Python');
    expect(delegatedProviderName('rust.rust-analyzer')).toBe('Rust');
    expect(delegatedProviderName('typescript.vscode-providers')).toBe('TypeScript/JavaScript');
    expect(describeReason('CargoNotFound')).toMatch(/cargo/);
    expect(describeReason('ServerNotFound')).toMatch(/bundled language server/);
  });
});
