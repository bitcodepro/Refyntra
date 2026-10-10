import { afterEach, describe, expect, it } from 'vitest';
import { type DelegatedWorkspace, TS_FILES, createDelegatedWorkspace, fakeEdit, fakeUri } from '@refyntra/adapter-testing';
import { CancellationSource, CancelledError } from '@refyntra/application';
import type { RenamePreview } from '@refyntra/application';
import { PROVIDER_COMMANDS, TS_JS_DESCRIPTOR, TS_JS_ROUTE_ID } from '../src';

const ORDERS = 'file:///ws/src/orders.ts';
const USE = 'file:///ws/src/use.ts';
const VIEW = 'file:///ws/src/view.tsx';
/** Cursor on "getOrder" in its declaration. */
const AT_DECL = { uri: ORDERS, position: { line: 0, character: 18 } };
/** Cursor on the call getOrder(1) in use.ts. */
const AT_CALL = { uri: USE, position: { line: 1, character: 16 } };

let w: DelegatedWorkspace | undefined;
afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

async function make(o: Parameters<typeof createDelegatedWorkspace>[0] = {}): Promise<DelegatedWorkspace> {
  w = createDelegatedWorkspace(o);
  await w.engine.start();
  w.open(ORDERS);
  w.open(USE);
  return w;
}

async function preview(ws: DelegatedWorkspace, newName = 'fetchOrder'): Promise<RenamePreview> {
  const r = await ws.engine.prepareRename(AT_DECL, newName);
  if (r.kind !== 'preview') throw new Error(`expected a preview, got ${r.reasonCode}: ${r.message}`);
  return r;
}

