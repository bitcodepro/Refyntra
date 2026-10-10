import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto } from '@refyntra/contracts';
import { validatePlanStructure } from '@refyntra/domain';
import { fixtureDescriptor } from '@refyntra/adapter-testing';
import { AdapterRegistry, DocumentTracker, RefyntraEngine, type ApplyReport, type CommitResult, type EditApplier, type LanguageAdapter } from '../src';

// File rename: plan validation of file renames, the apply order (text first, then each file rename), the
// separate failure path (text applied, file not renamed: reported, never rolled back) and the host resync.

const H = (c: string) => c.repeat(64);
const OLD = 'file:///ws/Widget.fixture.cs';
const NEW = 'file:///ws/Thing.fixture.cs';
const OTHER = 'file:///ws/Program.fixture.cs';

function plan(writeSet: PlannedChange[], included = true): RefactorPlanDto {
  return {
    planId: 'p1',
    actionId: 'fixture.rename',
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
    title: 'Rename Widget to Thing',
    fileRename: { files: [{ oldUri: OLD, newUri: NEW }], available: true, included },
  };
}

const text = (uri: string, result = H('b')): PlannedChange => ({ kind: 'text', uri, expectedHash: H('a'), resultHash: result, edits: [] });
const rename = (oldUri = OLD, newUri = NEW, resultHash = H('b')): PlannedChange => ({ kind: 'rename', oldUri, newUri, resultHash });
const codes = (p: RefactorPlanDto) => validatePlanStructure(p).map((i) => i.code);

describe('File rename plan validation', () => {
  it('accepts text changes followed by a file rename of an edited file with the same result hash', () => {
    expect(codes(plan([text(OLD), text(OTHER, H('c')), rename()]))).toEqual([]);
  });

  it('requires every file rename after every text change', () => {
    expect(codes(plan([text(OLD), rename(), text(OTHER, H('c'))]))).toContain('unordered-changes');
  });

  it('refuses a rename the plan did not offer, a delegated plan or a non-file URI', () => {
    expect(codes(plan([text(OLD), rename()], false))).toContain('unsupported-change');
    expect(codes(plan([text(OLD), rename(OLD, 'untitled:Thing.cs')]))).toContain('non-file-uri');
  });

  it('refuses another folder, another file kind, a case-only rename and a separator in the name', () => {
    expect(codes(plan([text(OLD), rename(OLD, 'file:///other/Thing.fixture.cs')]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), rename(OLD, 'file:///ws/Thing.txt')]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), rename(OLD, 'file:///ws/WIDGET.FIXTURE.cs')]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), rename(OLD, 'file:///ws/a%2FThing.cs')]))).toContain('invalid-rename');
  });

  it('refuses a rename of a file the plan does not edit, with another result, onto an edited file or twice', () => {
    expect(codes(plan([text(OTHER), rename()]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), rename(OLD, NEW, H('c'))]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), text(OTHER, H('c')), rename(OLD, OTHER)]))).toContain('invalid-rename');
    expect(codes(plan([text(OLD), rename(), rename(OLD, 'file:///ws/Gear.cs')]))).toContain('invalid-rename');
  });
});

/** Minimal owned route: prepare returns the given plan; revalidate is valid; records filesRenamed and restarts. */
function route(p: RefactorPlanDto) {
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
    symbolAt: async () => ({ value: { symbolId: 'sym', name: 'Widget' }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 }),
    prepare: async () => ({ value: { kind: 'prepared', plan: p }, providerRouteId: 'fixture.engine', sessionEpoch: 'e1', snapshotId: 's1', workspaceRevision: 0 }),
    revalidate: async () => {
      calls.push('revalidate');
      return { status: 'valid' };
    },
    discard: () => undefined,
    filesRenamed: (files: readonly { oldUri: string; newUri: string }[]) => {
      calls.push(`filesRenamed:${files.map((f) => `${f.oldUri}>${f.newUri}`).join(',')}`);
      return true;
    },
    dispose: async () => undefined,
  } as unknown as LanguageAdapter;
  return { adapter, calls };
}

/** Records the order of operations; `report` decides the reconciled outcome. */
function applier(calls: string[], report: (writeSet: readonly PlannedChange[]) => ApplyReport): EditApplier {
  return {
    capture: async (writeSet) => {
      calls.push(`capture:${writeSet.map((c) => c.kind).join(',')}`);
      return { ok: true, commit: (): CommitResult => ({ started: true, result: Promise.resolve(report(writeSet)) }) };
    },
  };
}

