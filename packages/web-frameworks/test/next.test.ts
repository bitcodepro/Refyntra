import { describe, expect, it } from 'vitest';
import { matchNextRoute, nextRouteForFile } from '../src/nextRoutes';
import { analyzer, fixture, kinds, labels, related } from './helpers';

// Next.js conventions (pure) and the worker's Next.js relations (tests/fixtures/WebNext, WebNextPages; synthetic).

describe('Next.js route conventions', () => {
  it('app router: groups, dynamic, catch-all, optional catch-all, parallel and intercepting routes', () => {
    expect(nextRouteForFile('app/page.tsx', 15)).toMatchObject({ router: 'app', kind: 'page', template: '/', dynamic: false });
    expect(nextRouteForFile('src/app/(shop)/orders/[id]/page.tsx', 15)).toMatchObject({ template: '/orders/[id]', dynamic: true, groups: ['(shop)'] });
    expect(nextRouteForFile('app/docs/[...slug]/page.tsx', 15)).toMatchObject({ template: '/docs/[...slug]', catchAll: true });
    expect(nextRouteForFile('app/shop/[[...f]]/page.tsx', 15)).toMatchObject({ template: '/shop/[[...f]]', catchAll: true });
    const modal = nextRouteForFile('app/@modal/(.)photos/[id]/page.tsx', 15)!;
    expect(modal).toMatchObject({ template: '/photos/[id]', slots: ['@modal'], intercepting: '(.)' });
    expect(modal.limitations.join(' ')).toMatch(/Intercepting route \(\.\)/);
    expect(nextRouteForFile('app/(..)(..)feed/page.tsx', 15)).toMatchObject({ intercepting: '(..)(..)', template: '/feed' });
    expect(nextRouteForFile('app/api/orders/route.ts', 15)).toMatchObject({ kind: 'route', template: '/api/orders' });
    expect(nextRouteForFile('app/orders/layout.tsx', 15)).toMatchObject({ kind: 'layout', template: '/orders' });
    expect(nextRouteForFile('app/_private/page.tsx', 15)).toBeUndefined();
    expect(nextRouteForFile('app/components/Counter.tsx', 15)).toBeUndefined();
  });

  it('pages router and version gates', () => {
    expect(nextRouteForFile('pages/index.jsx', 12)).toMatchObject({ router: 'pages', kind: 'page', template: '/' });
    expect(nextRouteForFile('pages/blog/[slug].jsx', 12)).toMatchObject({ template: '/blog/[slug]', dynamic: true });
    expect(nextRouteForFile('pages/api/hello.js', 12)).toMatchObject({ kind: 'api', template: '/api/hello' });
    expect(nextRouteForFile('pages/_app.jsx', 12)).toMatchObject({ kind: 'special' });
    expect(nextRouteForFile('app/ignored/page.jsx', 12)).toBeUndefined(); // no app router before 13
    expect(nextRouteForFile('app/page.tsx', undefined)!.limitations[0]).toMatch(/version is unknown/);
  });

  it('matches literal paths to templates', () => {
    expect(matchNextRoute('/orders/42?tab=1', '/orders/[id]')).toBeDefined();
    expect(matchNextRoute('/orders', '/orders/[id]')).toBeUndefined();
    expect(matchNextRoute('/docs/a/b', '/docs/[...slug]')).toBeDefined();
    expect(matchNextRoute('/docs', '/docs/[...slug]')).toBeUndefined();
    expect(matchNextRoute('/shop', '/shop/[[...f]]')).toBeDefined();
    expect(matchNextRoute('/orders/${id}', '/orders/[id]')).toBeDefined();
    expect(matchNextRoute('/${x}', '/orders')).toBeUndefined();
    expect(matchNextRoute('/orders/new', '/orders/new')!.score).toBeGreaterThan(matchNextRoute('/orders/new', '/orders/[id]')!.score);
  });
});

