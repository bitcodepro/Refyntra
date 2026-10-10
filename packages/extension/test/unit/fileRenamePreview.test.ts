import { describe, expect, it } from 'vitest';
import type { RefactorPlanDto } from '@refyntra/contracts';
import { fileRenameItems, fileRenameLabel, plannedFileRenames, renamePreviewSummary } from '../../src/renameSummary';

// File rename preview: the file rename is its own line and option; when it is not offered the reason is shown.

const H = (c: string) => c.repeat(64);
const OLD = 'file:///ws/Lib/Widget.cs';
const NEW = 'file:///ws/Lib/Thing.cs';

function plan(fileRename: RefactorPlanDto['fileRename'], withRename: boolean): RefactorPlanDto {
  return {
    planId: 'p',
    actionId: 'csharp.rename',
    providerRouteId: 'csharp.roslyn',
    protocolMajor: 1,
    workspaceId: 'ws',
    kind: 'owned-semantic',
    sessionEpoch: 'e',
    baseWorkspaceRevision: 0,
    baseSnapshotId: 's',
    projectContextIds: [],
    writeSet: [
      { kind: 'text', uri: OLD, expectedHash: H('a'), resultHash: H('b'), edits: [] },
      ...(withRename ? [{ kind: 'rename' as const, oldUri: OLD, newUri: NEW, resultHash: H('b') }] : []),
    ],
    readSet: [],
    evidence: [],
    limitations: [],
    validation: { status: 'valid', checkedContexts: [], uncheckedContexts: [], compilationDelta: 'passed' },
    title: 'Rename Widget to Thing',
    ...(fileRename ? { fileRename } : {}),
  };
}

const summary = (p: RefactorPlanDto) => renamePreviewSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: true }, [{ uri: OLD, original: '', modified: '', editCount: 2 }], false, (u) => u.replace('file:///ws/', ''));

describe('file rename preview', () => {
  it('lists the included file rename as its own line after the text edits and as an "on" option', () => {
    const p = plan({ files: [{ oldUri: OLD, newUri: NEW }], available: true, included: true }, true);
    expect(plannedFileRenames(p)).toEqual([{ oldUri: OLD, newUri: NEW }]);
    const s = summary(p);
    expect(s).toContain('file renames: 1');
    expect(s).toContain('## File rename');
    expect(s).toContain('- Rename Lib/Widget.cs → Thing.cs (after the text edits, as a separate step)');
    expect(s).toMatch(/If the file rename fails, the text edits stay applied \(nothing is rolled back\)/);
    const [item] = fileRenameItems(p);
    expect(item?.action).toBe('toggleFile');
    expect(item?.label).toBe('$(pass-filled) Also rename the file Widget.cs → Thing.cs');
    expect(item?.description).toMatch(/^on/);
  });

  it('shows the option as "off" when it was turned off', () => {
    const p = plan({ files: [{ oldUri: OLD, newUri: NEW }], available: true, included: false }, false);
    expect(summary(p)).toContain('Widget.cs keeps its name (renaming it was turned off for this preview).');
    expect(fileRenameItems(p)[0]?.label).toBe('$(circle-large-outline) Also rename the file Widget.cs → Thing.cs');
  });

  it('explains why the file keeps its name when the rename is not proven safe', () => {
    const p = plan({ files: [{ oldUri: OLD, newUri: NEW }], available: false, included: false, reasonCode: 'ExplicitCompileItem', message: 'Lib.csproj lists Widget.cs explicitly.' }, false);
    expect(summary(p)).toContain('- Widget.cs keeps its name: Lib.csproj lists Widget.cs explicitly.');
    expect(fileRenameItems(p)).toEqual([{ label: '$(info) Widget.cs keeps its name', detail: 'Lib.csproj lists Widget.cs explicitly.', action: 'fileInfo' }]);
  });

  it('says nothing about files for a rename without a file named after the symbol', () => {
    const p = plan(undefined, false);
    expect(summary(p)).not.toContain('## File rename');
    expect(fileRenameItems(p)).toEqual([]);
    expect(fileRenameLabel([{ oldUri: 'file:///a/Gadget.Part1.cs', newUri: 'file:///a/Device.Part1.cs' }, { oldUri: 'file:///a/Gadget.Part2.cs', newUri: 'file:///a/Device.Part2.cs' }])).toBe(
      'Also rename the files Gadget.Part1.cs → Device.Part1.cs, Gadget.Part2.cs → Device.Part2.cs',
    );
  });
});
