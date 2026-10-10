import assert from 'node:assert/strict';
import { PROVIDER_COMMANDS, TS_JS_ROUTE_ID } from '@refyntra/adapter-vscode-providers';
import { CancellationSource, CancelledError } from '@refyntra/application';
import { type DelegatedWorkspace, type DelegatedWorkspaceOptions, TS_FILES, createDelegatedWorkspace } from './delegatedHarness';
import { fakeUri } from './fakeProviders';

const ORDERS = 'file:///ws/src/orders.ts';
const USE = 'file:///ws/src/use.ts';
const AT_DECL = { uri: ORDERS, position: { line: 0, character: 18 } };
const AT_CALL = { uri: USE, position: { line: 1, character: 16 } };

export interface DelegatedConformanceCase {
  name: string;
  run(): Promise<void>;
}

async function withWorkspace(extra: DelegatedWorkspaceOptions, fn: (w: DelegatedWorkspace) => Promise<void>): Promise<void> {
  const w = createDelegatedWorkspace({ withFixtureRoute: true, fixtureFiles: { 'file:///ws/a.fixture': 'symbol GetOrder\n' }, ...extra });
  try {
    await w.engine.start();
    w.open(ORDERS);
    w.open(USE);
    await fn(w);
  } finally {
    await w.dispose();
  }
}

/**
 * The cases of the adapter conformance suite that apply to a delegated route, run through
 * the same RefyntraEngine use cases with the real DelegatedProviderAdapter over a fake of VS Code's public provider
 * commands. Not applicable: transport framing, backend barrier/replay, TrustRequired (no Refyntra process).
 */
