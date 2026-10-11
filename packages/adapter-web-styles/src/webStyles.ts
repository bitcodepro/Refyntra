import type { HeuristicProvenance, Location, OwnedProvenance, Position, Provenance, Range } from '@refyntra/contracts';
import type { AnyRelation, AnyRelationKind, FindItem } from '@refyntra/domain';
import { type CancellationToken, type ClientSourcePort, raceCancellation, throwIfCancelled } from '@refyntra/application';
import { parseHtml } from './html';
import { type FileFacts, type HtmlFacts, type NameUse, type ScriptFacts, type SelectorName, type StylesheetFacts, inRange } from './model';
import { baseName, joinSpec, styleImportCandidates, uriKey } from './paths';
import { parseScript } from './script';
import { parseStylesheet, styleLanguageOf } from './stylesheet';

// HTML/CSS/SCSS/LESS ↔ code links. One index of file facts (stylesheets, HTML pages, TS/JS sources), scanned once on
// demand and kept current by editor and file events, and the relation rules on top of it:
//   proven     CSS Modules: a static member (`styles.foo`, `styles['foo']`) of an import that resolves to the
//              `.module.css|scss|less` file ↔ the `.foo` rule of that file. SCSS/LESS variables and SCSS mixins ↔
//              their definition in the same file or in a file reached through resolved @use/@import/@forward.
//   heuristic  global classes and ids: a class/id token in HTML or code ↔ `.name` / `#name` rules, first in the
//              stylesheets linked from that file (<link>, <style>, `import './x.css'`), else in any global stylesheet
//              of the workspace. Ambiguous when several files define it.
//   unknown    dynamic class names (template literals, `styles[name]`, expressions): never linked.
// "Possibly unused" selectors are information in Related only (never a problem): classes can be built at run time.

export const WEB_STYLES_ROUTE_ID = 'web.styles';
export const GLOBAL_CLASS_LIMITATION = 'Heuristic: matched by the class name text. Classes added at run time, by other libraries or through string building are not seen.';
export const NOT_LINKED_LIMITATION = 'This file links no stylesheet that defines the name: matched in a stylesheet of the workspace.';
export const AMBIGUOUS_LIMITATION = (n: number) => `Ambiguous: ${n} stylesheets define this name.`;
export const ID_LIMITATION = 'Heuristic: matched by the id text. Ids set at run time are not seen.';
export const UNUSED_LIMITATION = 'Information only: no static use was found in HTML or code. The class may still be used dynamically (built strings, other libraries, server templates).';
export const DYNAMIC_LIMITATION = (n: number) => `${n} dynamic access${n === 1 ? '' : 'es'} (e.g. styles[name]) cannot be linked to a class.`;

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_CHARS = 1_000_000;
const MAX_RELATIONS = 200;
const MAX_UNUSED = 100;

export type WebFileKind = 'stylesheet' | 'html' | 'script';

