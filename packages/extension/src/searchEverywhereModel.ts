/** Search Everywhere: pure matching, ranking and section model (no vscode import, unit-tested). */

export type SearchSection = 'types' | 'symbols' | 'files' | 'commands' | 'settings';

export const SECTION_TITLES: Record<SearchSection, string> = {
  types: 'Types',
  symbols: 'Symbols',
  files: 'Files',
  commands: 'Commands',
  settings: 'Settings',
};

export const SECTION_ORDER: readonly SearchSection[] = ['types', 'symbols', 'files', 'commands', 'settings'];

/** Prefix that limits the search to one section; `#` symbols, `/` files, `>` commands, `@` settings. */
export interface ParsedQuery {
  text: string;
  only?: SearchSection;
}

export function parseQuery(raw: string): ParsedQuery {
  const v = raw.trimStart();
  const first = v.charAt(0);
  const map: Record<string, SearchSection> = { '#': 'symbols', '/': 'files', '>': 'commands', '@': 'settings' };
  const only = map[first];
  return only ? { text: v.slice(1).trim(), only } : { text: v.trim() };
}

/** Match quality, higher is better. 0 = no match. */
export enum MatchRank {
  None = 0,
  Substring = 1,
  CamelHump = 2,
  Prefix = 3,
  Exact = 4,
}

/** Word starts of an identifier: first char, uppercase after lowercase/digit, char after `_`, `.`, `-`, space, `/`. */
const isLowerOrDigit = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
const isUpperCode = (c: number): boolean => c >= 65 && c <= 90;
const isAlnum = (c: number): boolean => isLowerOrDigit(c) || isUpperCode(c);

function humpFlags(name: string): Uint8Array {
  const f = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!isAlnum(c)) continue;
    const prev = i > 0 ? name.charCodeAt(i - 1) : -1;
    const next = i + 1 < name.length ? name.charCodeAt(i + 1) : -1;
    const up = isUpperCode(c);
    if (i === 0 || !isAlnum(prev) || (up && isLowerOrDigit(prev)) || (up && isUpperCode(prev) && next >= 97 && next <= 122)) f[i] = 1;
  }
  return f;
}

/** Word starts of an identifier: first char, uppercase after lowercase/digit, last capital of an acronym before lowercase, char after a separator. */
export function humpStarts(name: string): number[] {
  const f = humpFlags(name);
  const out: number[] = [];
  f.forEach((v, i) => v && out.push(i));
  return out;
}

/**
 * Camel-hump match: query chars match in order; a lowercase char may continue inside the current hump
 * (skipping letters), any char may jump to the start of a later hump. Case-insensitive.
 * `OSvc` matches OrderService (O + S + v,c inside "Service"), `oSe` matches OrderService.
 */
export function camelHumpMatch(query: string, name: string): boolean {
  if (!query) return true;
  const starts = humpFlags(name);
  const lname = name.toLowerCase();
  const lquery = query.toLowerCase();
  const memo = new Int8Array((query.length + 1) * (name.length + 1));
  const w = name.length + 1;
  const go = (qi: number, ni: number): boolean => {
    if (qi === query.length) return true;
    if (ni >= name.length) return false;
    const key = qi * w + ni;
    if (memo[key]) return memo[key] === 1;
    const lq = lquery.charCodeAt(qi);
    const upper = query.charCodeAt(qi) !== lq;
    let ok = false;
    if (qi > 0 && !upper) {
      for (let j = ni; j < name.length && !ok && !starts[j]; j++) if (lname.charCodeAt(j) === lq) ok = go(qi + 1, j + 1);
    }
    for (let j = ni; j < name.length && !ok; j++) if (starts[j] && lname.charCodeAt(j) === lq) ok = go(qi + 1, j + 1);
    memo[key] = ok ? 1 : 2;
    return ok;
  };
  return go(0, 0);
}

function isSubsequence(q: string, n: string): boolean {
  let j = 0;
  for (let i = 0; i < n.length && j < q.length; i++) if (n.charCodeAt(i) === q.charCodeAt(j)) j++;
  return j === q.length;
}

