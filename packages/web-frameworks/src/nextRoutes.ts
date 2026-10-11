import { NEXT_CONVENTIONS } from './versions';

// Next.js file-system routing conventions (pure). A file path relative to the Next.js project folder is mapped to a
// route template. This is what the file system says, never a full routing graph: middleware, rewrites, redirects,
// basePath, i18n and runtime navigation are not resolved (they are reported as limitations).

export type NextRouter = 'app' | 'pages';
export type NextFileKind =
  | 'page'
  | 'layout'
  | 'template'
  | 'loading'
  | 'error'
  | 'global-error'
  | 'not-found'
  | 'default'
  | 'route'
  | 'api'
  | 'special';

export interface NextRouteFile {
  router: NextRouter;
  kind: NextFileKind;
  /** Route template in Next.js syntax: "/orders/[id]", "/docs/[...slug]", "/" */
  template: string;
  dynamic: boolean;
  /** Catch-all ([...x]) or optional catch-all ([[...x]]). */
  catchAll: boolean;
  /** Parallel route slots on the way (@team). */
  slots: string[];
  /** Intercepting route marker ("(.)", "(..)", "(...)") when the path has one. */
  intercepting?: string;
  /** Route groups on the way ("(shop)"); they do not change the URL. */
  groups: string[];
  /** Why the mapping is limited (intercepting route, version unknown ...). */
  limitations: string[];
}

const SOURCE_EXT = /\.(tsx|ts|jsx|js|mdx|md)$/i;
const APP_FILES: Readonly<Record<string, NextFileKind>> = {
  page: 'page',
  layout: 'layout',
  template: 'template',
  loading: 'loading',
  error: 'error',
  'global-error': 'global-error',
  'not-found': 'not-found',
  default: 'default',
  route: 'route',
};

/** Splits "src/app/(shop)/orders/[id]/page.tsx" into router root and the rest. */
function routerOf(rel: string): { router: NextRouter; rest: string[] } | undefined {
  const parts = rel.split('/').filter((p) => p.length > 0);
  const start = parts[0] === 'src' ? 1 : 0;
  const head = parts[start];
  if (head === 'app') return { router: 'app', rest: parts.slice(start + 1) };
  if (head === 'pages') return { router: 'pages', rest: parts.slice(start + 1) };
  return undefined;
}

/**
 * Maps a file (path relative to the folder with the Next.js package.json, "/" separators) to its route, or undefined
 * when the file is not a routing file. `nextMajor` gates the conventions (undefined = unknown, both routers accepted
 * with a limitation).
 */
export function nextRouteForFile(rel: string, nextMajor: number | undefined): NextRouteFile | undefined {
  const r = routerOf(rel);
  if (!r || r.rest.length === 0) return undefined;
  const file = r.rest[r.rest.length - 1]!;
  if (!SOURCE_EXT.test(file)) return undefined;
  const base = file.replace(SOURCE_EXT, '');
  const dirs = r.rest.slice(0, -1);
  const limitations: string[] = [];
  if (nextMajor === undefined) limitations.push('The Next.js version is unknown; conventions of the current Next.js are assumed.');
  if (r.router === 'app') {
    if (nextMajor !== undefined && nextMajor < NEXT_CONVENTIONS.appRouter) return undefined;
    const kind = APP_FILES[base];
    if (!kind) return undefined;
    const segs: string[] = [];
    const slots: string[] = [];
    const groups: string[] = [];
    let intercepting: string | undefined;
    for (const d of dirs) {
      if (d.startsWith('_')) return undefined; // private folder: not routable
      if (/^\(\.{1,3}\)|^(\(\.\.\))+/.test(d)) {
        const m = /^((?:\(\.\.\))+|\(\.{1,3}\))(.*)$/.exec(d)!;
        intercepting = m[1];
        if (m[2]) segs.push(m[2]);
        continue;
      }
      if (/^\(.*\)$/.test(d)) {
        groups.push(d);
        continue;
      }
      if (d.startsWith('@')) {
        slots.push(d);
        continue;
      }
      segs.push(d);
    }
    if (intercepting) limitations.push(`Intercepting route ${intercepting}: shown instead of the target route only when navigating from inside the app; which route it intercepts is not resolved.`);
    if (slots.length) limitations.push(`Parallel route slot ${slots.join(', ')}: rendered by the parent layout, not a URL of its own.`);
    return build('app', kind, segs, slots, groups, intercepting, limitations);
  }
  // pages router
  if (nextMajor !== undefined && nextMajor < NEXT_CONVENTIONS.pagesRouter) return undefined;
  if (/\.(md|mdx)$/i.test(file) && nextMajor !== undefined) limitations.push('MDX pages need @next/mdx; not checked.');
  if (dirs.length === 0 && /^_(app|document|error)$/.test(base)) return { router: 'pages', kind: 'special', template: `/${base}`, dynamic: false, catchAll: false, slots: [], groups: [], limitations: ['Special Next.js file: wraps every page, not a route.'] };
  if (dirs.some((d) => d.startsWith('_')) || base.startsWith('_')) return undefined;
  const segs = [...dirs, ...(base === 'index' ? [] : [base])];
  const kind: NextFileKind = dirs[0] === 'api' ? 'api' : 'page';
  return build('pages', kind, segs, [], [], undefined, limitations);
}

function build(router: NextRouter, kind: NextFileKind, segs: string[], slots: string[], groups: string[], intercepting: string | undefined, limitations: string[]): NextRouteFile {
  const template = `/${segs.join('/')}`;
  const dynamic = segs.some((s) => /^\[.*\]$/.test(s));
  const catchAll = segs.some((s) => /^\[\[?\.\.\./.test(s));
  if (dynamic) limitations.push('Dynamic segments match any value; which values exist (generateStaticParams, getStaticPaths, data) is not resolved.');
  return { router, kind, template, dynamic, catchAll, slots, groups, ...(intercepting ? { intercepting } : {}), limitations };
}

/** Whether a route file renders a URL (pages, route handlers, API routes) rather than wrapping one (layout, loading ...). */
export function isEndpointKind(kind: NextFileKind): boolean {
  return kind === 'page' || kind === 'route' || kind === 'api';
}

/**
 * Matches a literal href/path ("/orders/42?x=1", "/orders/${id}") against a route template. `${...}` parts of a
 * template literal match only dynamic segments. Returns undefined when it does not match, else how exact it is
 * (more static segments = better).
 */
export function matchNextRoute(href: string, template: string): { score: number } | undefined {
  const clean = href.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (!clean.startsWith('/')) return undefined;
  const h = clean.split('/').filter(Boolean);
  const t = template.split('/').filter(Boolean);
  let score = 0;
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!;
    const optionalCatchAll = /^\[\[\.\.\..+\]\]$/.test(seg);
    const catchAll = /^\[\.\.\..+\]$/.test(seg);
    if (optionalCatchAll) return i === t.length - 1 ? { score } : undefined;
    if (catchAll) return i === t.length - 1 && h.length > i ? { score } : undefined;
    const part = h[i];
    if (part === undefined) return undefined;
    if (/^\[.+\]$/.test(seg)) continue;
    if (part.includes('${')) return undefined; // a runtime value never equals a static segment
    if (decodeSafe(part) !== seg) return undefined;
    score++;
  }
  return h.length === t.length ? { score: score + 1 } : undefined;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Angular-style path joining for nested route definitions ("orders" + ":id" → "/orders/:id"). */
export function joinRoutePath(parts: readonly string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).filter((s) => s.length > 0);
  return `/${segs.join('/')}`;
}
