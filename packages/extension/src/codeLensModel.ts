import type { Location } from '@refyntra/contracts';
import { type MergedRelation, relationLocation } from '@refyntra/domain';

// CodeLens above C# types and methods. Pure: unit-tested with vitest (no vscode). The provider (codeLens.ts) scans the
// document text (cheap, cached per version), and resolves each lens lazily with one Related request per declaration.

export interface CSharpDeclaration {
  kind: 'type' | 'method';
  name: string;
  /** Zero-based line and character of the name. */
  line: number;
  character: number;
}

const TYPE_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|file|new|ref)\s+)*(class|struct|interface|record(?:\s+(?:class|struct))?|enum)\s+(@?[A-Za-z_][A-Za-z0-9_]*)/;
const METHOD_RE = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly)\s+)+)(?:[A-Za-z_][\w<>,.?\[\]\s()]*?\s+)?(@?[A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^()]*>)?\s*\(/;
const NOT_METHOD = new Set(['if', 'for', 'foreach', 'while', 'switch', 'using', 'lock', 'return', 'catch', 'when', 'nameof', 'typeof', 'sizeof', 'default', 'new', 'await', 'throw', 'base', 'this', 'get', 'set', 'init', 'add', 'remove', 'operator', 'implicit', 'explicit', 'delegate', 'event']);

/**
 * Types and methods (with at least one modifier, as members are written in practice) declared in C# text. Comments and
 * strings spanning lines are skipped; a line inside a block comment or a verbatim/raw string is never a declaration.
 * Linear in the text length.
 */
export function scanCSharpDeclarations(text: string, max = 2000): CSharpDeclaration[] {
  const out: CSharpDeclaration[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let inBlockComment = false;
  let inRawString = false;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    let line = lines[i]!;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlockComment = false;
      line = ' '.repeat(end + 2) + line.slice(end + 2);
    }
    if (inRawString) {
      if (line.includes('"""')) inRawString = false;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    const quotes = (line.match(/"""/g) ?? []).length;
    if (quotes % 2 === 1) inRawString = true;
    const open = line.lastIndexOf('/*');
    if (open >= 0 && line.indexOf('*/', open + 2) < 0) inBlockComment = true;
    if (quotes > 0) continue;
    const t = TYPE_RE.exec(line);
    if (t) {
      const name = t[2]!;
      out.push({ kind: 'type', name: name.replace(/^@/, ''), line: i, character: line.indexOf(name, t.index + t[0].length - name.length) });
      continue;
    }
    const m = METHOD_RE.exec(line);
    if (m) {
      const name = m[2]!;
      if (NOT_METHOD.has(name)) continue;
      // An assignment or a call on the line before the name is not a declaration ("x = Foo(").
      const before = line.slice(0, m.index + m[0].lastIndexOf(name));
      if (/[=;]/.test(before)) continue;
      out.push({ kind: 'method', name: name.replace(/^@/, ''), line: i, character: m.index + m[0].lastIndexOf(name) });
    }
  }
  return out;
}

export type LensKind = 'main' | 'handler' | 'sentFrom' | 'endpoint' | 'data';

export interface CodeLensSettings {
  enabled: boolean;
  references: boolean;
  mediatr: boolean;
  endpoints: boolean;
  efCore: boolean;
}

/** What one Related result says about a declaration, reduced to what the lenses show. */
export interface LensSummary {
  /** True when Related found a symbol at the declaration. */
  hasSubject: boolean;
  references: { count: number; locations: Location[]; more: boolean };
  implementations: Location[];
  tests: Location[];
  handlers: { label: string; location?: Location }[];
  sends: Location[];
  isHandler: boolean;
  /** A handler's request type declarations (where its "sent from" places are looked up). */
  requests: Location[];
  endpoints: { methods: string[]; route: string; location?: Location }[];
  clients: Location[];
  configurations: Location[];
  migrations: Location[];
}

const locs = (rs: readonly MergedRelation[]): Location[] => rs.flatMap((r) => {
  const l = relationLocation(r);
  return l ? [l] : [];
});

/** Reduces the relations of a Related result for the lenses. `total` of references from the "Showing N of M" note. */
export function summarize(subject: boolean, relations: readonly MergedRelation[]): LensSummary {
  const by = (kind: string) => relations.filter((r) => r.relationKind === kind);
  const refs = by('reference');
  let count = refs.length;
  for (const l of refs.flatMap((r) => r.limitations)) {
    const m = /Showing \d+ of (\d+) references/.exec(l);
    if (m) count = Math.max(count, Number(m[1]));
  }
  return {
    hasSubject: subject,
    references: { count, locations: locs(refs), more: count > refs.length },
    implementations: locs(by('implementation')),
    tests: locs(by('test')),
    handlers: [...by('mediatr.handler'), ...by('mediatr.notificationHandler'), ...by('handler.handler')].map((r) => ({ label: r.target.label, ...(relationLocation(r) ? { location: relationLocation(r)! } : {}) })),
    sends: locs([...by('mediatr.send'), ...by('handler.dispatch')]),
    isHandler: by('mediatr.request').length + by('handler.request').length > 0,
    requests: [...by('mediatr.request'), ...by('handler.request')].flatMap((r) => (r.target.symbol?.location ? [r.target.symbol.location] : [])),
    endpoints: by('aspnet.endpoint').flatMap((r) => (r.target.endpoint ? [{ methods: r.target.endpoint.httpMethods, route: r.target.endpoint.route, location: r.target.endpoint.location }] : [])),
    clients: locs(relations.filter((r) => r.group === 'clients')),
    configurations: locs(by('efcore.configuration')),
    migrations: locs(by('efcore.migration')),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Lenses beyond the main one that this summary has content for (in display order), filtered by the settings. */
export function extraLensKinds(s: LensSummary, settings: CodeLensSettings): LensKind[] {
  const out: LensKind[] = [];
  if (settings.mediatr && s.handlers.length > 0) out.push('handler');
  if (settings.mediatr && s.isHandler) out.push('sentFrom');
  if (settings.endpoints && s.endpoints.length > 0) out.push('endpoint');
  if (settings.efCore && (s.configurations.length > 0 || s.migrations.length > 0)) out.push('data');
  return out;
}

export interface LensView {
  title: string;
  tooltip: string;
  /** Peek these; empty = open the Related view instead. */
  locations: Location[];
}

/** Title, tooltip and peek targets of one lens. */
export function lensView(kind: LensKind, s: LensSummary, decl: Pick<CSharpDeclaration, 'kind' | 'name'>): LensView {
  switch (kind) {
    case 'main': {
      if (!s.hasSubject) return { title: 'no symbol', tooltip: 'Refyntra found no symbol here.', locations: [] };
      const parts = [plural(s.references.count, 'reference')];
      if (s.implementations.length > 0) parts.push(plural(s.implementations.length, 'implementation'));
      if (s.tests.length > 0) parts.push(plural(s.tests.length, 'test'));
      const title = parts.join(' · ');
      const tooltip = `${decl.name}: ${title}${s.references.more ? ` (peek shows the first ${s.references.locations.length})` : ''}. Opens a peek view.`;
      return { title, tooltip, locations: [...s.references.locations, ...s.implementations, ...s.tests] };
    }
    case 'handler': {
      const first = s.handlers[0];
      const title = s.handlers.length === 1 ? `→ Handler: ${first!.label}` : `→ ${plural(s.handlers.length, 'handler')}`;
      return { title, tooltip: `MediatR: ${s.handlers.map((h) => h.label).join(', ')}`, locations: s.handlers.flatMap((h) => (h.location ? [h.location] : [])) };
    }
    case 'sentFrom':
      return { title: `← sent from ${plural(s.sends.length, 'place')}`, tooltip: 'MediatR: where the request of this handler is sent.', locations: s.sends };
    case 'endpoint': {
      const e = s.endpoints[0]!;
      const route = `${e.methods.length ? e.methods.join(',') : 'ANY'} ${e.route.startsWith('/') ? e.route : `/${e.route}`}`;
      const title = `${route}${s.endpoints.length > 1 ? ` (+${s.endpoints.length - 1})` : ''} · ${plural(s.clients.length, 'frontend call')}`;
      return { title, tooltip: `ASP.NET Core endpoint; frontend calls are matched heuristically.`, locations: s.clients.length ? s.clients : s.endpoints.flatMap((x) => (x.location ? [x.location] : [])) };
    }
    case 'data': {
      const parts: string[] = [];
      if (s.configurations.length) parts.push(s.configurations.length === 1 ? '→ configuration' : `→ ${plural(s.configurations.length, 'configuration')}`);
      if (s.migrations.length) parts.push(plural(s.migrations.length, 'migration'));
      return { title: parts.join(' · '), tooltip: 'EF Core: model configuration and migrations that mention it.', locations: [...s.configurations, ...s.migrations] };
    }
  }
}

/** Settings → which declarations get a main lens (types always when references are on; methods too). */
export function parseCodeLensSettings(get: (key: string, fallback: boolean) => boolean): CodeLensSettings {
  return {
    enabled: get('codeLens.enabled', true),
    references: get('codeLens.references', true),
    mediatr: get('codeLens.mediatr', true),
    endpoints: get('codeLens.endpoints', true),
    efCore: get('codeLens.efCore', true),
  };
}
