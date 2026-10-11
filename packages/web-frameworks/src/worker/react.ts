import type * as TS from 'typescript';
import type { WorkerRelation } from '../protocol';
import { declName, isInNodeModules, nodeAt, nodeLocation, relation, symbolOf } from './util';

// React relations proven by the TypeScript checker: a JSX tag resolves to the component symbol, an attribute
// resolves to a member of the props type. Unused or missing props are information only (never diagnostics).
// Context providers/consumers are "likely": the checker proves the context object, not which provider is in scope.

export interface CheckerContext {
  ts: typeof TS;
  ls: TS.LanguageService;
  program: TS.Program;
  checker: TS.TypeChecker;
  basis: string;
}

const MAX_REFS = 500;

export interface ComponentDecl {
  name: string;
  nameNode: TS.Node;
  decl: TS.Node;
  style: 'function' | 'class' | 'wrapped';
}

function containsJsx(ts: typeof TS, node: TS.Node): boolean {
  let found = false;
  const visit = (n: TS.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

const WRAPPERS = new Set(['memo', 'forwardRef', 'observer']);

function calleeName(ts: typeof TS, e: TS.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Syntactic component shape (used by Find and, together with the checker, by Related). */
export function componentDeclOf(ts: typeof TS, decl: TS.Node): ComponentDecl | undefined {
  const capital = (n: string) => /^[A-Z]/.test(n);
  if (ts.isFunctionDeclaration(decl) && decl.name && capital(decl.name.text) && decl.body && containsJsx(ts, decl.body)) return { name: decl.name.text, nameNode: decl.name, decl, style: 'function' };
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && capital(decl.name.text) && decl.initializer) {
    const init = decl.initializer;
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && containsJsx(ts, init)) return { name: decl.name.text, nameNode: decl.name, decl, style: 'function' };
    if (ts.isCallExpression(init) && WRAPPERS.has(calleeName(ts, init.expression) ?? '') && init.arguments[0] && containsJsx(ts, init.arguments[0])) return { name: decl.name.text, nameNode: decl.name, decl, style: 'wrapped' };
  }
  if (ts.isClassDeclaration(decl) && decl.name && capital(decl.name.text)) {
    const ext = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (ext && /(^|\.)(Pure)?Component$/.test(ext.expression.getText())) return { name: decl.name.text, nameNode: decl.name, decl, style: 'class' };
  }
  return undefined;
}

export function resolveSymbol(c: CheckerContext, node: TS.Node): TS.Symbol | undefined {
  let s = c.checker.getSymbolAtLocation(node);
  if (s && s.flags & c.ts.SymbolFlags.Alias) s = c.checker.getAliasedSymbol(s);
  return s;
}

function propsTypeOf(c: CheckerContext, comp: ComponentDecl): TS.Type | undefined {
  const { ts, checker } = c;
  if (comp.style === 'class' && ts.isClassDeclaration(comp.decl) && comp.decl.name) {
    const sym = checker.getSymbolAtLocation(comp.decl.name);
    if (!sym) return undefined;
    const props = checker.getDeclaredTypeOfSymbol(sym).getProperty('props');
    return props ? checker.getTypeOfSymbol(props) : undefined;
  }
  let fn: TS.SignatureDeclaration | undefined;
  if (ts.isFunctionDeclaration(comp.decl)) fn = comp.decl;
  else if (ts.isVariableDeclaration(comp.decl) && comp.decl.initializer) {
    const init = comp.decl.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
    else if (ts.isCallExpression(init)) {
      const a = init.arguments[0];
      if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) fn = a;
    }
  }
  const p = fn?.parameters[0];
  return p ? checker.getTypeAtLocation(p) : undefined;
}

interface PropMember {
  name: string;
  symbol: TS.Symbol;
  optional: boolean;
  type: string;
  decl?: TS.Node;
}

function propMembers(c: CheckerContext, comp: ComponentDecl): PropMember[] {
  const t = propsTypeOf(c, comp);
  if (!t || t.flags & (c.ts.TypeFlags.Any | c.ts.TypeFlags.Unknown)) return [];
  return c.checker.getPropertiesOfType(t).map((s) => {
    const decl = s.valueDeclaration ?? s.declarations?.[0];
    return { name: s.name, symbol: s, optional: !!(s.flags & c.ts.SymbolFlags.Optional), type: c.checker.typeToString(c.checker.getTypeOfSymbol(s)), ...(decl ? { decl } : {}) };
  });
}

