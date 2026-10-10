import { describe, expect, it } from 'vitest';
import type { Availability, Provenance, RefactorPlanDto } from '@refyntra/contracts';
import {
  type AnyRelation,
  PlanLifecycle,
  PlanTransitionError,
  canTransition,
  formatAdapterHealth,
  formatStatusBar,
  groupRelations,
  mergeFindItems,
  mergeRelations,
  sortAvailability,
  toFindItem,
  validatePlanStructure,
} from '../src';

const prov = (route: string): Provenance => ({ kind: 'owned-semantic', providerRouteId: route, sessionEpoch: 'e1', snapshotId: 's1', projectContextId: 'p1' });
const loc = (uri: string, line: number, ch = 0) => ({ uri, range: { start: { line, character: ch }, end: { line, character: ch + 3 } } });
const H = 'a'.repeat(64);

function plan(over: Partial<RefactorPlanDto> = {}): RefactorPlanDto {
  return {
    planId: 'p',
    actionId: 'csharp.rename',
    providerRouteId: 'r',
    protocolMajor: 1,
    workspaceId: 'w',
    kind: 'owned-semantic',
    sessionEpoch: 'e1',
    baseWorkspaceRevision: 1,
    baseSnapshotId: 's1',
    projectContextIds: [],
    writeSet: [{ kind: 'text', uri: 'file:///a.cs', expectedHash: H, resultHash: H, edits: [{ range: loc('', 1).range, newText: 'X' }, { range: loc('', 2).range, newText: 'Y' }] }],
    readSet: [],
    evidence: [],
    limitations: [],
    validation: { status: 'valid', checkedContexts: [], uncheckedContexts: [], compilationDelta: 'not-run' },
    title: 't',
    ...over,
  };
}

describe('plan state machine', () => {
  it('follows Prepared → Previewing → Revalidating → Applying → Applied and is single use', () => {
    const l = new PlanLifecycle(plan());
    l.transition('Previewing');
    l.transition('Revalidating');
    l.transition('Applying');
    l.transition('Applied');
    expect(l.isTerminal).toBe(true);
    expect(() => l.transition('Previewing')).toThrow(PlanTransitionError);
    expect(l.tryTransition('Stale')).toBe(false);
    expect(l.history.map((h) => h.to)).toEqual(['Previewing', 'Revalidating', 'Applying', 'Applied']);
  });

  it('cannot cancel or go stale once applying started', () => {
    expect(canTransition('Applying', 'Cancelled')).toBe(false);
    expect(canTransition('Applying', 'Stale')).toBe(false);
    expect(canTransition('Applying', 'Failed')).toBe(true);
  });

  it('cannot skip revalidation', () => {
    expect(canTransition('Previewing', 'Applying')).toBe(false);
    expect(canTransition('Prepared', 'Applying')).toBe(false);
  });

  it.each(['Stale', 'Cancelled', 'Discarded', 'Failed'] as const)('%s is terminal', (s) => {
    const l = new PlanLifecycle(plan());
    l.transition(s);
    expect(l.isTerminal).toBe(true);
  });
});

describe('plan structure validator', () => {
  it('accepts a sorted text-only plan', () => expect(validatePlanStructure(plan())).toEqual([]));
  it('rejects overlapping and unsorted edits, non-file uris and missing hashes', () => {
    const bad = plan({
      writeSet: [
        { kind: 'text', uri: 'untitled:x', expectedHash: 'nope', resultHash: H, edits: [{ range: loc('', 2).range, newText: '' }, { range: loc('', 1).range, newText: '' }] },
        { kind: 'text', uri: 'file:///b.cs', expectedHash: H, resultHash: H, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: '' }, { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, newText: '' }] },
      ],
    });
    expect(validatePlanStructure(bad).map((i) => i.code).sort()).toEqual(['missing-hash', 'non-file-uri', 'overlapping-edits', 'unsorted-edits']);
  });
  it('rejects empty plans and resource operations', () => {
    expect(validatePlanStructure(plan({ writeSet: [] }))[0]!.code).toBe('empty-plan');
    expect(validatePlanStructure(plan({ writeSet: [{ kind: 'create' } as never] }))[0]!.code).toBe('unsupported-change');
  });
});

