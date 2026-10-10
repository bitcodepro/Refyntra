import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '../../src/terminology';
import {
  type Candidate,
  type Descriptor,
  STATUS_WORD,
  TASK_CONTEXT_LIMITS,
  TASK_CONTEXT_SCHEMA_VERSION,
  type TaskItem,
  activeContext,
  addItem,
  combineStatus,
  contextToMarkdown,
  createContext,
  decideEndpoint,
  decideFile,
  decideLocation,
  decideSymbol,
  deleteContext,
  emptyStore,
  importContexts,
  lineFingerprint,
  linesWithFingerprint,
  loadStore,
  moveItem,
  moveItemsTo,
  renameContext,
  renameFileRefs,
  replaceWord,
  setNote,
  toExportFile,
} from '../../src/taskContextModel';

const FILE = { folder: 'Shop', path: 'Shop.Api/Services/OrderServices.cs' };
const DECL = 'public sealed class OrderService : IOrderService';

function sym(over: Partial<Descriptor> = {}): Descriptor {
  return {
    kind: 'symbol',
    route: 'csharp.roslyn',
    symbolKind: 'class',
    name: 'OrderService',
    qualifiedName: 'Shop.Api.Services.OrderService',
    container: 'Shop.Api.Services',
    file: FILE,
    position: { line: 10, character: 20 },
    fingerprint: lineFingerprint(DECL),
    lineCount: 50,
    ...over,
  };
}

function cand(over: Partial<Candidate> = {}): Candidate {
  return { name: 'OrderService', qualifiedName: 'Shop.Api.Services.OrderService', symbolKind: 'class', container: 'Shop.Api.Services', file: FILE, position: { line: 14, character: 20 }, ...over };
}

const ev = (over: Partial<Parameters<typeof decideSymbol>[1]> = {}) => ({ routeReady: true, fileExists: true, exactLine: false, candidates: [], ...over });

let n = 0;
const id = () => `id${++n}`;
function item(over: Partial<TaskItem> = {}): TaskItem {
  return { id: id(), kind: 'symbol', target: sym(), createdAt: 1, ...over };
}

function storeWithContext() {
  const r = createContext(emptyStore(), 'Fix checkout', 'c1', 1);
  if (!r.ok) throw new Error(r.message);
  return r.store;
}

describe('fingerprint', () => {
  it('hashes the trimmed line, not the text, and is stable', () => {
    expect(lineFingerprint(`    ${DECL}  `)).toBe(lineFingerprint(DECL));
    expect(lineFingerprint(DECL)).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(lineFingerprint(DECL)).not.toContain('OrderService');
    expect(lineFingerprint('a')).not.toBe(lineFingerprint('b'));
  });

  it('finds lines with a fingerprint and replaces whole words only', () => {
    expect(linesWithFingerprint(`x\n${DECL}\r\ny\n  ${DECL}`, lineFingerprint(DECL))).toEqual([1, 3]);
    expect(replaceWord('class CachedOrderService : OrderService', 'OrderService', 'X')).toBe('class CachedOrderService : X');
  });
});

