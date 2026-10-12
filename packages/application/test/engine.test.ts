import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_FILES, type FixtureWorkspace, createFixtureWorkspace, flushAsync } from '@refyntra/adapter-testing';
import { AdapterRegistry, CancellationSource, CancelledError, DocumentTracker, descriptorHandles } from '../src';

const A = 'file:///ws/a.fixture';
const B = 'file:///ws/b.fixture';
const AT_HIER = { uri: A, position: { line: 0, character: 9 } };
let w: FixtureWorkspace | undefined;

afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

function make(extra: Partial<Parameters<typeof createFixtureWorkspace>[0]> = {}): FixtureWorkspace {
  w = createFixtureWorkspace({ transport: 'memory', files: FIXTURE_FILES, ...extra });
  return w;
}

const SEMANTIC = new Set(['code/search', 'code/related', 'code/symbolAt', 'capability/query', 'refactor/prepare', 'refactor/revalidate']);

describe('router', () => {
  it('routes a document to exactly one owning adapter by scheme + extension/language', () => {
    const ws = make({ withSecondRoute: true });
    expect(ws.registry.routeFor(A)?.descriptor.adapterId).toBe('fixture');
    expect(ws.registry.routeFor('file:///ws/x.fx2')?.descriptor.adapterId).toBe('fixture2');
    expect(ws.registry.routeFor('untitled:///ws/a.fixture')).toBeUndefined();
    expect(ws.registry.routeFor('file:///ws/a.txt')).toBeUndefined();
    expect(ws.registry.routeFor('file:///ws/a.txt', 'fixture2')?.descriptor.adapterId).toBe('fixture2');
  });

  it('refuses two adapters with the same route id', () => {
    const ws = make();
    const reg = new AdapterRegistry();
    reg.registerLanguage(ws.adapter);
    expect(() => reg.registerLanguage(ws.adapter)).toThrow(/already registered/);
  });

  it('descriptorHandles ignores query/fragment and is case-insensitive on extension', () => {
    const d = make().adapter.descriptor;
    expect(descriptorHandles(d, 'file:///x/A.FIXTURE?x=1')).toBe(true);
  });
});

describe('document tracker', () => {
  it('owns monotonic revision and sequence; change of unknown doc becomes open', () => {
    const t = new DocumentTracker();
    const events: string[] = [];
    t.onDidRecord((e) => events.push(`${e.kind}:${e.documentSequence}:${e.workspaceRevision}`));
    t.change('file:///a', 'x', 1, 'a', true);
    t.save('file:///a', 'x', 1, 'a');
    t.bumpRevision();
    t.close('file:///a');
    expect(t.close('file:///a')).toBeUndefined();
    expect(events).toEqual(['open:1:1', 'save:2:2', 'close:3:4']);
  });
});

describe('barrier and stale rejection', () => {
  it('sends a snapshot barrier before every semantic request', async () => {
    const ws = make({ withFramework: true, applyRenameEnabled: true });
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, FIXTURE_FILES[A]!, false);
    await ws.engine.find('Get');
    await ws.engine.related({ uri: A, position: { line: 0, character: 9 } });
    await ws.engine.actions({ uri: A, position: { line: 0, character: 9 } });
    const p = await ws.engine.prepareRename({ uri: A, position: { line: 0, character: 9 } }, 'X');
    if (p.kind === 'preview') await ws.engine.applyRename(p.planId);
    const log = ws.route.engine!.received.filter((m) => m !== 'textDocument/didOpen' && m !== 'textDocument/didChange');
    let semanticCount = 0;
    log.forEach((m, i) => {
      if (SEMANTIC.has(m)) {
        semanticCount++;
        expect(log[i - 1], `${m} at ${i}`).toBe('workspace/snapshotBarrier');
      }
    });
    expect(semanticCount).toBeGreaterThanOrEqual(6);
  });

  it('every document event is sent immediately with full text and increasing sequence', async () => {
    const ws = make();
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, 'symbol X\n', false);
    ws.engine.documentChanged(A, 'fixture', 2, 'symbol Y\n', true);
    await flushAsync();
    expect(ws.route.engine!.openedTexts.get(A)).toBe('symbol X\n');
    const found = await ws.engine.find('Y');
    expect(found.items.map((i) => i.label)).toEqual(['Y']);
  });

  it('drops a result when the revision changed while it was computed, then retries once', async () => {
    const ws = make();
    await ws.engine.start();
    let edits = 0;
    ws.route.engine!.beforeRequest = (m) => {
      if (m === 'code/search' && edits++ === 0) ws.engine.documentOpened(B, 'fixture', 2, 'symbol Late\n', true);
    };
    const r = await ws.engine.find('Late');
    expect(r.items.map((i) => i.label)).toEqual(['Late']);
    expect(edits).toBe(2);
  });

  it('drops a result whose epoch changed (crash mid-request) instead of publishing it', async () => {
    const ws = make({ staleRetries: 0 });
    await ws.engine.start();
    ws.route.engine!.beforeRequest = (m) => {
      if (m === 'code/related') ws.route.current!.crash();
    };
    const r = await ws.engine.related({ uri: A, position: { line: 0, character: 9 } });
    expect(r.kind).toBe('unavailable');
  });
});