describe('routing', () => {
  it('owns typescript/typescriptreact/javascript/javascriptreact documents on file: URIs only', async () => {
    const ws = await make({ withFixtureRoute: true });
    for (const [uri, lang] of [
      ['file:///ws/a.ts', 'typescript'],
      ['file:///ws/a.tsx', 'typescriptreact'],
      ['file:///ws/a.js', 'javascript'],
      ['file:///ws/a.jsx', 'javascriptreact'],
      ['file:///ws/a.mjs', undefined],
      ['file:///ws/a.cts', undefined],
    ] as const) {
      expect(ws.registry.routeFor(uri, lang)?.descriptor.providerRouteId).toBe(TS_JS_ROUTE_ID);
    }
    expect(ws.registry.routeFor('untitled:Untitled-1', 'typescript')).toBeUndefined();
    expect(ws.registry.routeFor('file:///ws/a.fixture')?.descriptor.providerRouteId).toBe('fixture.engine');
    expect(TS_JS_DESCRIPTOR.ownership).toBe('delegated');
    expect(TS_JS_DESCRIPTOR.languageIds).toEqual(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
  });

  it('health is a delegated route without a process, with a new epoch on restart', async () => {
    const ws = await make();
    const h = ws.adapter.health();
    expect(h.state).toBe('Ready');
    expect(h.message).toMatch(/completeness unknown/);
    const e1 = ws.adapter.currentEpoch();
    await ws.adapter.restart('test');
    expect(ws.adapter.currentEpoch()).not.toBe(e1);
  });
});

describe('Find', () => {
  it('returns delegated symbols of TS/JS files only, with unknown backend identity and a limitation note', async () => {
    const ws = await make();
    const r = await ws.engine.find('order');
    expect(r.items.map((i) => i.label)).toEqual(['order', 'OrderService', 'getOrder']);
    expect(r.items.every((i) => i.location!.uri.startsWith('file:///ws/src/'))).toBe(true);
    const p = r.items[0]!.provenances[0]!;
    expect(p.kind).toBe('delegated');
    if (p.kind === 'delegated') {
      expect(p.observationId).toMatch(/obs/);
      expect([p.sessionEpoch, p.snapshotId, p.projectContextId]).toEqual(['unknown', 'unknown', 'unknown']);
    }
    expect(r.items[0]!.symbol?.symbolId).toBeUndefined();
    expect(r.notes.some((n) => /completeness unknown/.test(n) && /not a complete index/.test(n))).toBe(true);
    expect(r.routeLabels?.[TS_JS_ROUTE_ID]).toBe('TS/JS (delegated)');
  });

  it('type:/member: filter by symbol kind; route:/method:/project: give nothing (C#-only filters)', async () => {
    const ws = await make();
    expect((await ws.engine.find('type: order')).items.map((i) => i.label)).toEqual(['OrderService']);
    expect((await ws.engine.find('member: order')).items.map((i) => i.label)).toEqual([]);
    expect((await ws.engine.find('route:/orders')).items).toEqual([]);
    expect((await ws.engine.find('project:Shop order')).items).toEqual([]);
  });

  it('merges with the owned route, keeps route labels and dedupes exact locations', async () => {
    const ws = await make({
      withFixtureRoute: true,
      fixtureFiles: { 'file:///ws/a.fixture': 'symbol OrderFixture\n' },
      // A provider that reports every symbol twice.
      wrapCommands: (inner) => ({
        executeCommand: async <T>(c: string, ...a: unknown[]) => {
          const v = await inner.executeCommand<unknown>(c, ...a);
          return (c === PROVIDER_COMMANDS.workspaceSymbols && Array.isArray(v) ? [...v, ...v] : v) as T;
        },
      }),
    });
    const r = await ws.engine.find('order');
    expect(r.items.map((i) => `${i.label}@${i.providerRouteId}`).sort()).toEqual([`OrderFixture@fixture.engine`, `OrderService@${TS_JS_ROUTE_ID}`, `getOrder@${TS_JS_ROUTE_ID}`, `order@${TS_JS_ROUTE_ID}`]);
    expect(r.routeLabels).toEqual({ 'fixture.engine': 'Fixture', [TS_JS_ROUTE_ID]: 'TS/JS (delegated)' });
  });

  it('drops malformed provider results instead of guessing', async () => {
    const ws = await make({
      wrapCommands: (inner) => ({
        executeCommand: async <T>(c: string, ...a: unknown[]) => {
          const v = await inner.executeCommand<unknown>(c, ...a);
          if (c !== PROVIDER_COMMANDS.workspaceSymbols) return v as T;
          return [...(v as unknown[]), null, { name: 'Broken' }, { name: 'BadRange', kind: 4, location: { uri: fakeUri(ORDERS), range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } } }] as T;
        },
      }),
    });
    expect((await ws.engine.find('order')).items.map((i) => i.label)).toEqual(['order', 'OrderService', 'getOrder']);
  });

  it('a throwing provider becomes a note, never a silent empty list', async () => {
    const ws = await make();
    ws.world.throwOn.set(PROVIDER_COMMANDS.workspaceSymbols, 'TS Server crashed');
    const r = await ws.engine.find('order');
    expect(r.items).toEqual([]);
    expect(r.notes.some((n) => n.includes('TS/JS') && n.includes('TS Server crashed'))).toBe(true);
  });
});

