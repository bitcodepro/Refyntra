import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Range, StructureMember, StructureType } from '@refyntra/contracts';
import { DEFAULT_FILTERS, type DocSymbol, type StructureInput, filterOf, fromDocumentSymbols, hiddenFiltersText, loadFilters, nameMatches, rowAtLine, structureSections } from '../../src/fileStructureModel';

const r = (start: number, end = start): Range => ({ start: { line: start, character: 4 }, end: { line: end, character: 5 } });

const m = (name: string, kind: StructureMember['kind'], line: number, extra: Partial<StructureMember> = {}): StructureMember => ({
  name,
  kind,
  accessibility: 'public',
  isStatic: false,
  signature: `${name}()`,
  range: r(line),
  selectionRange: r(line),
  navigable: true,
  ...extra,
});

const t = (name: string, start: number, end: number, members: StructureMember[], extra: Partial<StructureType> = {}): StructureType => ({
  name,
  fullName: name,
  kind: 'class',
  accessibility: 'public',
  isStatic: false,
  signature: `${name} : Base`,
  range: r(start, end),
  selectionRange: r(start),
  members,
  inherited: [],
  ...extra,
});

const order = t(
  'Order',
  2,
  40,
  [
    m('MaxLines', 'constant', 4, { region: 'Fields', isStatic: true }),
    m('_lines', 'field', 5, { region: 'Fields', accessibility: 'private' }),
    m('Order', 'constructor', 8),
    m('Total', 'property', 11, { region: 'Queries' }),
    m('GetOrderLines', 'method', 12, { region: 'Queries', range: r(12, 15) }),
    m('Changed', 'event', 17),
  ],
  {
    inherited: [
      m('Id', 'property', 5, { declaringType: 'Entity<int>', uri: 'file:///ws/Entity.cs', accessibility: 'protected' }),
      m('Raise', 'method', 9, { declaringType: 'Entity<int>', uri: 'file:///ws/Entity.cs' }),
      m('StackTrace', 'property', 0, { declaringType: 'Exception', navigable: false }),
    ],
  },
);
const line = t('Line', 30, 38, [m('Sku', 'property', 32)], { fullName: 'Order.Line', containingType: 'Order' });
const input: StructureInput = { types: [order, line], accessibility: true, inheritedAvailable: true };

const titles = (s: ReturnType<typeof structureSections>) => s.map((x) => [x.title, x.rows.map((row) => row.label)]);

describe('File Structure sections', () => {
  it('groups by type and #region, in source order, with kind and accessibility in words', () => {
    const s = structureSections(input, DEFAULT_FILTERS);
    expect(titles(s)).toEqual([
      ['Order : Base', ['Order']],
      ['Order · #region Fields', ['MaxLines()', '_lines()']],
      ['Order', ['Order()']],
      ['Order · #region Queries', ['Total()', 'GetOrderLines()']],
      ['Order', ['Changed()']],
      ['Line : Base', ['Order.Line', 'Sku()']],
    ]);
    const rows = s.flatMap((x) => x.rows);
    expect(rows.find((x) => x.label === 'MaxLines()')?.description).toBe('constant · public static');
    expect(rows.find((x) => x.label === '_lines()')?.description).toBe('field · private');
    expect(rows.find((x) => x.label === 'Order')).toMatchObject({ isType: true, icon: 'symbol-class', description: 'class · public' });
    expect(rows.find((x) => x.label === 'Order()')?.icon).toBe('symbol-constructor');
  });

  it('filters: member kinds, nested types; inherited members only when asked, per declaring type, metadata not navigable', () => {
    const noMethods = structureSections(input, { ...DEFAULT_FILTERS, methods: false, fields: false, nestedTypes: false });
    expect(noMethods.flatMap((x) => x.rows.map((row) => row.label))).toEqual(['Order', 'Total()', 'Changed()']);
    const inherited = structureSections(input, { ...DEFAULT_FILTERS, inherited: true });
    const tail = inherited.filter((x) => x.title.includes('inherited'));
    expect(titles(tail)).toEqual([
      ['Order · inherited from Entity<int>', ['Id()', 'Raise()']],
      ['Order · inherited from Exception', ['StackTrace()']],
    ]);
    expect(tail[0]!.rows[0]).toMatchObject({ inherited: true, navigable: true, uri: 'file:///ws/Entity.cs', description: 'property · protected' });
    expect(tail[1]!.rows[0]).toMatchObject({ navigable: false, description: 'property · public · no source (metadata)' });
    // The fallback (document symbols) never shows inherited members.
    expect(structureSections({ ...input, inheritedAvailable: false }, { ...DEFAULT_FILTERS, inherited: true }).some((x) => x.title.includes('inherited'))).toBe(false);
  });

  it('type-to-filter with camel humps keeps matching members (and their type section)', () => {
    expect(nameMatches('gOL', 'GetOrderLines')).toBe(true);
    expect(nameMatches('tot', 'Total')).toBe(true);
    expect(nameMatches('xyz', 'Total')).toBe(false);
    expect(titles(structureSections(input, DEFAULT_FILTERS, 'gOL'))).toEqual([['Order · #region Queries', ['GetOrderLines()']]]);
    expect(titles(structureSections(input, DEFAULT_FILTERS, 'sku'))).toEqual([['Line : Base', ['Sku()']]]);
    expect(structureSections(input, DEFAULT_FILTERS, 'nothing')).toEqual([]);
  });

  it('the first selected row is the innermost own row at the cursor', () => {
    const s = structureSections(input, DEFAULT_FILTERS);
    expect(rowAtLine(s, 13)?.label).toBe('GetOrderLines()');
    expect(rowAtLine(s, 33)?.label).toBe('Order.Line');
    expect(rowAtLine(s, 20)?.label).toBe('Order');
    expect(rowAtLine(s, 99)).toBeUndefined();
  });

  it('filters: stored values read back, title text for what is hidden', () => {
    expect(loadFilters(undefined)).toEqual(DEFAULT_FILTERS);
    expect(loadFilters({ fields: false, inherited: true, bogus: 1, methods: 'no' })).toEqual({ ...DEFAULT_FILTERS, fields: false, inherited: true });
    expect(hiddenFiltersText({ ...DEFAULT_FILTERS, fields: false, events: false }, true)).toBe('hidden: fields, events');
    expect(hiddenFiltersText({ ...DEFAULT_FILTERS, inherited: true }, true)).toBe('with inherited members');
    expect(hiddenFiltersText({ ...DEFAULT_FILTERS, inherited: true }, false)).toBe('');
    expect([filterOf('operator'), filterOf('indexer'), filterOf('enumMember'), filterOf('event')]).toEqual(['methods', 'properties', 'fields', 'events']);
  });
});

