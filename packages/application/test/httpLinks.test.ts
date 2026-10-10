import { describe, expect, it } from 'vitest';
import type { EndpointInfo, RelatedResult, SymbolRef } from '@refyntra/contracts';
import { HttpLinkService, type LanguageAdapter, type RouteResult, parseFindQuery } from '../src';

const owned = { kind: 'owned-semantic' as const, providerRouteId: 'csharp.roslyn', sessionEpoch: 'e1', snapshotId: 's1', projectContextId: 'p' };
const loc = (uri: string, line: number) => ({ uri, range: { start: { line, character: 0 }, end: { line, character: 5 } } });
const handler = (name: string, line: number): SymbolRef => ({ name, displayName: `Api.OrdersController.${name}(int)`, kind: 'method', location: loc('file:///w/Api/OrdersController.cs', line), origin: 'source', provenance: owned });

const GET_ORDER: EndpointInfo = { httpMethods: ['GET'], route: '/api/Orders/{id:int}', routeIsDynamic: false, kind: 'mvc', location: loc('file:///w/Api/OrdersController.cs', 10), handler: handler('GetOrder', 10) };
const CREATE: EndpointInfo = { httpMethods: ['POST'], route: '/api/Orders', routeIsDynamic: false, kind: 'mvc', location: loc('file:///w/Api/OrdersController.cs', 20), handler: handler('Create', 20) };

const FILES: Record<string, string> = {
  'file:///w/web/src/orders.ts': "export const load = (id: number) => fetch(`/api/orders/${id}`);\nexport const create = () => axios.post('/api/orders', {});\nexport const gone = () => fetch('/api/missing');\n",
  'file:///w/web/src/other.js': "fetch(base + '/x');\n",
};

function result<T>(value: T): RouteResult<T> {
  return { value, providerRouteId: 'csharp.roslyn', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 1 };
}

function service(listed = Object.keys(FILES)) {
  const searches: unknown[] = [];
  const server = {
    descriptor: { providerRouteId: 'csharp.roslyn' },
    search: async (req: unknown) => {
      searches.push(req);
      return result({ items: [GET_ORDER, CREATE].map((endpoint) => ({ endpoint, score: 50 })), truncated: false, snapshotId: 's1' });
    },
  } as unknown as LanguageAdapter;
  let reads = 0;
  const svc = new HttpLinkService({
    server,
    clientRouteIds: ['typescript.vscode-providers'],
    files: {
      listFiles: async () => listed,
      readFile: async (uri) => {
        reads++;
        return FILES[uri];
      },
    },
    settings: { basePaths: () => [], origins: () => [] },
  });
  return { svc, searches, reads: () => reads };
}

describe('HTTP links (heuristic)', () => {
  it('a call site links to its endpoint and, through it, to the handler; every relation is heuristic', async () => {
    const { svc, searches } = service();
    const rels = await svc.callSiteRelations('file:///w/web/src/orders.ts', { line: 0, character: 40 });
    expect(searches[0]).toEqual({ query: '', filters: { route: '' }, limit: 5000 });
    expect(rels.map((r) => `${r.group}|${r.relationKind}|${r.target.label}`)).toEqual(['endpoints|http.call|GET /api/Orders/{id:int}', 'handlers|http.handler|Api.OrdersController.GetOrder(int)']);
    for (const r of rels) {
      expect(r.confidence).toBe('heuristic');
      expect(r.provenance.kind).toBe('heuristic');
      expect(r.limitations[0]).toMatch(/^Heuristic/);
    }
    expect(await svc.callSiteRelations('file:///w/web/src/orders.ts', { line: 2, character: 3 })).toEqual([]);
  });

  it('an endpoint lists its client call sites (group clients) from the workspace index', async () => {
    const { svc } = service();
    const language: RelatedResult = {
      subject: GET_ORDER.handler!,
      relations: [{ relationKind: 'aspnet.endpoint', group: 'endpoints', target: { endpoint: GET_ORDER, label: 'GET /api/Orders/{id:int}' }, evidence: [], confidence: 'proven', provenance: owned, limitations: [] }],
      completeness: 'complete',
      scopeNotes: [],
      snapshotId: 's1',
    };
    const rels = await svc.clientRelations({ subject: GET_ORDER.handler!, languageResult: result(language), language: {} as LanguageAdapter });
    expect(rels).toHaveLength(1);
    expect(rels[0]!.group).toBe('clients');
    expect(rels[0]!.target.location).toEqual({ uri: 'file:///w/web/src/orders.ts', range: { start: { line: 0, character: 36 }, end: { line: 0, character: 62 } } });
    expect(rels[0]!.target.label).toBe('GET /api/orders/{id} — orders.ts:1');
    // Nothing for a subject without endpoints.
    expect(await svc.clientRelations({ subject: null, languageResult: result({ ...language, relations: [] }), language: {} as LanguageAdapter })).toEqual([]);
  });

  it('Find client: lists unlinked calls with the reason; client:all lists every call', async () => {
    const { svc } = service();
    const unlinked = await svc.find('unlinked', '', 100);
    expect(unlinked.items.map((i) => `${i.label} · ${i.description}`)).toEqual([
      'GET /api/missing · Client call (heuristic) · no matching route',
      'GET (no URL) · Client call (heuristic) · URL not resolvable',
    ].map((s) => s.replace('(no URL)', "base + '/x'")));
    expect((await svc.find('all', '', 100)).items).toHaveLength(4);
    expect((await svc.find('all', 'missing', 100)).items).toHaveLength(1);
    expect(parseFindQuery('client:')).toMatchObject({ client: 'unlinked', text: '' });
    expect(parseFindQuery('client:all orders')).toMatchObject({ client: 'all', text: 'orders' });
    expect(parseFindQuery('client: route:/x').errors[0]).toMatch(/client:/);
  });

  it('the index scans once, is updated incrementally and skips files over the size limit', async () => {
    const { svc, reads } = service();
    await Promise.all([svc.index.ensureScanned(), svc.index.ensureScanned()]);
    expect(reads()).toBe(2);
    svc.index.fileChanged('file:///w/web/src/other.js', "fetch('/api/orders', { method: 'POST' });");
    svc.index.fileDeleted('file:///w/web/src/orders.ts');
    const all = await svc.find('all', '', 100);
    expect(all.items.map((i) => i.label)).toEqual(['POST /api/orders']);
    expect(reads()).toBe(2);
  });
});
