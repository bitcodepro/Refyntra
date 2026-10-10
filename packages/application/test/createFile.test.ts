import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto } from '@refyntra/contracts';
import { validatePlanStructure } from '@refyntra/domain';
import { fixtureDescriptor } from '@refyntra/adapter-testing';
import { AdapterRegistry, DocumentTracker, RefyntraEngine, type ApplyReport, type CommitResult, type EditApplier, type LanguageAdapter } from '../src';

// Created files (Move Type to File, Generate handler): plan validation (created files first, listed, C# files, no
// overlap with edited or renamed files), the apply outcomes (all confirmed; create failed → nothing changed; created but
// text not applied → createdOnly, never rolled back) and the host resync (didCreateFiles, or a restart).

const H = (c: string) => c.repeat(64);
const SRC = 'file:///ws/Shapes.cs';
const NEW = 'file:///ws/Circle.cs';
const ACTION = 'csharp.moveTypeToFile';

function plan(writeSet: PlannedChange[], files: string[] = [NEW]): RefactorPlanDto {
  return {
    planId: 'p1',
    actionId: ACTION,
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
    title: 'Move Circle to Circle.cs',
    fileCreate: { files },
  };
}

const create = (uri = NEW, text = 'class Circle {}\n', resultHash = H('c')): PlannedChange => ({ kind: 'create', uri, text, resultHash });
const textChange = (uri = SRC): PlannedChange => ({ kind: 'text', uri, expectedHash: H('a'), resultHash: H('b'), edits: [] });
const codes = (p: RefactorPlanDto) => validatePlanStructure(p).map((i) => i.code);

describe('Created file plan validation', () => {
  it('accepts a created file followed by the text change, and a create-only plan', () => {
    expect(codes(plan([create(), textChange()]))).toEqual([]);
    expect(codes(plan([create()]))).toEqual([]);
  });

  it('requires created files before every text change and file rename', () => {
    expect(codes(plan([textChange(), create()]))).toContain('unordered-changes');
  });

  it('refuses a create the plan does not list, a plan without fileCreate, or a non-file URI', () => {
    expect(codes(plan([create()], ['file:///ws/Other.cs']))).toContain('invalid-create');
    const { fileCreate: _, ...bare } = plan([create()]);
    expect(codes(bare as RefactorPlanDto)).toContain('unsupported-change');
    expect(codes(plan([create('untitled:Circle.cs')], ['untitled:Circle.cs']))).toContain('non-file-uri');
  });

  it('refuses a non-C# file, an encoded separator, a missing hash, a huge text, a duplicate and an edited target', () => {
    expect(codes(plan([create('file:///ws/Circle.txt')], ['file:///ws/Circle.txt']))).toContain('invalid-create');
    expect(codes(plan([create('file:///ws/a%2FCircle.cs')], ['file:///ws/a%2FCircle.cs']))).toContain('invalid-create');
    expect(codes(plan([create(NEW, 'x', 'nothex')]))).toContain('missing-hash');
    expect(codes(plan([create(NEW, 'x'.repeat(512 * 1024 + 1))]))).toContain('invalid-create');
    expect(codes(plan([create(), create('file:///ws/CIRCLE.cs')], [NEW, 'file:///ws/CIRCLE.cs']))).toContain('invalid-create');
    expect(codes(plan([create(SRC), textChange(SRC)], [SRC]))).toContain('invalid-create');
  });
});

function route(p: RefactorPlanDto, created = true) {
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
    symbolAt: async () => ({ value: { symbolId: 'sym', name: 'Circle' }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 }),
    prepare: async (req: { actionId: string; documentUri?: string }) => {
      calls.push(`prepare:${req.actionId}:${req.documentUri ?? '-'}`);
      return { value: { kind: 'prepared', plan: p }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 };
    },
    revalidate: async () => {
      calls.push('revalidate');
      return { status: 'valid' };
    },
    discard: () => undefined,
    filesCreated: (uris: readonly string[]) => {
      calls.push(`filesCreated:${uris.join(',')}`);
      return created;
    },
    dispose: async () => undefined,
  } as unknown as LanguageAdapter;
  return { adapter, calls };
}

