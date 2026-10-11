import * as path from 'node:path';
import type * as TS from 'typescript';
import type { WorkerEndpoint, WorkerFindItem, WorkerRelation } from '../protocol';
import { joinRoutePath } from '../nextRoutes';
import { norm } from './tsHost';
import { baseName, fileStart, isInNodeModules, nodeAt, nodeLocation, propertyName, propertyNamed, readText, relation, stringValue, symbolOf, textLocation } from './util';

// Angular relations through the bundled Angular language service (template ↔ class bindings are proven by the Angular
// compiler's template type-checker) plus checker references for DI providers, NgModule arrays and route definitions.

export interface AngularContext {
  ts: typeof TS;
  /** The TypeScript language service wrapped by the Angular plugin (template-aware definitions and references). */
  ls: TS.LanguageService;
  program: TS.Program;
  basis: string;
  /** Opens a file in the project service (templates need it) and returns its text. */
  open(file: string): string | undefined;
}

type DecoratorKind = 'Component' | 'Directive' | 'Injectable' | 'NgModule' | 'Pipe';

export interface AngularClass {
  kind: DecoratorKind;
  cls: TS.ClassDeclaration;
  name: string;
  meta?: TS.ObjectLiteralExpression;
  selector?: string;
}

export interface TemplateSource {
  owner: AngularClass;
  /** File the template text lives in (the .html file, or the .ts file of an inline template). */
  file: string;
  /** Offset of the template text inside `file`. */
  base: number;
  text: string;
  inline: boolean;
}

export function angularClassOf(ts: typeof TS, cls: TS.ClassDeclaration): AngularClass | undefined {
  if (!cls.name) return undefined;
  for (const d of ts.getDecorators(cls) ?? []) {
    if (!ts.isCallExpression(d.expression)) continue;
    const name = ts.isIdentifier(d.expression.expression) ? d.expression.expression.text : undefined;
    if (name !== 'Component' && name !== 'Directive' && name !== 'Injectable' && name !== 'NgModule' && name !== 'Pipe') continue;
    const meta = d.expression.arguments[0] && ts.isObjectLiteralExpression(d.expression.arguments[0]) ? d.expression.arguments[0] : undefined;
    const selector = meta ? stringValue(ts, propertyNamed(ts, meta, 'selector')?.initializer) : undefined;
    return { kind: name, cls, name: cls.name.text, ...(meta ? { meta } : {}), ...(selector ? { selector } : {}) };
  }
  return undefined;
}

export function angularClassesIn(ts: typeof TS, sf: TS.SourceFile): AngularClass[] {
  const out: AngularClass[] = [];
  for (const st of sf.statements) if (ts.isClassDeclaration(st)) {
    const a = angularClassOf(ts, st);
    if (a) out.push(a);
  }
  return out;
}

/** The inline template literal of a component (template: `...`). */
function inlineTemplate(ts: typeof TS, a: AngularClass): TS.StringLiteral | TS.NoSubstitutionTemplateLiteral | undefined {
  const init = a.meta ? propertyNamed(ts, a.meta, 'template')?.initializer : undefined;
  return init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) ? init : undefined;
}

export function templatesOf(ts: typeof TS, a: AngularClass, read: (file: string) => string | undefined): TemplateSource[] {
  if (a.kind !== 'Component' || !a.meta) return [];
  const sf = a.cls.getSourceFile();
  const inline = inlineTemplate(ts, a);
  if (inline) return [{ owner: a, file: norm(sf.fileName), base: inline.getStart(sf) + 1, text: inline.text, inline: true }];
  const url = stringValue(ts, propertyNamed(ts, a.meta, 'templateUrl')?.initializer);
  if (!url) return [];
  const file = norm(path.resolve(path.dirname(sf.fileName), url));
  const text = read(file);
  return text === undefined ? [] : [{ owner: a, file, base: 0, text, inline: false }];
}

