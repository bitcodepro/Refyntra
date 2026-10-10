import assert from 'node:assert/strict';
import { CancellationSource, CancelledError } from '@refyntra/application';
import { flushAsync } from './fakes';
import { type FixtureWorkspace, type FixtureWorkspaceOptions, createFixtureWorkspace } from './harness';
import type { FixtureTransportKind } from './transports';

export const FIXTURE_FILES: Record<string, string> = {
  'file:///ws/a.fixture': 'symbol GetOrder\nsymbol OrderHandler\nrelate GetOrder -> OrderHandler\nsymbol GetOrderWiring\n',
  'file:///ws/b.fixture': 'use GetOrder here\n',
  'file:///ws/c.fx2': 'symbol Other\n',
};

const A = 'file:///ws/a.fixture';
const B = 'file:///ws/b.fixture';
const C = 'file:///ws/c.fx2';
/** Cursor on "GetOrder" in line 0 of a.fixture. */
const AT_GET_ORDER = { uri: A, position: { line: 0, character: 9 } };

export interface ConformanceCase {
  name: string;
  run(kind: FixtureTransportKind): Promise<void>;
}

async function withWorkspace(kind: FixtureTransportKind, extra: Partial<FixtureWorkspaceOptions>, fn: (w: FixtureWorkspace) => Promise<void>): Promise<void> {
  const w = createFixtureWorkspace({ transport: kind, files: FIXTURE_FILES, withFramework: true, withSecondRoute: true, ...extra });
  try {
    await w.engine.start();
    await fn(w);
  } finally {
    await w.dispose();
  }
}

function openAll(w: FixtureWorkspace): void {
  w.engine.documentOpened(A, 'fixture', 1, FIXTURE_FILES[A]!, false);
  w.engine.documentOpened(B, 'fixture', 1, FIXTURE_FILES[B]!, false);
}

/**
 * Acceptance suite. Every case goes through RefyntraEngine (the same use cases the VS Code
 * presentation calls); the fixture language is wired only in the registry composition (harness.ts).
 */
