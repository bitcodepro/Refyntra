import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Location, SymbolRef } from '@refyntra/contracts';
import type { MergedRelation, RelationGroupView } from '@refyntra/domain';
import { companionFiles, countWords, fileStem, navigateTargets, referenceCount, targetOutcome } from '../../src/navigateToModel';

const loc = (uri: string, line = 1): Location => ({ uri, range: { start: { line, character: 4 }, end: { line, character: 9 } } });
const A = 'file:///ws/Shop/Order.cs';

function rel(group: string, kind: string, location: Location | undefined, limitations: string[] = []): MergedRelation {
  return {
    relationKind: kind,
    group,
    target: { label: kind, ...(location ? { location } : {}) },
    evidence: [],
    confidence: 'proven',
    limitations,
    provenance: { kind: 'owned-semantic', providerRouteId: 'csharp.roslyn' },
    provenances: [{ kind: 'owned-semantic', providerRouteId: 'csharp.roslyn' }],
  } as unknown as MergedRelation;
}

const groups = (map: Record<string, MergedRelation[]>): RelationGroupView[] => Object.entries(map).map(([group, relations]) => ({ group, relations }) as RelationGroupView);

const sym = (name: string, uri: string, line = 0): SymbolRef => ({ name, kind: 'class', location: loc(uri, line) }) as SymbolRef;

describe('Navigate To targets', () => {
  it('lists only targets that exist, in a fixed order, with counts in words', () => {
    const t = navigateTargets({
      subject: { name: 'IOrderService', kind: 'interface', location: loc(A) },
      currentUri: A,
      groups: groups({
        declarations: [rel('declarations', 'declaration', loc(A))],
        implementations: [rel('implementations', 'implementation', loc('file:///ws/Shop/A.cs')), rel('implementations', 'implementation', loc('file:///ws/Shop/B.cs'))],
        references: [rel('references', 'reference', loc('file:///ws/Shop/C.cs'))],
        handlers: [],
        registrations: [rel('registrations', 'di.registration', loc('file:///ws/Shop/Program.cs', 7))],
      }),
      bases: [],
      containing: [],
      siblingFiles: [],
    });
    expect(t.map((x) => [x.id, x.label, x.countText])).toEqual([
      ['declaration', 'Declaration', '1 declaration'],
      ['implementations', 'Implementations', '2 types'],
      ['usages', 'Usages', '1 usage'],
      ['registrations', 'DI registration', '1 registration'],
    ]);
  });

  it('labels by subject kind: derived types, base types / base symbols, implementations and overrides', () => {
    const base = { currentUri: A, containing: [], siblingFiles: [] as string[] };
    const cls = navigateTargets({ ...base, subject: { name: 'Customer', kind: 'class', location: loc(A) }, groups: groups({ implementations: [rel('implementations', 'implementation', loc('file:///ws/V.cs'))] }), bases: [sym('EntityBase', 'file:///ws/E.cs')] });
    expect(cls.map((x) => x.label)).toEqual(['Derived types', 'Base types']);
    const method = navigateTargets({ ...base, subject: { name: 'Audit', kind: 'method', location: loc(A) }, groups: groups({ implementations: [rel('implementations', 'implementation', loc('file:///ws/V.cs'))] }), bases: [sym('Audit', 'file:///ws/E.cs'), sym('Audit', 'file:///ws/I.cs')], callers: 3 });
    expect(method.map((x) => [x.label, x.countText])).toEqual([
      ['Implementations and overrides', '1 member'],
      ['Base symbols', '2 symbols'],
      ['Call hierarchy', '3 callers'],
    ]);
  });

  it('takes the real reference count from the Related limitation ("Showing 50 of N")', () => {
    const refs = Array.from({ length: 50 }, (_, i) => rel('references', 'reference', loc('file:///ws/R.cs', i), ['Showing 50 of 132 references; use Find References for all.']));
    expect(referenceCount(refs)).toEqual({ count: 132, more: false });
    const t = navigateTargets({ subject: { name: 'Find', kind: 'method', location: loc(A) }, currentUri: A, groups: groups({ references: refs }), bases: [], containing: [], siblingFiles: [] });
    expect(t.find((x) => x.id === 'usages')?.countText).toBe('132 usages');
    expect(targetOutcome(t.find((x) => x.id === 'usages')!)).toEqual({ kind: 'usages' });
  });

  it('related files: other partial parts and companions, never the current file; containing type and file', () => {
    const other = 'file:///ws/Shop/Order.Validation.cs';
    const t = navigateTargets({
      subject: { name: 'Order', kind: 'class', location: loc(other) },
      currentUri: 'file:///ws/Shop/Usage.cs',
      groups: groups({ declarations: [rel('declarations', 'declaration', loc(A)), rel('declarations', 'declaration', loc(other))] }),
      bases: [],
      containing: [sym('Outer', 'file:///ws/Shop/Outer.cs', 3)],
      siblingFiles: ['file:///ws/Shop/Order.Designer.cs', 'file:///ws/Shop/Usage.cs'],
    });
    const byId = Object.fromEntries(t.map((x) => [x.id, x]));
    expect(byId.declaration!.label).toBe('Declarations (partial parts)');
    expect(byId.files!.locations.map((l) => l.uri)).toEqual([A, other, 'file:///ws/Shop/Order.Designer.cs']);
    expect(byId.containingType!.countText).toBe('1 type');
    expect(byId.containingFile!.locations[0]!.uri).toBe(other);
    expect(targetOutcome(byId.containingType!)).toEqual({ kind: 'open', location: loc('file:///ws/Shop/Outer.cs', 3) });
    expect(targetOutcome(byId.files!).kind).toBe('peek');
  });

  it('framework relations, tests and the call hierarchy appear only when they exist', () => {
    const t = navigateTargets({
      subject: { name: 'GetOrderQuery', kind: 'record', location: loc(A) },
      currentUri: A,
      groups: groups({
        handlers: [rel('handlers', 'mediatr.handler', loc('file:///ws/H.cs'))],
        endpoints: [rel('endpoints', 'aspnet.endpoint', loc('file:///ws/P.cs', 12))],
        tests: [rel('tests', 'test', loc('file:///ws/T.cs')), rel('tests', 'test', undefined)],
      }),
      bases: [],
      containing: [],
      callers: 0,
      siblingFiles: [],
    });
    expect(t.map((x) => x.id)).toEqual(['tests', 'handlers', 'endpoints']);
    expect(t[0]!.count).toBe(1); // the "N more tests" row has no location
  });
});