describe('restart policy', () => {
  it('replays open dirty documents after a crash, before any semantic request, with a new epoch', async () => {
    const ws = make();
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, FIXTURE_FILES[A]!, false);
    ws.engine.documentChanged(A, 'fixture', 7, 'symbol OnlyInBuffer\n', true);
    const epoch1 = ws.adapter.currentEpoch();
    const invalidated: string[] = [];
    ws.engine.onDidInvalidate((r) => invalidated.push(r));
    ws.route.current!.crash();
    await flushAsync();
    expect(invalidated).toEqual(['fixture.engine']);
    expect(ws.adapter.currentEpoch()).toBeUndefined();
    await ws.clock.advance(500);
    expect(ws.adapter.health().state).toBe('Ready');
    expect(ws.adapter.currentEpoch()).not.toBe(epoch1);
    const e2 = ws.route.engine!;
    expect(e2.openedTexts.get(A)).toBe('symbol OnlyInBuffer\n');
    expect(e2.received.slice(0, 4)).toEqual(['initialize', 'workspace/open', 'textDocument/didOpen', 'workspace/snapshotBarrier']);
    expect((await ws.engine.find('OnlyInBuffer')).items).toHaveLength(1);
    expect(ws.adapter.health().restartCount).toBe(1);
  });

  it('uses bounded backoff and stops after maxRestarts (no infinite loop)', async () => {
    const ws = make({ restartPolicy: { maxRestarts: 2, windowMs: 60_000, backoffMs: [100, 1000] } });
    await ws.engine.start();
    ws.route.failNextStarts = 100;
    ws.route.current!.crash();
    await flushAsync();
    expect(ws.adapter.health().state).toBe('Restarting');
    await ws.clock.advance(99);
    expect(ws.route.failNextStarts).toBe(100);
    await ws.clock.advance(1);
    expect(ws.route.failNextStarts).toBe(99);
    await ws.clock.advance(1000);
    expect(ws.route.failNextStarts).toBe(98);
    expect(ws.adapter.health().state).toBe('Failed');
    expect(ws.adapter.health().reasonCode).toBe('RestartLimitReached');
    expect(ws.adapter.health().recoveryActions[0]!.command).toBe('refyntra.restartBackend');
    await ws.clock.advance(600_000);
    expect(ws.route.failNextStarts).toBe(98);
    expect(ws.clock.pendingTimers).toBe(0);
    // Manual restart resets the budget.
    ws.route.failNextStarts = 0;
    await ws.engine.restart();
    expect(ws.adapter.health().state).toBe('Ready');
  });

  it('protocol major mismatch fails clearly without restart loop', async () => {
    const ws = make();
    ws.route.protocolMajor = 2;
    await ws.engine.start();
    expect(ws.adapter.health().state).toBe('Failed');
    expect(ws.adapter.health().reasonCode).toBe('ProtocolMismatch');
    expect(ws.clock.pendingTimers).toBe(0);
  });

  it('a request issued while restarting waits for the replayed session', async () => {
    const ws = make();
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, 'symbol Waiter\n', true);
    ws.route.current!.crash();
    await flushAsync();
    const pending = ws.engine.find('Waiter');
    await ws.clock.advance(500);
    expect((await pending).items.map((i) => i.label)).toEqual(['Waiter']);
  });
});

