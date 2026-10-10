import { afterEach, describe, expect, it } from 'vitest';
import { type DelegatedWorkspace, PYTHON_SYNTAX, RUST_SYNTAX, createDelegatedWorkspace, fakeEdit, fakeUri } from '@refyntra/adapter-testing';
import {
  type DelegatedLanguage,
  PROVIDER_COMMANDS,
  PYTHON_DESCRIPTOR,
  PYTHON_LANGUAGE,
  PYTHON_ROUTE_ID,
  RUST_LANGUAGE,
  RUST_ROUTE_ID,
  identifierAt,
  macroRulesBodies,
  pythonModuleSpans,
  validatePythonName,
  validateRustName,
} from '../src';

// The Python and Rust text rules (shared with the own language-server routes in @refyntra/adapter-lsp) driven through
// the delegated adapter. The fake provider
// answers like VS Code's public provider commands for a tiny Python-like / Rust-like language.

const PY_ORDERS = 'file:///ws/app/orders.py';
const PY_USE = 'file:///ws/app/use.py';
const PY_STUB = 'file:///ws/app/orders.pyi';
const PY_FILES: Record<string, string> = {
  [PY_ORDERS]: 'def get_order(order_id):\n    return order_id\n\nclass OrderService:\n    pass\n',
  [PY_USE]: 'from app.orders import get_order\nimport app.orders as orders\nfirst = get_order(1)\nlabel = "get_order"\n',
  [PY_STUB]: 'def get_order(order_id: int) -> int: ...\n',
  'file:///ws/notes.md': 'def get_order_notes\n',
};

const RS_LIB = 'file:///ws/src/lib.rs';
const RS_USE = 'file:///ws/src/usage.rs';
const RS_FILES: Record<string, string> = {
  [RS_LIB]: 'mod usage;\npub fn get_order(id: u32) -> u32 {\n    id\n}\npub struct OrderService;\n',
  [RS_USE]: 'use crate::get_order;\nfn first() -> u32 {\n    get_order(1)\n}\nconst LABEL: &str = "get_order";\n',
};

let w: DelegatedWorkspace | undefined;
afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

async function make(language: DelegatedLanguage, o: Parameters<typeof createDelegatedWorkspace>[0] = {}): Promise<DelegatedWorkspace> {
  const python = language === PYTHON_LANGUAGE;
  w = createDelegatedWorkspace({ files: python ? PY_FILES : RS_FILES, syntax: python ? PYTHON_SYNTAX : RUST_SYNTAX, language, ...o });
  await w.engine.start();
  for (const uri of python ? [PY_ORDERS, PY_USE] : [RS_LIB, RS_USE]) w.open(uri);
  return w;
}

const PY_DECL = { uri: PY_ORDERS, position: { line: 0, character: 6 } };
const PY_CALL = { uri: PY_USE, position: { line: 2, character: 10 } };
const RS_DECL = { uri: RS_LIB, position: { line: 1, character: 9 } };
const RS_CALL = { uri: RS_USE, position: { line: 2, character: 6 } };

describe('descriptors', () => {
  it('route ids, names, language ids and extensions; one adapter class serves every family', async () => {
    expect(PYTHON_DESCRIPTOR).toMatchObject({ adapterId: 'python', providerRouteId: PYTHON_ROUTE_ID, displayName: 'Python', languageIds: ['python'], fileExtensions: ['.py', '.pyi'], ownership: 'delegated' });
    expect(RUST_LANGUAGE.descriptor).toMatchObject({ adapterId: 'rust', providerRouteId: RUST_ROUTE_ID, displayName: 'Rust', languageIds: ['rust'], fileExtensions: ['.rs'] });
    expect(PYTHON_DESCRIPTOR.capabilityIds).toEqual(['python.find', 'python.related', 'python.references', 'python.rename', 'python.frameworkRelations']);
    const ws = await make(PYTHON_LANGUAGE);
    expect(ws.registry.routeFor(PY_STUB)?.descriptor.providerRouteId).toBe(PYTHON_ROUTE_ID);
    expect(ws.registry.routeFor('file:///ws/a.txt', 'python')?.descriptor.providerRouteId).toBe(PYTHON_ROUTE_ID);
    expect(ws.registry.routeFor('untitled:Untitled-1', 'python')).toBeUndefined();
    expect(ws.registry.routeFor('file:///ws/a.rs')).toBeUndefined();
  });
});

