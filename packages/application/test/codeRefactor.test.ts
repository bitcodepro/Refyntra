import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto, SignatureInfo } from '@refyntra/contracts';
import { validatePlanStructure } from '@refyntra/domain';
import { fixtureDescriptor } from '@refyntra/adapter-testing';
import { AdapterRegistry, DocumentTracker, RefyntraEngine, type ApplyReport, type CommitResult, type EditApplier, type LanguageAdapter } from '../src';

// Safe Delete, Extract Method, Change Signature (protocol 1.6): plan validation of deleted files (last, listed, C# files,
// no overlap with other changes), apply outcomes (deleted, text applied but the delete did not complete, never rolled
// back), the host resync (didDeleteFiles, or a restart), Extract Method prepared from a selection without a symbol, and
// the signature query.

const H = (c: string) => c.repeat(64);
const SRC = 'file:///ws/Members.cs';
const GONE = 'file:///ws/Unused.cs';
const ACTION = 'csharp.safeDelete';

function plan(writeSet: PlannedChange[], files: string[] = [GONE], actionId = ACTION): RefactorPlanDto {
  return {
    planId: 'p1',
    actionId,
    providerRouteId: 'fixture.engine',
    protocolMajor: 1,
    workspaceId: 'ws',
    kind: 'owned-semantic',
    sessionEpoch: 'e1',
    baseWorkspaceRevision: 0,
    baseSnapshotId: 's1',
    projectContextIds: ['pc'],
    writeSet,
    readSet: [],
    evidence: [],
    limitations: [],
    validation: { status: 'valid', checkedContexts: ['pc'], uncheckedContexts: [], compilationDelta: 'passed' },
    title: 'Safe delete class Unused',
    ...(files.length ? { fileDelete: { files } } : {}),
  };
}

const del = (uri = GONE, expectedHash = H('d')): PlannedChange => ({ kind: 'delete', uri, expectedHash });
const textChange = (uri = SRC): PlannedChange => ({ kind: 'text', uri, expectedHash: H('a'), resultHash: H('b'), edits: [] });
const codes = (p: RefactorPlanDto) => validatePlanStructure(p).map((i) => i.code);

describe('Deleted file plan validation', () => {
  it('accepts a delete after the text changes, and a delete-only plan', () => {
    expect(codes(plan([textChange(), del()]))).toEqual([]);
    expect(codes(plan([del()]))).toEqual([]);
  });

  it('requires deleted files last', () => {
    expect(codes(plan([del(), textChange()]))).toContain('unordered-changes');
  });

  it('refuses a delete the plan does not list, a plan without fileDelete, a non-file URI, a non-C# file and a missing hash', () => {
    expect(codes(plan([del()], ['file:///ws/Other.cs']))).toContain('invalid-delete');
    expect(codes(plan([del()], []))).toContain('unsupported-change');
    expect(codes(plan([del('untitled:Unused.cs')], ['untitled:Unused.cs']))).toContain('non-file-uri');
    expect(codes(plan([del('file:///ws/Unused.txt')], ['file:///ws/Unused.txt']))).toContain('invalid-delete');
    expect(codes(plan([del(GONE, 'nothex')]))).toContain('missing-hash');
  });

  it('refuses a deleted file that is also edited, and a duplicate', () => {
    expect(codes(plan([textChange(GONE), del()]))).toContain('invalid-delete');
    expect(codes(plan([del(), del('file:///ws/UNUSED.cs')], [GONE, 'file:///ws/UNUSED.cs']))).toContain('invalid-delete');
  });
});

function route(p: RefactorPlanDto, deleted = true, signature?: SignatureInfo) {
  const calls: string[] = [];
  const adapter = {
    descriptor: { ...fixtureDescriptor(), fileExtensions: ['.cs'] },
    handles: () => true,
    health: () => ({ providerRouteId: 'fixture.engine', displayName: 'Fixture', state: 'Ready', recoveryActions: [] }),
    onDidChangeHealth: () => ({ dispose: () => undefined }),
    onDidChangeEpoch: () => ({ dispose: () => undefined }),
    currentEpoch: () => 'e1',
    start: async () => undefined,
    restart: async (reason: string) => void calls.push(`restart:${reason}`),
    documentEvent: () => undefined,
    symbolAt: async () => {
      calls.push('symbolAt');
      return { value: { symbolId: 'sym', name: 'Unused' }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 };
    },
    prepare: async (req: { actionId: string; symbolId: string; newName: string; range?: unknown; signature?: unknown }) => {
      calls.push(`prepare:${req.actionId}:${req.symbolId || '-'}:${req.newName || '-'}:${req.range ? 'range' : '-'}:${req.signature ? JSON.stringify(req.signature) : '-'}`);
      return { value: { kind: 'prepared', plan: p }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 };
    },
    revalidate: async () => ({ status: 'valid' }),
    discard: () => undefined,
    filesDeleted: (uris: readonly string[]) => {
      calls.push(`filesDeleted:${uris.join(',')}`);
      return deleted;
    },
    signatureAt: async () => ({ value: signature ?? null, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 }),
    dispose: async () => undefined,
  } as unknown as LanguageAdapter;
  return { adapter, calls };
}

function engine(p: RefactorPlanDto, report: () => ApplyReport, deleted = true, signature?: SignatureInfo) {
  const { adapter, calls } = route(p, deleted, signature);
  const registry = new AdapterRegistry();
  registry.registerLanguage(adapter);
  const applier: EditApplier = {
    capture: async (writeSet) => {
      calls.push(`capture:${writeSet.map((c) => c.kind).join(',')}`);
      return { ok: true, commit: (): CommitResult => ({ started: true, result: Promise.resolve(report()) }) };
    },
  };
  const e = new RefyntraEngine({ workspaceId: 'ws', registry, tracker: new DocumentTracker(), editApplier: applier, settings: { applyRenameEnabled: () => true }, logger: { log: () => undefined } as never, isTrusted: () => true });
  return { e, calls };
}