/** Element names of a selector ("app-card, [appX]" → ["app-card"]). Attribute and class selectors are not searched. */
export function elementSelectors(selector: string | undefined): string[] {
  if (!selector) return [];
  return selector
    .split(',')
    .map((s) => s.trim())
    .map((s) => /^([a-zA-Z][\w-]*)/.exec(s)?.[1])
    .filter((s): s is string => !!s);
}

function memberDecorator(ts: typeof TS, m: TS.ClassElement): 'input' | 'output' | undefined {
  if (!ts.isPropertyDeclaration(m) && !ts.isSetAccessorDeclaration(m) && !ts.isGetAccessorDeclaration(m)) return undefined;
  for (const d of ts.canHaveDecorators(m) ? (ts.getDecorators(m) ?? []) : []) {
    const callee = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    if (ts.isIdentifier(callee) && callee.text === 'Input') return 'input';
    if (ts.isIdentifier(callee) && callee.text === 'Output') return 'output';
  }
  if (ts.isPropertyDeclaration(m) && m.initializer && ts.isCallExpression(m.initializer)) {
    const c = m.initializer.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : undefined;
    if (name === 'input' || name === 'model') return 'input';
    if (name === 'output' || name === 'outputFromObservable') return 'output';
  }
  return undefined;
}

function isInside(range: { start: number; end: number }, pos: number): boolean {
  return pos >= range.start && pos <= range.end;
}

const ROUTE_LIMITATION = 'Route definitions are read from the source: guards, resolvers, matchers, redirects and routes added at run time are not evaluated.';

export class AngularAnalyzer {
  constructor(
    private readonly c: AngularContext,
    /** Angular classes and templates of the project (syntactic, cached by the caller). */
    private readonly projectTemplates: () => TemplateSource[],
  ) {}

  private sf(file: string): TS.SourceFile | undefined {
    return this.c.program.getSourceFile(file);
  }

  /** Relations at a position of a .ts or .html file of an Angular project. */
  related(file: string, offset: number): { subject?: string; relations: WorkerRelation[] } {
    const { ts } = this.c;
    if (/\.html?$/i.test(file)) return this.templateRelated(file, offset, true);
    const sf = this.sf(file);
    if (!sf) return { relations: [] };
    const node = nodeAt(ts, sf, offset);
    let cls: TS.Node | undefined = node;
    while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
    const a = cls ? angularClassOf(ts, cls as TS.ClassDeclaration) : undefined;
    if (a) {
      const inline = inlineTemplate(ts, a);
      if (inline && isInside({ start: inline.getStart(sf), end: inline.getEnd() }, offset)) return this.templateRelated(file, offset, false);
      for (const m of a.cls.members) {
        const io = memberDecorator(ts, m);
        if (io && m.name && isInside({ start: m.getStart(sf), end: m.getEnd() }, offset)) return { subject: `${a.name}.${m.name.getText(sf)}`, relations: this.memberRelations(a, m, io) };
      }
      return { subject: a.name, relations: this.classRelations(a) };
    }
    const route = this.routeAt(node);
    if (route) return { subject: route.endpoint?.route, relations: [route] };
    return { relations: [] };
  }