export function matchRank(query: string, name: string): MatchRank {
  if (!query) return MatchRank.Substring;
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return MatchRank.Exact;
  if (n.startsWith(q)) return MatchRank.Prefix;
  if (isSubsequence(q, n) && camelHumpMatch(query, name)) return MatchRank.CamelHump;
  if (n.includes(q)) return MatchRank.Substring;
  return MatchRank.None;
}

export interface SearchCandidate<T = unknown> {
  section: SearchSection;
  /** Name that is matched (type name, file base name, command title, setting key). */
  name: string;
  /** Extra text that is matched with substring rank only (e.g. command id, full path). */
  alt?: string;
  payload: T;
}

export interface RankedCandidate<T = unknown> extends SearchCandidate<T> {
  rank: MatchRank;
  recent: boolean;
}

export interface RankOptions {
  /** Keys (section + ':' + name) of recently picked items; earlier entries are more recent. */
  recent?: readonly string[];
  limitPerSection?: number;
  /** Polled between chunks; returning true stops the ranking and returns undefined. */
  isCancelled?: () => boolean;
}

export const recentKey = (c: { section: SearchSection; name: string }): string => `${c.section}:${c.name}`;

/** Rank candidates: exact > prefix > camel-hump > substring; recent first within the same rank; then shorter names, then name. */
export function rankCandidates<T>(query: string, candidates: readonly SearchCandidate<T>[], options: RankOptions = {}): RankedCandidate<T>[] | undefined {
  const recentIndex = new Map<string, number>();
  (options.recent ?? []).forEach((k, i) => recentIndex.set(k, i));
  const out: RankedCandidate<T>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if ((i & 1023) === 1023 && options.isCancelled?.()) return undefined;
    const c = candidates[i]!;
    let rank = matchRank(query, c.name);
    if (rank === MatchRank.None && c.alt && query && c.alt.toLowerCase().includes(query.toLowerCase())) rank = MatchRank.Substring;
    if (rank === MatchRank.None) continue;
    out.push({ ...c, rank, recent: recentIndex.has(recentKey(c)) });
  }
  if (options.isCancelled?.()) return undefined;
  out.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    const ra = recentIndex.get(recentKey(a)) ?? Number.MAX_SAFE_INTEGER;
    const rb = recentIndex.get(recentKey(b)) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const limit = options.limitPerSection;
  if (!limit) return out;
  const counts = new Map<SearchSection, number>();
  return out.filter((c) => {
    const n = counts.get(c.section) ?? 0;
    counts.set(c.section, n + 1);
    return n < limit;
  });
}

/** Group ranked candidates into sections in the fixed section order. */
export function groupSections<T>(ranked: readonly RankedCandidate<T>[], only?: SearchSection): { section: SearchSection; items: RankedCandidate<T>[] }[] {
  const groups = new Map<SearchSection, RankedCandidate<T>[]>();
  for (const r of ranked) {
    if (only && r.section !== only) continue;
    const g = groups.get(r.section) ?? [];
    g.push(r);
    groups.set(r.section, g);
  }
  return SECTION_ORDER.filter((s) => groups.has(s)).map((s) => ({ section: s, items: groups.get(s)! }));
}

/** Push a key to the front of a recent list, deduplicated, capped. */
export function pushRecent(list: readonly string[], key: string, max = 50): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}

/** Commands contributed in a package.json manifest: id -> "Category: Title". */
export function commandTitles(manifest: { contributes?: { commands?: { command: string; title: string; category?: string }[]; menus?: { commandPalette?: { command: string; when?: string }[] } } }): Map<string, string> {
  // Commands an extension hides from the Command Palette (`when: false`) need arguments from a tree or a view: they are
  // not offered on their own.
  const hidden = new Set((manifest.contributes?.menus?.commandPalette ?? []).filter((e) => e.when === 'false').map((e) => e.command));
  const m = new Map<string, string>();
  for (const c of manifest.contributes?.commands ?? []) {
    if (hidden.has(c.command) || typeof c.title !== 'string') continue;
    m.set(c.command, c.category ? `${c.category}: ${c.title}` : c.title);
  }
  return m;
}
