import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as TS from 'typescript';
import type { WorkerEndpoint, WorkerFindItem, WorkerRelation } from '../protocol';
import { type NextRouteFile, isEndpointKind, matchNextRoute, nextRouteForFile } from '../nextRoutes';
import { norm } from './tsHost';
import { baseName, fileStart, nodeLocation, positionInText, readText, relation, textLocation, uriOf } from './util';

// Next.js: versioned file-system conventions (app and pages routers), 'use client' / 'use server' boundaries and
// heuristic links from literal hrefs (<Link href>, router.push, redirect, fetch) to routes. Never a routing graph.

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const NEXT_GENERAL_LIMITATION = 'File-system routing conventions only: the full routing graph (middleware, rewrites, redirects, basePath, i18n, runtime navigation) is never claimed.';
export const NEXT_LINK_LIMITATION = 'Heuristic: matched by the literal path text; paths built at run time are not linked.';

export interface NextProject {
  dir: string;
  major: number | undefined;
  version: string;
}

export interface NextRouteEntry {
  file: string;
  route: NextRouteFile;
  methods: string[];
}

export interface LinkSite {
  file: string;
  start: number;
  end: number;
  href: string;
  via: string;
  text: string;
}

const LINK_PATTERNS: { re: RegExp; via: string }[] = [
  { re: /\bhref\s*=\s*\{?\s*(["'`])(\/[^"'`\s]*)\1/g, via: 'href' },
  { re: /\b(router\.(?:push|replace|prefetch)|redirect|permanentRedirect|revalidatePath)\s*\(\s*(["'`])(\/[^"'`\s]*)\2/g, via: 'call' },
  { re: /\bfetch\s*\(\s*(["'`])(\/api\/[^"'`\s]*)\1/g, via: 'fetch' },
];

export function scanLinks(file: string, text: string): LinkSite[] {
  const out: LinkSite[] = [];
  for (const { re, via } of LINK_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const href = via === 'call' ? m[3]! : m[2]!;
      const name = via === 'call' ? m[1]! : via;
      const start = m.index + m[0].lastIndexOf(href);
      out.push({ file, start, end: start + href.length, href, via: name, text: m[0] });
      if (out.length > 2000) return out;
    }
  }
  return out;
}

export function directiveOf(ts: typeof TS, sf: TS.SourceFile): 'use client' | 'use server' | undefined {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === 'use client' || st.expression.text === 'use server') return st.expression.text;
  }
  return undefined;
}

function exportedMethods(ts: typeof TS, sf: TS.SourceFile): string[] {
  const out = new Set<string>();
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st) && exported && st.name && HTTP_METHODS.includes(st.name.text)) out.add(st.name.text);
    if (ts.isVariableStatement(st) && exported) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && HTTP_METHODS.includes(d.name.text)) out.add(d.name.text);
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) if (HTTP_METHODS.includes(e.name.text)) out.add(e.name.text);
  }
  return HTTP_METHODS.filter((m) => out.has(m));
}

export class NextIndex {
  private routes: NextRouteEntry[] | undefined;
  private readonly links = new Map<string, { stamp: string; links: LinkSite[] }>();

  constructor(
    readonly project: NextProject,
    private readonly ts: typeof TS,
    private readonly files: () => readonly string[],
    /** Unsaved editor text of a file (undefined = read the disk). */
    private readonly text: (file: string) => string | undefined,
  ) {}

  invalidate(): void {
    this.routes = undefined;
  }

  rel(file: string): string {
    return norm(path.relative(this.project.dir, file));
  }

  routeOf(file: string): NextRouteFile | undefined {
    const rel = this.rel(file);
    if (rel.startsWith('..')) return undefined;
    return nextRouteForFile(rel, this.project.major);
  }

  allRoutes(): NextRouteEntry[] {
    if (this.routes) return this.routes;
    const out: NextRouteEntry[] = [];
    for (const f of this.files()) {
      const route = this.routeOf(f);
      if (!route) continue;
      let methods: string[] = [];
      if (route.kind === 'route' || route.kind === 'api') {
        const t = this.text(f) ?? readText(f);
        if (t) methods = exportedMethods(this.ts, this.ts.createSourceFile(f, t, this.ts.ScriptTarget.Latest, true));
      }
      out.push({ file: f, route, methods });
    }
    this.routes = out;
    return out;
  }

  /** Project-wide limitations: middleware and next.config rewrites/redirects/basePath/i18n are not evaluated. */
  projectLimitations(): string[] {
    const out = [NEXT_GENERAL_LIMITATION];
    for (const m of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js', 'proxy.ts', 'src/proxy.ts']) {
      if (fs.existsSync(path.join(this.project.dir, m))) out.push(`${m} can rewrite, redirect or block a request before it reaches this route; it is not evaluated.`);
    }
    for (const c of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
      const t = readText(path.join(this.project.dir, c));
      if (!t) continue;
      const found = ['rewrites', 'redirects', 'basePath', 'i18n', 'trailingSlash'].filter((k) => new RegExp(`\\b${k}\\b`).test(t));
      if (found.length) out.push(`${c} configures ${found.join(', ')}; these are listed, not resolved.`);
    }
    return out;
  }

  endpointOf(e: NextRouteEntry): WorkerEndpoint {
    return {
      kind: e.route.kind === 'route' ? 'next-route-handler' : e.route.kind === 'api' ? 'next-api' : 'next-page',
      route: e.route.template,
      routeIsDynamic: e.route.dynamic,
      httpMethods: e.methods,
      location: fileStart(e.file),
    };
  }

  basis(router: 'app' | 'pages'): string {
    return `Next.js ${this.project.major ?? '(version unknown)'} ${router} router file convention`;
  }

  routeRelation(e: NextRouteEntry, kind: string, group: WorkerRelation['group']): WorkerRelation {
    const endpoint = this.endpointOf(e);
    return relation({
      kind,
      group,
      label: `${e.methods.length ? `${e.methods.join(',')} ` : ''}${e.route.template}${e.route.dynamic ? ' (dynamic)' : ''} — ${e.route.kind}`,
      location: endpoint.location,
      endpoint,
      confidence: 'likely',
      basis: this.basis(e.route.router),
      evidence: [{ description: `${this.rel(e.file)} (${e.route.router} router ${e.route.kind}${e.route.groups.length ? `, route group ${e.route.groups.join(', ')}` : ''})`, location: endpoint.location }],
      limitations: [...e.route.limitations, ...this.projectLimitations()],
    });
  }

  linkSites(): LinkSite[] {
    const out: LinkSite[] = [];
    for (const f of this.files()) {
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(f)) continue;
      let stamp = '';
      try {
        const st = fs.statSync(f);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        continue;
      }
      const dirty = this.text(f);
      const cached = this.links.get(f);
      if (cached && cached.stamp === stamp && dirty === undefined) {
        out.push(...cached.links);
        continue;
      }
      const t = dirty ?? readText(f);
      if (!t) continue;
      const links = scanLinks(f, t);
      this.links.set(f, { stamp, links });
      out.push(...links);
    }
    return out;
  }

  /** Best-matching endpoint routes (page, route handler, API) for a literal path. */
  routesFor(href: string, via: string): NextRouteEntry[] {
    const candidates = this.allRoutes().filter((e) => isEndpointKind(e.route.kind) && (via === 'fetch' ? e.route.kind !== 'page' : true) && !e.route.intercepting && e.route.slots.length === 0);
    let best = -1;
    let out: NextRouteEntry[] = [];
    for (const e of candidates) {
      const m = matchNextRoute(href, e.route.template);
      if (!m) continue;
      if (m.score > best) {
        best = m.score;
        out = [e];
      } else if (m.score === best) out.push(e);
    }
    return out;
  }

  related(sf: TS.SourceFile | undefined, file: string, text: string, offset: number): { subject?: string; relations: WorkerRelation[] } {
    const relations: WorkerRelation[] = [];
    let subject: string | undefined;
    // A literal path at the cursor: the route(s) it reaches.
    const site = scanLinks(file, text).find((l) => offset >= l.start && offset <= l.end);
    if (site) {
      subject = site.href;
      const targets = this.routesFor(site.href, site.via);
      for (const t of targets) {
        const r = this.routeRelation(t, 'next.linkTarget', 'endpoints');
        relations.push({ ...r, confidence: 'heuristic', basis: `${r.basis}; literal path matched`, limitations: [NEXT_LINK_LIMITATION, ...(targets.length > 1 ? [`Ambiguous: ${targets.length} routes match this path equally well.`] : []), ...r.limitations] });
      }
      return { subject, relations };
    }
    const route = this.routeOf(file);
    if (route) {
      const entry = this.allRoutes().find((e) => e.file === file) ?? { file, route, methods: [] };
      subject = `${route.template} (${route.kind})`;
      relations.push(this.routeRelation(entry, 'next.route', 'endpoints'));
      if (isEndpointKind(route.kind)) {
        for (const l of this.linkSites()) {
          if (l.file === file) continue;
          const targets = this.routesFor(l.href, l.via);
          if (!targets.some((t) => t.file === file)) continue;
          const t = this.text(l.file) ?? readText(l.file) ?? '';
          const loc = textLocation(l.file, t, l.start, l.end);
          relations.push(
            relation({
              kind: 'next.link',
              group: 'clients',
              label: `${l.via === 'href' ? 'href' : l.via}("${l.href}") in ${baseName(norm(l.file))}`,
              location: loc,
              confidence: 'heuristic',
              basis: 'Literal path matched to the file-system route',
              evidence: [{ description: l.text.slice(0, 120), location: loc }],
              limitations: [NEXT_LINK_LIMITATION, ...(targets.length > 1 ? [`Ambiguous: ${targets.length} routes match this path equally well.`] : [])],
            }),
          );
        }
      }
      // Layouts wrapping a page: the layout files on the way up (app router).
      if (route.router === 'app' && route.kind === 'page') {
        for (const e of this.allRoutes()) {
          if (e.route.kind !== 'layout' && e.route.kind !== 'template') continue;
          const dir = path.dirname(e.file);
          if (norm(file).startsWith(`${norm(dir)}/`)) relations.push({ ...this.routeRelation(e, 'next.layout', 'declarations'), label: `${e.route.kind} ${this.rel(e.file)}` });
        }
      }
    }
    if (sf) relations.push(...this.boundaryRelations(sf, route));
    return { ...(subject ? { subject } : {}), relations };
  }

  /** 'use client' / 'use server' markers of the file and the client components a server file imports. */
  boundaryRelations(sf: TS.SourceFile, route: NextRouteFile | undefined): WorkerRelation[] {
    const ts = this.ts;
    const out: WorkerRelation[] = [];
    const directive = directiveOf(ts, sf);
    const basis = `Next.js ${this.project.major ?? '(version unknown)'} directive`;
    if (directive) {
      out.push(relation({ kind: directive === 'use client' ? 'next.clientBoundary' : 'next.serverActions', group: 'declarations', label: directive === 'use client' ? "Client component boundary ('use client')" : "Server actions module ('use server')", location: nodeLocation(sf, sf.statements[0]!), confidence: 'proven', basis, evidence: [{ description: `The file starts with '${directive}'.` }] }));
    } else if (route?.router === 'app' && !/\.(md|mdx)$/.test(sf.fileName)) {
      out.push(relation({ kind: 'next.serverComponent', group: 'declarations', label: 'Server component (app router default, no directive)', location: fileStart(sf.fileName), confidence: 'likely', basis, limitations: ['A parent client component can still render it as part of the client tree.'] }));
    }
    // Function-level 'use server' (inline server actions).
    const visit = (n: TS.Node): void => {
      if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
        const first = n.body.statements[0];
        if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server') {
          const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text : 'inline function';
          out.push(relation({ kind: 'next.serverAction', group: 'declarations', label: `Server action ${name} ('use server')`, location: nodeLocation(sf, n), confidence: 'proven', basis }));
        }
      }
      n.forEachChild(visit);
    };
    sf.forEachChild(visit);
    // A server file importing client components: where the client boundary starts.
    if (directive !== 'use client') {
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
        const target = resolveRelative(path.dirname(sf.fileName), st.moduleSpecifier.text);
        if (!target) continue;
        const t = this.text(target) ?? readText(target);
        if (!t || !/^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(t)) continue;
        out.push(relation({ kind: 'next.clientImport', group: 'references', label: `Imports client component module ${baseName(norm(target))}`, location: { uri: uriOf(target), range: { start: positionInText(t, 0), end: positionInText(t, 0) } }, confidence: 'proven', basis, evidence: [{ description: `import from '${st.moduleSpecifier.text}'`, location: nodeLocation(sf, st) }] }));
      }
    }
    return out;
  }

  findPages(text: string): WorkerFindItem[] {
    const q = text.toLowerCase();
    return this.allRoutes()
      .filter((e) => isEndpointKind(e.route.kind) && (!q || e.route.template.toLowerCase().includes(q) || this.rel(e.file).toLowerCase().includes(q)))
      .map((e) => {
        const endpoint = this.endpointOf(e);
        return {
          kind: 'page' as const,
          label: `${e.methods.length ? `${e.methods.join(',')} ` : ''}${e.route.template}${e.route.dynamic ? ' (dynamic)' : ''}`,
          description: `Next.js ${e.route.router} router ${e.route.kind}`,
          detail: this.rel(e.file),
          location: endpoint.location,
          endpoint,
          confidence: 'likely' as const,
          basis: this.basis(e.route.router),
        };
      });
  }
}

const RESOLVE_EXT = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
function resolveRelative(dir: string, spec: string): string | undefined {
  const base = path.resolve(dir, spec);
  for (const ext of ['', ...RESOLVE_EXT]) {
    const p = base + ext;
    try {
      if (fs.statSync(p).isFile()) return norm(p);
    } catch {
      // next candidate
    }
  }
  return undefined;
}
