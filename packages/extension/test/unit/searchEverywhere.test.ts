import { describe, expect, it } from 'vitest';
import {
  MatchRank,
  type SearchCandidate,
  camelHumpMatch,
  commandTitles,
  groupSections,
  humpStarts,
  matchRank,
  parseQuery,
  pushRecent,
  rankCandidates,
} from '../../src/searchEverywhereModel';

describe('search everywhere matching', () => {
  it('finds hump starts', () => {
    expect(humpStarts('OrderService')).toEqual([0, 5]);
    expect(humpStarts('HTTPClient')).toEqual([0, 4]);
    expect(humpStarts('order_service.cs')).toEqual([0, 6, 14]);
  });
  it('matches camel humps', () => {
    expect(camelHumpMatch('OSvc', 'OrderService')).toBe(true);
    expect(camelHumpMatch('oSe', 'OrderService')).toBe(true);
    expect(camelHumpMatch('OS', 'OrderService')).toBe(true);
    expect(camelHumpMatch('OrdSer', 'OrderService')).toBe(true);
    expect(camelHumpMatch('SO', 'OrderService')).toBe(false);
    expect(camelHumpMatch('Ox', 'OrderService')).toBe(false);
    expect(camelHumpMatch('HC', 'HTTPClient')).toBe(true);
  });
  it('ranks exact > prefix > camel-hump > substring', () => {
    expect(matchRank('orderservice', 'OrderService')).toBe(MatchRank.Exact);
    expect(matchRank('Order', 'OrderService')).toBe(MatchRank.Prefix);
    expect(matchRank('OSvc', 'OrderService')).toBe(MatchRank.CamelHump);
    expect(matchRank('erSer', 'OrderService')).toBe(MatchRank.Substring);
    expect(matchRank('zzz', 'OrderService')).toBe(MatchRank.None);
  });
  it('parses prefixes', () => {
    expect(parseQuery('#Foo')).toEqual({ text: 'Foo', only: 'symbols' });
    expect(parseQuery('/a.cs')).toEqual({ text: 'a.cs', only: 'files' });
    expect(parseQuery('> rename')).toEqual({ text: 'rename', only: 'commands' });
    expect(parseQuery('@trace')).toEqual({ text: 'trace', only: 'settings' });
    expect(parseQuery(' Foo ')).toEqual({ text: 'Foo' });
  });
});

describe('search everywhere ranking', () => {
  const c = (section: SearchCandidate['section'], name: string, alt?: string): SearchCandidate => ({ section, name, alt, payload: name });
  it('orders by rank, then recent, then length', () => {
    const list = [c('types', 'OrderServiceFactory'), c('types', 'OrderSvc'), c('types', 'IOrderService'), c('types', 'OrderService'), c('types', 'OldSaveVerbCache')];
    const r = rankCandidates('OSvc', list)!.map((x) => x.name);
    expect(r[0]).toBe('OrderSvc');
    const r2 = rankCandidates('order', list, { recent: ['types:OrderServiceFactory'] })!.map((x) => x.name);
    expect(r2.slice(0, 3)).toEqual(['OrderServiceFactory', 'OrderSvc', 'OrderService']);
    expect(r2[r2.length - 1]).toBe('IOrderService');
  });
  it('matches alt text as substring and limits per section', () => {
    const list = [c('commands', 'Rename', 'refyntra.rename'), c('commands', 'Find', 'refyntra.find'), c('files', 'a.cs')];
    expect(rankCandidates('refyntra.ren', list)!.map((x) => x.name)).toEqual(['Rename']);
    expect(rankCandidates('', list, { limitPerSection: 1 })!.length).toBe(2);
  });
  it('groups in section order and filters by prefix section', () => {
    const r = rankCandidates('', [c('settings', 's'), c('types', 't'), c('files', 'f')])!;
    expect(groupSections(r).map((g) => g.section)).toEqual(['types', 'files', 'settings']);
    expect(groupSections(r, 'files').map((g) => g.section)).toEqual(['files']);
  });
  it('is cancellable', () => {
    const many = Array.from({ length: 5000 }, (_, i) => c('symbols', `Sym${i}`));
    expect(rankCandidates('S', many, { isCancelled: () => true })).toBeUndefined();
  });
  it('ranks 10k symbols fast', () => {
    const many = Array.from({ length: 10000 }, (_, i) => c('symbols', `Order${i % 7 ? 'Service' : 'Handler'}Item${i}Value`));
    rankCandidates('OSIV', many, { limitPerSection: 100 }); // warm-up (JIT)
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      rankCandidates('OSIV', many, { limitPerSection: 100 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    // Median after warm-up; the bound leaves room for loaded CI machines (locally ~10-30 ms).
    expect(times[2]).toBeLessThan(250);
  });
  it('keeps recent lists deduplicated and capped', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b', 2)).toEqual(['b', 'a']);
  });
  it('reads command titles from a manifest', () => {
    expect(commandTitles({ contributes: { commands: [{ command: 'x.a', title: 'A', category: 'X' }, { command: 'x.b', title: 'B' }] } })).toEqual(new Map([['x.a', 'X: A'], ['x.b', 'B']]));
  });
});