export function webFileKind(uri: string): WebFileKind | undefined {
  const path = (uri.split(/[?#]/)[0] ?? uri).toLowerCase();
  if (styleLanguageOf(path)) return 'stylesheet';
  if (/\.html?$/.test(path)) return 'html';
  if (/\.d\.[mc]?ts$/.test(path)) return undefined;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path)) return 'script';
  return undefined;
}

/** Parses one file into its facts; undefined for other file types or when the parser fails. */
export function parseWebFile(uri: string, text: string): FileFacts | undefined {
  try {
    const kind = webFileKind(uri);
    if (kind === 'stylesheet') return parseStylesheet(uri, text, styleLanguageOf(uri)!);
    if (kind === 'html') return parseHtml(uri, text);
    if (kind === 'script') return parseScript(text);
  } catch {
    // A parser failure on one file never breaks the index.
  }
  return undefined;
}

/** File facts of the workspace, scanned once on demand (bounded), updated incrementally. */
export class WebStyleIndex {
  private readonly byUri = new Map<string, FileFacts>();
  private readonly uriByKey = new Map<string, string>();
  private scan: Promise<void> | undefined;
  private generation = 0;
  /** Bumped on every change: the route's epoch, so cached Related views of an older index are not reused. */
  version = 0;
  truncated = false;
  readonly onChange = new Set<() => void>();

  constructor(
    private readonly files: ClientSourcePort,
    private readonly maxFiles = DEFAULT_MAX_FILES,
    private readonly maxFileChars = DEFAULT_MAX_FILE_CHARS,
  ) {}

  async ensureScanned(token?: CancellationToken): Promise<void> {
    if (!this.scan) {
      const gen = this.generation;
      this.scan = this.run(gen).catch((e) => {
        if (this.generation === gen) this.scan = undefined;
        throw e;
      });
    }
    return raceCancellation(this.scan, token);
  }

  private async run(gen: number): Promise<void> {
    const uris = await this.files.listFiles();
    if (gen !== this.generation) return;
    this.truncated = uris.length > this.maxFiles;
    for (const uri of uris.slice(0, this.maxFiles)) {
      if (gen !== this.generation) return;
      if (this.byUri.has(uri) || !webFileKind(uri)) continue;
      const text = await this.files.readFile(uri).catch(() => undefined);
      if (gen !== this.generation) return;
      if (text === undefined || text.length > this.maxFileChars) continue;
      this.set(uri, parseWebFile(uri, text));
    }
    this.changed();
  }

  private set(uri: string, facts: FileFacts | undefined): void {
    if (!facts) {
      this.byUri.delete(uri);
      this.uriByKey.delete(uriKey(uri));
      return;
    }
    this.byUri.set(uri, facts);
    this.uriByKey.set(uriKey(uri), uri);
  }

  private changed(): void {
    this.version++;
    for (const l of [...this.onChange]) l();
  }

  fileChanged(uri: string, text: string): void {
    if (!webFileKind(uri)) return;
    this.set(uri, text.length > this.maxFileChars ? undefined : parseWebFile(uri, text));
    this.changed();
  }

  fileDeleted(uri: string): void {
    this.set(uri, undefined);
    this.changed();
  }

  reset(): void {
    this.generation++;
    this.byUri.clear();
    this.uriByKey.clear();
    this.scan = undefined;
    this.truncated = false;
    this.changed();
  }

  get(uri: string): FileFacts | undefined {
    return this.byUri.get(uri) ?? this.byUri.get(this.uriByKey.get(uriKey(uri)) ?? '');
  }

  /** The indexed URI for a candidate URI (case/encoding-insensitive). */
  find(uri: string): string | undefined {
    return this.uriByKey.get(uriKey(uri));
  }

  /** Root-relative `/css/site.css`: the single indexed file whose path ends with it (else undefined). */
  findBySuffix(spec: string): string | undefined {
    const suffix = uriKey(spec.split(/[?#]/)[0]!);
    const hits = [...this.uriByKey.entries()].filter(([k]) => k.endsWith(suffix));
    return hits.length === 1 ? hits[0]![1] : undefined;
  }

  entries(): [string, FileFacts][] {
    return [...this.byUri].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

export interface WebStyleOptions {
  files: ClientSourcePort;
  /** Current text of an open document (dirty edits included), when tracked. */
  documentText?: (uri: string) => string | undefined;
  maxFiles?: number;
  maxFileChars?: number;
}

/** What is under the cursor. */
export type WebSubject =
  | { kind: 'class'; name: string; range: Range; sheet: string; module: boolean; selector: string }
  | { kind: 'id'; name: string; range: Range; sheet: string; selector: string }
  | { kind: 'variable' | 'mixin'; name: string; range: Range; sheet: string; definition: boolean; namespace?: string }
  | { kind: 'classUse' | 'idUse'; name: string; range: Range; form: string }
  | { kind: 'moduleUse'; alias: string; member?: string; range: Range }
  | { kind: 'import'; spec: string; range: Range; resolved?: string }
  | { kind: 'file' };

interface Def {
  uri: string;
  name: string;
  range: Range;
  selector: string;
}

const loc = (uri: string, range: Range): Location => ({ uri, range });
const place = (uri: string, r: Range) => `${baseName(uri)}:${r.start.line + 1}`;
const FILE_START: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** Read-only relation rules over the index. */
export class WebStyleService {
  readonly index: WebStyleIndex;

  constructor(private readonly o: WebStyleOptions) {
    this.index = new WebStyleIndex(o.files, o.maxFiles, o.maxFileChars);
  }

  private provenance(confidence: 'proven' | 'likely' | 'heuristic', basis: string): Provenance {
    if (confidence === 'heuristic') {
      return { kind: 'heuristic', providerRouteId: WEB_STYLES_ROUTE_ID, sessionEpoch: `web-${this.index.version}`, snapshotId: `web-${this.index.version}`, projectContextId: 'unknown', basis } satisfies HeuristicProvenance;
    }
    return { kind: 'owned-semantic', providerRouteId: WEB_STYLES_ROUTE_ID, sessionEpoch: `web-${this.index.version}`, snapshotId: `web-${this.index.version}`, projectContextId: 'workspace' } satisfies OwnedProvenance;
  }

  /** The facts of a document: the open editor text first, then the index, then the disk. */
  async factsFor(uri: string, token?: CancellationToken): Promise<FileFacts | undefined> {
    const open = this.o.documentText?.(uri);
    if (open !== undefined) return parseWebFile(uri, open);
    const indexed = this.index.get(uri);
    if (indexed) return indexed;
    const text = await this.o.files.readFile(uri, token);
    throwIfCancelled(token);
    return text === undefined ? undefined : parseWebFile(uri, text);
  }

  private sheet(uri: string): StylesheetFacts | undefined {
    const f = this.index.get(uri);
    return f?.kind === 'stylesheet' ? f : undefined;
  }

  // ------------------------------------------------------------ resolution

  /** A stylesheet import/link/@use to an indexed file (undefined: package, URL or not in the workspace). */
  resolveStyle(from: string, spec: string, bareIsRelative: boolean): string | undefined {
    if (spec.startsWith('/') && !spec.startsWith('//')) return this.index.findBySuffix(spec);
    const joined = joinSpec(from, spec, bareIsRelative);
    if (!joined) return undefined;
    for (const c of styleImportCandidates(joined)) {
      const hit = this.index.find(c);
      if (hit && this.sheet(hit)) return hit;
    }
    return undefined;
  }

  /** Stylesheets reached from `start` through resolved imports (start included), breadth first, bounded. */
  private closure(start: readonly string[]): string[] {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length && seen.size < 500) {
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      for (const imp of this.sheet(u)?.imports ?? []) {
        const r = this.resolveStyle(u, imp.spec, true);
        if (r && !seen.has(r)) queue.push(r);
      }
    }
    return [...seen];
  }

  /** The stylesheets a page or component links (resolved, with their imports), and its inline <style> blocks. */
  private linkedSheets(uri: string, facts: FileFacts): { files: string[]; inline: StylesheetFacts[] } {
    if (facts.kind === 'html') {
      const files = facts.links.map((l) => this.resolveStyle(uri, l.spec, true)).filter((x): x is string => !!x);
      return { files: this.closure(files), inline: facts.inline };
    }
    if (facts.kind === 'script') {
      const files = facts.styleImports.map((l) => this.resolveStyle(uri, l.spec, false)).filter((x): x is string => !!x);
      return { files: this.closure(files), inline: [] };
    }
    return { files: [], inline: [] };
  }

  private globalSheets(): [string, StylesheetFacts][] {
    return this.index.entries().filter((e): e is [string, StylesheetFacts] => e[1].kind === 'stylesheet' && !e[1].isModule);
  }

  /** Definitions of a global class/id for a use in `uri`: linked stylesheets first, else every global stylesheet. */
  private globalDefs(uri: string, facts: FileFacts, kind: 'classes' | 'ids', name: string): { defs: Def[]; linked: boolean } {
    const linked = this.linkedSheets(uri, facts);
    const pick = (u: string, s: StylesheetFacts) => s[kind].filter((c) => c.name === name).map((c) => ({ uri: u, name, range: c.range, selector: c.selector }));
    const fromLinked = [...linked.inline.flatMap((s) => pick(uri, s)), ...linked.files.flatMap((u) => (this.sheet(u) && !this.sheet(u)!.isModule ? pick(u, this.sheet(u)!) : []))];
    if (fromLinked.length) return { defs: fromLinked, linked: true };
    return { defs: this.globalSheets().flatMap(([u, s]) => pick(u, s)), linked: false };
  }

  /** SCSS/LESS variable or mixin definitions visible from a use in `uri` (namespaced uses: only that @use target). */
  private namedDefs(uri: string, kind: 'variables' | 'mixins', name: string, namespace?: string): Def[] {
    const s = this.sheet(uri);
    let start = [uri];
    if (namespace && s) {
      const imp = s.imports.find((i) => i.namespace === namespace);
      const r = imp ? this.resolveStyle(uri, imp.spec, true) : undefined;
      start = r ? [r] : [];
    }
    return this.closure(start).flatMap((u) => (this.sheet(u)?.[kind] ?? []).filter((d) => d.name === name).map((d) => ({ uri: u, name, range: d.range, selector: '' })));
  }

  // ------------------------------------------------------------ subject

  subjectAt(facts: FileFacts, uri: string, p: Position): WebSubject {
    const hit = <T extends { range: Range }>(xs: readonly T[]) => xs.find((x) => inRange(x.range, p.line, p.character));
    if (facts.kind === 'stylesheet' || facts.kind === 'html') {
      const sheets = facts.kind === 'stylesheet' ? [facts] : facts.inline;
      for (const s of sheets) {
        const c = hit(s.classes);
        if (c) return { kind: 'class', name: c.name, range: c.range, sheet: uri, module: s.isModule, selector: c.selector };
        const i = hit(s.ids);
        if (i) return { kind: 'id', name: i.name, range: i.range, sheet: uri, selector: i.selector };
        const v = hit(s.variables);
        if (v) return { kind: 'variable', name: v.name, range: v.range, sheet: uri, definition: true };
        const m = hit(s.mixins);
        if (m) return { kind: 'mixin', name: m.name, range: m.range, sheet: uri, definition: true };
        const vu = hit(s.variableUses);
        if (vu) return { kind: 'variable', name: vu.name, range: vu.range, sheet: uri, definition: false, ...(vu.namespace ? { namespace: vu.namespace } : {}) };
        const mu = hit(s.mixinUses);
        if (mu) return { kind: 'mixin', name: mu.name, range: mu.range, sheet: uri, definition: false, ...(mu.namespace ? { namespace: mu.namespace } : {}) };
        const imp = hit(s.imports);
        if (imp) return { kind: 'import', spec: imp.spec, range: imp.range, ...this.opt(this.resolveStyle(uri, imp.spec, true)) };
      }
    }
    if (facts.kind === 'html') {
      const l = hit(facts.links);
      if (l) return { kind: 'import', spec: l.spec, range: l.range, ...this.opt(this.resolveStyle(uri, l.spec, true)) };
    }
    if (facts.kind === 'script') {
      const mu = hit(facts.moduleUses);
      if (mu) return { kind: 'moduleUse', alias: mu.alias, range: mu.range, ...(mu.member !== undefined ? { member: mu.member } : {}) };
      const si = hit(facts.styleImports) ?? hit(facts.moduleImports);
      if (si) return { kind: 'import', spec: si.spec, range: si.range, ...this.opt(this.resolveStyle(uri, si.spec, false)) };
    }
    if (facts.kind !== 'stylesheet') {
      const c = hit(facts.classUses);
      if (c) return { kind: 'classUse', name: c.name, range: c.range, form: c.form };
      const i = hit(facts.idUses);
      if (i) return { kind: 'idUse', name: i.name, range: i.range, form: i.form };
    }
    return { kind: 'file' };
  }

  private opt(resolved: string | undefined): { resolved?: string } {
    return resolved ? { resolved } : {};
  }

  // ------------------------------------------------------------ relations

  /** Relations at a document position (every route: stylesheet, HTML, TS/JS). */
  async relationsAt(uri: string, position: Position, token?: CancellationToken): Promise<{ subject: WebSubject; relations: AnyRelation[] }> {
    await this.index.ensureScanned(token);
    uri = this.index.find(uri) ?? uri;
    const facts = await this.factsFor(uri, token);
    throwIfCancelled(token);
    if (!facts) return { subject: { kind: 'file' }, relations: [] };
    const subject = this.subjectAt(facts, uri, position);
    return { subject, relations: this.relationsFor(uri, facts, subject).slice(0, MAX_RELATIONS) };
  }

  private rel(kind: AnyRelationKind, group: string, target: Location, label: string, confidence: 'proven' | 'likely' | 'heuristic', evidence: string, limitations: string[], basis: string): AnyRelation {
    return {
      relationKind: kind as AnyRelation['relationKind'],
      group: group as AnyRelation['group'],
      target: { location: target, label },
      evidence: [{ description: evidence, location: target }],
      confidence,
      provenance: this.provenance(confidence, basis),
      limitations,
    };
  }

  relationsFor(uri: string, facts: FileFacts, s: WebSubject): AnyRelation[] {
    switch (s.kind) {
      case 'moduleUse':
        return this.moduleUseRelations(uri, facts as ScriptFacts, s);
      case 'classUse':
      case 'idUse': {
        const kind = s.kind === 'classUse' ? 'classes' : 'ids';
        const { defs, linked } = this.globalDefs(uri, facts, kind, s.name);
        const files = new Set(defs.map((d) => uriKey(d.uri))).size;
        const lim = [s.kind === 'classUse' ? GLOBAL_CLASS_LIMITATION : ID_LIMITATION, ...(linked ? [] : [NOT_LINKED_LIMITATION]), ...(files > 1 ? [AMBIGUOUS_LIMITATION(files)] : [])];
        const sign = s.kind === 'classUse' ? '.' : '#';
        return defs.map((d) =>
          this.rel(s.kind === 'classUse' ? 'css.rule' : 'css.idRule', 'styles', loc(d.uri, d.range), `${d.selector || sign + d.name} — ${place(d.uri, d.range)}${files > 1 ? ' (ambiguous)' : ''}`, 'heuristic', `${s.form} ${s.name} matches ${sign}${d.name}${linked ? ' in a linked stylesheet' : ''}`, lim, `${sign}${s.name} matched by name`),
        );
      }
      case 'class':
        return s.module ? this.moduleClassUsers(s) : this.globalUsers(uri, 'classUses', s.name, s.sheet);
      case 'id':
        return this.globalUsers(uri, 'idUses', s.name, s.sheet);
      case 'variable':
      case 'mixin':
        return s.definition ? this.namedUsers(s) : this.namedDefinitionRelations(s);
      case 'import': {
        if (!s.resolved) return [];
        return [this.rel('css.import', 'styles', loc(s.resolved, FILE_START), baseName(s.resolved), 'proven', `${s.spec} resolves to ${baseName(s.resolved)}`, [], 'import path resolved to a workspace file')];
      }
      case 'file':
        return facts.kind === 'stylesheet' ? [...this.importers(uri), ...this.unused(uri, facts)] : [];
    }
  }

  private moduleUseRelations(uri: string, facts: ScriptFacts, s: Extract<WebSubject, { kind: 'moduleUse' }>): AnyRelation[] {
    if (s.member === undefined) return []; // styles[expr]: unknown, never guessed
    const out: AnyRelation[] = [];
    for (const imp of facts.moduleImports.filter((i) => i.alias === s.alias)) {
      const target = this.resolveStyle(uri, imp.spec, false);
      const sheet = target ? this.sheet(target) : undefined;
      if (!target || !sheet) continue;
      for (const c of sheet.classes.filter((x) => x.name === s.member)) {
        out.push(this.rel('css.moduleClass', 'styles', loc(target, c.range), `${c.selector} — ${place(target, c.range)}`, 'proven', `${s.alias}.${s.member}: ${imp.spec} resolves to ${baseName(target)}`, [], 'CSS Module import resolved to the stylesheet'));
      }
    }
    return out;
  }

  /** Script files whose CSS Module import resolves to `sheet`, with their alias. */
  private moduleImporters(sheetUri: string): { uri: string; facts: ScriptFacts; aliases: Set<string> }[] {
    const sheet = this.index.find(sheetUri) ?? sheetUri;
    const out: { uri: string; facts: ScriptFacts; aliases: Set<string> }[] = [];
    for (const [u, f] of this.index.entries()) {
      if (f.kind !== 'script') continue;
      const aliases = new Set(f.moduleImports.filter((i) => this.resolveStyle(u, i.spec, false) === sheet).map((i) => i.alias));
      if (aliases.size) out.push({ uri: u, facts: f, aliases });
    }
    return out;
  }

  private moduleClassUsers(s: Extract<WebSubject, { kind: 'class' }>): AnyRelation[] {
    const sheet = this.index.find(s.sheet) ?? s.sheet;
    const out: AnyRelation[] = [];
    let dynamic = 0;
    for (const imp of this.moduleImporters(sheet)) {
      for (const u of imp.facts.moduleUses.filter((m) => imp.aliases.has(m.alias))) {
        if (u.member === undefined) dynamic++;
        else if (u.member === s.name) out.push(this.rel('css.moduleUse', 'usedBy', loc(imp.uri, u.range), `${u.alias}.${u.member} — ${place(imp.uri, u.range)}`, 'proven', `CSS Module import of ${baseName(sheet)} as ${u.alias}`, [], 'CSS Module import resolved to the stylesheet'));
      }
    }
    if (dynamic) for (const r of out) r.limitations.push(DYNAMIC_LIMITATION(dynamic));
    return out;
  }

  /** HTML/script uses of a global class/id defined in `sheet` (uses that resolve to another linked stylesheet are left out). */
  private globalUsers(sheetUri: string, kind: 'classUses' | 'idUses', name: string, sheet: string): AnyRelation[] {
    const out: AnyRelation[] = [];
    const defKind = kind === 'classUses' ? 'classes' : 'ids';
    const inline = this.index.get(sheetUri)?.kind === 'html';
    for (const [u, f] of this.index.entries()) {
      if (f.kind === 'stylesheet') continue;
      if (inline && uriKey(u) !== uriKey(sheetUri)) continue; // a <style> block serves its own page
      const uses = f[kind].filter((x: NameUse) => x.name === name);
      if (!uses.length) continue;
      const { defs, linked } = this.globalDefs(u, f, defKind, name);
      if (!defs.some((d) => uriKey(d.uri) === uriKey(sheet))) continue;
      const files = new Set(defs.map((d) => uriKey(d.uri))).size;
      const lim = [kind === 'classUses' ? GLOBAL_CLASS_LIMITATION : ID_LIMITATION, ...(linked ? [] : [NOT_LINKED_LIMITATION]), ...(files > 1 ? [AMBIGUOUS_LIMITATION(files)] : [])];
      for (const x of uses) out.push(this.rel(kind === 'classUses' ? 'css.classUse' : 'css.idUse', 'usedBy', loc(u, x.range), `${x.form} ${x.name} — ${place(u, x.range)}${files > 1 ? ' (ambiguous)' : ''}`, 'heuristic', `${x.form} ${x.name}${linked ? ' (the stylesheet is linked from this file)' : ''}`, lim, 'class/id matched by name'));
    }
    return out;
  }

  private namedDefinitionRelations(s: Extract<WebSubject, { kind: 'variable' | 'mixin' }>): AnyRelation[] {
    const defs = this.namedDefs(s.sheet, s.kind === 'variable' ? 'variables' : 'mixins', s.name, s.namespace);
    const files = new Set(defs.map((d) => uriKey(d.uri))).size;
    const confidence = defs.length === 1 ? 'proven' : 'likely';
    const sign = s.kind === 'variable' ? (this.sheet(s.sheet)?.language === 'less' ? '@' : '$') : '@mixin ';
    return defs.map((d) =>
      this.rel(s.kind === 'variable' ? 'css.variable' : 'css.mixin', 'styles', loc(d.uri, d.range), `${sign}${d.name} — ${place(d.uri, d.range)}${defs.length > 1 ? ' (ambiguous)' : ''}`, confidence, `defined in ${baseName(d.uri)}${d.uri === s.sheet ? '' : ', reached through @use/@import'}`, defs.length > 1 ? [AMBIGUOUS_LIMITATION(files)] : [], 'definition found through resolved imports'),
    );
  }

  private namedUsers(s: Extract<WebSubject, { kind: 'variable' | 'mixin' }>): AnyRelation[] {
    const out: AnyRelation[] = [];
    const kind = s.kind === 'variable' ? 'variables' : 'mixins';
    for (const [u, f] of this.index.entries()) {
      if (f.kind !== 'stylesheet') continue;
      for (const use of (s.kind === 'variable' ? f.variableUses : f.mixinUses).filter((x) => x.name === s.name)) {
        const defs = this.namedDefs(u, kind, s.name, use.namespace);
        if (!defs.some((d) => uriKey(d.uri) === uriKey(s.sheet) && d.range.start.line === s.range.start.line && d.range.start.character === s.range.start.character)) continue;
        out.push(this.rel(s.kind === 'variable' ? 'css.variableUse' : 'css.mixinInclude', 'usedBy', loc(u, use.range), `${use.namespace ? use.namespace + '.' : ''}${s.kind === 'variable' ? (f.language === 'less' ? '@' : '$') : '@include '}${use.name} — ${place(u, use.range)}`, defs.length === 1 ? 'proven' : 'likely', `resolves to the definition in ${baseName(s.sheet)}`, defs.length > 1 ? [AMBIGUOUS_LIMITATION(defs.length)] : [], 'definition found through resolved imports'));
      }
    }
    return out;
  }

  /** Files that import or link this stylesheet. */
  private importers(sheet: string): AnyRelation[] {
    const out: AnyRelation[] = [];
    for (const [u, f] of this.index.entries()) {
      const specs = f.kind === 'stylesheet' ? f.imports.map((i) => [i, true] as const) : f.kind === 'html' ? f.links.map((i) => [i, true] as const) : [...f.styleImports, ...f.moduleImports].map((i) => [i, false] as const);
      for (const [imp, bare] of specs) {
        if (uriKey(this.resolveStyle(u, imp.spec, bare) ?? '') !== uriKey(sheet)) continue;
        out.push(this.rel('css.importedBy', 'usedBy', loc(u, imp.range), `${baseName(u)}:${imp.range.start.line + 1}`, 'proven', `${imp.spec} resolves to ${baseName(sheet)}`, [], 'import path resolved to a workspace file'));
      }
    }
    return out;
  }

  /** Classes of a stylesheet without any static use (information only; capped). */
  unused(sheet: string, facts: StylesheetFacts): AnyRelation[] {
    const out: AnyRelation[] = [];
    const seen = new Set<string>();
    if (facts.isModule) {
      const importers = this.moduleImporters(sheet);
      if (importers.some((i) => i.facts.moduleUses.some((m) => i.aliases.has(m.alias) && m.member === undefined))) return []; // dynamic access: any class may be used
      const used = new Set(importers.flatMap((i) => i.facts.moduleUses.filter((m) => i.aliases.has(m.alias)).map((m) => m.member)));
      for (const c of facts.classes) if (!used.has(c.name) && !seen.has(c.name)) seen.add(c.name) && out.push(this.unusedRel(sheet, c));
    } else {
      const names = new Set<string>();
      for (const [, f] of this.index.entries()) if (f.kind !== 'stylesheet') for (const u of f.classUses) names.add(u.name);
      for (const c of facts.classes) if (!names.has(c.name) && !seen.has(c.name)) seen.add(c.name) && out.push(this.unusedRel(sheet, c));
    }
    return out.slice(0, MAX_UNUSED);
  }

  private unusedRel(sheet: string, c: SelectorName): AnyRelation {
    return this.rel('css.unusedSelector', 'unused', loc(sheet, c.range), `.${c.name} — ${place(sheet, c.range)}, may be used dynamically`, 'heuristic', `no static use of .${c.name} in the scanned HTML and code`, [UNUSED_LIMITATION], 'no static use found');
  }

  // ------------------------------------------------------------ Find css:

  async find(text: string, limit: number, token?: CancellationToken): Promise<{ items: FindItem[]; truncated: boolean }> {
    await this.index.ensureScanned(token);
    throwIfCancelled(token);
    const needle = text.trim().replace(/^[.#]/, '').toLowerCase();
    const items: FindItem[] = [];
    const add = (u: string, sign: string, x: SelectorName, module: boolean) => {
      if (needle && !x.name.toLowerCase().includes(needle)) return;
      items.push({
        key: `css|${u}|${x.range.start.line}:${x.range.start.character}`,
        kind: 'style',
        label: `${sign}${x.name}`,
        description: `${module ? 'CSS Module class' : sign === '#' ? 'Id selector' : 'Class selector'} · ${baseName(u)}`,
        detail: x.selector,
        location: loc(u, x.range),
        score: x.name.toLowerCase() === needle ? 100 : x.name.toLowerCase().startsWith(needle) ? 80 : 50,
        providerRouteId: WEB_STYLES_ROUTE_ID,
        provenances: [this.provenance('proven', 'selector parsed from the stylesheet')],
      });
    };
    for (const [u, f] of this.index.entries()) {
      const sheets = f.kind === 'stylesheet' ? [f] : f.kind === 'html' ? f.inline : [];
      for (const s of sheets) {
        for (const c of s.classes) add(u, '.', c, s.isModule);
        for (const i of s.ids) add(u, '#', i, false);
      }
    }
    items.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return { items: items.slice(0, limit), truncated: this.index.truncated || items.length > limit };
  }
}