  private templateRelated(file: string, offset: number, isHtml: boolean): { subject?: string; relations: WorkerRelation[] } {
    const { ls, basis } = this.c;
    const out: WorkerRelation[] = [];
    if (isHtml) {
      for (const loc of (ls as TS.LanguageService & { getComponentLocationsForTemplate?(f: string): readonly TS.DocumentSpan[] }).getComponentLocationsForTemplate?.(file) ?? []) {
        const sf = this.sf(loc.fileName);
        if (!sf) continue;
        const n = nodeAt(this.c.ts, sf, loc.textSpan.start);
        const name = n.getText(sf);
        out.push(relation({ kind: 'angular.templateOwner', group: 'declarations', label: `${name} (component of this template)`, location: nodeLocation(sf, n), symbol: symbolOf(name, 'class', nodeLocation(sf, n)), confidence: 'proven', basis }));
      }
    }
    const def = ls.getDefinitionAndBoundSpan(file, offset);
    let subject: string | undefined;
    for (const d of def?.definitions ?? []) {
      if (isInNodeModules(d.fileName) || /\/lib\.[\w.]*\.d\.ts$/.test(norm(d.fileName))) continue;
      const sf = this.sf(d.fileName);
      if (!sf) continue;
      const n = nodeAt(this.c.ts, sf, d.textSpan.start);
      const loc = nodeLocation(sf, n);
      let kind = 'angular.templateSymbol';
      let label = `${d.name} (${d.kind})`;
      let cls: TS.Node | undefined = n;
      while (cls && !this.c.ts.isClassDeclaration(cls)) cls = cls.parent;
      const a = cls ? angularClassOf(this.c.ts, cls as TS.ClassDeclaration) : undefined;
      if (a && n.parent === a.cls) {
        kind = 'angular.selectorTarget';
        label = `${a.name} (${a.kind === 'Component' ? 'component' : a.kind.toLowerCase()}${a.selector ? ` ${a.selector}` : ''})`;
      } else if (a && n.parent && this.c.ts.isClassElement(n.parent)) {
        const io = memberDecorator(this.c.ts, n.parent);
        if (io) {
          kind = io === 'input' ? 'angular.input' : 'angular.output';
          label = `${a.name}.${d.name} (${io})`;
        } else label = `${a.name}.${d.name}`;
      }
      subject = subject ?? d.name;
      out.push(relation({ kind, group: 'declarations', label, location: loc, symbol: symbolOf(d.name, d.kind === 'class' ? 'class' : d.kind === 'method' ? 'method' : 'property', loc, a?.name), confidence: 'proven', basis, evidence: [{ description: 'Resolved by the Angular language service (template type-checking).' }] }));
    }
    return { ...(subject ? { subject } : {}), relations: out };
  }

  private bindingRelations(file: string, pos: number, name: string): WorkerRelation[] {
    const out: WorkerRelation[] = [];
    const templates = this.projectTemplates();
    for (const r of this.c.ls.getReferencesAtPosition(file, pos) ?? []) {
      const f = norm(r.fileName);
      const inTemplate = /\.html?$/i.test(f) || templates.some((t) => t.inline && t.file === f && isInside({ start: t.base, end: t.base + t.text.length }, r.textSpan.start));
      if (!inTemplate) continue;
      const text = this.c.open(f) ?? '';
      const loc = textLocation(f, text, r.textSpan.start, r.textSpan.start + r.textSpan.length);
      out.push(relation({ kind: 'angular.binding', group: 'references', label: `${name} in template ${baseName(f)}:${loc.range.start.line + 1}`, location: loc, confidence: 'proven', basis: this.c.basis, evidence: [{ description: 'Template binding resolved by the Angular language service.', location: loc }] }));
    }
    return out;
  }

  private memberRelations(a: AngularClass, m: TS.ClassElement, io: 'input' | 'output'): WorkerRelation[] {
    const sf = a.cls.getSourceFile();
    const name = m.name!.getText(sf);
    const loc = nodeLocation(sf, m.name!);
    return [
      relation({ kind: io === 'input' ? 'angular.input' : 'angular.output', group: 'declarations', label: `${a.name}.${name} (${io})`, location: loc, symbol: symbolOf(name, 'property', loc, a.name), confidence: 'proven', basis: this.c.basis }),
      ...this.bindingRelations(sf.fileName, m.name!.getStart(sf), name),
    ];
  }

