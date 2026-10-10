import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto } from '@refyntra/contracts';
import { capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import { createPreviewSummary, createdFilePreview, folderChoices, folderLabel } from '../../src/createFileSummary';

const H = (c: string) => c.repeat(64);
const label = (uri: string) => uri.replace('file:///ws/', '');

function plan(writeSet: PlannedChange[], extra: Partial<RefactorPlanDto> = {}): RefactorPlanDto {
  return {
    planId: 'p1', actionId: 'csharp.generateHandler', providerRouteId: 'csharp.roslyn', protocolMajor: 1, workspaceId: 'ws', kind: 'owned-semantic', sessionEpoch: 'e', baseWorkspaceRevision: 0,
    baseSnapshotId: 's', projectContextIds: [], writeSet, readSet: [], evidence: [], validation: { status: 'valid', checkedContexts: ['pc'], uncheckedContexts: [], compilationDelta: 'passed' },
    limitations: ['No DI registration is generated: MediatR finds handlers by scanning assemblies.'], title: 'Generate GetThingHandler', ...extra,
  };
}

describe('create-file preview', () => {
  const create: PlannedChange = { kind: 'create', uri: 'file:///ws/App/Handlers/GetThingHandler.cs', resultHash: H('a'), text: 'namespace App.Handlers;\n\npublic sealed class GetThingHandler\n{\n}\n' };

  it('shows the new file as a diff from empty', () => {
    const f = createdFilePreview(create as Extract<PlannedChange, { kind: 'create' }>);
    expect(f.original).toBe('');
    expect(f.modified).toContain('class GetThingHandler');
  });

  it('summary: new file, folder choice, no DI registration note, order and failure semantics', () => {
    const p = plan([create], {
      fileCreate: {
        files: [create.kind === 'create' ? create.uri : ''],
        folderChoices: [
          { folderUri: 'file:///ws/App/Handlers', projectName: 'App', handlerCount: 2, namespace: 'App.Handlers' },
          { folderUri: 'file:///ws/Contracts/Requests', projectName: 'Contracts', handlerCount: 0, namespace: 'Contracts.Requests' },
        ],
        selectedFolderUri: 'file:///ws/App/Handlers',
      },
    });
    const text = createPreviewSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: true }, [createdFilePreview(create as never)], false, label);
    expect(text).toContain('# Generate GetThingHandler');
    expect(text).toContain('- App/Handlers/GetThingHandler.cs (5 line(s)) — created on disk first');
    expect(text).toContain('Folder: App/Handlers (one of 2 folders; choose **Change folder** to pick another)');
    expect(text).toContain('No DI registration is generated');
    expect(text).toContain('The new file is created on disk. If creating fails, nothing is changed.');
    expect(folderChoices(p)).toHaveLength(2);
    expect(folderLabel(folderChoices(p)[0]!, label)).toEqual({ label: 'App/Handlers', description: 'App · 2 handler(s) · namespace App.Handlers' });
  });

  it('summary of a move: the edit of the original file and the create-first order', () => {
    const move = plan([create, { kind: 'text', uri: 'file:///ws/App/Shapes.cs', expectedHash: H('b'), resultHash: H('c'), edits: [] }], { fileCreate: { files: [create.kind === 'create' ? create.uri : ''] }, title: 'Move Circle to Circle.cs' });
    const files = [createdFilePreview(create as never), { uri: 'file:///ws/App/Shapes.cs', original: 'a', modified: '', editCount: 1 }];
    const text = createPreviewSummary({ plan: move, state: 'Previewing', issues: [], applyEnabled: true }, files, false, label);
    expect(text).toContain('## Edits to existing files');
    expect(text).toContain('- App/Shapes.cs — 1 edit(s), not saved');
    expect(text).toMatch(/The new file is created first\. Only when it exists with exactly the previewed text is Shapes\.cs edited\..*nothing is rolled back automatically/);
  });

  it('Actions: titles and commands of the two actions', () => {
    expect(capabilityTitleOf('csharp.moveTypeToFile')).toBe('Move type to file (preview first)');
    expect(commandForCapability('csharp.moveTypeToFile')).toBe('refyntra.moveTypeToFile');
    expect(commandForCapability('csharp.generateHandler')).toBe('refyntra.generateHandler');
  });
});