describe('cancellation', () => {
  it('a cancelled find rejects with CancelledError', async () => {
    const ws = make();
    await ws.engine.start();
    const s = new CancellationSource();
    s.cancel();
    await expect(ws.engine.find('Get', s.token)).rejects.toBeInstanceOf(CancelledError);
  });

  it('cancelling while the route is restarting stops waiting', async () => {
    const ws = make();
    await ws.engine.start();
    ws.route.current!.crash();
    await flushAsync();
    const s = new CancellationSource();
    const p = ws.engine.related({ uri: A, position: { line: 0, character: 1 } }, s.token);
    s.cancel();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('health aggregation', () => {
  it('reports per adapter; one failed route does not hide the other', async () => {
    const ws = make({ withSecondRoute: true });
    ws.route.protocolMajor = 9;
    await ws.engine.start();
    const h = ws.engine.health();
    expect(h.adapters.map((a) => `${a.displayName}:${a.state}`)).toEqual(['Fixture:Failed', 'Fixture2:Ready']);
    expect(h.adapters[1]!.projects).toHaveLength(1);
  });
});

describe('rename plan state machine and apply', () => {
  const AT = { uri: A, position: { line: 0, character: 9 } };
  async function prepared(ws: FixtureWorkspace, open = true) {
    await ws.engine.start();
    if (open) {
      ws.engine.documentOpened(A, 'fixture', 1, FIXTURE_FILES[A]!, false);
      ws.engine.documentOpened(B, 'fixture', 1, FIXTURE_FILES[B]!, false);
    }
    const p = await ws.engine.prepareRename(AT, 'FetchOrder');
    if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
    return p;
  }

  it('walks Prepared → Previewing → Revalidating → Applying → Applied and is single use', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    expect(ws.engine.planState(p.planId)).toBe('Previewing');
    const ok = await ws.engine.applyRename(p.planId);
    expect(ok.status).toBe('applied');
    expect(ok.files!.every((f) => f.status === 'confirmed')).toBe(true);
    expect(ws.engine.planState(p.planId)).toBeUndefined();
    const again = await ws.engine.applyRename(p.planId);
    expect(again.status).toBe('stale');
    expect(ws.applier.applied).toHaveLength(2);
  });

  it('passes the Refactor Preview confirmation to the EditApplier after revalidation (ADR-004 Amendment 6)', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    const ok = await ws.engine.applyRename(p.planId, undefined, { confirmation: { label: 'Rename', description: '1 warning' } });
    expect(ok.status).toBe('applied');
    expect(ws.applier.captureOptions.at(-1)).toEqual({ confirmation: { label: 'Rename', description: '1 warning' } });
    const q = await prepared(ws);
    await ws.engine.applyRename(q.planId);
    expect(ws.applier.captureOptions.at(-1)).toBeUndefined();
  });

  it('refuses a stale plan before the Refactor Preview is shown', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    ws.engine.documentChanged(A, 'fixture', 99, (ws.world.files.get(A) ?? '') + ' // edit', true);
    const r = await ws.engine.applyRename(p.planId, undefined, { confirmation: { label: 'Rename' } });
    expect(r.status).toBe('stale');
    expect(ws.applier.applied).toHaveLength(0);
  });

  it('revalidates with the backend after confirmation, before anything is written', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    const before = ws.route.engine!.received.length;
    await ws.engine.applyRename(p.planId);
    const after = ws.route.engine!.received.slice(before);
    expect(after).toContain('refactor/revalidate');
    expect(after.indexOf('workspace/snapshotBarrier')).toBeLessThan(after.indexOf('refactor/revalidate'));
  });

  it('an editor event after the preview breaks the lease: stale, nothing applied, re-prepare gives a new plan', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    ws.engine.documentChanged(B, 'fixture', 2, `${FIXTURE_FILES[B]!}// typed\n`, true);
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('stale');
    expect(r.canReprepare).toBe(true);
    expect(ws.applier.applied).toHaveLength(0);
    const p2 = await ws.engine.prepareRename(AT, 'FetchOrder');
    expect(p2.kind).toBe('preview');
    if (p2.kind === 'preview') expect(p2.planId).not.toBe(p.planId);
  });

  it('a target edited between the final revalidation and apply is refused by the synchronous check', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws, false);
    ws.applier.afterCapture = () => ws.world.files.set(B, `${FIXTURE_FILES[B]!}// external write\n`);
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('stale');
    expect(ws.applier.applied).toHaveLength(0);
  });

  it('a backend epoch change (host killed between prepare and apply) makes the plan stale', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    ws.route.current!.crash();
    await flushAsync();
    expect(ws.engine.planState(p.planId)).toBeUndefined();
    await ws.clock.advance(500);
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('stale');
    expect(ws.applier.applied).toHaveLength(0);
  });

  it('a provider route / input change invalidates prepared plans', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    await ws.engine.inputsChanged('solution selected');
    expect(ws.engine.planState(p.planId)).toBeUndefined();
    expect((await ws.engine.applyRename(p.planId)).status).toBe('stale');
  });

  it('applyEdit returning false is reported as failed with every file unchanged (no rollback, no retry)', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    ws.applier.rejectApply = true;
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/no file was changed/);
    expect(r.files!.map((f) => f.status)).toEqual(['unchanged', 'unchanged']);
    expect(ws.engine.planState(p.planId)).toBeUndefined();
  });

  it('a post-state that differs from resultHash is reported as unknown, not as success', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    ws.applier.corruptUri = B;
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('failed');
    expect(r.files!.find((f) => f.uri === B)!.status).toBe('unknown');
    expect(r.files!.find((f) => f.uri === A)!.status).toBe('confirmed');
  });

  it('cancellation before apply writes nothing; disabled setting never applies', async () => {
    const ws = make({ applyRenameEnabled: true });
    const p = await prepared(ws);
    const cts = new CancellationSource();
    ws.route.engine!.beforeRequest = (m) => {
      if (m === 'refactor/revalidate') cts.cancel();
    };
    const r = await ws.engine.applyRename(p.planId, cts.token);
    expect(r.status).toBe('cancelled');
    expect(ws.applier.applied).toHaveLength(0);
    ws.route.engine!.beforeRequest = undefined;
    ws.settings.applyRename = false;
    const p2 = await ws.engine.prepareRename(AT, 'FetchOrder');
    if (p2.kind !== 'preview') throw new Error('expected preview');
    expect(p2.applyEnabled).toBe(false);
    expect((await ws.engine.applyRename(p2.planId)).status).toBe('disabled');
    expect(ws.applier.applied).toHaveLength(0);
  });
});

