import { describe, expect, it } from 'vitest';
import { type DelegatedRefactorPlan, PlanLifecycle, delegatedProvenance, validatePlanStructure } from '../src';

const H = 'b'.repeat(64);

function delegated(over: Partial<DelegatedRefactorPlan> = {}): DelegatedRefactorPlan {
  return {
    planId: 'd1',
    actionId: 'typescript.rename',
    providerRouteId: 'typescript.vscode-providers',
    workspaceId: 'w',
    kind: 'delegated',
    bridgeEpoch: 'bridge-1',
    observationId: 'obs-1',
    observedWorkspaceRevision: 3,
    observedInputs: [{ input: 'file:///a.ts', hash: H }],
    backendContext: 'unknown',
    backendSnapshot: 'unknown',
    semanticReadSet: 'unknown',
    coverage: 'provider-managed',
    origin: { uri: 'file:///a.ts', position: { line: 0, character: 1 }, newName: 'y' },
    writeSet: [{ kind: 'text', uri: 'file:///a.ts', expectedHash: H, resultHash: H, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' }] }],
    evidence: [],
    limitations: ['provider-managed'],
    validation: { status: 'limited', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false },
    title: 'Rename x to y',
    ...over,
  };
}

describe('delegated plan', () => {
  it('passes the shared structural validator', () => expect(validatePlanStructure(delegated())).toEqual([]));

  it('never accepts a delegated plan that claims owned validity', () => {
    const bad = delegated({ validation: { status: 'valid', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false } as never });
    expect(validatePlanStructure(bad).map((i) => i.code)).toEqual(['wrong-kind']);
  });

  it('requires compilationDelta not-run and unknown backend identity', () => {
    expect(validatePlanStructure(delegated({ validation: { status: 'limited', compilationDelta: 'passed' as never, providerReprepared: false, returnedEditsMatchedPreview: false } })).map((i) => i.code)).toEqual(['wrong-kind']);
    expect(validatePlanStructure(delegated({ backendSnapshot: 'snap-1' as never })).map((i) => i.code)).toEqual(['wrong-kind']);
  });

  it('applies the text-only checks to delegated write sets', () => {
    const p = delegated({ writeSet: [{ kind: 'text', uri: 'untitled:x', expectedHash: H, resultHash: H, edits: [] }] });
    expect(validatePlanStructure(p).map((i) => i.code)).toEqual(['non-file-uri']);
  });

  it('runs through the same lifecycle', () => {
    const l = new PlanLifecycle(delegated());
    l.transition('Previewing');
    expect(l.plan.kind).toBe('delegated');
  });

  it('delegated provenance marks backend identity unknown', () => {
    expect(delegatedProvenance('typescript.vscode-providers', 'obs-7')).toEqual({
      kind: 'delegated',
      providerRouteId: 'typescript.vscode-providers',
      observationId: 'obs-7',
      sessionEpoch: 'unknown',
      snapshotId: 'unknown',
      projectContextId: 'unknown',
    });
  });
});