type JsxTagElement = TS.JsxOpeningElement | TS.JsxSelfClosingElement;

/** The JSX opening/self-closing element whose tag name contains `node`. */
function jsxTagOf(ts: typeof TS, node: TS.Node, includeClosing = false): JsxTagElement | undefined {
  let n: TS.Node = node;
  while (n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isIdentifier(n.parent))) n = n.parent;
  const p = n.parent;
  if (p && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === n) return p;
  if (includeClosing && p && ts.isJsxClosingElement(p) && p.tagName === n && ts.isJsxElement(p.parent)) return p.parent.openingElement;
  return undefined;
}

interface Usage {
  element: JsxTagElement;
  sf: TS.SourceFile;
  attributes: string[];
  spread: boolean;
  hasChildren: boolean;
}

function usageOf(ts: typeof TS, element: JsxTagElement, sf: TS.SourceFile): Usage {
  const attributes: string[] = [];
  let spread = false;
  for (const a of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) spread = true;
    else attributes.push(a.name.getText(sf));
  }
  const hasChildren = ts.isJsxOpeningElement(element) && ts.isJsxElement(element.parent) && element.parent.children.some((ch) => !(ts.isJsxText(ch) && ch.containsOnlyTriviaWhiteSpaces));
  return { element, sf, attributes, spread, hasChildren };
}

/** References of the declaration at (file, pos), as nodes. */
function referenceNodes(c: CheckerContext, file: string, pos: number): { node: TS.Node; sf: TS.SourceFile; isDefinition: boolean }[] {
  const out: { node: TS.Node; sf: TS.SourceFile; isDefinition: boolean }[] = [];
  for (const entry of c.ls.findReferences(file, pos) ?? []) {
    for (const r of entry.references) {
      if (out.length >= MAX_REFS) return out;
      const sf = c.program.getSourceFile(r.fileName);
      if (!sf) continue;
      out.push({ node: nodeAt(c.ts, sf, r.textSpan.start), sf, isDefinition: !!r.isDefinition });
    }
  }
  return out;
}

function jsxUsages(c: CheckerContext, comp: ComponentDecl): Usage[] {
  const sf = comp.decl.getSourceFile();
  const usages: Usage[] = [];
  for (const r of referenceNodes(c, sf.fileName, comp.nameNode.getStart(sf))) {
    if (r.isDefinition) continue;
    const el = jsxTagOf(c.ts, r.node);
    // `<Theme.Provider>` refers to Theme, but the element is the Provider, not a usage of Theme.
    if (el && (el.tagName === r.node || (c.ts.isPropertyAccessExpression(el.tagName) && el.tagName.name === r.node))) usages.push(usageOf(c.ts, el, r.sf));
  }
  return usages;
}

const describeStyle = (s: ComponentDecl['style']) => (s === 'class' ? 'class component' : s === 'wrapped' ? 'wrapped function component' : 'function component');

function componentRelation(c: CheckerContext, comp: ComponentDecl, limitations: string[] = []): WorkerRelation {
  const sf = comp.decl.getSourceFile();
  const loc = nodeLocation(sf, comp.nameNode);
  return relation({
    kind: 'react.component',
    group: 'declarations',
    label: `${comp.name} (${describeStyle(comp.style)})`,
    location: loc,
    symbol: symbolOf(comp.name, comp.style === 'class' ? 'class' : 'function', loc),
    confidence: 'proven',
    basis: c.basis,
    evidence: [{ description: 'Declared as a React component: it returns JSX (or extends Component).', location: loc }],
    limitations,
  });
}

function missingRequired(members: PropMember[], u: Usage): string[] {
  if (u.spread) return [];
  return members.filter((m) => !m.optional && !u.attributes.includes(m.name) && !(m.name === 'children' && u.hasChildren) && m.name !== 'key' && m.name !== 'ref').map((m) => m.name);
}