describe('runnable projects (protocol 1.8)', () => {
  it('returns the project model of the owned route', async () => {
    const ws = make();
    const r = await ws.engine.runnableProjects();
    if (r.kind !== 'projects') throw new Error(JSON.stringify(r));
    expect(r.result.projects.map((p) => [p.name, p.kind, p.runnable])).toEqual([['App', 'console', true]]);
    expect(r.result.projects[0]!.outputs[0]!.outputUri).toContain('App.dll');
  });
});

describe('hierarchy (protocol 1.7)', () => {
  it('resolves the subject and returns the incoming calls from the owned route', async () => {
    const ws = make();
    const r = await ws.engine.hierarchy(AT_HIER, 'incoming');
    if (r.kind !== 'hierarchy') throw new Error(JSON.stringify(r));
    expect(r.subject.name).toBe('GetOrder');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.fromRanges.length === 1)).toBe(true);
    const subject = await ws.engine.hierarchy(AT_HIER, 'subject');
    expect(subject.kind === 'hierarchy' && subject.items.length === 0).toBe(true);
  });

  it('is unavailable where there is no symbol or no owned route', async () => {
    const ws = make();
    const none = await ws.engine.hierarchy({ uri: A, position: { line: 0, character: 0 } }, 'incoming');
    expect(none.kind).toBe('unavailable');
    const other = await ws.engine.hierarchy({ uri: 'file:///ws/x.txt', position: { line: 0, character: 0 } }, 'incoming');
    expect(other.kind === 'unavailable' && other.reasonCode).toBe('ActionNotSupported');
  });
});
