import type { EndpointInfo, Location, Provenance, SearchItem, SymbolKind, SymbolRef } from '@refyntra/contracts';
import { compareLocations, compareStrings, locationKey } from './location';

/** One Find result as presented, independent of the provider that produced it. */
export interface FindItem {
  /** Stable key used for dedupe and selection. */
  key: string;
  /** `client`: a heuristic HTTP client call site (Find `client:`). */
  kind: 'symbol' | 'endpoint' | 'client';
  label: string;
  /** Project, origin, endpoint style. */
  description: string;
  detail: string;
  location?: Location;
  symbol?: SymbolRef;
  endpoint?: EndpointInfo;
  symbolKind?: SymbolKind;
  score: number;
  providerRouteId: string;
  provenances: Provenance[];
}

export function endpointLabel(e: EndpointInfo): string {
  const methods = e.httpMethods.length > 0 ? e.httpMethods.join(',') : 'ANY';
  return `${methods} ${e.route}${e.routeIsDynamic ? ' (dynamic)' : ''}`;
}

/** Converts a contract SearchItem into a FindItem; returns undefined for malformed items. */
export function toFindItem(item: SearchItem, providerRouteId: string): FindItem | undefined {
  const score = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
  if (item.symbol && typeof item.symbol.name === 'string') {
    const s = item.symbol;
    const location = s.location;
    return {
      key: location ? `symbol|${locationKey(location)}|${s.displayName}` : `symbol|${providerRouteId}|${s.displayName}`,
      kind: 'symbol',
      label: s.name,
      description: [s.projectName, s.origin !== 'source' ? s.origin : undefined].filter((x): x is string => !!x).join(' · '),
      detail: s.displayName ?? s.name,
      ...(location ? { location } : {}),
      symbol: s,
      symbolKind: s.kind,
      score,
      providerRouteId,
      provenances: s.provenance ? [s.provenance] : [],
    };
  }
  if (item.endpoint && item.endpoint.location && typeof item.endpoint.route === 'string') {
    const e = item.endpoint;
    return {
      key: `endpoint|${locationKey(e.location)}|${e.route}|${(e.httpMethods ?? []).join(',')}`,
      kind: 'endpoint',
      label: endpointLabel({ ...e, httpMethods: e.httpMethods ?? [] }),
      description: e.kind === 'mvc' ? 'MVC' : 'Minimal API',
      detail: e.handler?.displayName ?? '',
      location: e.location,
      endpoint: e,
      score,
      providerRouteId,
      provenances: e.handler?.provenance ? [e.handler.provenance] : [],
    };
  }
  return undefined;
}

/** Stable product ordering: score desc, label (case-insensitive, then ordinal), detail, location, route. */
export function compareFindItems(a: FindItem, b: FindItem): number {
  return (
    b.score - a.score ||
    compareStrings(a.label.toLowerCase(), b.label.toLowerCase()) ||
    compareStrings(a.label, b.label) ||
    compareStrings(a.detail, b.detail) ||
    compareLocations(a.location, b.location) ||
    compareStrings(a.providerRouteId, b.providerRouteId)
  );
}

/** Merge results from several providers, dedupe exact identity (keeping all provenances), stable sort. */
export function mergeFindItems(lists: readonly (readonly FindItem[])[]): FindItem[] {
  const byKey = new Map<string, FindItem>();
  for (const list of lists) {
    for (const item of list) {
      const existing = byKey.get(item.key);
      if (existing) {
        existing.provenances = [...existing.provenances, ...item.provenances];
        existing.score = Math.max(existing.score, item.score);
      } else {
        byKey.set(item.key, { ...item, provenances: [...item.provenances] });
      }
    }
  }
  return [...byKey.values()].sort(compareFindItems);
}