describe('resolution decision table (symbols)', () => {
  it('1. the stored line still has the fingerprint → resolved', () => {
    expect(decideSymbol(sym(), ev({ exactLine: true })).status).toBe('resolved');
  });

  it('2. route not ready → pending, never missing', () => {
    const r = decideSymbol(sym(), ev({ routeReady: false }));
    expect(r.status).toBe('pending');
  });

  it('3. one candidate with the same identity elsewhere → moved, location and fingerprint updated', () => {
    const r = decideSymbol(sym(), ev({ candidates: [cand({ fingerprint: 'fnv1a32:00000001', lineCount: 52 })] }));
    expect(r.status).toBe('moved');
    if (r.status !== 'moved') return;
    expect(r.descriptor.position).toEqual({ line: 14, character: 20 });
    expect(r.descriptor.fingerprint).toBe('fnv1a32:00000001');
    expect(r.descriptor.lineCount).toBe(52);
    expect(r.descriptor.name).toBe('OrderService');
  });

  it('3. the same candidate at the same line (fingerprint changed by an edit on the line) → resolved', () => {
    expect(decideSymbol(sym(), ev({ candidates: [cand({ position: { line: 10, character: 20 } })] })).status).toBe('resolved');
  });

  it('3. two candidates with the same identity → ambiguous (Find and a same-line lookup are deduplicated)', () => {
    const r = decideSymbol(sym(), ev({ candidates: [cand(), cand(), cand({ file: { folder: 'Shop', path: 'Other.cs' } })] }));
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('5. same name but another kind or another container → ambiguous, never silently another symbol', () => {
    for (const c of [cand({ symbolKind: 'interface' }), cand({ container: 'Shop.Legacy' }), cand({ qualifiedName: 'Shop.Legacy.OrderService' })]) {
      const r = decideSymbol(sym(), ev({ candidates: [c] }));
      expect(r.status).toBe('ambiguous');
    }
  });

  it('4. only the name changed at the stored line and the line count is unchanged → resolved (renamed)', () => {
    const renamed = cand({ name: 'OrderManager', qualifiedName: 'Shop.Api.Services.OrderManager', position: { line: 10, character: 20 }, lineCount: 50 });
    const r = decideSymbol(sym(), ev({ renamedAt: renamed, lineCount: 50 }));
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.descriptor.name).toBe('OrderManager');
    expect(r.descriptor.qualifiedName).toBe('Shop.Api.Services.OrderManager');
    expect(r.reason).toContain('renamed');
  });

  it('4. a possible rename while the file changed elsewhere → ambiguous (the user confirms)', () => {
    const renamed = cand({ name: 'OrderManager', position: { line: 10, character: 20 } });
    expect(decideSymbol(sym(), ev({ renamedAt: renamed, lineCount: 45 })).status).toBe('ambiguous');
  });

  it('a candidate with the old identity wins over a rename guess', () => {
    const r = decideSymbol(sym(), ev({ candidates: [cand()], renamedAt: cand({ name: 'Other' }), lineCount: 50 }));
    expect(r.status).toBe('moved');
  });

  it('6. nothing found → missing with a reason (deleted file or deleted symbol)', () => {
    const a = decideSymbol(sym(), ev({ fileExists: false }));
    expect(a.status).toBe('missing');
    if (a.status === 'missing') expect(a.reason).toContain('file');
    const b = decideSymbol(sym(), ev());
    expect(b.status).toBe('missing');
  });
});

describe('resolution: files, places, endpoints, relations', () => {
  it('files exist or are missing', () => {
    const d: Descriptor = { kind: 'file', name: 'a.ts', file: { folder: 'w', path: 'a.ts' } };
    expect(decideFile(d, true).status).toBe('resolved');
    expect(decideFile(d, false).status).toBe('missing');
  });

  it('places: stored line, one identical line (moved), several (ambiguous), none (missing)', () => {
    const d: Descriptor = { kind: 'location', name: 'call', file: FILE, position: { line: 3, character: 0 }, fingerprint: 'fnv1a32:00000000' };
    const line = (l: number): Candidate => ({ name: 'call', file: FILE, position: { line: l, character: 0 } });
    expect(decideLocation(d, { fileExists: true, exactLine: true, sameLines: [] }).status).toBe('resolved');
    expect(decideLocation(d, { fileExists: true, exactLine: false, sameLines: [line(5)] }).status).toBe('moved');
    expect(decideLocation(d, { fileExists: true, exactLine: false, sameLines: [line(5), line(9)] }).status).toBe('ambiguous');
    expect(decideLocation(d, { fileExists: true, exactLine: false, sameLines: [] }).status).toBe('missing');
    expect(decideLocation(d, { fileExists: false, exactLine: false, sameLines: [] }).status).toBe('missing');
  });

  it('endpoints by methods and route', () => {
    const d: Descriptor = { kind: 'endpoint', route: 'csharp.roslyn', name: 'GET /orders/{id}', endpoint: { methods: ['GET'], route: '/orders/{id}' }, file: FILE, position: { line: 2, character: 0 } };
    const c = (l: number): Candidate => ({ name: d.name, file: FILE, position: { line: l, character: 0 } });
    expect(decideEndpoint(d, { routeReady: true, exactLine: false, candidates: [c(7)] }).status).toBe('moved');
    expect(decideEndpoint(d, { routeReady: true, exactLine: false, candidates: [c(7), c(9)] }).status).toBe('ambiguous');
    expect(decideEndpoint(d, { routeReady: true, exactLine: false, candidates: [] }).status).toBe('missing');
    expect(decideEndpoint(d, { routeReady: false, exactLine: false, candidates: [] }).status).toBe('pending');
  });

  it('a relation is as good as its worse end', () => {
    expect(combineStatus('resolved', 'moved')).toBe('moved');
    expect(combineStatus('missing', 'ambiguous')).toBe('missing');
    expect(combineStatus('pending', 'resolved')).toBe('pending');
  });

  it('every state has a word (no colour-only state)', () => {
    expect(Object.values(STATUS_WORD)).toEqual(['resolved', 'moved', 'ambiguous', 'missing', 'not checked yet']);
    // …and each word is in the glossary (docs/accessibility.md is checked against it).
    for (const w of Object.values(STATUS_WORD)) expect(GLOSSARY.map((g) => g.term)).toContain(w);
  });
});

describe('contexts and items', () => {
  it('creates, renames with unique names, switches and deletes contexts', () => {
    let s = storeWithContext();
    const r2 = createContext(s, 'Fix checkout', 'c2', 2);
    expect(r2.ok && activeContext(r2.store)?.name).toBe('Fix checkout (2)');
    if (!r2.ok) return;
    s = r2.store;
    const rn = renameContext(s, 'c2', '  Review  ');
    expect(rn.ok && rn.store.contexts[1]!.name).toBe('Review');
    expect(renameContext(s, 'c2', '   ').ok).toBe(false);
    const d = deleteContext(s, 'c2');
    expect(d.activeId).toBe('c1');
    expect(deleteContext(d, 'c1').activeId).toBeUndefined();
  });

  it('adds items once, refuses beyond the limit, needs an active context', () => {
    expect(addItem(emptyStore(), item()).ok).toBe(false);
    let s = storeWithContext();
    const a = addItem(s, item());
    expect(a.ok && a.added).toBe(true);
    if (!a.ok) return;
    s = a.store;
    const again = addItem(s, item());
    expect(again.ok && again.added).toBe(false);
    const full = { ...s, contexts: [{ ...s.contexts[0]!, items: Array.from({ length: TASK_CONTEXT_LIMITS.itemsPerContext }, (_, i) => item({ target: sym({ name: `S${i}`, qualifiedName: `S${i}` }) })) }] };
    expect(addItem(full, item({ target: sym({ name: 'New', qualifiedName: 'New' }) })).ok).toBe(false);
  });

  it('reorders with Move Up/Down (clamped) and drag and drop', () => {
    let s = storeWithContext();
    const items = ['A', 'B', 'C', 'D'].map((x) => item({ id: x, target: sym({ name: x, qualifiedName: x }) }));
    s = { ...s, contexts: [{ ...s.contexts[0]!, items }] };
    const names = (st: typeof s) => activeContext(st)!.items.map((i) => i.id).join('');
    const up = moveItem(s, 'C', -1);
    expect(up.ok && names(up.store)).toBe('ACBD');
    const top = moveItem(s, 'A', -1);
    expect(top.ok && names(top.store)).toBe('ABCD');
    const drop = moveItemsTo(s, ['D', 'B'], 'A');
    expect(drop.ok && names(drop.store)).toBe('BDAC');
    const end = moveItemsTo(s, ['A'], undefined);
    expect(end.ok && names(end.store)).toBe('BCDA');
  });

  it('notes are trimmed, limited, and removed when empty', () => {
    let s = storeWithContext();
    const a = addItem(s, item({ id: 'x' }));
    if (!a.ok) throw new Error();
    s = a.store;
    const withNote = setNote(s, 'x', `  ${'n'.repeat(TASK_CONTEXT_LIMITS.noteLength + 50)} `);
    expect(withNote.ok && activeContext(withNote.store)!.items[0]!.note!.length).toBe(TASK_CONTEXT_LIMITS.noteLength);
    if (!withNote.ok) return;
    const cleared = setNote(withNote.store, 'x', '  ');
    expect(cleared.ok && 'note' in activeContext(cleared.store)!.items[0]!).toBe(false);
  });

  it('a renamed file carries its items along', () => {
    let s = storeWithContext();
    const a = addItem(s, item({ id: 'x' }));
    if (!a.ok) throw new Error();
    s = renameFileRefs(a.store, FILE, { folder: 'Shop', path: 'Shop.Api/Services/Orders.cs' });
    expect(activeContext(s)!.items[0]!.target.file).toEqual({ folder: 'Shop', path: 'Shop.Api/Services/Orders.cs' });
  });
});

describe('storage schema', () => {
  it('round-trips the current version', () => {
    const a = addItem(storeWithContext(), item({ note: 'check the null case' }));
    if (!a.ok) throw new Error();
    const r = loadStore(JSON.parse(JSON.stringify(a.store)));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.store).toEqual(a.store);
      expect(r.store.version).toBe(TASK_CONTEXT_SCHEMA_VERSION);
    }
  });

  it('empty or garbage storage starts empty', () => {
    expect(loadStore(undefined)).toEqual({ kind: 'ok', store: emptyStore(), dropped: 0 });
    expect(loadStore('x').kind).toBe('ok');
  });

  it('a store from a newer version is reported, not overwritten', () => {
    expect(loadStore({ version: TASK_CONTEXT_SCHEMA_VERSION + 1, contexts: [] })).toEqual({ kind: 'newer', version: TASK_CONTEXT_SCHEMA_VERSION + 1 });
  });

  it('drops malformed items and contexts, refuses path traversal and non-file URIs', () => {
    const r = loadStore({
      version: 1,
      activeId: 'gone',
      contexts: [
        { id: 'c', name: 'C', createdAt: 1, items: [
          { id: 'ok', kind: 'symbol', target: sym(), createdAt: 1 },
          { id: 'bad1', kind: 'symbol', target: { kind: 'symbol' }, createdAt: 1 },
          { id: 'bad2', kind: 'file', target: { kind: 'file', name: 'x', file: { folder: 'w', path: '../../etc/passwd' } }, createdAt: 1 },
          { id: 'bad3', kind: 'file', target: { kind: 'file', name: 'x', file: { uri: 'https://example.com/x' } }, createdAt: 1 },
          { id: 'bad4', kind: 'relation', target: sym(), createdAt: 1 },
          { id: 'ok', kind: 'symbol', target: sym(), createdAt: 1 },
        ] },
        { name: 'no id', items: [] },
      ],
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.store.contexts).toHaveLength(1);
    expect(r.store.contexts[0]!.items.map((i) => i.id)).toEqual(['ok']);
    expect(r.store.activeId).toBe('c');
    expect(r.dropped).toBe(6);
  });

  it('refuses to grow beyond the size limit', () => {
    const s = storeWithContext();
    const big = item({ note: 'x'.repeat(TASK_CONTEXT_LIMITS.noteLength) });
    let cur = s;
    let refused = false;
    for (let i = 0; i < TASK_CONTEXT_LIMITS.itemsPerContext && !refused; i++) {
      const r = addItem(cur, { ...big, id: `b${i}`, target: sym({ name: `N${i}`, qualifiedName: `N${i}` }) });
      if (r.ok) cur = r.store;
      else refused = /KB/.test(r.message);
    }
    expect(refused).toBe(true);
  });
});