function usageRelation(c: CheckerContext, comp: ComponentDecl, members: PropMember[], u: Usage): WorkerRelation {
  const loc = nodeLocation(u.sf, u.element.tagName);
  const limitations: string[] = [];
  const missing = missingRequired(members, u);
  if (missing.length) limitations.push(`Information: required props not passed here: ${missing.join(', ')}.`);
  if (u.spread) limitations.push('Spread attributes: which props are passed is not fully known.');
  return relation({
    kind: 'react.usage',
    group: 'references',
    label: `<${u.element.tagName.getText(u.sf)}> in ${u.sf.fileName.slice(u.sf.fileName.lastIndexOf('/') + 1)}`,
    location: loc,
    confidence: 'proven',
    basis: c.basis,
    evidence: [{ description: `The TypeScript checker resolves this JSX tag to ${comp.name}.`, location: loc }],
    limitations,
  });
}

function propRelation(c: CheckerContext, m: PropMember, usages: Usage[] | undefined, comp: ComponentDecl): WorkerRelation | undefined {
  if (!m.decl || isInNodeModules(m.decl.getSourceFile().fileName)) return undefined;
  const sf = m.decl.getSourceFile();
  const nameNode = declName(c.ts, m.decl) ?? m.decl;
  const loc = nodeLocation(sf, nameNode);
  const limitations: string[] = [];
  if (usages && usages.length > 0 && !usages.some((u) => u.spread || u.attributes.includes(m.name) || (m.name === 'children' && u.hasChildren))) {
    limitations.push(`Information: none of the ${usages.length} usages found passes this prop.`);
  }
  return relation({
    kind: 'react.prop',
    group: 'declarations',
    label: `${m.name}${m.optional ? '?' : ''}: ${m.type}`,
    location: loc,
    symbol: symbolOf(m.name, 'property', loc, comp.name),
    confidence: 'proven',
    basis: c.basis,
    evidence: [{ description: `Member of the props type of ${comp.name} (${m.optional ? 'optional' : 'required'}).`, location: loc }],
    limitations,
  });
}

/** Component declaration of a symbol (alias resolved), when the symbol is a component in project source. */
function componentOfSymbol(c: CheckerContext, sym: TS.Symbol | undefined): ComponentDecl | undefined {
  for (const d of sym?.declarations ?? []) {
    if (isInNodeModules(d.getSourceFile().fileName)) continue;
    const comp = componentDeclOf(c.ts, d);
    if (comp) return comp;
  }
  return undefined;
}

function isHookName(n: string): boolean {
  return /^use[A-Z0-9]/.test(n);
}

function hookDeclOf(c: CheckerContext, sym: TS.Symbol | undefined): { name: string; nameNode: TS.Node } | undefined {
  const { ts } = c;
  for (const d of sym?.declarations ?? []) {
    if (isInNodeModules(d.getSourceFile().fileName) || d.getSourceFile().isDeclarationFile) continue;
    if (ts.isFunctionDeclaration(d) && d.name && isHookName(d.name.text)) return { name: d.name.text, nameNode: d.name };
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && isHookName(d.name.text) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return { name: d.name.text, nameNode: d.name };
  }
  return undefined;
}

function contextDeclOf(c: CheckerContext, sym: TS.Symbol | undefined): { name: string; nameNode: TS.Node } | undefined {
  const { ts } = c;
  for (const d of sym?.declarations ?? []) {
    if (isInNodeModules(d.getSourceFile().fileName)) continue;
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && ts.isCallExpression(d.initializer) && calleeName(ts, d.initializer.expression) === 'createContext') return { name: d.name.text, nameNode: d.name };
  }
  return undefined;
}

function componentRelations(c: CheckerContext, comp: ComponentDecl): WorkerRelation[] {
  const members = propMembers(c, comp);
  const usages = jsxUsages(c, comp);
  const out = [componentRelation(c, comp)];
  for (const u of usages) out.push(usageRelation(c, comp, members, u));
  for (const m of members) {
    const r = propRelation(c, m, usages, comp);
    if (r) out.push(r);
  }
  return out;
}