describe('Related', () => {
  it('declarations from the definition provider + references, delegated, no framework relations', async () => {
    const ws = await make({ withFixtureRoute: true });
    const r = await ws.engine.related(AT_CALL);
    expect(r.kind).toBe('related');
    if (r.kind !== 'related') return;
    expect(r.subject?.name).toBe('getOrder');
    expect(r.subject?.kind).toBe('method');
    expect(r.groups.map((g) => g.group)).toEqual(['declarations', 'references']);
    expect(r.groups[0]!.relations.map((x) => x.target.location?.uri)).toEqual([ORDERS]);
    // The declaration itself is not repeated as a reference.
    expect(r.groups[1]!.relations.map((x) => `${x.target.location!.uri.split('/').pop()}:${x.target.location!.range.start.line}`)).toEqual(['use.ts:0', 'use.ts:1', 'view.tsx:0']);
    expect(r.groups.flatMap((g) => g.relations).every((x) => x.provenance.kind === 'delegated' && x.limitations.length > 0)).toBe(true);
    expect(r.completeness).toBe('unknown');
    expect(r.scopeNotes.join(' ')).toMatch(/completeness unknown/);
    expect(r.scopeNotes.join(' ')).toMatch(/framework relations/i);
    expect(r.providerRouteId).toBe(TS_JS_ROUTE_ID);
    expect(r.snapshotId).toBe('unknown');
  });

  it('provider absent → ProviderUnavailable', async () => {
    const ws = await make();
    ws.world.absent = true;
    const r = await ws.engine.related(AT_CALL);
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ProviderUnavailable');
    if (r.kind === 'unavailable') expect(r.message).toMatch(/TypeScript/);
  });

  it('provider returns empty → ProviderEmpty', async () => {
    const ws = await make();
    ws.world.emptyOn.add(PROVIDER_COMMANDS.definitions);
    ws.world.emptyOn.add(PROVIDER_COMMANDS.references);
    const r = await ws.engine.related(AT_CALL);
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ProviderEmpty');
  });

  it('provider throws → ProviderError with the message; one failing provider leaves a scope note', async () => {
    const ws = await make();
    ws.world.throwOn.set(PROVIDER_COMMANDS.definitions, 'boom-def');
    ws.world.throwOn.set(PROVIDER_COMMANDS.references, 'boom-ref');
    const r = await ws.engine.related(AT_CALL);
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ProviderError');
    if (r.kind === 'unavailable') expect(r.message).toMatch(/boom-def/);
    ws.world.throwOn.delete(PROVIDER_COMMANDS.definitions);
    const partial = await ws.engine.related(AT_CALL);
    expect(partial.kind).toBe('related');
    if (partial.kind === 'related') {
      expect(partial.groups.map((g) => g.group)).toEqual(['declarations']);
      expect(partial.scopeNotes.join(' ')).toMatch(/boom-ref/);
    }
  });

  it('an edit while the provider runs makes the result stale (dropped, retried)', async () => {
    const ws = await make({ staleRetries: 0 });
    let injected = false;
    ws.world.beforeCommand = (c) => {
      if (c === PROVIDER_COMMANDS.references && !injected) {
        injected = true;
        ws.world.editBuffer(USE, `${ws.world.text(USE)}// typing\n`);
      }
    };
    const r = await ws.engine.related(AT_CALL);
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('Stale');
    expect((await ws.engine.related(AT_CALL)).kind).toBe('related');
  });

  it('cancellation rejects with CancelledError', async () => {
    const ws = await make();
    const source = new CancellationSource();
    ws.world.beforeCommand = async () => {
      source.cancel();
    };
    await expect(ws.engine.related(AT_CALL, source.token)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('Actions / availability', () => {
  it('lists delegated capabilities and framework relations as unavailable with a reason', async () => {
    const ws = await make();
    const r = await ws.engine.actions(AT_CALL);
    const byId = Object.fromEntries(r.items.map((i) => [i.capabilityId, i]));
    expect(byId['typescript.find']!.state).toBe('available');
    expect(byId['typescript.related']!.guarantee).toBe('delegated');
    expect(byId['typescript.rename']!.state).toBe('limited');
    expect(byId['typescript.rename']!.limitations.join(' ')).toMatch(/provider-managed/i);
    const fw = byId['typescript.frameworkRelations']!;
    expect(fw.state).toBe('unavailable');
    expect(fw.reasonCode).toBe('NoFrameworkModule');
    expect(fw.message).toMatch(/TypeScript\/JavaScript/);
    expect(r.items.every((i) => i.providerRouteId === TS_JS_ROUTE_ID)).toBe(true);
  });
});

describe('delegated rename', () => {
  it('prepare: a limited delegated plan with fingerprints of every affected document; apply disabled by default', async () => {
    const ws = await make();
    const r = await preview(ws);
    const plan = r.plan;
    expect(plan.kind).toBe('delegated');
    if (plan.kind !== 'delegated') return;
    expect(plan.validation).toEqual({ status: 'limited', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false });
    expect([plan.backendContext, plan.backendSnapshot, plan.semanticReadSet]).toEqual(['unknown', 'unknown', 'unknown']);
    expect(plan.coverage).toBe('provider-managed');
    expect(plan.writeSet.map((c) => c.uri)).toEqual([ORDERS, USE, VIEW]);
    for (const c of plan.writeSet) expect(c.expectedHash).toBe(ws.world.hash(c.uri));
    expect(plan.observedInputs.map((i) => i.input).sort()).toEqual([ORDERS, USE, VIEW]);
    expect(plan.title).toBe('Rename getOrder to fetchOrder');
    expect(plan.limitations.join(' ')).toMatch(/provider-managed semantic coverage/i);
    expect(r.issues).toEqual([]);
    expect(r.applyEnabled).toBe(false);
    expect((await ws.engine.applyRename(r.planId)).status).toBe('disabled');
    expect(ws.applier.applied).toEqual([]);
  });

  it('apply: needs the limited confirmation, re-asks the provider, then applies through the EditApplier', async () => {
    const ws = await make({ applyRenameEnabled: true });
    const r = await preview(ws);
    const first = await ws.engine.applyRename(r.planId);
    expect(first.status).toBe('limited');
    const renameCallsBefore = ws.world.calls.filter((c) => c === PROVIDER_COMMANDS.rename).length;
    const ok = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(ok.status, ok.message).toBe('applied');
    expect(ws.world.calls.filter((c) => c === PROVIDER_COMMANDS.rename).length).toBe(renameCallsBefore + 1);
    if (r.plan.kind === 'delegated') expect(r.plan.validation).toMatchObject({ status: 'limited', providerReprepared: true, returnedEditsMatchedPreview: true });
    expect(ws.applier.applied.sort()).toEqual([ORDERS, USE, VIEW]);
    expect(ws.world.text(USE)).toContain('fetchOrder(1)');
    expect(ws.world.text(VIEW)).toContain('fetchOrder(2)');
  });

  it('apply: the provider returns a different edit on the current state → stale, nothing applied', async () => {
    const ws = await make({ applyRenameEnabled: true });
    ws.world.renameMutator = (edit, call) => (call === 2 ? fakeEdit(edit.entries().slice(0, 1)) : edit);
    const r = await preview(ws);
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status).toBe('stale');
    expect(out.message).toMatch(/different edit/);
    expect(ws.applier.applied).toEqual([]);
  });

  it('apply: a closed target changed on disk after the preview → stale, nothing applied', async () => {
    const ws = await make({ applyRenameEnabled: true });
    const r = await preview(ws);
    ws.world.files.set(VIEW, `// changed on disk\n${ws.world.files.get(VIEW)}`);
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status).toBe('stale');
    expect(ws.applier.applied).toEqual([]);
  });

  it('apply: an editor edit after the preview ends the lease → stale without asking the provider', async () => {
    const ws = await make({ applyRenameEnabled: true });
    const r = await preview(ws);
    ws.world.editBuffer(USE, `${ws.world.text(USE)}// edited\n`);
    const calls = ws.world.calls.length;
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status).toBe('stale');
    expect(ws.world.calls.length).toBe(calls);
    expect(ws.applier.applied).toEqual([]);
  });

  it('route change (route restarted → new bridge epoch) invalidates the preview', async () => {
    const ws = await make({ applyRenameEnabled: true });
    const r = await preview(ws);
    await ws.adapter.restart('test');
    expect(ws.engine.planState(r.planId)).toBeUndefined();
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status).toBe('stale');
    expect(ws.applier.applied).toEqual([]);
  });

  it('route change (the document now belongs to another route) refuses the apply', async () => {
    const ws = await make({ applyRenameEnabled: true });
    const r = await preview(ws);
    const original = ws.registry.routeFor.bind(ws.registry);
    ws.registry.routeFor = (uri, lang) => (uri === ORDERS ? undefined : original(uri, lang));
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status).toBe('stale');
    expect(ws.applier.applied).toEqual([]);
  });

  it('a document edited during preparation → DocumentChanged', async () => {
    const ws = await make();
    ws.world.beforeCommand = (c) => {
      if (c === PROVIDER_COMMANDS.rename) ws.world.editBuffer(ORDERS, `${ws.world.text(ORDERS)}// typing\n`);
    };
    const r = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('DocumentChanged');
  });

  it('provider absent → ProviderUnavailable (no native fallback offered: there is no provider)', async () => {
    const ws = await make();
    ws.world.absent = true;
    const r = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ProviderUnavailable');
    if (r.kind === 'unavailable') expect(r.recoveryActions).toEqual([]);
  });

  it('no provider for the document as VS Code reports it (empty rename edit, no document symbols) → ProviderUnavailable', async () => {
    const ws = await make({
      wrapCommands: (inner) => ({
        executeCommand: async <T>(c: string, ...a: unknown[]) => {
          if (c === PROVIDER_COMMANDS.rename) return fakeEdit([]) as T;
          if (c === PROVIDER_COMMANDS.documentSymbols) return undefined as T;
          return inner.executeCommand<T>(c, ...a);
        },
      }),
    });
    const r = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ProviderUnavailable');
  });

  it('a rename inside a module path string (may rename a file, invisible to the public API) is refused with the native fallback', async () => {
    const ws = await make({
      wrapCommands: (inner) => ({
        executeCommand: async <T>(c: string, ...a: unknown[]) => {
          // TS answers a rename of './orders' with the file name range inside the string literal.
          if (c === PROVIDER_COMMANDS.prepareRename) return { range: { start: { line: 0, character: 28 }, end: { line: 0, character: 34 } }, placeholder: 'orders' } as T;
          return inner.executeCommand<T>(c, ...a);
        },
      }),
    });
    const r = await ws.engine.prepareRename({ uri: USE, position: { line: 0, character: 30 } }, 'sales');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('PossibleFileOperation');
    if (r.kind === 'unavailable') expect(r.recoveryActions[0]?.command).toBe('refyntra.nativeRename');
  });

  it('prepareRename refused by the provider → NotRenameable with its reason', async () => {
    const ws = await make();
    const r = await ws.engine.prepareRename({ uri: USE, position: { line: 1, character: 2 } }, 'x');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('NotRenameable');
    if (r.kind === 'unavailable') expect(r.message).toMatch(/cannot rename this element/);
  });

  it('rename provider throws → ProviderError; returns no changes → ProviderEmpty', async () => {
    const ws = await make();
    ws.world.throwOn.set(PROVIDER_COMMANDS.rename, 'tsserver exited');
    const thrown = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(thrown.kind === 'unavailable' && thrown.reasonCode).toBe('ProviderError');
    if (thrown.kind === 'unavailable') expect(thrown.message).toMatch(/tsserver exited/);
    ws.world.throwOn.clear();
    ws.world.emptyOn.add(PROVIDER_COMMANDS.rename);
    const empty = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(empty.kind === 'unavailable' && empty.reasonCode).toBe('ProviderEmpty');
  });

  it.each([
    ['resource operations', (e: ReturnType<typeof fakeEdit>) => fakeEdit(e.entries(), 1), 'ResourceOperation'],
    ['a snippet edit', (e: ReturnType<typeof fakeEdit>) => fakeEdit(e.entries().map(([u, l]) => [u, l.map((x) => ({ ...x, snippet: { value: '${1}' } }))])), 'OpaqueEdit'],
    ['an end-of-line change', (e: ReturnType<typeof fakeEdit>) => fakeEdit(e.entries().map(([u, l]) => [u, l.map((x) => ({ ...x, newEol: 2 }))])), 'OpaqueEdit'],
    ['a non-file target', (e: ReturnType<typeof fakeEdit>) => fakeEdit([...e.entries(), [fakeUri('untitled:Untitled-1'), [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }]]]), 'NonFileTarget'],
    ['an unreadable edit object', () => ({ size: 1 }) as unknown as ReturnType<typeof fakeEdit>, 'OpaqueEdit'],
  ])('refuses %s and offers the native rename (not validated by Refyntra)', async (_name, mutate, reason) => {
    const ws = await make({ applyRenameEnabled: true });
    ws.world.renameMutator = (e) => mutate(e);
    const r = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe(reason);
    if (r.kind !== 'unavailable') return;
    expect(r.recoveryActions).toEqual([{ command: 'refyntra.nativeRename', title: 'Use the editor Rename (not validated by Refyntra)', args: [AT_DECL.uri, AT_DECL.position] }]);
    expect(ws.applier.applied).toEqual([]);
  });

  it('refuses a non-UTF-8 target and a closed target with mixed line endings', async () => {
    const ws = await make();
    ws.world.notUtf8.add(VIEW);
    const enc = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(enc.kind === 'unavailable' && enc.reasonCode).toBe('UnsupportedEncoding');
    if (enc.kind === 'unavailable') expect(enc.message).toMatch(/view\.tsx/);
    ws.world.notUtf8.clear();
    ws.world.files.set(VIEW, 'const label = getOrder(2);\r\nconst again = getOrder(3);\n');
    const eol = await ws.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(eol.kind === 'unavailable' && eol.reasonCode).toBe('MixedLineEndings');
  });

  it('the plan origin is plain data even when the caller passes a vscode.Position-like object', async () => {
    const ws = await make();
    class Pos {
      private readonly c = 0;
      private readonly e = 18;
      get line() { return this.c; }
      get character() { return this.e; }
    }
    const r = await ws.engine.prepareRename({ uri: ORDERS, position: new Pos() }, 'fetchOrder');
    expect(r.kind === 'preview' && r.plan.kind === 'delegated' && r.plan.origin.position).toEqual({ line: 0, character: 18 });
  });

  it('UTF-16 positions: an emoji before the identifier', async () => {
    const files = { ...TS_FILES, 'file:///ws/src/emoji.ts': "const s = '\u{1F680}'; const v = getOrder(3);\n" };
    w = createDelegatedWorkspace({ files, applyRenameEnabled: true });
    await w.engine.start();
    w.open(ORDERS);
    const r = await w.engine.prepareRename(AT_DECL, 'fetchOrder');
    expect(r.kind).toBe('preview');
    if (r.kind !== 'preview') return;
    const ok = await w.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(ok.status, ok.message).toBe('applied');
    expect(w.world.text('file:///ws/src/emoji.ts')).toBe("const s = '\u{1F680}'; const v = fetchOrder(3);\n");
  });
});

describe('isolation from the owned route (the C# route must be unaffected)', () => {
  it('a failing TS/JS provider does not change owned results; owned plans stay owned-semantic', async () => {
    const ws = await make({ withFixtureRoute: true, fixtureFiles: { 'file:///ws/a.fixture': 'symbol GetOrder\nuse GetOrder\n' } });
    ws.world.throwOn.set(PROVIDER_COMMANDS.workspaceSymbols, 'down');
    ws.engine.documentOpened('file:///ws/a.fixture', 'fixture', 1, 'symbol GetOrder\nuse GetOrder\n', false);
    const r = await ws.engine.find('GetOrder');
    expect(r.items.map((i) => `${i.label}@${i.providerRouteId}`)).toEqual(['GetOrder@fixture.engine']);
    const p = await ws.engine.prepareRename({ uri: 'file:///ws/a.fixture', position: { line: 0, character: 9 } }, 'FetchOrder');
    expect(p.kind === 'preview' && p.plan.kind).toBe('owned-semantic');
    const rel = await ws.engine.related({ uri: 'file:///ws/a.fixture', position: { line: 0, character: 9 } });
    expect(rel.kind === 'related' && rel.providerRouteId).toBe('fixture.engine');
  });
});