function engine(p: RefactorPlanDto, report: (writeSet: readonly PlannedChange[]) => ApplyReport) {
  const { adapter, calls } = route(p);
  const registry = new AdapterRegistry();
  registry.registerLanguage(adapter);
  const tracker = new DocumentTracker();
  const e = new RefyntraEngine({
    workspaceId: 'ws',
    registry,
    tracker,
    editApplier: applier(calls, report),
    settings: { applyRenameEnabled: () => true },
    logger: { log: () => undefined } as never,
    isTrusted: () => true,
  });
  return { e, calls, tracker };
}

const at = { uri: OLD, position: { line: 0, character: 0 } };
const confirmedText = { uri: OLD, status: 'confirmed' as const };

describe('File rename apply: order, failure path and resync', () => {
  it('passes the text changes and then the file rename to the single EditApplier; success resyncs the host without reload', async () => {
    const { e, calls, tracker } = engine(plan([text(OLD), rename()]), () => ({ editorAccepted: true, files: [confirmedText], resources: [{ kind: 'rename', oldUri: OLD, newUri: NEW, status: 'confirmed' }] }));
    const p = await e.prepareRename(at, 'Thing', undefined, { renameFile: true });
    expect(p.kind).toBe('preview');
    if (p.kind !== 'preview') return;
    expect(p.issues).toEqual([]);
    const before = tracker.revision;
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('applied');
    expect(out.message).toMatch(/renamed to Thing\.fixture\.cs/);
    expect(calls).toEqual(['revalidate', 'capture:text,rename', `filesRenamed:${OLD}>${NEW}`]);
    expect(tracker.revision).toBeGreaterThan(before);
  });

  it('text applied but the file rename refused: failed with textAppliedOnly, the exact status, no rollback and no resync', async () => {
    const { e, calls } = engine(plan([text(OLD), rename()]), () => ({
      editorAccepted: true,
      files: [confirmedText],
      resources: [{ kind: 'rename', oldUri: OLD, newUri: NEW, status: 'refused', detail: 'Thing.fixture.cs appeared after the text edits' }],
    }));
    const p = await e.prepareRename(at, 'Thing', undefined, { renameFile: true });
    if (p.kind !== 'preview') throw new Error('no preview');
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('failed');
    expect(out.textAppliedOnly).toBe(true);
    expect(out.message).toMatch(/text edits were applied to 1 file\(s\).*Widget\.fixture\.cs → Thing\.fixture\.cs: refused.*Nothing was rolled back.*Undo/);
    expect(out.resources?.[0]?.status).toBe('refused');
    expect(calls.filter((c) => c.startsWith('filesRenamed') || c.startsWith('restart'))).toEqual([]);
    expect(e.planState(p.planId)).toBeUndefined(); // single use
  });

  it('an unknown file rename result restarts the route (full reload) instead of guessing', async () => {
    const { e, calls } = engine(plan([text(OLD), rename()]), () => ({ editorAccepted: true, files: [confirmedText], resources: [{ kind: 'rename', oldUri: OLD, newUri: NEW, status: 'unknown' }] }));
    const p = await e.prepareRename(at, 'Thing', undefined, { renameFile: true });
    if (p.kind !== 'preview') throw new Error('no preview');
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('failed');
    expect(calls).toContain('restart:files renamed');
  });

  it('text not applied: the rename is not attempted and the message says no file was changed', async () => {
    const { e } = engine(plan([text(OLD), rename()]), () => ({
      editorAccepted: false,
      files: [{ uri: OLD, status: 'unchanged' }],
      resources: [{ kind: 'rename', oldUri: OLD, newUri: NEW, status: 'not-attempted' }],
    }));
    const p = await e.prepareRename(at, 'Thing', undefined, { renameFile: true });
    if (p.kind !== 'preview') throw new Error('no preview');
    const out = await e.applyRename(p.planId);
    expect(out.status).toBe('failed');
    expect(out.textAppliedOnly).toBeUndefined();
    expect(out.message).toMatch(/no file was changed/);
  });

  it('a plan with an unoffered file rename is refused before anything is applied', async () => {
    const { e, calls } = engine(plan([text(OLD), rename()], false), () => ({ editorAccepted: true, files: [] }));
    const p = await e.prepareRename(at, 'Thing', undefined, { renameFile: true });
    if (p.kind !== 'preview') throw new Error('no preview');
    expect(p.state).toBe('Failed');
    expect(p.applyEnabled).toBe(false);
    expect(calls).toEqual([]);
  });
});