function engine(p: RefactorPlanDto, report: () => ApplyReport, created = true) {
  const { adapter, calls } = route(p, created);
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

async function prepared(e: RefyntraEngine) {
  const p = await e.prepareAction(at, ACTION);
  if (p.kind !== 'preview') throw new Error(JSON.stringify(p));
  expect(p.issues).toEqual([]);
  return p;
}

describe('Created files apply: outcomes and resync', () => {
  it('prepares with the action id and the cursor document; applies create then text through the single EditApplier; resyncs with didCreateFiles', async () => {
    const { e, calls } = engine(plan([create(), textChange()]), () => ({ editorAccepted: true, files: [{ uri: SRC, status: 'confirmed' }], resources: [{ kind: 'create', uri: NEW, status: 'confirmed' }] }));
    const p = await prepared(e);
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('applied');
    expect(out.message).toBe('Move Circle to Circle.cs: Circle.cs created and 1 file(s) changed');
    expect(calls).toEqual([`prepare:${ACTION}:${SRC}`, 'revalidate', 'capture:create,text', `filesCreated:${NEW}`]);
  });

  it('a create-only plan (Generate handler) reports the created file', async () => {
    const { e } = engine(plan([create()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'create', uri: NEW, status: 'confirmed' }] }));
    const out = await e.applyRename((await prepared(e)).planId);
    expect(out.status).toBe('applied');
    expect(out.message).toBe('Move Circle to Circle.cs: Circle.cs created');
  });

  it('the create fails: nothing changed, no resync, the text edit was not attempted', async () => {
    const { e, calls } = engine(plan([create(), textChange()]), () => ({
      editorAccepted: false,
      files: [{ uri: SRC, status: 'unchanged', detail: 'not attempted: the file was not created' }],
      resources: [{ kind: 'create', uri: NEW, status: 'failed', detail: 'the editor did not create the file' }],
    }));
    const out = await e.applyRename((await prepared(e)).planId);
    expect(out.status).toBe('failed');
    expect(out.message).toMatch(/the file was not created \(Circle\.cs: failed \(the editor did not create the file\)\); no file was changed/);
    expect(out.createdOnly).toBeUndefined();
    expect(out.canReprepare).toBe(true);
    expect(calls.filter((c) => c.startsWith('filesCreated') || c.startsWith('restart'))).toEqual([]);
  });

  it('created but the text edit not applied: createdOnly, exact message, no rollback, the created file is resynced', async () => {
    const { e, calls } = engine(plan([create(), textChange()]), () => ({
      editorAccepted: false,
      files: [{ uri: SRC, status: 'unchanged' }],
      resources: [{ kind: 'create', uri: NEW, status: 'confirmed' }],
    }));
    const out = await e.applyRename((await prepared(e)).planId);
    expect(out.status).toBe('failed');
    expect(out.createdOnly).toBe(true);
    expect(out.message).toMatch(/Circle\.cs was created, but the edit of Shapes\.cs was not applied.*Nothing was rolled back/);
    expect(calls).toContain(`filesCreated:${NEW}`);
  });

  it('an unknown create result, or a backend without didCreateFiles, restarts the route', async () => {
    const unknown = engine(plan([create()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'create', uri: NEW, status: 'unknown' }] }));
    expect((await unknown.e.applyRename((await prepared(unknown.e)).planId)).status).toBe('failed');
    expect(unknown.calls.some((c) => c.startsWith('restart:'))).toBe(true);
    const old = engine(plan([create()]), () => ({ editorAccepted: true, files: [], resources: [{ kind: 'create', uri: NEW, status: 'confirmed' }] }), false);
    expect((await old.e.applyRename((await prepared(old.e)).planId)).status).toBe('applied');
    expect(old.calls.some((c) => c.startsWith('restart:'))).toBe(true);
  });

  it('a plan for another action is refused before anything is applied', async () => {
    const { e, calls } = engine({ ...plan([create()]), actionId: 'csharp.generateHandler' }, () => ({ editorAccepted: true, files: [] }));
    const p = await e.prepareAction(at, ACTION);
    if (p.kind !== 'preview') throw new Error('no preview');
    expect(p.state).toBe('Failed');
    expect(calls.filter((c) => c.startsWith('capture'))).toEqual([]);
  });
});
