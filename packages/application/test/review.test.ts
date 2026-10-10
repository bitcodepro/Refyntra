import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCodes } from '@refyntra/contracts';
import { FIXTURE_FILES, FIXTURE_LIMITATION, type FixtureWorkspace, createFixtureWorkspace, flushAsync } from '@refyntra/adapter-testing';
import { RpcError } from '../src';

/** Regression tests for the review findings R5, R6, C2 and S3 (client side). */
const A = 'file:///ws/a.fixture';
const B = 'file:///ws/b.fixture';
const AT = { uri: A, position: { line: 0, character: 9 } };
let w: FixtureWorkspace | undefined;

afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

function make(extra: Partial<Parameters<typeof createFixtureWorkspace>[0]> = {}): FixtureWorkspace {
  w = createFixtureWorkspace({ transport: 'memory', files: FIXTURE_FILES, ...extra });
  return w;
}

describe('R5: oversized documents and barrier timeouts', () => {
  it('a document larger than limits.maxMessageBytes is skipped explicitly: no sequence gap, later barriers work, health names it', async () => {
    const ws = make({ transport: 'loopback', maxMessageBytes: 4096 });
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, 'symbol SmallOne\n', false);
    ws.engine.documentOpened(B, 'fixture', 1, `symbol BigOne\n// ${'x'.repeat(10_000)}\n`, true);
    await flushAsync();
    const r = await ws.engine.find('SmallOne');
    expect(r.notes).toEqual([]);
    expect(r.items.map((i) => i.label)).toEqual(['SmallOne']);
    const h = ws.adapter.health();
    expect(h.diagnostics.some((d) => d.severity === 'warning' && /too large/i.test(d.message) && d.message.includes('b.fixture'))).toBe(true);
    // Shrinking it again sends it normally and clears the warning.
    ws.engine.documentChanged(B, 'fixture', 2, 'symbol BigOne\n', true);
    await flushAsync();
    expect((await ws.engine.find('BigOne')).items.map((i) => i.label)).toEqual(['BigOne']);
    expect(ws.adapter.health().diagnostics.some((d) => /too large/i.test(d.message))).toBe(false);
  });

  it('replaying an oversized dirty buffer after a crash does not loop into RestartLimitReached', async () => {
    const ws = make({ transport: 'loopback', maxMessageBytes: 4096, restartPolicy: { maxRestarts: 3, windowMs: 60_000, backoffMs: [100] } });
    await ws.engine.start();
    ws.engine.documentOpened(B, 'fixture', 1, `symbol BigOne\n// ${'x'.repeat(10_000)}\n`, true);
    ws.route.current!.crash();
    await flushAsync();
    await ws.clock.advance(1_000);
    expect(ws.adapter.health().state).toBe('Ready');
    expect(ws.adapter.health().restartCount).toBe(1);
  });

  it('BarrierTimeout (-33008) makes the client replay the open documents and retry', async () => {
    const ws = make();
    await ws.engine.start();
    ws.engine.documentOpened(A, 'fixture', 1, 'symbol Before\n', true);
    await flushAsync();
    ws.route.engine!.dropDocumentEvents = 1; // the next document event is lost on the way
    ws.engine.documentChanged(A, 'fixture', 2, 'symbol AfterLoss\n', true);
    await flushAsync();
    const r = await ws.engine.find('AfterLoss');
    expect(r.notes).toEqual([]);
    expect(r.items.map((i) => i.label)).toEqual(['AfterLoss']);
  });
});

describe('R6: startup crash accounting', () => {
  it('one host crash during startup counts as one automatic restart', async () => {
    const ws = make({ restartPolicy: { maxRestarts: 4, windowMs: 60_000, backoffMs: [100, 1_000] } });
    let crashed = false;
    ws.route.configureEngine = (engine) => {
      engine.beforeRequest = (m) => {
        if (m === 'workspace/open' && !crashed) {
          crashed = true;
          ws.route.current!.crash();
        }
      };
    };
    await ws.engine.start();
    await flushAsync();
    expect(ws.adapter.health().state).toBe('Restarting');
    expect(ws.adapter.health().restartCount).toBe(1);
    expect(ws.clock.pendingTimers).toBe(1);
    await ws.clock.advance(100); // the first backoff step, not the second
    expect(ws.adapter.health().state).toBe('Ready');
    expect(ws.adapter.health().restartCount).toBe(1);
  });
});