const at = { uri: SRC, position: { line: 0, character: 0 } };

describe('Safe Delete apply: outcomes and resync', () => {
  it('applies text then delete through the single EditApplier and resyncs with didDeleteFiles', async () => {
    const { e, calls } = engine(plan([textChange(), del()]), () => ({ editorAccepted: true, files: [{ uri: SRC, status: 'confirmed' }], resources: [{ kind: 'delete', uri: GONE, status: 'confirmed' }] }));
    const p = await e.prepareAction(at, ACTION);
    if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
    expect(p.issues).toEqual([]);
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('applied');
    expect(out.message).toBe('Safe delete class Unused: 1 file(s) changed and Unused.cs deleted');
    expect(calls).toEqual(['symbolAt', `prepare:${ACTION}:sym:-:-:-`, 'capture:text,delete', `filesDeleted:${GONE}`]);
  });

  it('a delete-only plan reports only the deleted file', async () => {
    const { e } = engine(plan([del()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'delete', uri: GONE, status: 'confirmed' }] }));
    const p = await e.prepareAction(at, ACTION);
    if (p.kind !== 'preview') throw new Error('no preview');
    expect((await e.applyRename(p.planId)).message).toBe('Safe delete class Unused: Unused.cs deleted');
  });

  it('text applied but the delete refused: textAppliedOnly, exact message, no rollback, no delete resync', async () => {
    const { e, calls } = engine(plan([textChange(), del()]), () => ({ editorAccepted: true, files: [{ uri: SRC, status: 'confirmed' }], resources: [{ kind: 'delete', uri: GONE, status: 'refused', detail: 'Unused.cs changed' }] }));
    const p = await e.prepareAction(at, ACTION);
    if (p.kind !== 'preview') throw new Error('no preview');
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('failed');
    expect(out.textAppliedOnly).toBe(true);
    expect(out.message).toMatch(/the file deletion did not complete \(Unused\.cs: refused \(Unused\.cs changed\)\)\. Nothing was rolled back/);
    expect(calls.filter((c) => c.startsWith('filesDeleted') || c.startsWith('restart'))).toEqual([]);
  });

  it('an unknown delete result, or a backend without didDeleteFiles, restarts the route', async () => {
    const unknown = engine(plan([del()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'delete', uri: GONE, status: 'unknown' }] }));
    const p1 = await unknown.e.prepareAction(at, ACTION);
    if (p1.kind !== 'preview') throw new Error('no preview');
    await unknown.e.applyRename(p1.planId);
    expect(unknown.calls.some((c) => c.startsWith('restart:'))).toBe(true);
    const old = engine(plan([del()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'delete', uri: GONE, status: 'confirmed' }] }), false);
    const p2 = await old.e.prepareAction(at, ACTION);
    if (p2.kind !== 'preview') throw new Error('no preview');
    expect((await old.e.applyRename(p2.planId)).status).toBe('applied');
    expect(old.calls.some((c) => c.startsWith('restart:'))).toBe(true);
  });
});

describe('Extract Method and Change Signature preparation', () => {
  it('Extract Method prepares from the selection without asking for a symbol', async () => {
    const { e, calls } = engine(plan([textChange()], [], 'csharp.extractMethod'), () => ({ editorAccepted: true, files: [] }));
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 5 } };
    const p = await e.prepareAction({ uri: SRC, position: range.start }, 'csharp.extractMethod', undefined, { range, newName: 'Helper' });
    expect(p.kind).toBe('preview');
    expect(calls).toEqual(['prepare:csharp.extractMethod:-:Helper:range:-']);
  });

  it('Change Signature sends the new parameter list with the symbol', async () => {
    const { e, calls } = engine(plan([textChange()], [], 'csharp.changeSignature'), () => ({ editorAccepted: true, files: [] }));
    const signature = { parameters: [{ from: 1, name: 'b' }, { from: 0, name: 'a' }] };
    const p = await e.prepareAction(at, 'csharp.changeSignature', undefined, { signature });
    expect(p.kind).toBe('preview');
    expect(calls).toEqual(['symbolAt', `prepare:csharp.changeSignature:sym:-:-:${JSON.stringify(signature)}`]);
  });

  it('signatureAt returns the parameters, or the host reason as unavailable', async () => {
    const info: SignatureInfo = { name: 'Greet', display: 'Greet(string, int)', parameters: [{ name: 'name', type: 'string', modifiers: '' }], snapshotId: 's1' };
    const ok = engine(plan([textChange()], []), () => ({ editorAccepted: true, files: [] }), true, info);
    const r = await ok.e.signatureAt(at);
    expect(r.kind === 'signature' && r.info.parameters[0]!.name).toBe('name');
    const refused = engine(plan([textChange()], []), () => ({ editorAccepted: true, files: [] }), true, { parameters: [], reasonCode: 'UnsupportedSymbolKind', message: 'Change Signature applies to methods and constructors.', snapshotId: 's1' });
    const u = await refused.e.signatureAt(at);
    expect(u.kind === 'unavailable' && u.reasonCode).toBe('UnsupportedSymbolKind');
    const none = engine(plan([textChange()], []), () => ({ editorAccepted: true, files: [] }));
    expect((await none.e.signatureAt(at)).kind).toBe('unavailable');
  });
});
