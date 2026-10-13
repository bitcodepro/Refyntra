import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type LineChange,
  RECENT_LIMIT,
  type RecentLocation,
  applyChanges,
  declaredName,
  deleteFiles,
  filesStore,
  insertedShape,
  loadFiles,
  loadLocations,
  locationSections,
  locationsStore,
  memberFromSymbols,
  memberFromText,
  reanchor,
  recentFileOrder,
  recordLocation,
  refreshLineTexts,
  relativePath,
  removeFile,
  removeLocation,
  renameFiles,
  renameLocations,
  touchFile,
} from '../../src/recentModel';

const A = 'file:///ws/A.cs';
const B = 'file:///ws/B.cs';
const C = 'file:///ws/C.cs';

const loc = (uri: string, line: number, kind: RecentLocation['kind'] = 'visited', character = 4): RecentLocation => ({ uri, line, character, kind, lineText: `line ${line}`, time: 1 });

const change = (startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): LineChange => ({ startLine, startCharacter, endLine, endCharacter, ...insertedShape(text) });

describe('Recent Files', () => {
  it('moves a reopened file to the front, never twice, at most 50', () => {
    let list: string[] = [];
    for (const u of [A, B, C, A]) list = touchFile(list, u);
    expect(list).toEqual([A, C, B]);
    for (let i = 0; i < 60; i++) list = touchFile(list, `file:///ws/F${i}.cs`);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe('file:///ws/F59.cs');
  });

  it('shows the current file second from the top (Enter goes back), then open editors not yet recorded', () => {
    expect(recentFileOrder([B, A, C], B, [C, 'file:///ws/D.cs'])).toEqual([A, B, C, 'file:///ws/D.cs']);
    expect(recentFileOrder([B], B)).toEqual([B]);
    expect(recentFileOrder([A, B], undefined)).toEqual([A, B]);
    // The current file is only an open editor (not recorded yet): still second.
    expect(recentFileOrder([A, B], C, [C])).toEqual([A, C, B]);
  });

  it('removes, renames (file and folder) and deletes', () => {
    expect(removeFile([A, B], A)).toEqual([B]);
    expect(renameFiles([A, B], A, C)).toEqual([C, B]);
    expect(renameFiles(['file:///ws/src/X.cs', B], 'file:///ws/src', 'file:///ws/lib')).toEqual(['file:///ws/lib/X.cs', B]);
    expect(renameFiles([A, C], A, C)).toEqual([C]);
    expect(deleteFiles(['file:///ws/src/X.cs', 'file:///ws/srcX.cs'], 'file:///ws/src')).toEqual(['file:///ws/srcX.cs']);
  });

  it('persistence: round trip, invalid values dropped, duplicates removed, unknown versions ignored', () => {
    expect(loadFiles(filesStore([A, B]))).toEqual([A, B]);
    expect(loadFiles({ version: 1, files: [A, 3, '', A, B] })).toEqual([A, B]);
    expect(loadFiles({ version: 2, files: [A] })).toEqual([]);
    expect(loadFiles(undefined)).toEqual([]);
    expect(loadFiles('x')).toEqual([]);
  });

  it('relative paths against the workspace folders', () => {
    expect(relativePath('file:///ws/Shop/My%20Api/A.cs', ['file:///ws/Shop'])).toBe('My Api/A.cs');
    expect(relativePath('file:///other/A.cs', ['file:///ws'])).toBe('/other/A.cs');
  });
});