  classRelations(a: AngularClass): WorkerRelation[] {
    const { ts, basis } = this.c;
    const sf = a.cls.getSourceFile();
    const loc = nodeLocation(sf, a.cls.name!);
    const out: WorkerRelation[] = [relation({ kind: 'angular.class', group: 'declarations', label: `${a.name} (${a.kind === 'Component' ? 'component' : a.kind}${a.selector ? ` ${a.selector}` : ''})`, location: loc, symbol: symbolOf(a.name, 'class', loc), confidence: 'proven', basis })];
    if (a.meta && a.kind === 'Component') {
      const inline = inlineTemplate(ts, a);
      const url = propertyNamed(ts, a.meta, 'templateUrl');
      if (inline) out.push(relation({ kind: 'angular.template', group: 'declarations', label: 'Inline template', location: nodeLocation(sf, inline), confidence: 'proven', basis }));
      else if (url) {
        const v = stringValue(ts, url.initializer);
        const target = v ? norm(path.resolve(path.dirname(sf.fileName), v)) : undefined;
        const exists = target !== undefined && readText(target) !== undefined;
        out.push(relation({ kind: 'angular.template', group: 'declarations', label: `Template ${v ?? '(not a literal)'}`, location: exists ? fileStart(target!) : nodeLocation(sf, url), confidence: exists ? 'proven' : 'heuristic', basis, limitations: exists ? [] : ['The template file was not found.'] }));
      }
      // styleUrl(s) and inline styles: the HTML/CSS route (web.styles) owns stylesheet links; not duplicated here.
    }
    for (const m of a.cls.members) {
      const io = memberDecorator(ts, m);
      if (!io || !m.name) continue;
      const name = m.name.getText(sf);
      const mloc = nodeLocation(sf, m.name);
      const bindings = this.bindingRelations(sf.fileName, m.name.getStart(sf), name);
      out.push(relation({ kind: io === 'input' ? 'angular.input' : 'angular.output', group: 'declarations', label: `${name} (${io}, ${bindings.length} template use${bindings.length === 1 ? '' : 's'})`, location: mloc, symbol: symbolOf(name, 'property', mloc, a.name), confidence: 'proven', basis }));
    }
    out.push(...this.selectorUsages(a));
    out.push(...this.referenceRelations(a));
    if (a.kind === 'Injectable' && a.meta) {
      const p = propertyNamed(ts, a.meta, 'providedIn');
      if (p) out.push(relation({ kind: 'angular.providedIn', group: 'registrations', label: `providedIn: ${p.initializer.getText(sf)}`, location: nodeLocation(sf, p), confidence: 'proven', basis, evidence: [{ description: '@Injectable({ providedIn }) registers the service with that injector.' }] }));
    }
    return out;
  }

