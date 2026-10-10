import { describe, expect, it } from 'vitest';
import { scanClientCalls } from '../src';

/** "METHOD path" (or "METHOD !reason") per call, the golden form of these tests. */
function golden(src: string): string[] {
  return scanClientCalls(src).map((c) => `${c.form} ${c.method ?? '?'} ${c.url ? `${c.url.origin ?? ''}${c.url.path}` : `!${c.reason}`}`);
}

describe('HTTP client call detection (golden)', () => {
  it('fetch with literals, templates, init objects and global receivers', () => {
    const src = [
      "fetch('/api/orders');",
      "fetch(\"/api/orders/7\", { method: 'DELETE' });",
      'await fetch(`/api/orders/${order.id}/lines/${lineId}`, { method: "put", body: JSON.stringify(x) });',
      "window.fetch('/api/ping', init);",
      "globalThis.fetch('api/health');",
      "fetch('/api/orders?page=2#top');",
    ].join('\n');
    expect(golden(src)).toEqual([
      'fetch GET /api/orders',
      'fetch DELETE /api/orders/7',
      'fetch PUT /api/orders/{id}/lines/{lineId}',
      'fetch ? /api/ping',
      'fetch GET /api/health',
      'fetch GET /api/orders',
    ]);
  });

  it('axios verbs, call and config forms, request(), instances with baseURL, aliases', () => {
    const src = `
import http from 'axios';
const api = http.create({ baseURL: '/api' });
axios.get('/api/orders/' + id);
axios.post<Order>(\`/api/orders\`, body);
axios({ url: '/api/orders/1', method: 'patch' });
axios('/api/things', { method: 'delete' });
axios.request({ url: '/api/req' });
http.put('/api/aliased/' + id);
api.get(\`/products/\${p}\`);
`;
    expect(golden(src)).toEqual([
      'axios.get GET /api/orders/{id}',
      'axios.post POST /api/orders',
      'axios PATCH /api/orders/1',
      'axios DELETE /api/things',
      'axios.request GET /api/req',
      'http.put PUT /api/aliased/{id}',
      'api.get GET /api/products/{p}',
    ]);
  });

  it('Angular HttpClient, AngularJS $http, ky and superagent', () => {
    const src = `
import request from 'superagent';
class OrdersApi {
  constructor(private http: HttpClient) {}
  load(id: number) { return this.http.get<Order[]>(\`/api/orders/\${id}\`); }
  save() { return this.httpClient.post('/api/orders', {}); }
}
$http.delete('/api/orders/3');
$http({ method: 'POST', url: '/api/legacy' });
ky.get('api/k');
ky('/api/k2', { method: 'post' });
superagent.del('/api/s/1');
request.get('/api/s2');
`;
    expect(golden(src)).toEqual([
      'http.get GET /api/orders/{id}',
      'httpClient.post POST /api/orders',
      '$http.delete DELETE /api/orders/3',
      '$http POST /api/legacy',
      'ky.get GET /api/k',
      'ky POST /api/k2',
      'superagent.del DELETE /api/s/1',
      'request.get GET /api/s2',
    ]);
  });

  it('concatenation with a constant base and same-file consts (no semicolons, typed consts)', () => {
    const src = `
const API = '/api'
const ORDERS: string = API + '/orders'
export const V = \`\${API}/v2\`
fetch(API + '/orders/' + id)
fetch(\`\${ORDERS}/\${id}/cancel\`, { method: 'POST' })
fetch(V + '/x')
`;
    expect(golden(src)).toEqual(['fetch GET /api/orders/{id}', 'fetch POST /api/orders/{id}/cancel', 'fetch GET /api/v2/x']);
  });

  it('absolute URLs keep their origin', () => {
    expect(golden("fetch('https://Example.com/api/orders');\nfetch('//cdn.example.com/x');")).toEqual(['fetch GET https://example.com/api/orders', 'fetch GET //cdn.example.com/x']);
  });

  it('never guesses: dynamic bases, partial segments, non-literal methods and unknown forms', () => {
    const src = `
fetch(baseUrl + '/orders');
fetch(\`\${config.api}/orders\`);
fetch('/api/orders-' + id);
fetch(url);
fetch('/api/x', { method: verb });
fetch('/api/y', options);
fetch(cond ? '/a' : '/b');
fetch('mailto:someone');
const BASE = '/one';
const BASE = '/two';
fetch(BASE + '/z');
`;
    const g = golden(src);
    expect(g[0]).toMatch(/^fetch GET !the URL starts with a value/);
    expect(g[1]).toMatch(/^fetch GET !the URL starts with a value/);
    expect(g[2]).toMatch(/!a parameter fills only part of a path segment/);
    expect(g[3]).toMatch(/!the URL starts with a value/);
    expect(g[4]).toBe('fetch ? /api/x');
    expect(g[5]).toBe('fetch ? /api/y');
    expect(g[6]).toMatch(/!the URL is not a literal/);
    expect(g[7]).toMatch(/!not an HTTP URL/);
    expect(g[8]).toMatch(/!the URL starts with a value/); // BASE declared twice: not a known constant
  });

  it('false positives: comments, strings, regexes, member calls and declarations are not calls', () => {
    const src = `
// fetch('/api/in-line-comment')
/* axios.get('/api/in-block-comment') */
const s = "fetch('/api/in-string')";
const t = \`axios.post('/api/in-template')\`;
const r = /fetch\\('\\/api\\/regex'\\)/;
cache.fetch('/api/not-global');
obj.axios.get('/api/member');
function fetch(u) { return u; }
class C { get(url) { return url; } }
const ok = a / b; fetch('/api/after-division');
`;
    expect(golden(src)).toEqual(['fetch GET /api/after-division']);
  });

  it('JSX text with an apostrophe does not swallow later calls; ranges span the call', () => {
    const src = "const v = <p>Don't panic</p>;\nexport function load() {\n  return fetch(\n    '/api/later'\n  );\n}\n";
    const calls = scanClientCalls(src);
    expect(calls.map((c) => c.url?.path)).toEqual(['/api/later']);
    expect(calls[0]!.range.start).toEqual({ line: 2, character: 9 });
    expect(calls[0]!.range.end.line).toBe(4);
  });

  it('template expressions with nested strings and braces', () => {
    expect(golden("fetch(`/api/orders/${ids.map((x) => `${x}`).join('}')}`);")).toEqual(['fetch GET /api/orders/{join}']);
  });
});
