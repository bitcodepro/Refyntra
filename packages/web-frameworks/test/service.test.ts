import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RouteUnavailableError } from '@refyntra/application';
import { WorkerProcess } from '../src/host/workerProcess';
import { type OpenDocument, WebFrameworkService, type WorkerPort } from '../src/service';
import type { WorkerMethod, WorkerRelation } from '../src/protocol';

// The application side: lazy start, trust gate, dirty-document sync, conversion; and the process client's lifecycle.

function fakePort(answer: (method: WorkerMethod, params: any) => unknown) {
  const calls: { method: WorkerMethod; params: any }[] = [];
  let running = false;
  let epoch = 0;
  const port: WorkerPort = {
    get running() {
      return running;
    },
    sessionEpoch: () => `web-${epoch}`,
    onEvents: () => undefined,
    stop: async () => {
      running = false;
    },
    resetCrashes: () => undefined,
    request: async (method, params) => {
      if (!running) {
        running = true;
        epoch++;
      }
      calls.push({ method, params });
      return answer(method, params) as never;
    },
  };
  return { port, calls };
}

const rel: WorkerRelation = { kind: 'react.usage', group: 'references', label: '<Button> in App.tsx', location: { uri: 'file:///w/App.tsx', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } } }, confidence: 'proven', basis: 'TypeScript checker', evidence: [], limitations: [] };

describe('WebFrameworkService', () => {
  const docs: OpenDocument[] = [];
  const make = (o: { trusted?: boolean; web?: boolean } = {}) => {
    const f = fakePort((m) => (m === 'initialize' ? { protocolVersion: 1, typescriptVersion: '6.0.3', projects: [], truncated: false } : m === 'related' ? { relations: [rel], notes: [] } : { items: [], truncated: false, notes: [] }));
    const s = new WebFrameworkService({ port: f.port, roots: () => ['file:///w'], isTrusted: () => o.trusted ?? true, hasWebProject: async () => o.web ?? true, openDocuments: () => docs, routeIds: ['typescript.vscode-providers'], normalizeUri: (u) => u.toUpperCase() });
    return { s, f };
  };

  it('never starts the worker without a web project', async () => {
    const { s, f } = make({ web: false });
    expect(await s.framework().related({ subject: null, languageResult: {} as never, language: {} as never, target: { uri: 'file:///w/App.tsx', position: { line: 0, character: 0 } } })).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('refuses in Restricted Mode without starting anything', async () => {
    const { s, f } = make({ trusted: false });
    await expect(s.relatedAt('file:///w/App.tsx', { line: 0, character: 0 })).rejects.toBeInstanceOf(RouteUnavailableError);
    expect(f.calls).toEqual([]);
  });

  it('initializes once, sends dirty text once and its reset, converts relations', async () => {
    const { s, f } = make();
    docs.push({ uri: 'file:///w/App.tsx', languageId: 'typescriptreact', text: 'x', dirty: true });
    const r = await s.relatedAt('file:///w/App.tsx', { line: 1, character: 3 });
    expect(r.relations[0]).toMatchObject({ relationKind: 'react.usage', confidence: 'proven', provenance: { kind: 'owned-semantic', providerRouteId: 'web.frameworks' }, target: { location: { uri: 'FILE:///W/APP.TSX' } } });
    await s.relatedAt('file:///w/App.tsx', { line: 1, character: 3 });
    docs.length = 0;
    await s.relatedAt('file:///w/App.tsx', { line: 1, character: 3 });
    expect(f.calls.map((c) => c.method)).toEqual(['initialize', 'related', 'related', 'related']);
    expect(f.calls.slice(1).map((c) => c.params.documents)).toEqual([[{ uri: 'file:///w/App.tsx', text: 'x' }], [], [{ uri: 'file:///w/App.tsx', text: null }]]);
  });
});

describe('WorkerProcess', () => {
  const procs: WorkerProcess[] = [];
  afterEach(async () => {
    for (const p of procs.splice(0)) await p.dispose();
  });
  const make = (o: Partial<ConstructorParameters<typeof WorkerProcess>[0]> = {}) => {
    const p = new WorkerProcess({ resolveLaunch: () => ({ command: process.execPath, args: [path.join(__dirname, 'support', 'fakeWorker.cjs')], cwd: __dirname, env: {} }), requestTimeoutMs: 1500, ...o });
    procs.push(p);
    return p;
  };

  it('starts lazily, answers, restarts after a crash with a new epoch, stops after repeated crashes', async () => {
    const p = make({ maxCrashes: 2 });
    expect(p.running).toBe(false);
    await p.request('initialize', { protocolVersion: 1, roots: [] });
    const e1 = p.sessionEpoch();
    await expect(p.request('related', { uri: 'file:///crash', position: { line: 0, character: 0 }, documents: [] })).rejects.toMatchObject({ code: 'WorkerCrashed' });
    await p.request('initialize', { protocolVersion: 1, roots: [] });
    expect(p.sessionEpoch()).not.toBe(e1);
    await expect(p.request('related', { uri: 'file:///crash', position: { line: 0, character: 0 }, documents: [] })).rejects.toMatchObject({ code: 'WorkerCrashed' });
    expect(() => p.request('initialize', { protocolVersion: 1, roots: [] })).toThrow(/not restarted automatically/);
    p.resetCrashes();
    await p.request('initialize', { protocolVersion: 1, roots: [] });
  });

  it('times out a request that gets no answer, and shuts down when idle', async () => {
    const p = make({ idleShutdownMs: 300 });
    await expect(p.request('related', { uri: 'file:///hang', position: { line: 0, character: 0 }, documents: [] })).rejects.toMatchObject({ code: 'WorkerTimeout' });
    await p.request('initialize', { protocolVersion: 1, roots: [] });
    for (let i = 0; i < 40 && p.running; i++) await new Promise((r) => setTimeout(r, 100));
    expect(p.running).toBe(false);
  });
});

describe('Find filters component: and page:', () => {
  it('parse and refuse combinations', async () => {
    const { parseFindQuery } = await import('@refyntra/application');
    expect(parseFindQuery('component:Button')).toMatchObject({ web: 'component', text: 'Button', errors: [] });
    expect(parseFindQuery('page: orders')).toMatchObject({ web: 'page', text: 'orders', errors: [] });
    expect(parseFindQuery('page:x route:/a').errors[0]).toMatch(/page: lists web framework routes/);
  });
});
