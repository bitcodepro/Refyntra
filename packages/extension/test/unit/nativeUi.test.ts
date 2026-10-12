import { describe, expect, it } from 'vitest';
import type { MergedRelation } from '@refyntra/domain';
import type { HealthSummary } from '@refyntra/domain';
import type { PlannedChange, SignatureInfo } from '@refyntra/contracts';
import { KIND, kindMatches, looksExtractable, parseCodeActionTarget, planOffers } from '../../src/codeActionsModel';
import { extraLensKinds, lensView, parseCodeLensSettings, scanCSharpDeclarations, summarize } from '../../src/codeLensModel';
import { confirmationFor, nativeOutcomeMessage, nativePreviewBlocker, outsideChangeNote, parsePreviewStyle } from '../../src/nativePreviewModel';
import { parseSignatureMessage, reduceSignature, renderSignatureHtml, signatureView } from '../../src/changeSignatureModel';
import { initialRows } from '../../src/codeRefactorSummary';
import { groupIcon, previewLine, relatedHeader, relationIcon } from '../../src/relatedPresentation';
import { loadingMessage, statusKind, statusMenu } from '../../src/statusModel';
import { mayBeMediatRRequest, mediatrHoverMarkdown } from '../../src/hoverModel';
import { hierarchyDetail, symbolKindName } from '../../src/hierarchyModel';

const loc = (uri: string, line: number) => ({ uri, range: { start: { line, character: 0 }, end: { line, character: 3 } } });
const prov = { kind: 'owned-semantic' as const, providerRouteId: 'csharp.roslyn', sessionEpoch: 'e', snapshotId: 's', projectContextId: 'p' };
function rel(relationKind: string, group: string, extra: Partial<MergedRelation> = {}): MergedRelation {
  return { relationKind, group, target: { label: 'X', location: loc('file:///a.cs', 1) }, evidence: [], confidence: 'proven', provenance: prov, provenances: [prov], limitations: [], ...extra } as MergedRelation;
}

describe('code actions (lightbulb, Ctrl+., Refactor…)', () => {
  it('kinds are hierarchical so the native Refactor menu and "only" filters find them', () => {
    expect(kindMatches('refactor', KIND.extractMethod)).toBe(true);
    expect(kindMatches('refactor.extract', KIND.extractMethod)).toBe(true);
    expect(kindMatches('refactor.rewrite', KIND.changeSignature)).toBe(true);
    expect(kindMatches('refactor.move', KIND.moveTypeToFile)).toBe(true);
    expect(kindMatches('source', KIND.cleanup)).toBe(true);
    expect(kindMatches('quickfix', KIND.safeDelete)).toBe(false);
    expect(kindMatches(undefined, KIND.safeDelete)).toBe(true);
  });

  it('the cheap extract check accepts statements and expressions, refuses broken selections', () => {
    expect(looksExtractable('var x = a + b;\nConsole.WriteLine(x);')).toBe(true);
    expect(looksExtractable('a + b')).toBe(true);
    expect(looksExtractable('Foo(1, "x)")')).toBe(true);
    expect(looksExtractable('if (a) { b(); }')).toBe(true);
    expect(looksExtractable('')).toBe(false);
    expect(looksExtractable('   ')).toBe(false);
    expect(looksExtractable('Foo(1, ')).toBe(false);
    expect(looksExtractable('b(); }')).toBe(false);
    expect(looksExtractable('.Where(x => x)')).toBe(false);
    expect(looksExtractable('"unterminated')).toBe(false);
    expect(looksExtractable('/* open comment')).toBe(false);
    expect(looksExtractable('public class A { }')).toBe(false);
    expect(looksExtractable('public void M() { }')).toBe(false);
  });

  it('offers what the route reports, disabled with the reason otherwise; extract needs a selection', () => {
    const offers = planOffers({ runnable: ['csharp.safeDelete', 'csharp.changeSignature', 'csharp.rename'], unavailable: [{ capabilityId: 'csharp.moveTypeToFile', reason: 'only type in its file' }], extractable: false, emptySelection: true });
    expect(offers.map((o) => [o.spec.key, o.disabled])).toEqual([
      ['changeSignature', undefined],
      ['moveTypeToFile', 'only type in its file'],
      ['safeDelete', undefined],
      ['rename', undefined],
    ]);
    const withSel = planOffers({ runnable: ['csharp.extractMethod'], unavailable: [], extractable: true, emptySelection: false, only: 'refactor.extract' });
    expect(withSel.map((o) => o.spec.command)).toEqual(['refyntra.extractMethod']);
    const bad = planOffers({ runnable: ['csharp.extractMethod'], unavailable: [], extractable: false, emptySelection: false });
    expect(bad[0]?.disabled).toMatch(/complete statements/);
  });

  it('command targets are validated (untrusted arguments are ignored)', () => {
    expect(parseCodeActionTarget({ uri: 'file:///a.cs', position: { line: 1, character: 2 }, range: { start: { line: 1, character: 2 }, end: { line: 2, character: 0 } } })).toEqual({ uri: 'file:///a.cs', position: { line: 1, character: 2 }, range: { start: { line: 1, character: 2 }, end: { line: 2, character: 0 } } });
    expect(parseCodeActionTarget({ uri: 'untitled:x', position: { line: 1, character: 2 } })).toBeUndefined();
    expect(parseCodeActionTarget({ uri: 'file:///a.cs', position: { line: -1, character: 2 } })).toBeUndefined();
    expect(parseCodeActionTarget('file:///a.cs')).toBeUndefined();
    expect(parseCodeActionTarget(undefined)).toBeUndefined();
  });
});