describe('Recent Locations', () => {
  it('one entry per line, most recent first; an edited line stays edited when visited again', () => {
    let list: RecentLocation[] = [];
    list = recordLocation(list, loc(A, 3, 'edited'));
    list = recordLocation(list, loc(B, 1));
    list = recordLocation(list, loc(A, 3, 'visited', 9));
    expect(list.map((l) => [l.uri, l.line, l.kind, l.character])).toEqual([
      [A, 3, 'edited', 9],
      [B, 1, 'visited', 4],
    ]);
    for (let i = 0; i < 70; i++) list = recordLocation(list, loc(C, i));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(removeLocation(list, `${C}#69`).some((l) => l.line === 69)).toBe(false);
  });

  it('sections: Edited then Visited; the edited-only mode hides visited ones', () => {
    const list = [loc(A, 1), loc(B, 2, 'edited'), loc(C, 3)];
    expect(locationSections(list, 'all').map((s) => [s.title, s.items.map((l) => l.line)])).toEqual([
      ['Edited', [2]],
      ['Visited', [1, 3]],
    ]);
    expect(locationSections(list, 'edited').map((s) => s.title)).toEqual(['Edited']);
    expect(locationSections([], 'all')).toEqual([]);
  });

  it('re-anchors: lines after an insertion or deletion shift, lines before stay', () => {
    expect(reanchor(loc(A, 10), change(2, 0, 2, 0, 'a\nb\n'))?.line).toBe(12);
    expect(reanchor(loc(A, 1), change(2, 0, 2, 0, 'a\nb\n'))?.line).toBe(1);
    expect(reanchor(loc(A, 10), change(2, 0, 5, 0, ''))?.line).toBe(7);
  });

  it('re-anchors: a deleted line drops its location; text joined after a multi-line deletion moves', () => {
    // Whole lines 2..4 deleted (from column 0 to column 0): 2, 3 and 4 are gone, 5 becomes 2.
    expect(reanchor(loc(A, 2), change(2, 0, 5, 0, ''))).toBeUndefined();
    expect(reanchor(loc(A, 3), change(2, 0, 5, 0, ''))).toBeUndefined();
    expect(reanchor(loc(A, 5), change(2, 0, 5, 0, ''))?.line).toBe(2);
    // Lines 3..5 joined into line 3 (deleting from the end of 3 to the middle of 5).
    expect(reanchor(loc(A, 3), change(3, 10, 5, 2, ''))?.line).toBe(3);
    expect(reanchor(loc(A, 4), change(3, 10, 5, 2, ''))).toBeUndefined();
    expect(reanchor(loc(A, 5, 'visited', 6), change(3, 10, 5, 2, ''))).toMatchObject({ line: 3, character: 14 });
    expect(reanchor(loc(A, 5, 'visited', 1), change(3, 10, 5, 2, ''))).toBeUndefined();
  });

  it('re-anchors: a change on the same line keeps the line and moves a cursor after it', () => {
    expect(reanchor(loc(A, 4, 'visited', 8), change(4, 2, 4, 2, 'abc'))).toMatchObject({ line: 4, character: 11 });
    expect(reanchor(loc(A, 4, 'visited', 1), change(4, 2, 4, 2, 'abc'))).toMatchObject({ line: 4, character: 1 });
    expect(reanchor(loc(A, 4, 'visited', 8), change(4, 2, 4, 2, 'x\ny'))).toMatchObject({ line: 5, character: 7 });
  });

  it('applies the changes of one event (old coordinates) to the document only, merging lines that meet', () => {
    const list = [loc(A, 1), loc(A, 10, 'edited'), loc(B, 10), loc(A, 20)];
    // Two changes in one event: two lines inserted at 5, line 15 deleted.
    const out = applyChanges(list, A, [change(5, 0, 5, 0, 'x\ny\n'), change(15, 0, 16, 0, '')]);
    expect(out.map((l) => [l.uri, l.line, l.kind])).toEqual([
      [A, 1, 'visited'],
      [A, 12, 'edited'],
      [B, 10, 'visited'],
      [A, 21, 'visited'],
    ]);
    // Two locations meeting on one line after a deletion: one entry, edited wins.
    const merged = applyChanges([loc(A, 2), loc(A, 3, 'edited')], A, [change(2, 5, 3, 0, '')]);
    expect(merged.map((l) => [l.line, l.kind])).toEqual([[2, 'edited']]);
  });

  it('refreshes the stored code line, renames and deletes', () => {
    const r = refreshLineTexts([loc(A, 1), loc(B, 1)], A, (l) => `new ${l}`);
    expect(r.map((l) => l.lineText)).toEqual(['new 1', 'line 1']);
    expect(renameLocations([loc(A, 1), loc(C, 1)], A, C)).toHaveLength(1);
  });

  it('persistence: round trip; invalid entries dropped; text limited', () => {
    const list = [loc(A, 1, 'edited'), loc(B, 2)];
    expect(loadLocations(locationsStore(list))).toEqual(list);
    expect(loadLocations({ version: 1, items: [loc(A, 1), { uri: A, line: -1 }, { ...loc(B, 1), kind: 'other' }, null, { ...loc(C, 1), lineText: 'x'.repeat(900) }] }).map((l) => [l.uri, l.lineText.length])).toEqual([
      [A, 6],
      [C, 500],
    ]);
    expect(loadLocations({ version: 9, items: list })).toEqual([]);
  });
});

