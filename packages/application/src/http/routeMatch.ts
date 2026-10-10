import type { EndpointInfo } from '@refyntra/contracts';
import type { ClientCall, UrlSegment } from './clientCalls';

// Heuristic matching of a client URL to ASP.NET route templates. Both sides are normalised: leading/trailing
// slashes are ignored, literal segments compare case-insensitively (as ASP.NET routing does), `{id}`, `{id:int}`,
// `{id?}`, `{id=1}` and `{*rest}`/`{**rest}` are route parameters; a client parameter (`${x}`, `+ x`, `:id`) matches
// only a route parameter. The HTTP method must match when both sides know it.

type RouteSegment =
  | { kind: 'literal'; text: string }
  | { kind: 'param'; constraints: string[]; optional: boolean }
  | { kind: 'catchAll' }
  /** e.g. `{name}.{ext}` or `v{version}`: matches any single segment. */
  | { kind: 'complex' };

export function parseRouteTemplate(route: string): RouteSegment[] {
  const r = route.replace(/^~/, '');
  const out: RouteSegment[] = [];
  for (const raw of r.split('/')) {
    if (raw.length === 0) continue;
    const whole = /^\{([^{}]*)\}$/.exec(raw);
    if (whole) {
      const body = whole[1]!;
      if (body.startsWith('*')) {
        out.push({ kind: 'catchAll' });
        continue;
      }
      const [nameAndDefault, ...constraints] = body.split(':');
      const optional = body.endsWith('?') || (nameAndDefault ?? '').includes('=');
      out.push({ kind: 'param', constraints: constraints.map((c) => c.replace(/\?$/, '').replace(/\(.*$/, '').toLowerCase()), optional });
      continue;
    }
    if (raw.includes('{')) out.push({ kind: 'complex' });
    else out.push({ kind: 'literal', text: raw });
  }
  return out;
}

/** Client path segments; `:id` (a route-style placeholder written in the client) is a parameter too. */
function clientSegments(segments: readonly UrlSegment[]): UrlSegment[] {
  return segments.map((s) => (s.kind === 'literal' && /^:[A-Za-z_]\w*$/.test(s.text) ? { kind: 'param', name: s.text.slice(1) } : s));
}

function satisfies(constraints: readonly string[], value: string): boolean {
  for (const c of constraints) {
    if ((c === 'int' || c === 'long') && !/^-?\d+$/.test(value)) return false;
    if ((c === 'decimal' || c === 'double' || c === 'float') && !/^-?\d+(\.\d+)?$/.test(value)) return false;
    if (c === 'bool' && !/^(true|false)$/i.test(value)) return false;
    if (c === 'guid' && !/^[{(]?[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}[)}]?$/i.test(value)) return false;
    if (c === 'alpha' && !/^[a-z]+$/i.test(value)) return false;
  }
  return true;
}

/**
 * Precedence of a match per segment (ASP.NET-like: literal > constrained parameter > parameter > complex > catch-all),
 * or undefined when the route does not match.
 */
function matchSegments(client: readonly UrlSegment[], route: readonly RouteSegment[]): number[] | undefined {
  const score: number[] = [];
  let ci = 0;
  for (let ri = 0; ri < route.length; ri++) {
    const r = route[ri]!;
    const c = client[ci];
    if (r.kind === 'catchAll') {
      score.push(0);
      return score;
    }
    if (!c) {
      // Missing trailing segments: only optional parameters may be absent.
      if (r.kind === 'param' && r.optional) {
        score.push(1);
        continue;
      }
      return undefined;
    }
    if (r.kind === 'literal') {
      if (c.kind !== 'literal' || c.text.toLowerCase() !== r.text.toLowerCase()) return undefined;
      score.push(4);
    } else if (r.kind === 'param') {
      if (c.kind === 'literal' && !satisfies(r.constraints, c.text)) return undefined;
      score.push(r.constraints.length ? 3 : 2);
    } else {
      score.push(1);
    }
    ci++;
  }
  return ci === client.length ? score : undefined;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export function normalizeBasePath(p: string): string {
  const t = p.trim().replace(/^\/+|\/+$/g, '');
  return t ? `/${t}` : '';
}

export function normalizeOrigin(o: string): string {
  return o.trim().toLowerCase().replace(/\/+$/, '');
}

export interface MatchOptions {
  /** Path prefixes the client adds that the server does not see (e.g. a dev proxy), refyntra.http.basePaths. */
  basePaths?: readonly string[];
  /** Absolute origins that are this backend, refyntra.http.origins (e.g. "https://localhost:5001"). */
  origins?: readonly string[];
}

export type MatchStatus = 'linked' | 'ambiguous' | 'unmatched' | 'unresolved' | 'otherOrigin';

export interface CallMatch {
  status: MatchStatus;
  /** Best candidates (one when linked). */
  candidates: EndpointInfo[];
  /** The base path removed from the client path before the match. */
  strippedBase?: string;
  /** Why it is not linked (or how it was linked), user-facing. */
  reason: string;
}

export function endpointKey(e: EndpointInfo): string {
  const l = e.location;
  return `${l.uri}|${l.range.start.line}:${l.range.start.character}|${e.route}|${[...e.httpMethods].sort().join(',')}`;
}

/** Matches one client call against the endpoint list. Pure. */
export function matchCall(call: ClientCall, endpoints: readonly EndpointInfo[], options: MatchOptions = {}): CallMatch {
  if (!call.url) return { status: 'unresolved', candidates: [], reason: `URL not resolvable: ${call.reason ?? 'unknown form'}` };
  const url = call.url;
  if (url.origin && !(options.origins ?? []).map(normalizeOrigin).includes(url.origin)) {
    return { status: 'otherOrigin', candidates: [], reason: `another host (${url.origin}); add it to refyntra.http.origins if it is this backend` };
  }
  const segs = clientSegments(url.segments);
  const bases = ['', ...[...new Set((options.basePaths ?? []).map(normalizeBasePath).filter((b) => b))].sort((a, b) => b.length - a.length)];
  let methodMiss: EndpointInfo | undefined;
  for (const base of bases) {
    let rest = segs;
    if (base) {
      const bs = base.slice(1).split('/');
      if (segs.length < bs.length || !bs.every((b, i) => segs[i]!.kind === 'literal' && (segs[i] as { text: string }).text.toLowerCase() === b.toLowerCase())) continue;
      rest = segs.slice(bs.length);
    }
    const scored: Array<{ e: EndpointInfo; s: number[] }> = [];
    for (const e of endpoints) {
      if (e.routeIsDynamic) continue;
      const s = matchSegments(rest, parseRouteTemplate(e.route));
      if (!s) continue;
      if (call.method && e.httpMethods.length > 0 && !e.httpMethods.map((m) => m.toUpperCase()).includes(call.method)) {
        methodMiss ??= e;
        continue;
      }
      scored.push({ e, s });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => compareScores(b.s, a.s));
    const best = scored.filter((x) => compareScores(x.s, scored[0]!.s) === 0).map((x) => x.e);
    const unique = new Map(best.map((e) => [endpointKey(e), e]));
    const candidates = [...unique.values()];
    const via = base ? ` after removing the base path ${base}` : '';
    if (candidates.length === 1) return { status: 'linked', candidates, ...(base ? { strippedBase: base } : {}), reason: `matches ${candidates[0]!.route}${via}` };
    return { status: 'ambiguous', candidates, ...(base ? { strippedBase: base } : {}), reason: `ambiguous: ${candidates.length} routes match equally well${via}` };
  }
  if (methodMiss) return { status: 'unmatched', candidates: [], reason: `the path matches ${methodMiss.route}, but not the method ${call.method}` };
  return { status: 'unmatched', candidates: [], reason: 'no route matches' };
}