describe('File Structure from document symbols (other languages)', () => {
  const sym = (name: string, kind: number, start: number, end: number, children: DocSymbol[] = [], detail?: string): DocSymbol => ({ name, kind, range: r(start, end), selectionRange: r(start), children, ...(detail ? { detail } : {}) });

  it('classes, interfaces and enums become types; namespaces are flattened; top-level functions get a file section', () => {
    const input2 = fromDocumentSymbols(
      [
        sym('load', 11, 0, 3, [], '(id: string)'),
        sym('ns', 2, 5, 40, [sym('Store', 4, 6, 30, [sym('constructor', 8, 7, 8), sym('items', 7, 9, 9), sym('get', 5, 10, 12), sym('Kind', 9, 14, 20, [sym('A', 21, 15, 15)])]), sym('IStore', 10, 32, 35, [sym('get', 5, 33, 33)])]),
      ],
      'store.ts',
    );
    expect(input2).toMatchObject({ accessibility: false, inheritedAvailable: false, fileSection: 'store.ts' });
    expect(input2.types.map((x) => [x.fullName, x.kind, x.containingType ?? null, x.members.map((mm) => `${mm.kind}:${mm.signature}`)])).toEqual([
      ['store.ts', 'class', null, ['method:load(id: string)']],
      ['Store', 'class', null, ['constructor:constructor', 'field:items', 'method:get']],
      ['Store.Kind', 'enum', 'Store', ['enumMember:A']],
      ['IStore', 'interface', null, ['method:get']],
    ]);
    const s = structureSections(input2, DEFAULT_FILTERS);
    expect(s.flatMap((x) => x.rows).find((row) => row.label === 'items')?.description).toBe('field');
    // The file section has no type row of its own.
    expect(s[0]).toMatchObject({ title: 'store.ts', rows: [{ label: 'load(id: string)', description: 'method' }] });
  });
});

describe('File Structure keybinding and setting', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; mac?: string; when: string }[]; configuration: { properties: Record<string, { type: string; default: unknown }> } };
  };

  it('Ctrl+F12 (Cmd+F12 on macOS) in both presets, in any editor; preview off by default', () => {
    const keys = pkg.contributes.keybindings.filter((k) => k.command === 'refyntra.fileStructure');
    expect(keys.map((k) => [k.key, k.mac, /preset == '(\w+)'/.exec(k.when)?.[1], /editorTextFocus/.test(k.when)])).toEqual([
      ['ctrl+f12', 'cmd+f12', 'visualStudio', true],
      ['ctrl+f12', 'cmd+f12', 'resharper', true],
    ]);
    expect(pkg.contributes.configuration.properties['refyntra.fileStructure.preview']).toMatchObject({ type: 'boolean', default: false });
  });
});