describe('identifier rules', () => {
  it('Python: Unicode identifiers, no hard keywords, soft keywords allowed', () => {
    for (const ok of ['get_order', '_private', 'Ordnung', 'größe', 'заказ', '名前', 'match', 'case', 'type', '_']) expect(validatePythonName(ok), ok).toBeUndefined();
    for (const bad of ['1st', 'get-order', 'class', 'None', 'lambda', '', 'a b', '$x']) expect(validatePythonName(bad), bad).toBeDefined();
    expect(identifierAt('größe = 1\n', { line: 0, character: 2 }, PYTHON_LANGUAGE.identifierPattern)).toBe('größe');
  });

  it('Rust: identifiers, raw identifiers r#name, keywords need r#, lifetimes only for lifetimes', () => {
    for (const ok of ['get_order', 'r#match', 'r#type', 'Größe', '_x']) expect(validateRustName(ok, 'old'), ok).toBeUndefined();
    for (const bad of ['match', 'fn', 'r#self', 'r#crate', 'r#Self', '_', '1x', 'a-b', "'a"]) expect(validateRustName(bad, 'old'), bad).toBeDefined();
    expect(validateRustName('match', 'old')).toMatch(/r#match/);
    expect(validateRustName("'b", "'a")).toBeUndefined();
    for (const bad of ['b', "'static", "'_", "'1"]) expect(validateRustName(bad, "'a"), bad).toBeDefined();
    expect(identifierAt('let r#type = 1;\n', { line: 0, character: 6 }, RUST_LANGUAGE.identifierPattern)).toBe('r#type');
    expect(identifierAt("fn f<'a>(x: &'a str) {}\n", { line: 0, character: 6 }, RUST_LANGUAGE.identifierPattern)).toBe("'a");
  });

  it('text heuristics: Python import module spans, Rust macro_rules bodies', () => {
    expect(pythonModuleSpans('from app.orders import get_order')).toEqual([[5, 15]]);
    expect(pythonModuleSpans('import a.b as c, d')).toEqual([[7, 10], [17, 18]]);
    expect(pythonModuleSpans('x = 1')).toEqual([]);
    const text = 'macro_rules! twice {\n    ($e:expr) => { $e; $e };\n}\nfn after() {}\n';
    const [body] = macroRulesBodies(text);
    expect(text.slice(body![0], body![1])).toBe('{\n    ($e:expr) => { $e; $e };\n}');
  });
});

describe.each([
  ['Python', PYTHON_LANGUAGE, PY_DECL, PY_CALL, PY_ORDERS, PY_USE, PYTHON_ROUTE_ID],
  ['Rust', RUST_LANGUAGE, RS_DECL, RS_CALL, RS_LIB, RS_USE, RUST_ROUTE_ID],
] as const)('%s delegated route', (name, language, decl, call, declUri, useUri, routeId) => {
  it('Find: delegated symbols of this language only, labelled, never a complete index', async () => {
    const ws = await make(language);
    const r = await ws.engine.find('order');
    expect([...new Set(r.items.map((i) => i.label))].sort()).toEqual(['OrderService', 'get_order']);
    expect(r.items.every((i) => !i.location!.uri.endsWith('.md'))).toBe(true);
    expect(r.items.every((i) => i.providerRouteId === routeId && i.provenances[0]!.kind === 'delegated')).toBe(true);
    expect(r.routeLabels?.[routeId]).toBe(`${name} (delegated)`);
    expect(r.notes.some((n) => n.startsWith(`${name}:`) && /not a complete index/.test(n))).toBe(true);
  });

  it('Related: declaration + references, completeness unknown, framework relations unavailable', async () => {
    const ws = await make(language);
    const r = await ws.engine.related(call);
    expect(r.kind).toBe('related');
    if (r.kind !== 'related') return;
    expect(r.subject?.name).toBe('get_order');
    expect(r.groups[0]!.relations.map((x) => x.target.location?.uri)).toEqual([declUri]);
    expect(r.groups[1]!.relations.some((x) => x.target.location?.uri === useUri)).toBe(true);
    expect(r.completeness).toBe('unknown');
    expect(r.scopeNotes.join(' ')).toContain(`installed ${name} language provider`);
    expect(r.scopeNotes.join(' ')).toContain(`Refyntra has no ${name} framework module`);
  });

  it('Actions: limited rename with language limitations, framework relations unavailable', async () => {
    const ws = await make(language);
    const byId = Object.fromEntries((await ws.engine.actions(call)).items.map((i) => [i.capabilityId, i]));
    const p = language.capabilityPrefix;
    expect(byId[`${p}.find`]!.state).toBe('available');
    expect(byId[`${p}.rename`]!.state).toBe('limited');
    expect(byId[`${p}.rename`]!.limitations.join(' ')).toMatch(name === 'Python' ? /getattr/ : /macro_rules!/);
    expect(byId[`${p}.frameworkRelations`]!.reasonCode).toBe('NoFrameworkModule');
  });

  it('rename: limited delegated plan, re-asked before apply, applied through the EditApplier', async () => {
    const ws = await make(language, { applyRenameEnabled: true });
    const r = await ws.engine.prepareRename(decl, 'fetch_order');
    expect(r.kind, JSON.stringify(r)).toBe('preview');
    if (r.kind !== 'preview' || r.plan.kind !== 'delegated') return;
    expect(r.plan.actionId).toBe(`${language.capabilityPrefix}.rename`);
    expect(r.plan.validation.status).toBe('limited');
    expect(r.plan.providerRouteId).toBe(routeId);
    expect(r.plan.limitations.join(' ')).toContain(`installed ${name} rename provider`);
    const calls = ws.world.calls.filter((c) => c === PROVIDER_COMMANDS.rename).length;
    const out = await ws.engine.applyRename(r.planId, undefined, { acceptLimited: true });
    expect(out.status, out.message).toBe('applied');
    expect(ws.world.calls.filter((c) => c === PROVIDER_COMMANDS.rename).length).toBe(calls + 1);
    expect(ws.world.text(useUri)).toContain('fetch_order(1)');
  });

  it('rename: an invalid new name is refused before the provider is asked', async () => {
    const ws = await make(language);
    const r = await ws.engine.prepareRename(decl, name === 'Python' ? 'class' : 'match');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('InvalidName');
    expect(ws.world.calls).not.toContain(PROVIDER_COMMANDS.rename);
  });

  it('rename: a document edited during preparation → DocumentChanged', async () => {
    const ws = await make(language);
    ws.world.beforeCommand = (c) => {
      if (c === PROVIDER_COMMANDS.rename) ws.world.editBuffer(declUri, `${ws.world.text(declUri)}\n`);
    };
    const r = await ws.engine.prepareRename(decl, 'fetch_order');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('DocumentChanged');
  });

  it('rename: resource operations and non-file targets are refused with the native rename labelled not validated', async () => {
    const ws = await make(language);
    ws.world.renameMutator = (edit) => fakeEdit(edit.entries(), 1);
    const r = await ws.engine.prepareRename(decl, 'fetch_order');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('ResourceOperation');
    if (r.kind === 'unavailable') expect(r.recoveryActions?.some((a) => a.command === 'refyntra.nativeRename')).toBe(true);
    ws.world.renameMutator = (edit) => fakeEdit([...edit.entries(), [fakeUri('vscode-notebook-cell:/x'), [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }]]]);
    const r2 = await ws.engine.prepareRename(decl, 'fetch_order');
    expect(r2.kind === 'unavailable' && r2.reasonCode).toBe('NonFileTarget');
  });

  it('rename inside a string is refused (the provider would only see text)', async () => {
    const ws = await make(language);
    const text = ws.world.text(useUri)!;
    const line = text.split('\n').findIndex((l) => l.includes('"get_order"'));
    const r = await ws.engine.prepareRename({ uri: useUri, position: { line, character: text.split('\n')[line]!.indexOf('"get_order"') + 3 } }, 'fetch_order');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('InsideString');
  });
});

