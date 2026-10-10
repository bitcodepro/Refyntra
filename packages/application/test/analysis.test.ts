import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_FILES, type FixtureWorkspace, createFixtureWorkspace } from '@refyntra/adapter-testing';
import type { AnalysisRunResult } from '@refyntra/contracts';

// analysis/run through the application (EngineClient.analyze → ProtocolLanguageAdapter.analyze).
let w: FixtureWorkspace | undefined;

afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

const A = 'file:///ws/a.fixture';

function answer(ws: FixtureWorkspace, respond: (params: Record<string, unknown>) => unknown): string[] {
  const seen: string[] = [];
  const engine = ws.route.engine!;
  const original = engine.handle.bind(engine);
  engine.handle = async (method: string, params: unknown, token?: never) => {
    if (method !== 'analysis/run') return original(method, params, token);
    seen.push(JSON.stringify(params));
    return respond(params as Record<string, unknown>);
  };
  return seen;
}

describe('EngineClient.analyze', () => {
  it('sends analysis/run after a barrier on the current snapshot and returns diagnostics and abstentions', async () => {
    w = createFixtureWorkspace({ transport: 'memory', files: FIXTURE_FILES });
    await w.engine.start();
    let snapshot = '';
    const seen = answer(w, (p) => {
      snapshot = String(p.snapshotId);
      const r: AnalysisRunResult = {
        diagnostics: [
          {
            id: 'OR1001',
            severity: 'warning',
            message: 'captured',
            location: { uri: A, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
            relatedLocations: [{ location: { uri: A, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }, message: 'step' }],
            evidence: [],
            confidence: 'proven',
            completeness: 'complete',
          },
          // Malformed entries from the backend are dropped (untrusted output).
          { id: 'OR1001', severity: 'warning' } as never,
        ],
        abstentions: [{ ruleId: 'OR1001', reason: 'FactoryRegistration', message: 'factory' }],
        completeness: 'complete',
        snapshotId: String(p.snapshotId),
      };
      return r;
    });
    const out = await w.engine.analyze();
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.kind).toBe('analysis');
    if (r.kind !== 'analysis') return;
    expect(r.diagnostics.map((d) => d.message)).toEqual(['captured']);
    expect(r.abstentions.map((a) => a.reason)).toEqual(['FactoryRegistration']);
    expect(r.snapshotId).toBe(snapshot);
    expect(seen).toHaveLength(1);
    const log = w.route.engine!.received;
    // The wrapper answers analysis/run itself, so the last request the fixture engine saw is the barrier.
    expect(log[log.length - 1]).toBe('workspace/snapshotBarrier');
  });

  it('passes the document filter and reports an unsupported backend as unavailable (never throws)', async () => {
    w = createFixtureWorkspace({ transport: 'memory', files: FIXTURE_FILES });
    await w.engine.start();
    const out = await w.engine.analyze({ uri: A });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('unavailable');
    const seen = answer(w, (p) => ({ diagnostics: [], abstentions: [], completeness: 'complete', snapshotId: p.snapshotId }));
    const ok = await w.engine.analyze({ uri: A });
    expect(ok[0]!.kind).toBe('analysis');
    expect(JSON.parse(seen[0]!).uri).toBe(A);
  });
});
