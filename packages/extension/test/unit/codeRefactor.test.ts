import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto, SignatureInfo } from '@refyntra/contracts';
import { capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import {
  addRow,
  codeRefactorSummary,
  deletedFilePreview,
  identifierProblem,
  initialRows,
  isUnchanged,
  moveRow,
  removeRow,
  removedNames,
  renameRow,
  rowDescription,
  rowsProblem,
  signatureText,
  toSpec,
} from '../../src/codeRefactorSummary';
import { sha256 } from '../../src/textEdits';

// Safe Delete / Extract Method / Change Signature presentation: capability → command, the preview summary (deleted
// files, limited plans), the deleted-file diff and the Change Signature editor model.

const H = (c: string) => c.repeat(64);

function plan(writeSet: PlannedChange[], status: 'valid' | 'limited' = 'valid'): RefactorPlanDto {
  return {
    planId: 'p1',
    actionId: 'csharp.safeDelete',
    providerRouteId: 'csharp.roslyn',
    protocolMajor: 1,
    workspaceId: 'ws',
    kind: 'owned-semantic',
    sessionEpoch: 'e1',
    baseWorkspaceRevision: 0,
    baseSnapshotId: 's1',
    projectContextIds: ['pc'],
    writeSet,
    readSet: [],
    evidence: [{ description: 'No use of Unused outside the deleted code' }],
    limitations: ['Framework relation (mediatr.request, proven): Ping'],
    validation: { status, checkedContexts: ['pc'], uncheckedContexts: [], compilationDelta: 'passed' },
    title: 'Safe delete class Unused',
    fileDelete: { files: ['file:///ws/Unused.cs'] },
  };
}

describe('Code refactoring capabilities', () => {
  it('maps the new capabilities to their commands and titles', () => {
    expect(commandForCapability('csharp.safeDelete')).toBe('refyntra.safeDelete');
    expect(commandForCapability('csharp.extractMethod')).toBe('refyntra.extractMethod');
    expect(commandForCapability('csharp.changeSignature')).toBe('refyntra.changeSignature');
    expect(capabilityTitleOf('csharp.safeDelete')).toBe('Safe delete (only when unused, preview first)');
  });
});

describe('Code refactoring preview', () => {
  it('a deleted file is a diff to empty; a changed file makes the preview invalid', () => {
    const change = { kind: 'delete' as const, uri: 'file:///ws/Unused.cs', expectedHash: sha256('class Unused {}\n') };
    expect(deletedFilePreview(change, 'class Unused {}\n')).toEqual({ uri: change.uri, original: 'class Unused {}\n', modified: '', editCount: 1 });
    expect(deletedFilePreview(change, 'class Changed {}\n').problem).toMatch(/changed/);
  });

  it('the summary lists edits, deleted files with their order, limitations and evidence; limited plans ask for confirmation', () => {
    const p = plan([{ kind: 'text', uri: 'file:///ws/Members.cs', expectedHash: H('a'), resultHash: H('b'), edits: [] }, { kind: 'delete', uri: 'file:///ws/Unused.cs', expectedHash: H('d') }], 'limited');
    const files = [
      { uri: 'file:///ws/Members.cs', original: 'a', modified: 'b', editCount: 2 },
      { uri: 'file:///ws/Unused.cs', original: 'x', modified: '', editCount: 1 },
    ];
    const text = codeRefactorSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: true }, files, false, (u) => u.slice(u.lastIndexOf('/') + 1));
    expect(text).toContain('# Safe delete class Unused');
    expect(text).toContain('**Partly validated.**');
    expect(text).toContain('- Members.cs — 2 edit(s), not saved');
    expect(text).toContain('- Unused.cs — deleted after the edits, only while its text is unchanged');
    expect(text).toContain('Only when every edit is confirmed is the file deleted');
    expect(text).toContain('- Framework relation (mediatr.request, proven): Ping');
    expect(text).toContain('## Evidence');
    const valid = codeRefactorSummary({ plan: plan([], 'valid'), state: 'Previewing', issues: [], applyEnabled: false }, [], false, (u) => u);
    expect(valid).toContain('**Preview only.**');
  });
});

describe('Change Signature editor model', () => {
  const info: SignatureInfo = {
    name: 'Greet',
    parameters: [
      { name: 'name', type: 'string', modifiers: '' },
      { name: 'times', type: 'int', modifiers: '' },
      { name: 'rest', type: 'int[]', modifiers: 'params' },
    ],
    snapshotId: 's1',
  };

  it('starts unchanged and turns edits into the parameter spec', () => {
    let rows = initialRows(info);
    expect(isUnchanged(rows, info)).toBe(true);
    expect(signatureText(rows)).toBe('(string name, int times, params int[] rest)');
    rows = moveRow(rows, 1, -1);
    rows = renameRow(rows, 1, 'person');
    expect(isUnchanged(rows, info)).toBe(false);
    expect(rowDescription(rows[1]!, info)).toBe('renamed from name');
    expect(toSpec(rows)).toEqual([{ from: 1, name: 'times' }, { from: 0, name: 'person' }, { from: 2, name: 'rest' }]);
  });

  it('adds new parameters before a params array, removes parameters and reports what is removed', () => {
    let rows = addRow(initialRows(info), { name: 'polite', type: 'bool', callSiteValue: 'true' });
    expect(rows.map((r) => r.name)).toEqual(['name', 'times', 'polite', 'rest']);
    expect(rowDescription(rows[2]!, info)).toBe('new · call sites get true');
    rows = removeRow(rows, 1);
    expect(removedNames(rows, info)).toEqual(['times']);
    expect(toSpec(rows)).toEqual([{ from: 0, name: 'name' }, { name: 'polite', type: 'bool', callSiteValue: 'true' }, { from: 2, name: 'rest' }]);
    expect(moveRow(rows, 0, -1)).toEqual(rows);
  });

  it('validates names and values before anything is sent', () => {
    expect(identifierProblem('ok_1')).toBeUndefined();
    expect(identifierProblem('1x')).toMatch(/letters/);
    expect(identifierProblem('class')).toMatch(/keyword/);
    expect(rowsProblem(renameRow(initialRows(info), 1, 'name'))).toMatch(/Two parameters/);
    expect(rowsProblem(addRow(initialRows(info), { name: 'x', type: 'int' }))).toMatch(/call-site value or a default value/);
    expect(rowsProblem(addRow(initialRows(info), { name: 'x', type: 'int', defaultValue: '0' }))).toBeUndefined();
  });
});
