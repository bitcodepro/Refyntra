import { describe, expect, it } from 'vitest';
import type { EndpointInfo } from '@refyntra/contracts';
import { matchCall, scanClientCalls } from '../src';

let line = 0;
function ep(methods: string[], route: string, dynamic = false): EndpointInfo {
  return { httpMethods: methods, route, routeIsDynamic: dynamic, kind: 'mvc', location: { uri: 'file:///w/Api/Controllers.cs', range: { start: { line: line++, character: 0 }, end: { line, character: 1 } } } };
}

const ENDPOINTS = [
  ep(['GET'], '/api/Orders/{id:int}'),
  ep(['POST'], '/api/Orders'),
  ep(['GET'], '/api/Orders/recent'),
  ep(['DELETE'], '/api/legacy/orders/{id}'),
  ep([], '/files/{*path}'),
  ep(['GET'], '/api/items/{id?}'),
  ep(['GET'], '/api/a/{x}'),
  ep(['GET'], '/api/a/{y}'),
  ep(['GET'], '/dyn/{x}', true),
];

function match(src: string, opts = {}) {
  const [call] = scanClientCalls(src);
  return matchCall(call!, ENDPOINTS, opts);
}

describe('HTTP route matching', () => {
  it('literal segments case-insensitive, trailing slash ignored, parameters and constraints', () => {
    const m = match("fetch('/API/orders/42/')");
    expect(m.status).toBe('linked');
    expect(m.candidates[0]!.route).toBe('/api/Orders/{id:int}');
    expect(match('fetch(`/api/orders/${id}`)').candidates.map((e) => e.route)).toEqual(['/api/Orders/{id:int}']);
    // int constraint: a non-numeric literal does not match {id:int}
    expect(match("fetch('/api/orders/abc')").status).toBe('unmatched');
  });

  it('prefers a literal route over a parameter (ASP.NET precedence)', () => {
    const m = match("fetch('/api/orders/recent')");
    expect(m.status).toBe('linked');
    expect(m.candidates[0]!.route).toBe('/api/Orders/recent');
  });

  it('a client parameter matches only route parameters; :id placeholders are parameters', () => {
    expect(match("axios.delete('/api/legacy/orders/:id')").candidates.map((e) => e.route)).toEqual(['/api/legacy/orders/{id}']);
    expect(match("fetch('/api/orders/' + name)").candidates.map((e) => e.route)).toEqual(['/api/Orders/{id:int}']);
  });

  it('methods must match when known; unknown methods accept any', () => {
    const m = match("fetch('/api/orders/1', { method: 'POST' })");
    expect(m.status).toBe('unmatched');
    expect(m.reason).toMatch(/not the method POST/);
    expect(match("axios.post('/api/orders')").status).toBe('linked');
    expect(match("fetch('/api/orders', opts)").candidates.map((e) => e.route)).toEqual(['/api/Orders']);
    expect(match("axios.put('/files/a/b/c.txt')").candidates.map((e) => e.route)).toEqual(['/files/{*path}']);
  });

  it('optional parameters and catch-all', () => {
    expect(match("fetch('/api/items')").status).toBe('linked');
    expect(match("fetch('/api/items/3')").status).toBe('linked');
    expect(match("fetch('/files')").status).toBe('linked');
  });

  it('ambiguity lists every equally good candidate; dynamic routes are never matched', () => {
    const m = match("fetch('/api/a/1')");
    expect(m.status).toBe('ambiguous');
    expect(m.candidates.map((e) => e.route).sort()).toEqual(['/api/a/{x}', '/api/a/{y}']);
    expect(match("fetch('/dyn/1')").status).toBe('unmatched');
  });

  it('base paths: exact match only by default; configured prefixes are removed from the client path', () => {
    expect(match("fetch('/backend/api/orders/1')").status).toBe('unmatched');
    const m = match("fetch('/backend/api/orders/1')", { basePaths: ['backend/'] });
    expect(m.status).toBe('linked');
    expect(m.strippedBase).toBe('/backend');
  });

  it('other hosts are not linked unless their origin is configured', () => {
    expect(match("fetch('https://example.com/api/orders/1')").status).toBe('otherOrigin');
    expect(match("fetch('https://Example.com/api/orders/1')", { origins: ['https://example.com/'] }).status).toBe('linked');
  });

  it('unresolved URLs report why', () => {
    const m = match('fetch(baseUrl + `/orders`)');
    expect(m.status).toBe('unresolved');
    expect(m.reason).toMatch(/^URL not resolvable/);
  });
});
