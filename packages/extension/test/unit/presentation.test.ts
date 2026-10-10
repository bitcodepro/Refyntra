import { describe, expect, it } from 'vitest';
import { CSHARP_CAPABILITY_IDS, type PlannedTextChange, type SymbolRef } from '@refyntra/contracts';
import type { RelatedOutcome } from '@refyntra/application';
import type { MergedRelation } from '@refyntra/domain';
import { CAPABILITY_TITLES, capabilityTitleOf, commandForCapability } from '../../src/capabilityUi';
import { FindResultsGate } from '../../src/findGate';
import { RelatedViewState, findSameRelation } from '../../src/relatedState';
import { previewFile, sha256 } from '../../src/textEdits';

// Pure presentation logic of the extension (review findings C1, U1, U2, U3). The vscode wiring is covered by the
// Extension Host suites in packages/extension/test/suite.

describe('C1: capability catalogue in the UI', () => {
  it('every catalogue id has a title and an editor command', () => {
    for (const id of CSHARP_CAPABILITY_IDS) {
      expect(CAPABILITY_TITLES[id], id).toBeTruthy();
      expect(capabilityTitleOf(id)).not.toBe(id);
      expect(commandForCapability(id), id).toMatch(/^refyntra\./);
    }
    expect(commandForCapability('csharp.references')).toBe('refyntra.related');
    expect(capabilityTitleOf('vendor.unknown')).toBe('vendor.unknown');
  });
});

describe('U2: Find accepts only results of the current query', () => {
  it('Enter during the debounce or while the request runs does not open a result of the previous query', () => {
    const gate = new FindResultsGate('Order');
    expect(gate.resultsArrived('Order')).toBe(true);
    expect(gate.accept('OrderService')).toBe('OrderService');
    gate.setValue('Customer'); // typed: debounce running, old items still selected
    expect(gate.outdated).toBe(true);
    expect(gate.accept('OrderService')).toBeUndefined();
    expect(gate.resultsArrived('Order')).toBe(false); // a late answer of the old query is dropped
    expect(gate.accept('OrderService')).toBeUndefined();
    expect(gate.resultsArrived('Customer')).toBe(true);
    expect(gate.accept('CustomerService')).toBe('CustomerService');
  });
});

const FILE_A = 'file:///ws/A.cs';
const FILE_B = 'file:///ws/B.cs';
const FILE_C = 'file:///ws/C.cs';
const prov = { kind: 'owned-semantic' as const, providerRouteId: 'csharp.roslyn', sessionEpoch: 'e', snapshotId: 's', projectContextId: 'p' };
const loc = (uri: string, line: number) => ({ uri, range: { start: { line, character: 0 }, end: { line, character: 1 } } });
const subject: SymbolRef = { name: 'IOrderService', displayName: 'Shop.IOrderService', kind: 'interface', origin: 'source', location: loc(FILE_A, 3), provenance: prov };
const relation = (line: number): MergedRelation => ({
  relationKind: 'implementation',
  group: 'implementations',
  target: { symbol: { ...subject, name: 'OrderService', displayName: 'Shop.OrderService', kind: 'class', location: loc(FILE_B, line) }, label: 'OrderService' },
  evidence: [],
  confidence: 'proven',
  provenance: prov,
  provenances: [prov],
  limitations: [],
});
const outcome = (line: number): RelatedOutcome => ({
  kind: 'related',
  subject,
  groups: [{ group: 'implementations', relations: [relation(line)] }],
  completeness: 'complete',
  scopeNotes: [],
  additionalNotes: [],
  providerRouteId: 'csharp.roslyn',
  sessionEpoch: 'e',
  snapshotId: 's',
  workspaceRevision: 1,
});

describe('U1: Related view state', () => {
  it('shows Loading (not the previous outcome) while a request runs', () => {
    const st = new RelatedViewState();
    st.complete(outcome(10), FILE_A);
    expect(st.visibleOutcome).toBeDefined();
    st.begin();
    expect(st.loading).toBe(true);
    expect(st.visibleOutcome).toBeUndefined();
    expect(st.canOpenDirectly).toBe(false);
    st.complete(outcome(11), FILE_A);
    expect(st.visibleOutcome).toEqual(outcome(11));
  });

  it('an edit of the subject or a target file marks the view outdated; other files do not', () => {
    const st = new RelatedViewState();
    st.complete(outcome(10), FILE_A);
    expect(st.documentChanged(FILE_C)).toBe(false);
    expect(st.canOpenDirectly).toBe(true);
    expect(st.documentChanged(FILE_B)).toBe(true);
    expect(st.stale).toBe(true);
    expect(st.canOpenDirectly).toBe(false);
    st.complete(outcome(12), FILE_A);
    expect(st.stale).toBe(false);
    expect(st.documentChanged(FILE_A)).toBe(true);
  });

  it('an outdated relation is resolved again in the fresh outcome before it is opened', () => {
    const fresh = outcome(14);
    const again = findSameRelation(fresh, relation(10));
    expect(again?.target.symbol?.location?.range.start.line).toBe(14);
    expect(findSameRelation(fresh, { ...relation(10), target: { label: 'Gone' } })).toBeUndefined();
  });
});

describe('U3: rename preview validity', () => {
  const original = 'class A {\n  GetOrder x;\n}\n';
  const change = (edits: PlannedTextChange['edits'], expected = original, result?: string): PlannedTextChange => ({
    kind: 'text',
    uri: FILE_A,
    expectedHash: sha256(expected),
    resultHash: sha256(result ?? expected),
    edits,
  });

  it('a matching plan previews exactly the planned result', () => {
    const edits = [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } }, newText: 'FetchOrder' }];
    const f = previewFile(change(edits, original, 'class A {\n  FetchOrder x;\n}\n'), original);
    expect(f.problem).toBeUndefined();
    expect(f.modified).toBe('class A {\n  FetchOrder x;\n}\n');
  });

  it('edits that do not fit the current text make the preview invalid (never a silent "modified = original")', () => {
    const edits = [{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 3 } }, newText: 'X' }];
    expect(previewFile(change(edits), original).problem).toMatch(/do not fit/);
  });

  it('a file that changed after the plan was computed makes the preview invalid', () => {
    const edits = [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } }, newText: 'FetchOrder' }];
    const f = previewFile(change(edits, original, 'class A {\n  FetchOrder x;\n}\n'), `${original}// typed\n`);
    expect(f.problem).toMatch(/changed/);
  });
});