describe('export, import and Markdown', () => {
  it('imports an export as a new, active context with new ids and a unique name', () => {
    const a = addItem(storeWithContext(), item({ id: 'x' }));
    if (!a.ok) throw new Error();
    const text = JSON.stringify(toExportFile([activeContext(a.store)!]));
    let k = 0;
    const r = importContexts(a.store, text, () => `new${++k}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toEqual(['Fix checkout (2)']);
    const ctx = activeContext(r.store)!;
    expect(ctx.items[0]!.id).not.toBe('x');
    expect(ctx.items[0]!.target).toEqual(sym());
  });

  it('refuses files that are not an export, invalid JSON and newer versions', () => {
    const s = storeWithContext();
    expect(importContexts(s, '{', id).ok).toBe(false);
    expect(importContexts(s, '{"contexts":[]}', id).ok).toBe(false);
    const newer = importContexts(s, JSON.stringify({ format: 'refyntra.taskContext', version: 99, contexts: [] }), id);
    expect(newer.ok === false && newer.message).toContain('newer');
  });

  it('Markdown has names, relative paths and notes — no source text, no absolute paths', () => {
    const ctx = {
      id: 'c',
      name: 'Fix *checkout*',
      createdAt: 1,
      items: [
        item({ id: 'a', note: 'look at\nthe cache' }),
        item({ id: 'b', kind: 'relation', subject: sym(), relationKind: 'implements', target: sym({ name: 'IOrderService', qualifiedName: 'Shop.Api.Services.IOrderService', symbolKind: 'interface', position: { line: 4, character: 17 } }) }),
        item({ id: 'c', kind: 'file', target: { kind: 'file', name: 'secret.txt', file: { uri: 'file:///home/someone/secret.txt' } } }),
      ],
    };
    const md = contextToMarkdown(ctx, false, (i) => (i.id === 'b' ? 'moved' : undefined));
    expect(md).toContain('# Fix \\*checkout\\*');
    expect(md).toContain('**OrderService** (class) — `Shop.Api/Services/OrderServices.cs:11`');
    expect(md).toContain('  > look at');
    expect(md).toContain('OrderService implements IOrderService');
    expect(md).toContain('_(moved)_');
    expect(md).toContain('secret.txt (outside the workspace)');
    expect(md).not.toContain('/home/someone');
    expect(md).not.toContain(DECL);
  });
});