describe('Next.js relations (worker)', () => {
  const ROOT = fixture('WebNext');
  const a = analyzer(ROOT);

  it('a dynamic page: its route, its clients (Link href) and the wrapping layout; limitations listed', () => {
    const r = related(a, ROOT, 'app/(shop)/orders/[id]/page.tsx', 'export default', 1);
    const route = kinds(r, 'next.route')[0]!;
    expect(route.endpoint).toMatchObject({ kind: 'next-page', route: '/orders/[id]', routeIsDynamic: true });
    expect(route.confidence).toBe('likely');
    expect(route.limitations.join('\n')).toMatch(/full routing graph .* is never claimed/);
    expect(route.limitations.join('\n')).toMatch(/middleware\.ts can rewrite/);
    expect(route.limitations.join('\n')).toMatch(/next\.config\.mjs configures rewrites/);
    expect(route.limitations.join('\n')).toMatch(/Dynamic segments/);
    expect(labels(r, 'next.link')).toEqual(['href("/orders/42") in page.tsx']);
    expect(kinds(r, 'next.link')[0]!.confidence).toBe('heuristic');
    expect(labels(r, 'next.layout')).toEqual(['layout app/layout.tsx']);
    expect(labels(r, 'next.serverComponent')).toHaveLength(1);
  });

  it('a route handler: exported methods as an endpoint; fetch callers as clients', () => {
    const r = related(a, ROOT, 'app/api/orders/route.ts', 'GET', 0);
    expect(kinds(r, 'next.route')[0]!.endpoint).toMatchObject({ kind: 'next-route-handler', route: '/api/orders', httpMethods: ['GET', 'POST'] });
    expect(labels(r, 'next.link')).toEqual(['fetch("/api/orders") in actions.ts']);
  });

  it('a literal href: the route it reaches (heuristic); a path without a route gives nothing', () => {
    const docs = related(a, ROOT, 'app/page.tsx', '/docs/getting', 2);
    expect(kinds(docs, 'next.linkTarget').map((x) => x.endpoint!.route)).toEqual(['/docs/[...slug]']);
    expect(kinds(docs, 'next.linkTarget')[0]!.limitations[0]).toMatch(/Heuristic/);
    const none = related(a, ROOT, 'app/page.tsx', '/nowhere', 2);
    expect(kinds(none, 'next.linkTarget')).toEqual([]);
    const push = related(a, ROOT, 'app/components/Counter.tsx', "'/orders'", 2);
    expect(kinds(push, 'next.linkTarget').map((x) => x.endpoint!.route)).toEqual(['/orders']);
  });

  it("'use client' / 'use server' boundaries and a server page importing a client component", () => {
    const counter = related(a, ROOT, 'app/components/Counter.tsx', 'export function', 1);
    expect(labels(counter, 'next.clientBoundary')).toEqual(["Client component boundary ('use client')"]);
    const actions = related(a, ROOT, 'app/actions.ts', 'saveOrder', 1);
    expect(labels(actions, 'next.serverActions')).toEqual(["Server actions module ('use server')"]);
    const home = related(a, ROOT, 'app/page.tsx', 'export default', 1);
    expect(labels(home, 'next.clientImport')).toEqual(['Imports client component module Counter.tsx']);
  });

  it('intercepting and parallel routes are marked, private folders are not routes', () => {
    const modal = related(a, ROOT, 'app/@modal/(.)photos/[id]/page.tsx', 'export default', 1);
    const lim = kinds(modal, 'next.route')[0]!.limitations.join('\n');
    expect(lim).toMatch(/Intercepting route/);
    expect(lim).toMatch(/Parallel route slot @modal/);
    expect(kinds(related(a, ROOT, 'app/_private/page.tsx', 'export default', 1), 'next.route')).toEqual([]);
  });

  it('Find page: lists endpoint routes with dynamic markers', () => {
    const r = a.find({ kind: 'page', text: '', limit: 50, documents: [] });
    expect(r.items.map((i) => i.label)).toEqual(['/', '/docs/[...slug] (dynamic)', '/orders', '/orders/[id] (dynamic)', '/photos/[id] (dynamic)', '/photos/[id] (dynamic)', '/shop/[[...filters]] (dynamic)', 'GET,POST /api/orders']);
    expect(a.find({ kind: 'page', text: 'orders', limit: 50, documents: [] }).items).toHaveLength(3);
  });
});

describe('Next.js pages router (Next 12)', () => {
  const ROOT = fixture('WebNextPages');
  const a = analyzer(ROOT);

  it('pages, API routes and the special _app; app/ is ignored before Next 13', () => {
    const r = a.find({ kind: 'page', text: '', limit: 50, documents: [] });
    expect(r.items.map((i) => `${i.label}|${i.description}`)).toEqual(['/ |Next.js pages router page'.replace(' |', '|'), '/api/hello|Next.js pages router api', '/blog/[slug] (dynamic)|Next.js pages router page']);
    const index = related(a, ROOT, 'pages/index.jsx', '/blog/hello', 2);
    expect(kinds(index, 'next.linkTarget').map((x) => x.endpoint!.route)).toEqual(['/blog/[slug]']);
    expect(kinds(related(a, ROOT, 'app/ignored/page.jsx', 'export default', 1), 'next.route')).toEqual([]);
  });
});
