import { describe, expect, it, vi } from 'vitest';
import type { ApplyOutcome, RenamePreview } from '@refyntra/application';

// F2 in C# gets the same checks as Refyntra Rename: refused plans never reach the editor; an applicable one is
// revalidated and every target checked (engine.handOverRename) before its edits are returned for the editor to apply.

vi.mock('vscode', () => {
  class WorkspaceEdit {
    readonly entries: unknown[][] = [];
    replace(...a: unknown[]) {
      this.entries.push(['replace', ...a]);
    }
    renameFile(...a: unknown[]) {
      this.entries.push(['renameFile', ...a]);
    }
    get size() {
      return this.entries.length;
    }
  }
  class Range {
    constructor(...a: number[]) {
      void a;
    }
  }
  class CancellationTokenSource {
    token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  }
  return {
    WorkspaceEdit,
    Range,
    TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
    Uri: { parse: (s: string) => s },
    CancellationTokenSource,
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    extensions: { getExtension: () => undefined },
  };
});

import { CSharpRenameProvider } from '../../src/editorEdits';
import { editorRenameRefusal } from '../../src/editorEditsModel';

const writeSet = [{ kind: 'text', uri: 'file:///w/A.cs', expectedHash: 'e', resultHash: 'r', edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'B' }] }];

function preview(over: Partial<RenamePreview> = {}, validation: 'valid' | 'limited' = 'valid', changes: unknown[] = writeSet): RenamePreview {
  return {
    kind: 'preview',
    planId: 'p1',
    state: 'Previewing',
    issues: [],
    applyEnabled: true,
    plan: { kind: 'owned-semantic', planId: 'p1', title: 'Rename A to B', writeSet: changes, limitations: validation === 'limited' ? ['razor not checked'] : [], validation: { status: validation, checkedContexts: [], uncheckedContexts: [], compilationDelta: 'passed' } } as never,
    ...over,
  };
}

function engine(r: RenamePreview, checked: ApplyOutcome = { status: 'handed-over', message: 'Rename A to B: checked and handed to the editor' }) {
  return {
    prepareRename: vi.fn(async () => r),
    handOverRename: vi.fn(async () => checked),
    applyRename: vi.fn(),
    discardPlan: vi.fn(),
  };
}

const doc = { uri: { toString: () => 'file:///w/A.cs' } } as never;
const pos = { line: 0, character: 6 } as never;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never;

describe('F2 rename in C#', () => {
  it.each([
    ['a Failed plan with issues and apply disabled', preview({ state: 'Failed', applyEnabled: false, issues: [{ code: 'overlapping-edits', message: 'Edits overlap in A.cs' }] }), /problems: Edits overlap/],
    ['a plan in another state than Previewing', preview({ state: 'Failed' }), /Failed and cannot be applied/],
    ['applying turned off (refyntra.rename.apply)', preview({ applyEnabled: false }), /turned off/],
    ['a plan only partly validated (no confirmation in the rename box)', preview({}, 'limited'), /partly validate/],
    ['a plan that deletes a file', preview({}, 'valid', [...writeSet, { kind: 'delete', uri: 'file:///w/Old.cs', expectedHash: 'x' }]), /creates or deletes files/],
  ])('refuses %s: no edit reaches the editor and the plan is discarded', async (_name, r, reason) => {
    const e = engine(r);
    const p = new CSharpRenameProvider(e as never);
    await expect(p.provideRenameEdits(doc, pos, 'B', token)).rejects.toThrow(reason);
    expect(e.handOverRename).not.toHaveBeenCalled();
    expect(e.discardPlan).toHaveBeenCalledWith('p1');
  });

  it('a valid plan is revalidated and checked by the engine, then its edits are returned (nothing applied here)', async () => {
    const e = engine(preview());
    const p = new CSharpRenameProvider(e as never);
    const edit = (await p.provideRenameEdits(doc, pos, ' B ', token)) as unknown as { size: number; entries: unknown[][] };
    expect(e.prepareRename).toHaveBeenCalledWith({ uri: 'file:///w/A.cs', position: { line: 0, character: 6 } }, 'B', expect.anything(), {});
    expect(e.handOverRename).toHaveBeenCalledWith('p1', expect.anything());
    expect(e.applyRename).not.toHaveBeenCalled();
    expect(edit.size).toBe(1);
    expect(edit.entries[0]![3]).toBe('B');
  });

  it('a stale check (the code changed after prepare) returns no edits', async () => {
    const e = engine(preview(), { status: 'stale', message: 'The code changed since the preview (A.cs changed).', canReprepare: true });
    const p = new CSharpRenameProvider(e as never);
    await expect(p.provideRenameEdits(doc, pos, 'B', token)).rejects.toThrow(/code changed since the rename was prepared.*A\.cs changed/);
    expect(e.discardPlan).toHaveBeenCalledWith('p1');
  });

  it('a plan Refyntra Rename would apply without asking passes the gate', () => {
    expect(editorRenameRefusal(preview())).toBeUndefined();
  });
});