describe('relations', () => {
  const rel = (group: AnyRelation['group'], kind: AnyRelation['relationKind'], l: ReturnType<typeof loc>, route = 'r1'): AnyRelation => ({
    relationKind: kind,
    group,
    target: { location: l, label: `${l.uri}:${l.range.start.line}` },
    evidence: [{ description: route }],
    confidence: 'proven',
    provenance: prov(route),
    limitations: [],
  });

  it('groups in RELATION_GROUP_ORDER and sorts within groups', () => {
    const groups = groupRelations(
      mergeRelations([[rel('references', 'reference', loc('file:///b', 2)), rel('handlers', 'mediatr.handler', loc('file:///a', 1)), rel('references', 'reference', loc('file:///a', 9)), rel('declarations', 'declaration', loc('file:///a', 0))]]),
    );
    expect(groups.map((g) => g.group)).toEqual(['declarations', 'handlers', 'references']);
    expect(groups[2]!.relations.map((r) => r.target.location!.uri)).toEqual(['file:///a', 'file:///b']);
  });

  it('merges exact-location duplicates from two providers and keeps both provenances', () => {
    const merged = mergeRelations([[rel('references', 'reference', loc('file:///a', 1), 'r1')], [rel('references', 'reference', loc('file:///a', 1), 'r2'), rel('references', 'reference', loc('file:///a', 2), 'r2')]]);
    expect(merged).toHaveLength(2);
    const dup = merged.find((m) => m.target.location!.range.start.line === 1)!;
    expect(dup.provenances.map((p) => p.providerRouteId)).toEqual(['r1', 'r2']);
    expect(dup.evidence.map((e) => e.description)).toEqual(['r1', 'r2']);
  });

  it('keeps unknown groups from newer backends at the end', () => {
    const g = groupRelations(mergeRelations([[rel('zzz' as never, 'x.y', loc('file:///a', 1)), rel('tests', 'test', loc('file:///a', 2))]]));
    expect(g.map((x) => x.group)).toEqual(['tests', 'zzz']);
  });
});

describe('find result ordering', () => {
  const sym = (name: string, uri: string, score: number, route = 'r1') =>
    toFindItem({ score, symbol: { symbolId: name, name, displayName: `N.${name}`, kind: 'class', location: loc(uri, 1), origin: 'source', provenance: prov(route), projectName: 'P' } }, route)!;

  it('orders by score desc, then name, then location, deterministically', () => {
    const items = mergeFindItems([[sym('beta', 'file:///b', 10), sym('Alpha', 'file:///a', 10), sym('Zed', 'file:///z', 50)]]);
    expect(items.map((i) => i.label)).toEqual(['Zed', 'Alpha', 'beta']);
    const reversed = mergeFindItems([[sym('Zed', 'file:///z', 50), sym('beta', 'file:///b', 10), sym('Alpha', 'file:///a', 10)]]);
    expect(reversed.map((i) => i.key)).toEqual(items.map((i) => i.key));
  });

  it('dedupes the same symbol location from two routes and keeps provenance', () => {
    const items = mergeFindItems([[sym('A', 'file:///a', 1, 'r1')], [sym('A', 'file:///a', 5, 'r2')]]);
    expect(items).toHaveLength(1);
    expect(items[0]!.score).toBe(5);
    expect(items[0]!.provenances.map((p) => p.providerRouteId)).toEqual(['r1', 'r2']);
  });

  it('formats endpoints and drops malformed items', () => {
    const e = toFindItem({ score: 1, endpoint: { httpMethods: ['GET'], route: '/orders/{id}', routeIsDynamic: false, location: loc('file:///p.cs', 3), kind: 'minimal-api' } }, 'r');
    expect(e!.label).toBe('GET /orders/{id}');
    expect(toFindItem({ score: 1 }, 'r')).toBeUndefined();
  });
});

describe('availability and health', () => {
  const av = (id: string, state: Availability['state']): Availability => ({ capabilityId: id, providerRouteId: 'r', scope: { workspaceId: 'w' }, state, recoveryActions: [], requiredTrust: 'workspace', guarantee: 'owned-semantic', limitations: [] });
  it('sorts available before limited, unknown and unavailable', () => {
    expect(sortAvailability([av('b', 'unavailable'), av('a', 'unknown'), av('c', 'available'), av('d', 'limited')]).map((a) => a.capabilityId)).toEqual(['c', 'd', 'a', 'b']);
  });
  it('formats "C#: Partial, 7/8 projects" and the status bar', () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ projectContextId: `p${i}`, name: `P${i}`, projectPath: '', targetFramework: 'net10.0', state: i < 7 ? ('loaded' as const) : ('failed' as const), documentCount: 1, diagnostics: [] }));
    const h = { adapterId: 'csharp', providerRouteId: 'csharp.roslyn', displayName: 'C#', state: 'Partial' as const, recoveryActions: [], projects, diagnostics: [], restartCount: 0 };
    expect(formatAdapterHealth(h)).toBe('C#: Partial, 7/8 projects');
    expect(formatStatusBar({ adapters: [h], workspaceTrusted: true })).toBe('Refyntra: C# Partial 7/8');
    expect(formatStatusBar({ adapters: [{ ...h, state: 'TrustRequired', projects: [] }], workspaceTrusted: false })).toBe('Refyntra: C# TrustRequired');
  });
});
