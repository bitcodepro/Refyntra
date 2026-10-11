import * as fs from 'node:fs';
import type * as TS from 'typescript';
import type { DocumentSync, FileChange, FindParams, FindResult, InitializeResult, RelatedParams, RelatedResult, WorkerFindItem, WorkerRelation } from '../protocol';
import { WEB_WORKER_PROTOCOL_VERSION } from '../protocol';
import { type ScanResult, type ScannedProject, SOURCE_FILE, TEMPLATE_FILE, scanWorkspace } from '../node/scan';
import { BUNDLED_ANGULAR_LS_VERSION } from '../versions';
import { AngularAnalyzer, type TemplateSource, angularClassesIn, findComponents, findRoutes, templatesOf } from './angular';
import { NextIndex } from './next';
import { type CheckerContext, componentDeclOf, reactRelated } from './react';
import { WatchRegistry, createProjectService } from './tsHost';
import { canon, nodeLocation, offsetInText, pathOf, readText, symbolOf } from './util';

// The worker's analysis core: workspace scan, one TypeScript project service for React/Next.js and one per Angular
// project (with the bundled Angular language service). Unit tests drive this class in-process; main.ts wraps it.

export interface AnalyzerOptions {
  ts: typeof TS;
  /** The bundled @angular/language-service plugin factory; absent = Angular relations unavailable. */
  angularPlugin?: unknown;
  /** Upper bound of files kept open in the project services. */
  maxOpenFiles?: number;
}

interface OpenEntry {
  service: TS.server.ProjectService;
  text: string;
}

const isUnder = (file: string, dir: string) => file.toLowerCase().startsWith(`${dir.toLowerCase()}/`);

export class WebAnalyzer {
  private readonly ts: typeof TS;
  private readonly watches = new WatchRegistry();
  private roots: string[] = [];
  private scan: ScanResult = { projects: [], files: [], truncated: false };
  private plain: TS.server.ProjectService | undefined;
  private readonly angular = new Map<string, TS.server.ProjectService>();
  private readonly open = new Map<string, OpenEntry>();
  private readonly dirty = new Map<string, string>();
  private readonly next = new Map<string, NextIndex>();
  private readonly syntax = new Map<string, { stamp: string; sf: TS.SourceFile }>();
  private templates = new Map<string, TemplateSource[]>();
  private rescan = false;
  private readonly basis: string;

  constructor(private readonly o: AnalyzerOptions) {
    this.ts = o.ts;
    this.basis = `TypeScript ${o.ts.version} checker (Refyntra web worker)`;
  }

  initialize(roots: readonly string[]): InitializeResult {
    this.roots = roots.map(pathOf);
    this.doScan();
    return {
      protocolVersion: WEB_WORKER_PROTOCOL_VERSION,
      typescriptVersion: this.ts.version,
      ...(this.o.angularPlugin ? { angularLanguageServiceVersion: BUNDLED_ANGULAR_LS_VERSION } : {}),
      projects: this.scan.projects.map((p) => p.info),
      truncated: this.scan.truncated,
    };
  }

  private doScan(): void {
    for (const s of [this.plain, ...this.angular.values()]) disposeService(s);
    this.plain = undefined;
    this.angular.clear();
    this.open.clear();
    this.next.clear();
    this.templates.clear();
    const r = scanWorkspace(this.roots);
    this.scan = { projects: r.projects.map((p) => ({ dir: canon(p.dir), info: p.info })), files: r.files.map(canon), truncated: r.truncated };
    for (const p of this.scan.projects) {
      if (p.info.next) this.next.set(p.dir, new NextIndex({ dir: p.dir, major: p.info.next.major, version: p.info.next.version }, this.ts, () => this.filesOf(p), (f) => this.dirty.get(f)));
    }
    this.rescan = false;
  }

  private ensureScan(): void {
    if (this.rescan) this.doScan();
  }

  projects(): readonly ScannedProject[] {
    return this.scan.projects;
  }