export const conformanceCases: ConformanceCase[] = [
  {
    name: 'Find sees the fixture symbol with provenance and stable order',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        const r = await w.engine.find('getorder');
        assert.deepEqual(
          r.items.map((i) => i.label),
          ['GetOrder', 'GetOrderWiring'],
        );
        assert.equal(r.items[0]!.providerRouteId, 'fixture.engine');
        assert.equal(r.items[0]!.provenances[0]!.kind, 'owned-semantic');
        const again = await w.engine.find('getorder');
        assert.deepEqual(again.items.map((i) => i.key), r.items.map((i) => i.key));
        const filtered = await w.engine.find('member: getorder');
        assert.equal(filtered.items.length, 0);
      }),
  },
  {
    name: 'Related shows language relations and the fake framework relation in group order',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        openAll(w);
        const r = await w.engine.related(AT_GET_ORDER);
        assert.equal(r.kind, 'related');
        if (r.kind !== 'related') return;
        assert.equal(r.subject?.name, 'GetOrder');
        assert.deepEqual(
          r.groups.map((g) => g.group),
          ['declarations', 'registrations', 'implementations', 'references'],
        );
        const reg = r.groups.find((g) => g.group === 'registrations')!;
        assert.equal(reg.relations[0]!.relationKind, 'fixture.wiredBy');
        const refs = r.groups.find((g) => g.group === 'references')!;
        assert.ok(refs.relations.some((x) => x.target.location?.uri === B));
      }),
  },
  {
    name: 'Actions lists the available capability and an unavailable one with its reason',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        openAll(w);
        const r = await w.engine.actions(AT_GET_ORDER);
        assert.deepEqual(
          r.items.map((i) => [i.capabilityId, i.state]),
          [
            ['fixture.rename', 'available'],
            ['fixture.extract', 'unavailable'],
          ],
        );
        assert.equal(r.items[1]!.reasonCode, 'NotImplemented');
        assert.equal(r.items[1]!.recoveryActions[0]!.command, 'refyntra.showHealth');
      }),
  },
  {
    name: 'Rename preview is a valid text-only plan; apply is refused while disabled',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        openAll(w);
        const r = await w.engine.prepareRename(AT_GET_ORDER, 'FetchOrder');
        assert.equal(r.kind, 'preview');
        if (r.kind !== 'preview') return;
        assert.equal(r.state, 'Previewing');
        assert.deepEqual(r.issues, []);
        assert.deepEqual(r.plan.writeSet.map((c) => ('uri' in c ? c.uri : c.oldUri)).sort(), [A, B]);
        assert.equal(r.applyEnabled, false);
        const applied = await w.engine.applyRename(r.planId);
        assert.equal(applied.status, 'disabled');
        assert.equal(w.applier.applied.length, 0);
      }),
  },
  {
    name: 'Apply (when enabled) revalidates and applies; an edit after preview makes the plan stale',
    run: (kind) =>
      withWorkspace(kind, { applyRenameEnabled: true }, async (w) => {
        openAll(w);
        const p1 = await w.engine.prepareRename(AT_GET_ORDER, 'FetchOrder');
        assert.equal(p1.kind, 'preview');
        if (p1.kind !== 'preview') return;
        w.engine.documentChanged(B, 'fixture', 2, 'use GetOrder here\n// edited\n', true);
        const stale = await w.engine.applyRename(p1.planId);
        assert.equal(stale.status, 'stale');
        assert.equal(w.engine.planState(p1.planId), undefined);
        const p2 = await w.engine.prepareRename(AT_GET_ORDER, 'FetchOrder');
        assert.equal(p2.kind, 'preview');
        if (p2.kind !== 'preview') return;
        const ok = await w.engine.applyRename(p2.planId);
        assert.equal(ok.status, 'applied', ok.message);
        assert.match(w.tracker.get(A)!.text, /symbol FetchOrder/);
      }),
  },
  {
    name: 'A result computed on a snapshot that changed mid-request is dropped (stale rejection)',
    run: (kind) =>
      withWorkspace(kind, { staleRetries: 0 }, async (w) => {
        openAll(w);
        let injected = false;
        w.route.engine!.beforeRequest = (method) => {
          if (method === 'code/related' && !injected) {
            injected = true;
            w.engine.documentChanged(B, 'fixture', 5, 'use GetOrder there\n', true);
          }
        };
        const r = await w.engine.related(AT_GET_ORDER);
        assert.equal(r.kind, 'unavailable');
        if (r.kind === 'unavailable') assert.equal(r.reasonCode, 'Stale');
        const again = await w.engine.related(AT_GET_ORDER);
        assert.equal(again.kind, 'related');
      }),
  },
  {
    name: 'Crash → new epoch: plans become stale, dirty buffers are replayed before new requests',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        openAll(w);
        w.engine.documentChanged(B, 'fixture', 2, 'symbol DirtyOnly\nuse GetOrder\n', true);
        const p = await w.engine.prepareRename(AT_GET_ORDER, 'FetchOrder');
        assert.equal(p.kind, 'preview');
        const firstEpoch = w.adapter.currentEpoch();
        w.route.current!.crash();
        await flushAsync();
        assert.equal(w.adapter.health().state, 'Restarting');
        if (p.kind === 'preview') assert.equal(w.engine.planState(p.planId), undefined, 'stale plan must be dropped');
        await w.clock.advance(60_000);
        assert.equal(w.adapter.health().state, 'Ready');
        assert.notEqual(w.adapter.currentEpoch(), firstEpoch);
        const engine = w.route.engine!;
        assert.equal(engine.openedTexts.get(B), 'symbol DirtyOnly\nuse GetOrder\n');
        const firstSemantic = engine.received.findIndex((m) => m === 'code/search' || m === 'code/related');
        const lastOpen = engine.received.lastIndexOf('textDocument/didOpen');
        const found = await w.engine.find('DirtyOnly');
        assert.equal(found.items.length, 1);
        assert.ok(firstSemantic === -1 || lastOpen < firstSemantic);
      }),
  },
  {
    name: 'Crash of the fixture route does not break another route',
    run: (kind) =>
      withWorkspace(kind, { restartPolicy: { maxRestarts: 0, windowMs: 60_000, backoffMs: [1000] } }, async (w) => {
        w.engine.documentOpened(C, 'fixture2', 1, FIXTURE_FILES[C]!, false);
        w.route.current!.crash();
        await flushAsync();
        assert.equal(w.adapter.health().state, 'Failed');
        assert.equal(w.adapter.health().reasonCode, 'RestartLimitReached');
        const r = await w.engine.find('Other');
        assert.deepEqual(r.items.map((i) => i.label), ['Other']);
        assert.ok(r.notes.some((n) => n.startsWith('Fixture: Failed')));
        const rel = await w.engine.related({ uri: C, position: { line: 0, character: 8 } });
        assert.equal(rel.kind, 'related');
        assert.equal(w.second!.adapter.health().state, 'Ready');
      }),
  },
  {
    name: 'Cancellation rejects with CancelledError and publishes nothing',
    run: (kind) =>
      withWorkspace(kind, {}, async (w) => {
        openAll(w);
        const source = new CancellationSource();
        w.route.engine!.beforeRequest = async (method) => {
          if (method === 'code/related') {
            source.cancel();
            await flushAsync(3);
          }
        };
        await assert.rejects(w.engine.related(AT_GET_ORDER, source.token), CancelledError);
        w.route.engine!.beforeRequest = undefined;
        const ok = await w.engine.related(AT_GET_ORDER);
        assert.equal(ok.kind, 'related');
      }),
  },
  {
    name: 'Untrusted workspace: no backend is started and features explain TrustRequired',
    run: (kind) =>
      withWorkspace(kind, { trusted: false }, async (w) => {
        assert.equal(w.route.transports.length, 0);
        assert.equal(w.adapter.health().state, 'TrustRequired');
        const a = await w.engine.actions(AT_GET_ORDER);
        assert.ok(a.items.every((i) => i.state === 'unavailable' && i.reasonCode === 'TrustRequired'));
        assert.equal(a.items[0]!.recoveryActions[0]!.command, 'workbench.trust.manage');
      }),
  },
];