describe('CodeLens', () => {
  const src = [
    'using System;',
    '// public class Commented {}',
    'namespace Shop;',
    '/* public class InComment',
    '   { } */',
    'public sealed class OrderService : IOrderService',
    '{',
    '    [HttpGet("{id}")]',
    '    public async Task<OrderDto?> Find(int id) => null;',
    '    private static int Count<T>(List<T> items) { return items.Count; }',
    '    public OrderService(int x) { }',
    '    var s = """',
    '    public class InRawString {}',
    '    """;',
    '    public void M() { if (x) Foo(); x = Bar(1); }',
    '}',
    'public record GetOrderQuery(int Id) : IRequest<OrderDto>;',
    'internal interface IThing { void Do(); }',
  ].join('\n');

  it('scans types and member declarations, never comments, raw strings or statements', () => {
    const d = scanCSharpDeclarations(src);
    expect(d.map((x) => `${x.kind}:${x.name}@${x.line}`)).toEqual(['type:OrderService@5', 'method:Find@8', 'method:Count@9', 'method:OrderService@10', 'method:M@14', 'type:GetOrderQuery@16', 'type:IThing@17']);
    const find = d.find((x) => x.name === 'Find')!;
    expect(src.split('\n')[find.line]!.slice(find.character, find.character + 4)).toBe('Find');
  });

  it('scanning is cheap: a 20,000-line file in well under typing latency', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `public class C${i}\n{\n    public int M${i}(int a) { return a; }\n    // comment\n    private string _f${i} = "x";\n    public void N${i}() { Foo(); }\n}\n\n\n`).join('');
    const t0 = performance.now();
    const d = scanCSharpDeclarations(big, 100000);
    const ms = performance.now() - t0;
    expect(d.length).toBe(6000);
    expect(ms).toBeLessThan(250);
  });

  it('summarizes Related into the lens titles; the reference total comes from the "Showing N of M" note', () => {
    const refs = Array.from({ length: 50 }, (_, i) => rel('reference', 'references', { target: { label: `r${i}`, location: loc('file:///b.cs', i) }, limitations: ['Showing 50 of 73 references; use Find References for all.'] }));
    const s = summarize(true, [...refs, rel('implementation', 'implementations'), rel('test', 'tests'), rel('test', 'tests', { target: { label: 't2', location: loc('file:///t.cs', 9) } })]);
    expect(lensView('main', s, { kind: 'type', name: 'OrderService' }).title).toBe('73 references · 1 implementation · 2 tests');
    expect(lensView('main', s, { kind: 'type', name: 'OrderService' }).locations).toHaveLength(53);
    expect(extraLensKinds(s, parseCodeLensSettings((_, f) => f))).toEqual([]);
  });

  it('MediatR, endpoint and EF Core lenses, each behind its own setting', () => {
    const handler = rel('mediatr.handler', 'handlers', { target: { label: 'GetOrderQueryHandler', location: loc('file:///h.cs', 4) } });
    const s = summarize(true, [handler, rel('mediatr.send', 'callers'), rel('mediatr.send', 'callers', { target: { label: 'y', location: loc('file:///p.cs', 2) } })]);
    expect(lensView('handler', s, { kind: 'type', name: 'GetOrderQuery' }).title).toBe('→ Handler: GetOrderQueryHandler');
    const h = summarize(true, [rel('mediatr.request', 'declarations', { target: { label: 'Q', symbol: { name: 'Q', displayName: 'Q', kind: 'record', location: loc('file:///q.cs', 3), origin: 'source', provenance: prov } } }), rel('mediatr.send', 'callers'), rel('mediatr.send', 'callers', { target: { label: 'y', location: loc('file:///p.cs', 2) } })]);
    expect(h.requests).toEqual([loc('file:///q.cs', 3)]);
    expect(lensView('sentFrom', h, { kind: 'type', name: 'H' }).title).toBe('← sent from 2 places');
    const ep = summarize(true, [rel('aspnet.endpoint', 'endpoints', { target: { label: 'GET', endpoint: { httpMethods: ['GET'], route: 'api/orders/{id}', routeIsDynamic: false, location: loc('file:///c.cs', 3), kind: 'mvc' } } }), rel('http.clientCall', 'clients')]);
    expect(lensView('endpoint', ep, { kind: 'method', name: 'Get' }).title).toBe('GET /api/orders/{id} · 1 frontend call');
    const ef = summarize(true, [rel('efcore.configuration', 'data'), rel('efcore.migration', 'data'), rel('efcore.migration', 'data', { target: { label: 'm2', location: loc('file:///m2.cs', 1) } })]);
    expect(lensView('data', ef, { kind: 'type', name: 'Order' }).title).toBe('→ configuration · 2 migrations');
    const all = parseCodeLensSettings((_, f) => f);
    expect(extraLensKinds(s, all)).toEqual(['handler']);
    expect(extraLensKinds(s, { ...all, mediatr: false })).toEqual([]);
    expect(extraLensKinds(ep, { ...all, endpoints: false })).toEqual([]);
    expect(extraLensKinds(ef, all)).toEqual(['data']);
  });
});