describe('C2: error codes', () => {
  it('UnknownSymbol (-33005) is a real error: not retried as stale, reason and recovery shown', async () => {
    const ws = make();
    await ws.engine.start();
    let calls = 0;
    ws.route.engine!.beforeRequest = (m) => {
      if (m !== 'code/related') return;
      calls++;
      throw new RpcError(ErrorCodes.UnknownSymbol, 'unknown symbol', { reasonCode: 'UnknownSymbol', message: 'The symbol id cannot be resolved.', recovery: 'Place the cursor on the symbol and try again.' });
    };
    const r = await ws.engine.related(AT);
    expect(r.kind).toBe('unavailable');
    if (r.kind !== 'unavailable') return;
    expect(r.reasonCode).toBe('UnknownSymbol');
    expect(r.message).toContain('The symbol id cannot be resolved.');
    expect(r.message).toContain('Place the cursor on the symbol and try again.');
    expect(calls).toBe(1);
  });

  it('StaleSnapshot (-33004) is still retried once', async () => {
    const ws = make();
    await ws.engine.start();
    let calls = 0;
    ws.route.engine!.beforeRequest = (m) => {
      if (m !== 'code/related' || calls++ > 0) return;
      throw new RpcError(ErrorCodes.StaleSnapshot, 'stale', { reasonCode: 'StaleSnapshot', message: 'not current' });
    };
    const r = await ws.engine.related(AT);
    expect(r.kind).toBe('related');
    expect(calls).toBe(2);
  });

  it('InternalError (-32603) shows the reason code and the recovery text', async () => {
    const ws = make();
    await ws.engine.start();
    ws.route.engine!.beforeRequest = (m) => {
      if (m === 'code/related') throw new RpcError(ErrorCodes.InternalError, 'boom', { reasonCode: 'InternalError', message: 'NullReferenceException: x', recovery: 'Restart the backend.' });
    };
    const r = await ws.engine.related(AT);
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('InternalError');
    expect(r.kind === 'unavailable' && r.message).toMatch(/Restart the backend\./);
  });

  it('UnknownPlan on revalidate means the preview expired: stale with "prepare again", nothing applied', async () => {
    const ws = make({ applyRenameEnabled: true });
    await ws.engine.start();
    const p = await ws.engine.prepareRename(AT, 'FetchOrder');
    if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
    ws.route.engine!.notify('refactor/discard', { workspaceId: 'ws-test', planId: p.planId });
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).toBe('stale');
    expect(r.canReprepare).toBe(true);
    expect(r.message).toMatch(/preview expired/i);
    expect(ws.applier.applied).toHaveLength(0);
  });
});

describe('S3: limited plans', () => {
  it('a limited plan is never applied without an explicit confirmation of its limitations', async () => {
    const ws = make({ applyRenameEnabled: true });
    await ws.engine.start();
    ws.route.engine!.limitedPlans = true;
    ws.engine.documentOpened(A, 'fixture', 1, FIXTURE_FILES[A]!, false);
    ws.engine.documentOpened(B, 'fixture', 1, FIXTURE_FILES[B]!, false);
    const p = await ws.engine.prepareRename(AT, 'FetchOrder');
    if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
    expect(p.plan.validation.status).toBe('limited');

    const first = await ws.engine.applyRename(p.planId);
    expect(first.status).toBe('limited');
    expect(first.limitations).toContain(FIXTURE_LIMITATION);
    expect(ws.applier.applied).toHaveLength(0);
    expect(ws.engine.planState(p.planId)).toBe('Previewing');
    expect(ws.route.engine!.received).not.toContain('refactor/revalidate');

    const confirmed = await ws.engine.applyRename(p.planId, undefined, { acceptLimited: true });
    expect(confirmed.status).toBe('applied');
    expect(ws.applier.applied.length).toBeGreaterThan(0);
  });

  it('a backend that answers "limited" for a plan previewed as valid is not applied', async () => {
    const ws = make({ applyRenameEnabled: true });
    await ws.engine.start();
    // The backend stores a limited plan; the client copy says "valid" (e.g. a backend that changed its mind).
    ws.route.engine!.limitedPlans = true;
    const p = await ws.engine.prepareRename(AT, 'FetchOrder');
    if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
    (p.plan.validation as { status: string }).status = 'valid';
    const r = await ws.engine.applyRename(p.planId);
    expect(r.status).not.toBe('applied');
    expect(ws.applier.applied).toHaveLength(0);
  });
});

describe('Related scope details (structured, additive)', () => {
  const details = {
    projectsTotal: 18, projectsComplete: 0, projectsPartial: 18, projectsFailed: 0,
    causes: { missingAssets: 18, missingPackages: 0, missingProjectReferences: 0, loadFailures: 0, otherErrors: 0 },
    restoreRecommended: true, solutionPath: 'C:/src/App.sln',
    frameworks: [{ id: 'aspnetcore', name: 'ASP.NET Core', evidence: 'Microsoft.AspNetCore.Routing, Version=6.0.0.0', versionVerified: true }],
  };

  it('passes scopeDetails through; host scope notes are not repeated as additional notes', async () => {
    const ws = make();
    await ws.engine.start();
    ws.route.engine!.relatedScope = { completeness: 'partial', scopeNotes: ['0 of 18 projects loaded completely', 'aspnetcore: x'], scopeDetails: details };
    const r = await ws.engine.related(AT);
    expect(r.kind).toBe('related');
    if (r.kind !== 'related') return;
    expect(r.scopeDetails).toEqual(details);
    expect(r.scopeNotes).toEqual(['0 of 18 projects loaded completely', 'aspnetcore: x']);
    expect(r.additionalNotes).toEqual([]);
  });

  it('drops malformed scopeDetails (the client then falls back to scopeNotes)', async () => {
    const ws = make();
    await ws.engine.start();
    ws.route.engine!.relatedScope = { completeness: 'partial', scopeNotes: ['n'], scopeDetails: { projectsTotal: 'x' } as never };
    const r = await ws.engine.related(AT);
    expect(r.kind === 'related' && r.scopeDetails).toBeUndefined();
  });
});