  private projectFor(file: string): ScannedProject | undefined {
    let best: ScannedProject | undefined;
    for (const p of this.scan.projects) if (isUnder(file, p.dir) && (!best || p.dir.length > best.dir.length)) best = p;
    return best;
  }

  private filesOf(p: ScannedProject): string[] {
    const nested = this.scan.projects.filter((q) => q !== p && isUnder(q.dir, p.dir));
    return this.scan.files.filter((f) => isUnder(f, p.dir) && !nested.some((q) => isUnder(f, q.dir)));
  }

  textOf(file: string): string | undefined {
    return this.dirty.get(file) ?? readText(file);
  }

  // ------------------------------------------------------------ documents and files

  syncDocuments(docs: readonly DocumentSync[]): void {
    for (const d of docs) {
      const file = pathOf(d.uri);
      if (d.text === null) {
        this.dirty.delete(file);
        const entry = this.open.get(file);
        if (entry) {
          entry.service.closeClientFile(file);
          this.open.delete(file);
        }
      } else this.dirty.set(file, d.text);
      this.syntax.delete(file);
      this.templates.clear();
      this.next.forEach((n) => n.invalidate());
    }
  }

  filesChanged(changes: readonly FileChange[]): void {
    for (const c of changes) {
      const file = pathOf(c.uri);
      if (/\/package\.json$/i.test(file)) this.rescan = true;
      this.syntax.delete(file);
      this.templates.clear();
      if (c.type !== 'changed') {
        this.scan.files = this.scan.files.filter((f) => f !== file);
        if (c.type === 'created' && this.projectFor(file) && (SOURCE_FILE.test(file) || TEMPLATE_FILE.test(file)) && !file.endsWith('.d.ts')) this.scan.files.push(file);
        this.next.forEach((n) => n.invalidate());
      } else if (/\/route\.[jt]sx?$|\/pages\/api\//.test(file)) this.next.forEach((n) => n.invalidate());
      this.watches.fire(file, c.type === 'created' ? 0 : c.type === 'changed' ? 1 : 2);
      const entry = this.open.get(file);
      if (entry && !this.dirty.has(file)) {
        // An open (clean) file changed on disk: reopen it with the new text.
        entry.service.closeClientFile(file);
        this.open.delete(file);
      }
    }
  }

  // ------------------------------------------------------------ project services

  private plainService(): TS.server.ProjectService {
    if (!this.plain) this.plain = createProjectService({ ts: this.ts, watches: this.watches });
    return this.plain;
  }

  private angularService(p: ScannedProject): TS.server.ProjectService | undefined {
    if (!this.o.angularPlugin || !p.info.angular?.supported) return undefined;
    let s = this.angular.get(p.dir);
    if (!s) {
      const version = p.info.angular.source === 'installed' ? p.info.angular.version : `${p.info.angular.major}.0.0`;
      s = createProjectService({ ts: this.ts, watches: this.watches, angularPlugin: this.o.angularPlugin, angularConfig: { angularCoreVersion: version } });
      this.angular.set(p.dir, s);
    }
    return s;
  }

  /** Opens (or refreshes) a file in a project service; returns its language service and program. */
  private ensureOpen(service: TS.server.ProjectService, file: string): { ls: TS.LanguageService; program: TS.Program } | undefined {
    const text = this.textOf(file);
    if (text === undefined) return undefined;
    const entry = this.open.get(file);
    if (!entry || entry.service !== service || entry.text !== text) {
      if (entry) entry.service.closeClientFile(file);
      const kind = TEMPLATE_FILE.test(file) ? this.ts.ScriptKind.Unknown : undefined;
      service.openClientFile(file, text, kind);
      this.open.delete(file);
      this.open.set(file, { service, text });
      const max = this.o.maxOpenFiles ?? 64;
      for (const [f, e] of this.open) {
        if (this.open.size <= max) break;
        if (f === file || this.dirty.has(f)) continue;
        e.service.closeClientFile(f);
        this.open.delete(f);
      }
    }
    const project = service.getDefaultProjectForFile(this.ts.server.toNormalizedPath(file), true);
    if (!project) return undefined;
    project.updateGraph();
    const ls = project.getLanguageService();
    const program = ls.getProgram();
    return program ? { ls, program } : undefined;
  }

  private syntaxOf(file: string): TS.SourceFile | undefined {
    const dirty = this.dirty.get(file);
    let stamp: string;
    if (dirty !== undefined) stamp = `dirty:${dirty.length}:${dirty.slice(0, 64)}`;
    else {
      try {
        const st = fs.statSync(file);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        return undefined;
      }
    }
    const cached = this.syntax.get(file);
    if (cached && cached.stamp === stamp) return cached.sf;
    const text = this.textOf(file);
    if (text === undefined) return undefined;
    const sf = this.ts.createSourceFile(file, text, this.ts.ScriptTarget.Latest, true, /\.[jt]sx$/i.test(file) ? this.ts.ScriptKind.TSX : undefined);
    this.syntax.set(file, { stamp, sf });
    return sf;
  }

  private projectTemplates(p: ScannedProject): TemplateSource[] {
    const cached = this.templates.get(p.dir);
    if (cached) return cached;
    const out: TemplateSource[] = [];
    for (const f of this.filesOf(p)) {
      if (!/\.ts$/i.test(f)) continue;
      const sf = this.syntaxOf(f);
      if (!sf || !/@Component\s*\(/.test(sf.text)) continue;
      for (const a of angularClassesIn(this.ts, sf)) out.push(...templatesOf(this.ts, a, (x) => this.textOf(canon(x))));
    }
    this.templates.set(p.dir, out);
    return out;
  }

  // ------------------------------------------------------------ requests

  related(params: RelatedParams): RelatedResult {
    this.ensureScan();
    this.syncDocuments(params.documents);
    const file = pathOf(params.uri);
    const project = this.projectFor(file);
    if (!project) return { relations: [], notes: [] };
    const text = this.textOf(file);
    if (text === undefined) return { relations: [], notes: [] };
    const offset = offsetInText(text, params.position);
    const relations: WorkerRelation[] = [];
    const notes: string[] = [];
    let subject: string | undefined;
    // Unsaved files of this project are opened with their editor text, so references from them are seen.
    const dirtyHere = [...this.dirty.keys()].filter((f) => f !== file && this.projectFor(f) === project);
    const syncDirty = (service: TS.server.ProjectService, filter: (f: string) => boolean) => {
      for (const f of dirtyHere) if (filter(f)) this.ensureOpen(service, f);
    };
    const take = (r: { subject?: string; relations: WorkerRelation[] }) => {
      if (r.relations.length && !subject && r.subject) subject = r.subject;
      relations.push(...r.relations);
    };
    const info = project.info;
    if (info.angular) {
      if (!info.angular.supported) notes.push(`Angular: ${info.angular.reason}`);
      else if (!this.o.angularPlugin) notes.push('Angular: the bundled Angular language service is not available in this installation.');
      else {
        const service = this.angularService(project)!;
        syncDirty(service, () => true);
        const opened = this.ensureOpen(service, file);
        if (opened) {
          const analyzer = new AngularAnalyzer(
            { ts: this.ts, ls: opened.ls, program: opened.program, basis: `Angular language service ${BUNDLED_ANGULAR_LS_VERSION} (Angular ${info.angular.version})`, open: (f) => (this.ensureOpen(service, canon(f)) ? this.textOf(canon(f)) : undefined) },
            () => this.projectTemplates(project),
          );
          take(analyzer.related(file, offset));
        }
      }
    }
    if ((info.react || info.next) && SOURCE_FILE.test(file)) {
      syncDirty(this.plainService(), (f) => SOURCE_FILE.test(f));
      const opened = this.ensureOpen(this.plainService(), file);
      const sf = opened?.program.getSourceFile(file);
      if (opened && sf) {
        const ctx: CheckerContext = { ts: this.ts, ls: opened.ls, program: opened.program, checker: opened.program.getTypeChecker(), basis: this.basis };
        take(reactRelated(ctx, sf, offset));
      }
      const nextIndex = this.next.get(project.dir);
      if (nextIndex) take(nextIndex.related(sf ?? this.syntaxOf(file), file, text, offset));
      if (info.react && info.react.major !== undefined && info.react.major < 16) notes.push(`React ${info.react.version}: older than 16; function component and hook relations may be incomplete.`);
    }
    return { ...(subject ? { subject } : {}), relations, notes };
  }

  find(params: FindParams): FindResult {
    this.ensureScan();
    this.syncDocuments(params.documents);
    const q = params.text.trim().toLowerCase();
    const items: WorkerFindItem[] = [];
    const notes: string[] = [];
    for (const p of this.scan.projects) {
      const files = this.filesOf(p);
      if (params.kind === 'component') {
        if (p.info.react || p.info.next) {
          for (const f of files) {
            if (!/\.(tsx|jsx|js)$/i.test(f)) continue;
            const sf = this.syntaxOf(f);
            if (sf) items.push(...this.reactComponents(sf, q));
          }
        }
        if (p.info.angular?.supported) {
          for (const f of files) {
            if (!/\.ts$/i.test(f)) continue;
            const sf = this.syntaxOf(f);
            if (sf && /@Component\s*\(/.test(sf.text)) items.push(...findComponents(this.ts, sf, q, `Angular decorator (syntax), ${this.basis}`));
          }
        } else if (p.info.angular) notes.push(`Angular: ${p.info.angular.reason}`);
      } else {
        const n = this.next.get(p.dir);
        if (n) items.push(...n.findPages(q));
        if (p.info.angular?.supported) {
          for (const f of files) {
            if (!/\.ts$/i.test(f)) continue;
            const sf = this.syntaxOf(f);
            if (sf) items.push(...findRoutes(this.ts, sf, q, 'Angular route definition (syntax)'));
          }
        } else if (p.info.angular) notes.push(`Angular: ${p.info.angular.reason}`);
      }
      if (items.length > params.limit * 2) break;
    }
    if (this.scan.truncated) notes.push('The workspace scan stopped at its file limit; some projects or files are not included.');
    items.sort((a, b) => a.label.localeCompare(b.label) || a.detail.localeCompare(b.detail));
    return { items: items.slice(0, params.limit), truncated: items.length > params.limit, notes };
  }

  private reactComponents(sf: TS.SourceFile, q: string): WorkerFindItem[] {
    const ts = this.ts;
    const out: WorkerFindItem[] = [];
    const consider = (d: TS.Node) => {
      const c = componentDeclOf(ts, d);
      if (!c || (q && !c.name.toLowerCase().includes(q))) return;
      const loc = nodeLocation(sf, c.nameNode);
      out.push({ kind: 'component', label: c.name, description: `React ${c.style === 'class' ? 'class' : 'function'} component`, detail: sf.fileName.slice(sf.fileName.lastIndexOf('/') + 1), location: loc, symbol: symbolOf(c.name, c.style === 'class' ? 'class' : 'function', loc), confidence: 'likely', basis: 'React component shape (syntax: returns JSX or extends Component)' });
    };
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach(consider);
      else consider(st);
    }
    return out;
  }

  memory(): { heapUsedMB: number; rssMB: number } {
    const m = process.memoryUsage();
    return { heapUsedMB: Math.round(m.heapUsed / 1048576), rssMB: Math.round(m.rss / 1048576) };
  }

  dispose(): void {
    for (const s of [this.plain, ...this.angular.values()]) disposeService(s);
    this.plain = undefined;
    this.angular.clear();
    this.open.clear();
  }
}

function disposeService(s: TS.server.ProjectService | undefined): void {
  if (!s) return;
  try {
    for (const f of [...s.openFiles.keys()]) s.closeClientFile(f);
  } catch {
    // best effort
  }
}