function jsxElementRelations(c: CheckerContext, el: JsxTagElement): WorkerRelation[] {
  const { ts } = c;
  const tag = ts.isPropertyAccessExpression(el.tagName) ? el.tagName.expression : el.tagName;
  const sym = resolveSymbol(c, ts.isPropertyAccessExpression(el.tagName) ? el.tagName.name : el.tagName);
  const ctx = contextDeclOf(c, resolveSymbol(c, tag));
  if (ctx) return contextRelations(c, ctx);
  const comp = componentOfSymbol(c, sym);
  if (!comp) return [];
  const members = propMembers(c, comp);
  const u = usageOf(ts, el, el.getSourceFile());
  const missing = missingRequired(members, u);
  const limitations = missing.length ? [`Information: required props not passed here: ${missing.join(', ')}.`] : [];
  const out = [componentRelation(c, comp, limitations)];
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const m = members.find((x) => x.name === a.name.getText());
    const r = m && propRelation(c, m, undefined, comp);
    if (r) out.push({ ...r, evidence: [...r.evidence, { description: `Passed here as ${a.name.getText()}=…`, location: nodeLocation(el.getSourceFile(), a) }] });
  }
  return out;
}

function propUseRelations(c: CheckerContext, decl: TS.Node, name: string): WorkerRelation[] {
  const sf = decl.getSourceFile();
  const nameNode = declName(c.ts, decl) ?? decl;
  const out: WorkerRelation[] = [];
  for (const r of referenceNodes(c, sf.fileName, nameNode.getStart(sf))) {
    if (r.isDefinition || !r.node.parent || !c.ts.isJsxAttribute(r.node.parent)) continue;
    const el = r.node.parent.parent.parent as JsxTagElement;
    const loc = nodeLocation(r.sf, r.node.parent);
    out.push(
      relation({
        kind: 'react.propUse',
        group: 'references',
        label: `<${el.tagName.getText(r.sf)} ${name}=…> in ${r.sf.fileName.slice(r.sf.fileName.lastIndexOf('/') + 1)}`,
        location: loc,
        confidence: 'proven',
        basis: c.basis,
        evidence: [{ description: `The TypeScript checker resolves this attribute to the prop ${name}.`, location: loc }],
      }),
    );
  }
  return out;
}

function hookRelations(c: CheckerContext, hook: { name: string; nameNode: TS.Node }): WorkerRelation[] {
  const sf = hook.nameNode.getSourceFile();
  const loc = nodeLocation(sf, hook.nameNode);
  const out = [relation({ kind: 'react.hook', group: 'declarations', label: `${hook.name} (custom hook)`, location: loc, symbol: symbolOf(hook.name, 'function', loc), confidence: 'proven', basis: c.basis })];
  for (const r of referenceNodes(c, sf.fileName, hook.nameNode.getStart(sf))) {
    if (r.isDefinition) continue;
    const call = r.node.parent;
    if (!call || !c.ts.isCallExpression(call) || call.expression !== r.node) continue;
    const at = nodeLocation(r.sf, call);
    out.push(relation({ kind: 'react.hookUse', group: 'references', label: `${hook.name}(…) in ${r.sf.fileName.slice(r.sf.fileName.lastIndexOf('/') + 1)}`, location: at, confidence: 'proven', basis: c.basis, evidence: [{ description: `Call resolved by the TypeScript checker to ${hook.name}.`, location: at }] }));
  }
  return out;
}