  /** <app-x> elements in every template of the project, each confirmed by the Angular language service. */
  private selectorUsages(a: AngularClass): WorkerRelation[] {
    const names = elementSelectors(a.selector);
    if (a.kind !== 'Component' && a.kind !== 'Directive') return [];
    const out: WorkerRelation[] = [];
    const sf = a.cls.getSourceFile();
    const nameStart = a.cls.name!.getStart(sf);
    for (const t of this.projectTemplates()) {
      for (const sel of names) {
        const re = new RegExp(`<${sel.replace(/[-]/g, '\\-')}(?=[\\s>/])`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(t.text)) !== null) {
          const pos = t.base + m.index + 1;
          this.c.open(t.file);
          const defs = this.c.ls.getDefinitionAndBoundSpan(t.file, pos)?.definitions ?? [];
          if (!defs.some((d) => norm(d.fileName) === norm(sf.fileName) && d.textSpan.start === nameStart)) continue;
          const text = t.inline ? (this.c.open(t.file) ?? '') : t.text;
          const loc = textLocation(t.file, text, pos, pos + sel.length);
          out.push(relation({ kind: 'angular.selectorUsage', group: 'references', label: `<${sel}> in ${t.owner.name} (${baseName(t.file)}:${loc.range.start.line + 1})`, location: loc, confidence: 'proven', basis: this.c.basis, evidence: [{ description: `The Angular language service resolves this element to ${a.name}.`, location: loc }] }));
        }
      }
    }
    return out;
  }

  /** Checker references of the class inside NgModule arrays, providers, inject()/constructor parameters and routes. */
  private referenceRelations(a: AngularClass): WorkerRelation[] {
    const { ts, ls, basis } = this.c;
    const sf = a.cls.getSourceFile();
    const out: WorkerRelation[] = [];
    for (const r of ls.getReferencesAtPosition(sf.fileName, a.cls.name!.getStart(sf)) ?? []) {
      const rsf = this.sf(r.fileName);
      if (!rsf || r.isWriteAccess) continue;
      const n = nodeAt(ts, rsf, r.textSpan.start);
      if (n === a.cls.name) continue;
      const loc = nodeLocation(rsf, n);
      const where = `${baseName(norm(rsf.fileName))}:${loc.range.start.line + 1}`;
      // Arrays of decorators / configs: declarations, imports, exports, providers, viewProviders, bootstrap.
      let arr: TS.Node | undefined = n.parent;
      for (let i = 0; i < 4 && arr && !ts.isArrayLiteralExpression(arr); i++) arr = arr.parent;
      const prop = arr && ts.isArrayLiteralExpression(arr) && arr.parent && ts.isPropertyAssignment(arr.parent) ? propertyName(ts, arr.parent) : undefined;
      if (prop && arr) {
        const owner = ownerName(ts, arr.parent.parent);
        if (prop === 'providers' || prop === 'viewProviders') {
          out.push(relation({ kind: 'angular.provider', group: 'registrations', label: `${prop} of ${owner} (${where})`, location: loc, confidence: 'proven', basis, evidence: [{ description: `${a.name} is listed in ${prop}.`, location: loc }] }));
          continue;
        }
        if (prop === 'declarations' || prop === 'imports' || prop === 'exports' || prop === 'bootstrap') {
          const verb = { declarations: 'declared in', imports: 'imported by', exports: 'exported by', bootstrap: 'bootstrapped by' }[prop];
          out.push(relation({ kind: 'angular.ngModule', group: 'registrations', label: `${verb} ${owner} (${where})`, location: loc, confidence: 'proven', basis }));
          continue;
        }
      }
      const p = n.parent;
      if (p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'inject' && p.arguments[0] === n) {
        out.push(relation({ kind: 'angular.injection', group: 'references', label: `inject(${a.name}) in ${where}`, location: nodeLocation(rsf, p), confidence: 'proven', basis }));
        continue;
      }
      if (p && ts.isTypeReferenceNode(p) && p.parent && ts.isParameter(p.parent) && p.parent.parent && ts.isConstructorDeclaration(p.parent.parent)) {
        out.push(relation({ kind: 'angular.injection', group: 'references', label: `constructor parameter ${p.parent.name.getText(rsf)} in ${where}`, location: nodeLocation(rsf, p.parent), confidence: 'proven', basis }));
        continue;
      }
      const route = this.routeAt(n);
      if (route) out.push(route);
    }
    return out;
  }

  /** The route definition (object literal with `path`) around a node: component:, loadComponent: or the object itself. */
  routeAt(node: TS.Node): WorkerRelation | undefined {
    const { ts } = this.c;
    let n: TS.Node | undefined = node;
    let lazy = false;
    for (let i = 0; i < 12 && n; i++, n = n.parent) {
      if (ts.isPropertyAssignment(n) && (propertyName(ts, n) === 'loadComponent' || propertyName(ts, n) === 'loadChildren')) lazy = true;
      if (ts.isObjectLiteralExpression(n) && propertyNamed(ts, n, 'path') && n.parent && ts.isArrayLiteralExpression(n.parent)) return this.routeRelation(n, lazy);
    }
    return undefined;
  }

  private routeRelation(obj: TS.ObjectLiteralExpression, lazy: boolean): WorkerRelation {
    const { ts } = this.c;
    const sf = obj.getSourceFile();
    const route = routePath(ts, obj);
    const loc = nodeLocation(sf, obj);
    const target = routeTarget(ts, obj, sf);
    const endpoint: WorkerEndpoint = { kind: 'angular-route', route, routeIsDynamic: /(^|\/)(:|\*\*)/.test(route), httpMethods: [], location: loc };
    return relation({
      kind: 'angular.route',
      group: 'endpoints',
      label: `${route}${target ? ` → ${target}` : ''}${lazy ? ' (lazy)' : ''}`,
      location: loc,
      endpoint,
      confidence: 'likely',
      basis: `${this.c.basis}; route definition in ${baseName(norm(sf.fileName))}`,
      evidence: [{ description: 'Route object in a route array (path joined with its parent routes).', location: loc }],
      limitations: [ROUTE_LIMITATION, ...(lazy ? ['Lazy route: the loaded module or component is resolved from the import expression only.'] : []), 'Prefixes added by loadChildren from another file are not applied.'],
    });
  }
}