export const delegatedConformanceCases: DelegatedConformanceCase[] = [
  {
    name: 'Find sees the symbol with delegated provenance and stable order',
    run: () =>
      withWorkspace({}, async (w) => {
        const r = await w.engine.find('getorder');
        const ts = r.items.filter((i) => i.providerRouteId === TS_JS_ROUTE_ID);
        assert.deepEqual(ts.map((i) => i.label), ['getOrder']);
        assert.equal(ts[0]!.provenances[0]!.kind, 'delegated');
        assert.ok(r.items.some((i) => i.providerRouteId === 'fixture.engine'), 'owned results are merged');
        const again = await w.engine.find('getorder');
        assert.deepEqual(again.items.map((i) => i.key), r.items.map((i) => i.key));
        assert.equal((await w.engine.find('type: getorder')).items.filter((i) => i.providerRouteId === TS_JS_ROUTE_ID).length, 0);
      }),
  },
  {
    name: 'Related shows declarations and references in group order; framework modules of other routes do not attach',
    run: () =>
      withWorkspace({}, async (w) => {
        const r = await w.engine.related(AT_CALL);
        assert.equal(r.kind, 'related');
        if (r.kind !== 'related') return;
        assert.equal(r.subject?.name, 'getOrder');
        assert.deepEqual(r.groups.map((g) => g.group), ['declarations', 'references']);
        assert.equal(r.completeness, 'unknown');
      }),
  },
  {
    name: 'Actions lists the available capabilities and an unavailable one with its reason',
    run: () =>
      withWorkspace({}, async (w) => {
        const r = await w.engine.actions(AT_CALL);
        const last = r.items[r.items.length - 1]!;
        assert.equal(last.capabilityId, 'typescript.frameworkRelations');
        assert.equal(last.state, 'unavailable');
        assert.equal(last.reasonCode, 'NoFrameworkModule');
        assert.ok(r.items.filter((i) => i.state !== 'unavailable').every((i) => i.guarantee === 'delegated'));
      }),
  },
  {
    name: 'Rename preview is a limited text-only delegated plan; apply is refused while disabled',
    run: () =>
      withWorkspace({}, async (w) => {
        const r = await w.engine.prepareRename(AT_DECL, 'fetchOrder');
        assert.equal(r.kind, 'preview');
        if (r.kind !== 'preview') return;
        assert.equal(r.state, 'Previewing');
        assert.deepEqual(r.issues, []);
        assert.equal(r.plan.kind, 'delegated');
        assert.equal(r.plan.validation.status, 'limited');
        assert.equal((await w.engine.applyRename(r.planId)).status, 'disabled');
        assert.equal(w.applier.applied.length, 0);
      }),
  },
  {
    name: 'Apply (when enabled) re-asks the provider and applies; an edit after preview makes the plan stale',
    run: () =>
      withWorkspace({ applyRenameEnabled: true }, async (w) => {
        const p1 = await w.engine.prepareRename(AT_DECL, 'fetchOrder');
        assert.equal(p1.kind, 'preview');
        if (p1.kind !== 'preview') return;
        w.world.editBuffer(USE, `${w.world.text(USE)}// edited\n`);
        const stale = await w.engine.applyRename(p1.planId, undefined, { acceptLimited: true });
        assert.equal(stale.status, 'stale');
        assert.equal(w.engine.planState(p1.planId), undefined);
        const p2 = await w.engine.prepareRename(AT_DECL, 'fetchOrder');
        assert.equal(p2.kind, 'preview');
        if (p2.kind !== 'preview') return;
        const ok = await w.engine.applyRename(p2.planId, undefined, { acceptLimited: true });
        assert.equal(ok.status, 'applied', ok.message);
        assert.match(w.world.text(ORDERS)!, /function fetchOrder/);
      }),
  },
  {
    name: 'A result computed while the code changed mid-request is dropped (stale rejection)',
    run: () =>
      withWorkspace({ staleRetries: 0 }, async (w) => {
        let injected = false;
        w.world.beforeCommand = (c) => {
          if (c === PROVIDER_COMMANDS.definitions && !injected) {
            injected = true;
            w.world.editBuffer(USE, `${w.world.text(USE)}// typing\n`);
          }
        };
        const r = await w.engine.related(AT_CALL);
        assert.equal(r.kind === 'unavailable' && r.reasonCode, 'Stale');
        assert.equal((await w.engine.related(AT_CALL)).kind, 'related');
      }),
  },
  {
    name: 'Restart → new epoch: plans become stale, new requests work',
    run: () =>
      withWorkspace({ applyRenameEnabled: true }, async (w) => {
        const p = await w.engine.prepareRename(AT_DECL, 'fetchOrder');
        assert.equal(p.kind, 'preview');
        const first = w.adapter.currentEpoch();
        await w.engine.restart(TS_JS_ROUTE_ID);
        assert.notEqual(w.adapter.currentEpoch(), first);
        if (p.kind === 'preview') assert.equal(w.engine.planState(p.planId), undefined);
        assert.equal((await w.engine.related(AT_CALL)).kind, 'related');
      }),
  },
  {
    name: 'Failure of the delegated route does not break another route',
    run: () =>
      withWorkspace({}, async (w) => {
        for (const c of Object.values(PROVIDER_COMMANDS)) w.world.throwOn.set(c, 'provider crashed');
        const r = await w.engine.find('GetOrder');
        assert.deepEqual(r.items.map((i) => i.providerRouteId), ['fixture.engine']);
        assert.ok(r.notes.some((n) => n.startsWith('TS/JS:') && n.includes('provider crashed')));
        w.engine.documentOpened('file:///ws/a.fixture', 'fixture', 1, 'symbol GetOrder\n', false);
        assert.equal((await w.engine.related({ uri: 'file:///ws/a.fixture', position: { line: 0, character: 9 } })).kind, 'related');
        const ts = await w.engine.related(AT_CALL);
        assert.equal(ts.kind === 'unavailable' && ts.reasonCode, 'ProviderError');
      }),
  },
  {
    name: 'Cancellation rejects with CancelledError and publishes nothing',
    run: () =>
      withWorkspace({}, async (w) => {
        const source = new CancellationSource();
        w.world.beforeCommand = () => source.cancel();
        await assert.rejects(w.engine.related(AT_CALL, source.token), CancelledError);
        await assert.rejects(w.engine.prepareRename(AT_DECL, 'x', source.token), CancelledError);
        w.world.beforeCommand = undefined;
        assert.equal((await w.engine.related(AT_CALL)).kind, 'related');
      }),
  },
  {
    name: 'Malformed provider results are dropped, not guessed',
    run: () =>
      withWorkspace(
        {
          wrapCommands: (inner) => ({
            executeCommand: async <T>(c: string, ...a: unknown[]) =>
              (c === PROVIDER_COMMANDS.references ? [{ uri: 'not a uri', range: {} }, { uri: fakeUri(USE) }, 42] : await inner.executeCommand<unknown>(c, ...a)) as T,
          }),
        },
        async (w) => {
          const r = await w.engine.related(AT_CALL);
          assert.equal(r.kind, 'related');
          if (r.kind === 'related') assert.deepEqual(r.groups.map((g) => g.group), ['declarations']);
        },
      ),
  },
  {
    name: 'UTF-16 positions survive the round trip (emoji before the symbol)',
    run: () =>
      withWorkspace({ files: { ...TS_FILES, 'file:///ws/src/e.ts': "const s = '\u{1F469}‍\u{1F469}'; getOrder(1);\n" } }, async (w) => {
        const r = await w.engine.related({ uri: 'file:///ws/src/e.ts', position: { line: 0, character: 20 } });
        assert.equal(r.kind, 'related');
        if (r.kind !== 'related') return;
        const ref = r.groups.find((g) => g.group === 'references')!.relations.find((x) => x.target.location!.uri.endsWith('e.ts'))!;
        assert.deepEqual(ref.target.location!.range.start, { line: 0, character: 19 });
      }),
  },
];