describe('Navigate To helpers', () => {
  it('file stems of companions', () => {
    expect(fileStem('Order.cs')).toBe('Order');
    expect(fileStem('Order.Designer.cs')).toBe('Order');
    expect(fileStem('Order.g.cs')).toBe('Order');
    expect(fileStem('Index.cshtml.cs')).toBe('Index');
    expect(fileStem('Counter.razor')).toBe('Counter');
    expect(fileStem('MainWindow.xaml.cs')).toBe('MainWindow');
  });

  it('companion files: same stem, known extensions, not the file itself, sorted', () => {
    const dir = 'file:///ws/Pages/';
    expect(companionFiles(`${dir}Index.cshtml.cs`, [`${dir}Index.cshtml`, `${dir}Index.cshtml.cs`, `${dir}Index.cshtml.css`, `${dir}IndexHelper.cs`, `${dir}Index.json`])).toEqual([`${dir}Index.cshtml`, `${dir}Index.cshtml.css`]);
    expect(companionFiles(`${dir}Form1.cs`, [`${dir}Form1.Designer.cs`, `${dir}Form1.resx`])).toEqual([`${dir}Form1.Designer.cs`, `${dir}Form1.resx`]);
  });

  it('count words', () => {
    expect(countWords(1, 'usage')).toBe('1 usage');
    expect(countWords(2, 'registration')).toBe('2 registrations');
    expect(countWords(3, 'symbol')).toBe('3 symbols');
    expect(countWords(50, 'usage', true)).toBe('50+ usages');
  });
});

describe('Navigate To keybinding', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; mac?: string; when: string }[]; commands: { command: string; title: string }[] };
  };

  it('is Alt+` in the Visual Studio and ReSharper presets, C# editors only; Ctrl+Alt+` on macOS', () => {
    const keys = pkg.contributes.keybindings.filter((k) => k.command === 'refyntra.navigateTo');
    expect(keys.map((k) => [k.key, k.mac])).toEqual([
      ['alt+`', 'ctrl+alt+`'],
      ['alt+`', 'ctrl+alt+`'],
    ]);
    expect(keys.map((k) => /preset == '(\w+)'/.exec(k.when)?.[1])).toEqual(['visualStudio', 'resharper']);
    expect(keys.every((k) => k.when.includes('editorTextFocus') && k.when.includes('editorLangId == csharp'))).toBe(true);
    expect(pkg.contributes.commands.find((c) => c.command === 'refyntra.navigateTo')?.title).toBe('Navigate To…');
  });

  it('no other Refyntra binding uses the same keys', () => {
    const others = pkg.contributes.keybindings.filter((k) => k.command !== 'refyntra.navigateTo');
    expect(others.some((k) => k.key === 'alt+`' || k.mac === 'ctrl+alt+`')).toBe(false);
  });
});