function ownerName(ts: typeof TS, n: TS.Node | undefined): string {
  for (let i = 0; i < 8 && n; i++, n = n.parent) {
    if (ts.isClassDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !(n.parent && ts.isDecorator(n.parent))) return `${n.expression.text}(…)`;
  }
  return 'a configuration';
}

/** Full path of a route object: its `path` joined with the paths of the parent routes (children arrays). */
export function routePath(ts: typeof TS, obj: TS.ObjectLiteralExpression): string {
  const parts: string[] = [];
  let cur: TS.Node | undefined = obj;
  while (cur && ts.isObjectLiteralExpression(cur)) {
    parts.unshift(stringValue(ts, propertyNamed(ts, cur, 'path')?.initializer) ?? '');
    const arr: TS.Node | undefined = cur.parent;
    const prop: TS.Node | undefined = arr && ts.isArrayLiteralExpression(arr) ? arr.parent : undefined;
    if (!prop || !ts.isPropertyAssignment(prop) || propertyName(ts, prop) !== 'children') break;
    cur = prop.parent;
  }
  return joinRoutePath(parts);
}

function routeTarget(ts: typeof TS, obj: TS.ObjectLiteralExpression, sf: TS.SourceFile): string | undefined {
  const comp = propertyNamed(ts, obj, 'component');
  if (comp) return comp.initializer.getText(sf);
  for (const k of ['loadComponent', 'loadChildren']) {
    const p = propertyNamed(ts, obj, k);
    if (!p) continue;
    const m = /\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.(\w+)\s*\)/.exec(p.initializer.getText(sf));
    const imp = /import\(\s*['"]([^'"]+)['"]\s*\)/.exec(p.initializer.getText(sf));
    return `${m?.[1] ?? 'default export'}${imp ? ` from ${imp[1]}` : ''}`;
  }
  const redirect = stringValue(ts, propertyNamed(ts, obj, 'redirectTo')?.initializer);
  return redirect !== undefined ? `redirect to ${redirect}` : undefined;
}

/** Find: Angular components (component:) of one file, syntactically. */
export function findComponents(ts: typeof TS, sf: TS.SourceFile, q: string, basis: string): WorkerFindItem[] {
  return angularClassesIn(ts, sf)
    .filter((a) => a.kind === 'Component' && (!q || a.name.toLowerCase().includes(q) || (a.selector ?? '').toLowerCase().includes(q)))
    .map((a) => {
      const loc = nodeLocation(sf, a.cls.name!);
      return { kind: 'component' as const, label: a.name, description: `Angular component${a.selector ? ` <${a.selector}>` : ''}`, detail: baseName(norm(sf.fileName)), location: loc, symbol: symbolOf(a.name, 'class', loc), confidence: 'proven' as const, basis };
    });
}

/** Find: Angular route definitions (page:) of one file, syntactically. */
export function findRoutes(ts: typeof TS, sf: TS.SourceFile, q: string, basis: string): WorkerFindItem[] {
  if (!/\bpath\s*:/.test(sf.text)) return [];
  const out: WorkerFindItem[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isObjectLiteralExpression(n) && n.parent && ts.isArrayLiteralExpression(n.parent) && propertyNamed(ts, n, 'path') && ['component', 'loadComponent', 'loadChildren', 'children', 'redirectTo'].some((k) => propertyNamed(ts, n, k))) {
      const route = routePath(ts, n);
      const target = routeTarget(ts, n, sf);
      if (!q || route.toLowerCase().includes(q) || (target ?? '').toLowerCase().includes(q)) {
        const loc = nodeLocation(sf, n);
        out.push({ kind: 'page', label: route, description: `Angular route${target ? ` → ${target}` : ''}`, detail: baseName(norm(sf.fileName)), location: loc, endpoint: { kind: 'angular-route', route, routeIsDynamic: /(^|\/)(:|\*\*)/.test(route), httpMethods: [], location: loc }, confidence: 'likely', basis });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