describe('containing member', () => {
  it('from document symbols (namespaces left out)', () => {
    const symbols = [{ name: 'Shop', kind: 2, startLine: 0, endLine: 50, children: [{ name: 'OrderService', kind: 4, startLine: 2, endLine: 40, children: [{ name: 'Find(int)', kind: 5, startLine: 10, endLine: 12, children: [] }] }] }];
    expect(memberFromSymbols(symbols, 11)).toBe('OrderService.Find');
    expect(memberFromSymbols(symbols, 5)).toBe('OrderService');
    expect(memberFromSymbols(symbols, 60)).toBeUndefined();
  });

  it('from the text when there are no symbols (C# without a C# extension)', () => {
    const lines = [
      'namespace Shop.Api;',
      '',
      'public sealed class OrderService : IOrderService',
      '{',
      '    private readonly Dictionary<int, OrderDto> _orders = new();',
      '    public OrderDto? Find(int id) => _orders.TryGetValue(id, out var o) ? o : null;',
      '',
      '    public void Save(OrderDto order)',
      '    {',
      '        if (order.Id > 0)',
      '        {',
      '            _orders[order.Id] = order; // }',
      '        }',
      '    }',
      '',
      '    public int Count { get { return _orders.Count; } }',
      '}',
    ];
    expect(memberFromText(lines, 5)).toBe('OrderService.Find');
    expect(memberFromText(lines, 11)).toBe('OrderService.Save');
    expect(memberFromText(lines, 13)).toBe('OrderService.Save');
    expect(memberFromText(lines, 4)).toBe('OrderService._orders');
    expect(memberFromText(lines, 15)).toBe('OrderService.Count');
    expect(memberFromText(lines, 0)).toBeUndefined();
  });

  it('declared names', () => {
    expect(declaredName('public record GetOrderQuery(int Id) : IRequest<OrderDto?>;')).toBe('GetOrderQuery');
    expect(declaredName('    public async Task<IActionResult> Get<T>(int id)')).toBe('Get');
    expect(declaredName('        var x = Make(1);')).toBeUndefined();
    expect(declaredName('        return Make(1);')).toBeUndefined();
    expect(declaredName('export function load(id: string) {')).toBe('load');
    expect(declaredName('    public OrderService(IClock clock)')).toBe('OrderService');
  });
});

describe('Recent Files / Locations keybindings', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; mac?: string; when: string }[]; commands: { command: string }[] };
  };

  it('Ctrl+E / Ctrl+Shift+E in both presets (not in the terminal); Cmd+Alt+E / Cmd+Alt+Shift+E on macOS', () => {
    for (const [command, key, mac] of [
      ['refyntra.recentFiles', 'ctrl+e', 'cmd+alt+e'],
      ['refyntra.recentLocations', 'ctrl+shift+e', 'cmd+alt+shift+e'],
    ] as const) {
      const keys = pkg.contributes.keybindings.filter((k) => k.command === command);
      expect(keys.map((k) => [k.key, k.mac, /preset == '(\w+)'/.exec(k.when)?.[1]])).toEqual([
        [key, mac, 'visualStudio'],
        [key, mac, 'resharper'],
      ]);
      for (const k of keys) expect(k.when).toContain('!terminalFocus');
      expect(pkg.contributes.commands.some((c) => c.command === command)).toBe(true);
    }
  });

  it('no other Refyntra binding uses these keys in the same preset', () => {
    const others = pkg.contributes.keybindings.filter((k) => !k.command.startsWith('refyntra.recent'));
    for (const k of others) expect(['ctrl+e', 'ctrl+shift+e', 'cmd+alt+e', 'cmd+alt+shift+e']).not.toContain(k.mac ?? k.key);
  });
});
