import { describe, expect, it } from 'vitest';
import { angularSupport, majorOf } from '../src/versions';
import { elementSelectors } from '../src/worker/angular';
import { analyzer, fixture, kinds, labels, related } from './helpers';

// Angular relations through the bundled Angular language service (tests/fixtures/WebAngular: standalone components,
// an NgModule, DI and routes; WebAngularOld: an unsupported major). Synthetic fixtures with stub declarations.

describe('Angular version policy', () => {
  it('reads majors from versions and ranges', () => {
    expect(majorOf('^22.1.0')).toBe(22);
    expect(majorOf('~12.2.0')).toBe(12);
    expect(majorOf('>=17.0.0')).toBe(17);
    expect(majorOf('22.2.1')).toBe(22);
    expect(majorOf('latest')).toBeUndefined();
    expect(majorOf('workspace:^19.0.0')).toBe(19);
  });
  it('supports 17–22 and refuses others with a reason', () => {
    expect(angularSupport(22)).toEqual({ supported: true });
    expect(angularSupport(17)).toEqual({ supported: true });
    expect(angularSupport(12).reason).toMatch(/Angular 12 is older/);
    expect(angularSupport(23).reason).toMatch(/Angular 23 is newer/);
    expect(angularSupport(undefined).supported).toBe(false);
  });
  it('element selectors', () => {
    expect(elementSelectors('app-card, [appX], .x')).toEqual(['app-card']);
  });
});

describe('Angular relations (bundled language service)', () => {
  const ROOT = fixture('WebAngular');
  const a = analyzer(ROOT);

  // The first query loads the Angular language service bundle and builds the TypeScript program: on a busy machine
  // (all unit test files in parallel, e.g. in a container) that alone can take longer than the default 10 s.
  it('component class: template file, styles, inputs/outputs with bindings, selector usages, route', { timeout: 60_000 }, () => {
    const r = related(a, ROOT, 'src/app/orders/order-card.component.ts', 'class OrderCardComponent', 7);
    expect(r.subject).toBe('OrderCardComponent');
    expect(labels(r, 'angular.template')).toEqual(['Template ./order-card.component.html']);
    expect(kinds(r, 'angular.template')[0]!.location!.uri).toMatch(/order-card\.component\.html$/);
    expect(kinds(r, 'angular.style')).toEqual([]); // stylesheet links belong to the web.styles route
    expect(labels(r, 'angular.input')).toEqual(['orderId (input, 2 template uses)', 'title (input, 3 template uses)']);
    expect(labels(r, 'angular.output')).toEqual(['selected (output, 1 template use)']);
    expect(labels(r, 'angular.selectorUsage')).toEqual(['<app-order-card> in OrderListComponent (order-list.component.ts:10)', '<app-order-card> in OrderListComponent (order-list.component.ts:11)']);
    expect(kinds(r, 'angular.selectorUsage').every((x) => x.confidence === 'proven')).toBe(true);
    const route = kinds(r, 'angular.route')[0]!;
    expect(route.endpoint).toMatchObject({ kind: 'angular-route', route: '/orders/:id', routeIsDynamic: true });
    expect(route.label).toBe('/orders/:id → OrderCardComponent from ./orders/order-card.component (lazy)');
  });

  it('inline template: element and binding resolve to the component and its input', () => {
    const el = related(a, ROOT, 'src/app/orders/order-list.component.ts', '<app-order-card', 3);
    expect(labels(el, 'angular.selectorTarget')).toEqual(['OrderCardComponent (component app-order-card)']);
    const input = related(a, ROOT, 'src/app/orders/order-list.component.ts', '[orderId]', 2);
    expect(labels(input, 'angular.input')).toEqual(['OrderCardComponent.orderId (input)']);
  });

  it('template file: its component and the class member a binding uses', () => {
    const r = related(a, ROOT, 'src/app/orders/order-card.component.html', 'title', 1);
    expect(labels(r, 'angular.templateOwner')).toEqual(['OrderCardComponent (component of this template)']);
    expect(kinds(r, 'angular.input').map((x) => x.label)).toEqual(['OrderCardComponent.title (input)']);
  });

  it('input member: its template bindings', () => {
    const r = related(a, ROOT, 'src/app/orders/order-card.component.ts', 'orderId = 0', 1);
    expect(labels(r, 'angular.binding')).toEqual(['orderId in template order-list.component.ts:10', 'orderId in template order-list.component.ts:11']);
  });

  it('NgModule components: selector usage across modules, declarations, DI provider and constructor injection', () => {
    const banner = related(a, ROOT, 'src/app/shared/banner.component.ts', 'class BannerComponent', 7);
    expect(labels(banner, 'angular.selectorUsage')).toEqual(['<app-banner> in HomeComponent (home.component.ts:6)']);
    expect(labels(banner, 'angular.ngModule')).toEqual(['declared in SharedModule (shared.module.ts:6)', 'exported by SharedModule (shared.module.ts:7)']);
    const audit = related(a, ROOT, 'src/app/shared/audit.service.ts', 'class AuditService', 7);
    expect(labels(audit, 'angular.provider')).toEqual(['providers of SharedModule (shared.module.ts:8)']);
    expect(labels(audit, 'angular.injection')).toEqual(['constructor parameter audit in banner.component.ts:12']);
  });

  it('injectable providedIn root and inject() calls', () => {
    const r = related(a, ROOT, 'src/app/orders/order.service.ts', 'class OrderService', 7);
    expect(labels(r, 'angular.providedIn')).toEqual(["providedIn: 'root'"]);
    expect(labels(r, 'angular.injection')).toEqual(['inject(OrderService) in order-list.component.ts:15']);
  });

  it('route definitions: nested paths', () => {
    const r = related(a, ROOT, 'src/app/app.routes.ts', "path: ''", 2, 1);
    expect(kinds(r, 'angular.route').map((x) => x.endpoint!.route)).toEqual(['/orders']);
    const find = a.find({ kind: 'page', text: '', limit: 50, documents: [] });
    expect(find.items.map((i) => `${i.label} ${i.description}`)).toEqual(['/ Angular route → HomeComponent', '/orders Angular route', '/orders Angular route → OrderListComponent', '/orders/:id Angular route → OrderCardComponent from ./orders/order-card.component']);
  });

  it('Find component lists Angular components with selectors', () => {
    const r = a.find({ kind: 'component', text: 'order', limit: 50, documents: [] });
    expect(r.items.map((i) => `${i.label} ${i.description}`)).toEqual(['OrderCardComponent Angular component <app-order-card>', 'OrderListComponent Angular component <app-order-list>']);
  });
});

describe('Angular: unsupported major', () => {
  const ROOT = fixture('WebAngularOld');
  const a = analyzer(ROOT);
  it('is refused with a reason, no relations', () => {
    const r = related(a, ROOT, 'src/legacy.component.ts', 'class LegacyComponent', 7);
    expect(r.relations).toEqual([]);
    expect(r.notes).toEqual([expect.stringMatching(/^Angular: Angular 12 is older than the versions the bundled Angular language service 22\.2\.1 understands \(17–22\)/)]);
    expect(a.find({ kind: 'component', text: '', limit: 10, documents: [] }).notes[0]).toMatch(/Angular 12/);
  });
});
