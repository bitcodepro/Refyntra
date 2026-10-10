import { describe, expect, it } from 'vitest';
import { parseFindQuery } from '../src';

describe('Find filter parser', () => {
  it('parses flags and keeps free text', () => {
    expect(parseFindQuery('type:Order')).toEqual({ text: 'Order', filters: { type: true }, errors: [] });
    expect(parseFindQuery('member: Get  project:Shop.Api')).toEqual({ text: 'Get', filters: { member: true, project: 'Shop.Api' }, errors: [] });
  });

  it('parses endpoint filters and normalises the HTTP method', () => {
    expect(parseFindQuery('route:/api/orders method:post')).toEqual({ text: '', filters: { route: '/api/orders', method: 'POST' }, errors: [] });
  });

  it('supports quoted values', () => {
    expect(parseFindQuery('project:"My Project" Foo').filters.project).toBe('My Project');
  });

  it('keeps unknown prefixes as text (e.g. global::)', () => {
    expect(parseFindQuery('global::System foo:bar').text).toBe('global::System foo:bar');
  });

  it('reports conflicting or incomplete filters', () => {
    expect(parseFindQuery('type: member: x').errors).toContain('type: and member: cannot be combined');
    expect(parseFindQuery('method:FETCH').errors[0]).toMatch(/Unknown HTTP method/);
    expect(parseFindQuery('project:').errors[0]).toMatch(/project:/);
    expect(parseFindQuery('type: route:/x').errors[0]).toMatch(/cannot be combined/);
  });

  it('parses EF Core filters like type: (entity:) and route: (table:)', () => {
    expect(parseFindQuery('entity:Order')).toEqual({ text: 'Order', filters: { entity: true }, errors: [] });
    expect(parseFindQuery('entity:')).toEqual({ text: '', filters: { entity: true }, errors: [] });
    expect(parseFindQuery('table:orders project:Api')).toEqual({ text: '', filters: { table: 'orders', project: 'Api' }, errors: [] });
    expect(parseFindQuery('table:"order lines"').filters.table).toBe('order lines');
    expect(parseFindQuery('entity: route:/x').errors[0]).toMatch(/entity:\/table:/);
    expect(parseFindQuery('table:x member:').errors).toContain('entity:/table: search EF Core entities and cannot be combined with member:/route:/method:');
    expect(parseFindQuery('ENTITY:Foo').filters.entity).toBe(true);
  });

  it('is case-insensitive on filter names', () => {
    expect(parseFindQuery('TYPE:Foo').filters.type).toBe(true);
  });
});