describe('native Refactor Preview (ADR-004 Amendment 6)', () => {
  const text: PlannedChange = { kind: 'text', uri: 'file:///a.cs', expectedHash: 'a', resultHash: 'b', edits: [] } as never;
  const create: PlannedChange = { kind: 'create', uri: 'file:///b.cs', resultHash: 'c', text: '' } as never;

  it('is used only for applicable text-only plans with the native style', () => {
    expect(parsePreviewStyle(undefined)).toBe('native');
    expect(parsePreviewStyle('quickPick')).toBe('quickPick');
    expect(nativePreviewBlocker({ style: 'native', writeSet: [text], canApply: true })).toBeUndefined();
    expect(nativePreviewBlocker({ style: 'quickPick', writeSet: [text], canApply: true })).toMatch(/QuickPick/);
    expect(nativePreviewBlocker({ style: 'native', writeSet: [create, text], canApply: true })).toMatch(/creates, renames or deletes/);
    expect(nativePreviewBlocker({ style: 'native', writeSet: [text], canApply: false })).toMatch(/cannot be applied/);
    expect(nativePreviewBlocker({ style: 'native', writeSet: [text], canApply: true, hasExtraChoices: true })).toMatch(/choices/);
  });

  it('labels the entries with the plan and its open points', () => {
    expect(confirmationFor({ title: 'Rename A to B', limitations: [], validation: { status: 'valid' } })).toEqual({ label: 'Refyntra: Rename A to B' });
    expect(confirmationFor({ title: 'X', limitations: ['a', 'b'], validation: { status: 'limited' } }, [{}])).toEqual({ label: 'Refyntra: X', description: 'partly validated · 2 limitations · 1 warning' });
  });

  it('a discarded preview is a cancellation; files left out are reported; outside edits are noted', () => {
    const label = (u: string) => u.slice(u.lastIndexOf('/') + 1);
    expect(nativeOutcomeMessage({ status: 'failed', message: 'x', files: [{ uri: 'file:///a.cs', status: 'unchanged' }] }, label).kind).toBe('discarded');
    const partial = nativeOutcomeMessage({ status: 'failed', message: 'x', files: [{ uri: 'file:///a.cs', status: 'confirmed' }, { uri: 'file:///b.cs', status: 'unchanged' }] }, label);
    expect(partial.kind).toBe('partial');
    expect(partial.message).toContain('b.cs was left out');
    expect(nativeOutcomeMessage({ status: 'stale', message: 'The code changed', files: [] }, label)).toEqual({ kind: 'other', message: 'The code changed' });
    expect(outsideChangeNote(new Set(['file:///a.cs']), new Set(['file:///a.cs']), label)).toBeUndefined();
    expect(outsideChangeNote(new Set(['file:///c.cs']), new Set(['file:///a.cs']), label)).toMatch(/^c\.cs changed while the Refactor Preview was open/);
  });
});

