import { describe, expect, it } from 'vitest';
import type { DelegatedRefactorPlan } from '@refyntra/domain';
import type { RefactorPlanDto } from '@refyntra/contracts';
import { TS_JS_CAPABILITY_IDS } from '@refyntra/adapter-vscode-providers';
import { capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import { findItemDescription } from '../../src/findGate';
import { identifierPattern, previewTitle, renamePreviewSummary } from '../../src/renameSummary';

const H = 'c'.repeat(64);
const delegatedPlan: DelegatedRefactorPlan = {
  planId: 'p',
  actionId: 'typescript.rename',
  providerRouteId: 'typescript.vscode-providers',
  workspaceId: 'w',
  kind: 'delegated',
  bridgeEpoch: 'b1',
  observationId: 'o1',
  observedWorkspaceRevision: 1,
  observedInputs: [],
  backendContext: 'unknown',
  backendSnapshot: 'unknown',
  semanticReadSet: 'unknown',
  coverage: 'provider-managed',
  origin: { uri: 'file:///a.ts', position: { line: 0, character: 0 }, newName: 'b' },
  writeSet: [{ kind: 'text', uri: 'file:///a.ts', expectedHash: H, resultHash: H, edits: [] }],
  evidence: [{ description: 'Edits returned by vscode.executeDocumentRenameProvider' }],
  limitations: ['Provider-managed semantic coverage: the edits come from the installed provider.'],
  validation: { status: 'limited', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false },
  title: 'Rename a to b',
};

const ownedPlan: RefactorPlanDto = {
  planId: 'q',
  actionId: 'csharp.rename',
  providerRouteId: 'csharp.roslyn',
  protocolMajor: 1,
  workspaceId: 'w',
  kind: 'owned-semantic',
  sessionEpoch: 'e',
  baseWorkspaceRevision: 1,
  baseSnapshotId: 's',
  projectContextIds: ['p'],
  writeSet: [],
  readSet: [],
  evidence: [],
  limitations: [],
  validation: { status: 'valid', checkedContexts: ['p'], uncheckedContexts: [], compilationDelta: 'passed' },
  title: 'Rename A to B',
};

const files = [{ uri: 'file:///a.ts', original: 'a', modified: 'b', editCount: 1 }];

describe('delegated rename preview is labelled provider-managed', () => {
  it('summary names provider-managed semantic coverage, limited validation and not-run compilation', () => {
    const text = renamePreviewSummary({ plan: delegatedPlan, state: 'Previewing', issues: [], applyEnabled: true }, files, false);
    expect(text).toMatch(/provider-managed semantic coverage/i);
    expect(text).toMatch(/not validated semantically by Refyntra/i);
    expect(text).toMatch(/Validation: limited; compilation delta[^\n]*not-run/);
    expect(text).not.toMatch(/Project contexts checked/);
    expect(text).not.toMatch(/String literals, comments, reflection names/);
    expect(previewTitle(delegatedPlan)).toBe('Rename a to b — preview (provider-managed semantic coverage)');
  });

  it('owned summary is unchanged in substance', () => {
    const text = renamePreviewSummary({ plan: ownedPlan, state: 'Previewing', issues: [], applyEnabled: false }, [], false);
    expect(text).toMatch(/Project contexts checked: 1/);
    expect(text).toMatch(/Preview only/);
    expect(text).not.toMatch(/provider-managed/i);
    expect(previewTitle(ownedPlan)).toBe('Rename A to B — preview');
  });

  it('identifier rules per language: $ is valid in TS/JS, @ in C#', () => {
    expect(identifierPattern('typescript').test('$store')).toBe(true);
    expect(identifierPattern('javascriptreact').test('_x1')).toBe(true);
    expect(identifierPattern('typescript').test('@x')).toBe(false);
    expect(identifierPattern('csharp').test('@class')).toBe(true);
    expect(identifierPattern('csharp').test('$x')).toBe(false);
  });
});

describe('capability ids and Find route labels in the UI', () => {
  it('every TS/JS capability has a title; runnable ones have a command', () => {
    for (const id of TS_JS_CAPABILITY_IDS) expect(capabilityTitleOf(id), id).not.toBe(id);
    expect(commandForCapability('typescript.rename')).toBe('refyntra.rename');
    expect(commandForCapability('typescript.find')).toBe('refyntra.find');
    expect(commandForCapability('typescript.references')).toBe('refyntra.related');
    expect(commandForCapability('typescript.frameworkRelations')).toBeUndefined();
  });

  it('Find shows the route label of every item', () => {
    const labels = { 'csharp.roslyn': 'C#', 'typescript.vscode-providers': 'TS/JS (delegated)' };
    expect(findItemDescription({ providerRouteId: 'typescript.vscode-providers', description: '' }, labels)).toBe('TS/JS (delegated)');
    expect(findItemDescription({ providerRouteId: 'csharp.roslyn', description: 'Shop.Api' }, labels)).toBe('C# · Shop.Api');
    expect(findItemDescription({ providerRouteId: 'x', description: 'd' }, undefined)).toBe('d');
  });
});