function contextRelations(c: CheckerContext, ctx: { name: string; nameNode: TS.Node }): WorkerRelation[] {
  const { ts } = c;
  const sf = ctx.nameNode.getSourceFile();
  const loc = nodeLocation(sf, ctx.nameNode);
  const limits = ['Which provider is in scope for a consumer depends on the rendered tree at run time; not resolved.'];
  const out = [relation({ kind: 'react.context', group: 'declarations', label: `${ctx.name} (context)`, location: loc, symbol: symbolOf(ctx.name, 'variable', loc), confidence: 'proven', basis: c.basis })];
  for (const r of referenceNodes(c, sf.fileName, ctx.nameNode.getStart(sf))) {
    if (r.isDefinition) continue;
    const p = r.node.parent;
    const file = r.sf.fileName.slice(r.sf.fileName.lastIndexOf('/') + 1);
    const el = jsxTagOf(ts, r.node);
    const member = p && ts.isPropertyAccessExpression(p) && p.expression === r.node ? p.name.text : undefined;
    if (el && (member === 'Provider' || member === undefined)) {
      const at = nodeLocation(r.sf, el.tagName);
      out.push(relation({ kind: 'react.contextProvider', group: 'registrations', label: `<${el.tagName.getText(r.sf)}> in ${file}`, location: at, confidence: 'likely', basis: c.basis, evidence: [{ description: `Provides a value for ${ctx.name}.`, location: at }], limitations: limits }));
    } else if (el && member === 'Consumer') {
      const at = nodeLocation(r.sf, el.tagName);
      out.push(relation({ kind: 'react.contextConsumer', group: 'references', label: `<${el.tagName.getText(r.sf)}> in ${file}`, location: at, confidence: 'likely', basis: c.basis, limitations: limits }));
    } else if (p && ts.isCallExpression(p) && p.arguments[0] === r.node && ['useContext', 'use'].includes(calleeName(ts, p.expression) ?? '')) {
      const at = nodeLocation(r.sf, p);
      out.push(relation({ kind: 'react.contextConsumer', group: 'references', label: `${p.expression.getText(r.sf)}(${ctx.name}) in ${file}`, location: at, confidence: 'likely', basis: c.basis, limitations: limits }));
    }
  }
  return out;
}

/** React relations at a position (empty when nothing React-specific is there). */
export function reactRelated(c: CheckerContext, sf: TS.SourceFile, offset: number): { subject?: string; relations: WorkerRelation[] } {
  const { ts } = c;
  const node = nodeAt(ts, sf, offset);
  // 1. A JSX tag name.
  const el = jsxTagOf(ts, node, true);
  if (el) {
    const relations = jsxElementRelations(c, el);
    if (relations.length) return { subject: `<${el.tagName.getText(sf)}>`, relations };
  }
  // 2. A JSX attribute name: the prop it resolves to and the other places passing it.
  if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name === node) {
    const sym = c.checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && !isInNodeModules(decl.getSourceFile().fileName)) {
      const owner = jsxElementRelations(c, node.parent.parent.parent as JsxTagElement).filter((r) => r.kind === 'react.component' || (r.kind === 'react.prop' && r.symbol?.name === sym!.name));
      return { subject: `prop ${sym!.name}`, relations: [...owner, ...propUseRelations(c, decl, sym!.name)] };
    }
  }
  if (!ts.isIdentifier(node)) return { relations: [] };
  const sym = resolveSymbol(c, node);
  // 3. Component, hook or context symbol (declaration or any reference).
  const comp = componentOfSymbol(c, sym);
  if (comp) return { subject: comp.name, relations: componentRelations(c, comp) };
  const hook = hookDeclOf(c, sym);
  if (hook) return { subject: hook.name, relations: hookRelations(c, hook) };
  const ctx = contextDeclOf(c, sym);
  if (ctx) return { subject: ctx.name, relations: contextRelations(c, ctx) };
  // useContext(X): the callee itself.
  if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node && ['useContext', 'use'].includes(node.text) && node.parent.arguments[0]) {
    const target = contextDeclOf(c, resolveSymbol(c, node.parent.arguments[0]));
    if (target) return { subject: target.name, relations: contextRelations(c, target) };
  }
  // 4. A member of a props type: the JSX attributes that set it.
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (sym && decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl) || ts.isBindingElement(decl)) && !isInNodeModules(decl.getSourceFile().fileName)) {
    const target = ts.isBindingElement(decl) ? propOfBinding(c, decl) : decl;
    if (target) {
      const uses = propUseRelations(c, target, sym.name);
      if (uses.length) return { subject: `prop ${sym.name}`, relations: uses };
    }
  }
  return { relations: [] };
}

/** `function Button({ label })`: the props member `label` the binding element destructures. */
function propOfBinding(c: CheckerContext, b: TS.BindingElement): TS.Node | undefined {
  const pattern = b.parent;
  const t = c.checker.getTypeAtLocation(pattern);
  const name = b.propertyName && c.ts.isIdentifier(b.propertyName) ? b.propertyName.text : c.ts.isIdentifier(b.name) ? b.name.text : undefined;
  const p = name ? t.getProperty(name) : undefined;
  return p?.valueDeclaration ?? p?.declarations?.[0];
}