describe('Change Signature dialog', () => {
  const info: SignatureInfo = { name: 'Greet', parameters: [{ name: 'name', type: 'string', modifiers: '' }, { name: 'times', type: 'int', modifiers: '' }, { name: 'rest', type: 'object[]', modifiers: 'params' }], snapshotId: 's' };

  it('messages from the page are validated', () => {
    expect(parseSignatureMessage({ type: 'move', index: 0, delta: 1 }, 3)).toEqual({ type: 'move', index: 0, delta: 1 });
    expect(parseSignatureMessage({ type: 'move', index: 5, delta: 1 }, 3)).toBeUndefined();
    expect(parseSignatureMessage({ type: 'edit', index: 0, field: 'modifiers', value: 'x' }, 3)).toBeUndefined();
    expect(parseSignatureMessage({ type: 'edit', index: 0, field: 'name', value: 'x'.repeat(501) }, 3)).toBeUndefined();
    expect(parseSignatureMessage({ type: 'eval' }, 3)).toBeUndefined();
    expect(parseSignatureMessage(null, 3)).toBeUndefined();
  });

  it('reorders (buttons and drag), keeps params last, renames, adds and validates with a live preview', () => {
    let rows = initialRows(info);
    expect(signatureView(info, rows).problem).toBe('The signature is unchanged.');
    rows = reduceSignature(rows, { type: 'move', index: 0, delta: 1 });
    expect(signatureView(info, rows).preview).toBe('Greet(int times, string name, params object[] rest)');
    expect(reduceSignature(rows, { type: 'move', index: 1, delta: 1 })).toEqual(rows); // params stays last
    expect(reduceSignature(rows, { type: 'moveTo', from: 2, to: 0 })).toEqual(rows);
    rows = reduceSignature(rows, { type: 'moveTo', from: 1, to: 0 });
    expect(rows.map((r) => r.name)).toEqual(['name', 'times', 'rest']);
    rows = reduceSignature(rows, { type: 'edit', index: 1, field: 'name', value: 'count' });
    rows = reduceSignature(rows, { type: 'edit', index: 1, field: 'type', value: 'long' }); // existing: type is read only
    expect(rows[1]).toMatchObject({ name: 'count', type: 'int' });
    rows = reduceSignature(rows, { type: 'add' });
    expect(rows.map((r) => r.name)).toEqual(['name', 'count', 'value1', 'rest']);
    rows = reduceSignature(rows, { type: 'edit', index: 2, field: 'callSiteValue', value: '' });
    const v = signatureView(info, rows, { count: 3 });
    expect(v.rows[2]!.problem).toMatch(/value at call sites or a default/);
    expect(v.problem).toBeDefined();
    expect(v.callSites).toBe('Affects 3 call sites (references)');
    expect(v.rows[0]!.canMoveUp).toBe(false);
    expect(v.rows[2]!.canMoveDown).toBe(false);
    rows = reduceSignature(rows, { type: 'edit', index: 2, field: 'defaultValue', value: '1' });
    rows = reduceSignature(rows, { type: 'edit', index: 0, field: 'name', value: 'class' });
    expect(signatureView(info, rows).rows[0]!.problem).toMatch(/keyword/);
    rows = reduceSignature(rows, { type: 'edit', index: 0, field: 'name', value: 'who' });
    expect(signatureView(info, rows).problem).toBeUndefined();
    rows = reduceSignature(rows, { type: 'remove', index: 1 });
    expect(signatureView(info, rows).removed).toEqual(['times']);
  });

  it('the page has a strict CSP with a nonce, no external resources and labelled controls', () => {
    const html = renderSignatureHtml({ nonce: 'N0nce', cspSource: 'vscode-resource:', title: 'Change Signature: <Greet>' });
    expect(html).toContain("default-src 'none'; style-src 'nonce-N0nce'; script-src 'nonce-N0nce'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('Change Signature: &#60;Greet&#62;');
    expect(html).toContain('<caption>Parameters</caption>');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('innerHTML');
  });
});

describe('Related view, status bar, hover, hierarchy', () => {
  it('icons per relation kind and group; header names the symbol and the pinned state', () => {
    expect(relationIcon('mediatr.handler')).toBe('symbol-event');
    expect(relationIcon('aspnet.endpoint')).toBe('globe');
    expect(relationIcon('test')).toBe('beaker');
    expect(relationIcon('di.registration')).toBe('plug');
    expect(relationIcon('efcore.migration')).toBe('database');
    expect(relationIcon('http.clientCall', 'clients')).toBe('cloud');
    expect(relationIcon('implementation')).toBe('symbol-class');
    expect(relationIcon('reference')).toBe('references');
    expect(relationIcon('fixture.wiredBy')).toBe('symbol-misc');
    expect(relationIcon('unknown.kind', 'tests')).toBe('beaker');
    expect(groupIcon('handlers')).toBe('symbol-event');
    expect(relatedHeader('Shop.OrderService', true, true)).toBe('Related to Shop.OrderService — pinned (does not follow the cursor)');
    expect(relatedHeader('X', false, true)).toBe('Related to X — follows the cursor');
    expect(relatedHeader(undefined, false, true)).toBeUndefined();
    expect(previewLine('   return x;   ')).toBe('return x;');
    expect(previewLine('x'.repeat(300))!.length).toBe(160);
  });

  const health = (state: string, extra: Partial<HealthSummary> = {}): HealthSummary =>
    ({ workspaceTrusted: true, adapters: [{ adapterId: 'csharp', providerRouteId: 'csharp.roslyn', displayName: 'C#', state, recoveryActions: [], projects: [], diagnostics: [], restartCount: 0 }], ...extra }) as unknown as HealthSummary;

  it('status: loading / ready / problem, and a menu that leads with what helps now', () => {
    expect(statusKind(health('Loading'))).toBe('loading');
    expect(statusKind(health('Ready'))).toBe('ready');
    const two = health('Ready');
    (two.adapters as unknown[]).push({ ...two.adapters[0]!, adapterId: 'python', state: 'NotStarted' });
    expect(statusKind(two)).toBe('ready'); // a route that has not started does not count
    expect(statusKind(health('NotStarted'))).toBe('idle');
    expect(statusKind(health('Failed'))).toBe('problem');
    expect(statusKind(health('Partial'))).toBe('problem');
    expect(loadingMessage(health('Loading'))).toBe('C#: loading the solution');
    expect(statusMenu(health('Failed')).items[0]!.command).toBe('refyntra.showHealth');
    expect(statusMenu(health('Failed')).items.map((i) => i.command)).toContain('refyntra.restartBackend');
    expect(statusMenu(health('Ready')).items[0]!.command).toBe('refyntra.find');
    expect(statusMenu(health('Ready', { workspaceTrusted: false })).items[0]!.command).toBe('workbench.trust.manage');
    expect(statusMenu(health('Ready')).items.at(-1)!.command).toBe('refyntra.showMenu');
  });

  it('MediatR hover: cheap gate, escaped text, links only to file locations', () => {
    expect(mayBeMediatRRequest('GetOrderQuery', 'var q = new GetOrderQuery(1);')).toBe(true);
    expect(mayBeMediatRRequest('Thing', 'await mediator.Send(new Thing());')).toBe(true);
    expect(mayBeMediatRRequest('Thing', 'var t = new Thing();')).toBe(false);
    expect(mayBeMediatRRequest('var', 'var q = 1;')).toBe(false);
    const md = mediatrHoverMarkdown('GetOrderQuery', [{ label: 'GetOrderQueryHandler', location: loc('file:///h.cs', 4), notification: false }], (u) => u.slice(8))!;
    expect(md).toContain('the handler');
    expect(md).toContain('command:refyntra.openLocation?');
    expect(mediatrHoverMarkdown('X', [{ label: 'H', location: loc('http://evil/x', 1), notification: false }], (u) => u)).not.toContain('command:');
    expect(mediatrHoverMarkdown('X', [], (u) => u)).toBeUndefined();
  });

  it('hierarchy item detail and unknown kinds', () => {
    expect(hierarchyDetail({ containerName: 'Shop.Api.OrderService', projectName: 'Shop.Api' })).toBe('Shop.Api.OrderService (Shop.Api)');
    expect(symbolKindName('method')).toBe('method');
    expect(symbolKindName('somethingNew')).toBe('other');
  });
});