describe('language-specific refusals', () => {
  it('Python: a rename that touches an import module path is refused (possible file operation)', async () => {
    // A provider that can rename the module name in `import app.orders as orders`.
    const ws = await make(PYTHON_LANGUAGE, {
      wrapCommands: (inner) => ({
        executeCommand: async <T>(c: string, ...a: unknown[]) => {
          const p = a[1] as { line: number } | undefined;
          if (c === PROVIDER_COMMANDS.prepareRename && p?.line === 1) return { range: { start: { line: 1, character: 11 }, end: { line: 1, character: 17 } }, placeholder: 'orders' } as T;
          return inner.executeCommand<T>(c, ...a);
        },
      }),
    });
    const r = await ws.engine.prepareRename({ uri: PY_USE, position: { line: 1, character: 12 } }, 'billing');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('PossibleFileOperation');
    // The provider's edit lands in a module path although the cursor was elsewhere.
    ws.world.renameMutator = (edit) => fakeEdit([...edit.entries(), [fakeUri(PY_USE), [{ range: { start: { line: 1, character: 11 }, end: { line: 1, character: 17 } }, newText: 'billing' }]]]);
    const r2 = await ws.engine.prepareRename(PY_DECL, 'fetch_order');
    expect(r2.kind === 'unavailable' && r2.reasonCode).toBe('PossibleFileOperation');
  });

  it('Rust: edits inside macro_rules! bodies and `mod name;` declarations are refused', async () => {
    const files = {
      ...RS_FILES,
      'file:///ws/src/macros.rs': 'macro_rules! call_get {\n    () => { get_order(0) };\n}\n',
    };
    const ws = await make(RUST_LANGUAGE, { files });
    const r = await ws.engine.prepareRename(RS_DECL, 'fetch_order');
    expect(r.kind === 'unavailable' && r.reasonCode).toBe('MacroDefinition');
    if (r.kind === 'unavailable') expect(r.recoveryActions?.some((a) => a.command === 'refyntra.nativeRename')).toBe(true);
    const m = await ws.engine.prepareRename({ uri: RS_LIB, position: { line: 0, character: 6 } }, 'billing');
    expect(m.kind === 'unavailable' && m.reasonCode).toBe('PossibleFileOperation');
  });

  it('Rust: raw identifiers are accepted as new names', async () => {
    const ws = await make(RUST_LANGUAGE);
    const r = await ws.engine.prepareRename(RS_DECL, 'r#match');
    expect(r.kind, JSON.stringify(r)).toBe('preview');
  });
});
