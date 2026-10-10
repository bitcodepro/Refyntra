import { describe, expect, it } from 'vitest';
import { readDocumentSymbols, readLocations, readWorkspaceEdit, readWorkspaceSymbols } from '../src';

const uri = (s: string) => ({ scheme: s.slice(0, s.indexOf(':')), toString: () => s });
const r = (l: number, a: number, b: number) => ({ start: { line: l, character: a }, end: { line: l, character: b } });

describe('structural readers of public provider results', () => {
  it('workspace symbols: the call-signature suffix "()" of the TypeScript extension is not part of the name', () => {
    const syms = readWorkspaceSymbols([{ name: 'getOrder()', kind: 11, containerName: '', location: { uri: uri('file:///a.ts'), range: r(0, 0, 9) } }]);
    expect(syms?.map((s) => [s.name, s.kind])).toEqual([['getOrder', 'method']]);
  });

  it('locations: Location and LocationLink; undefined means no answer at all', () => {
    expect(readLocations(undefined)).toBeUndefined();
    expect(readLocations([{ targetUri: uri('file:///b.ts'), targetRange: r(1, 0, 20), targetSelectionRange: r(1, 9, 17) }, { uri: uri('file:///c.ts'), range: r(2, 1, 3) }])).toEqual([
      { uri: 'file:///b.ts', range: r(1, 9, 17) },
      { uri: 'file:///c.ts', range: r(2, 1, 3) },
    ]);
  });

  it('document symbols are flattened with container names', () => {
    const syms = readDocumentSymbols([{ name: 'OrderService', kind: 4, range: r(0, 0, 30), selectionRange: r(0, 13, 25), children: [{ name: 'load', kind: 5, range: r(0, 15, 20), selectionRange: r(0, 15, 19), children: [] }] }], 'file:///a.ts');
    expect(syms?.map((s) => `${s.containerName ?? ''}/${s.name}`)).toEqual(['/OrderService', 'OrderService/load']);
  });

  it('workspace edit: merges entries per file and refuses resources counted by size but not listed', () => {
    const e = { entries: () => [[uri('file:///a.ts'), [{ range: r(0, 0, 1), newText: 'x' }]], [uri('file:///a.ts'), [{ range: r(1, 0, 1), newText: 'y' }]]], size: 2 };
    expect(readWorkspaceEdit({ ...e, size: 1 })).toMatchObject({ ok: false, reasonCode: 'ResourceOperation' });
    const ok = readWorkspaceEdit({ entries: () => [[uri('file:///a.ts'), [{ range: r(0, 0, 1), newText: 'x' }, { range: r(1, 0, 1), newText: 'y' }]]], size: 1 });
    expect(ok).toEqual({ ok: true, changes: [{ uri: 'file:///a.ts', edits: [{ range: r(0, 0, 1), newText: 'x' }, { range: r(1, 0, 1), newText: 'y' }] }] });
  });
});
