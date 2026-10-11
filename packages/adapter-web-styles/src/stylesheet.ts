import { type DocumentSymbol, type LanguageService, SymbolKind, getCSSLanguageService, getLESSLanguageService, getSCSSLanguageService } from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Range } from '@refyntra/contracts';
import type { NamedDefinition, NamedUse, SelectorName, StyleImport, StyleLanguage, StylesheetFacts } from './model';

// CSS / SCSS / LESS facts through the official vscode-css-languageservice parser (bundled, in-process, no server):
// document symbols give the selectors, variables and mixins; document links give @import/@use/@forward. Class and id
// names are read from each selector's text. Comments are masked before the small pattern scans (uses of variables
// and mixins), so commented-out code is never reported.

const services: Partial<Record<StyleLanguage, LanguageService>> = {};
function service(language: StyleLanguage): LanguageService {
  return (services[language] ??= language === 'scss' ? getSCSSLanguageService() : language === 'less' ? getLESSLanguageService() : getCSSLanguageService());
}

export function styleLanguageOf(uri: string): StyleLanguage | undefined {
  const m = /\.(css|scss|less)$/i.exec(uri.split(/[?#]/)[0] ?? uri);
  return m ? (m[1]!.toLowerCase() as StyleLanguage) : undefined;
}

export function isCssModuleUri(uri: string): boolean {
  return /\.module\.(css|scss|less)$/i.test(uri.split(/[?#]/)[0] ?? uri);
}

/** Replaces comments with spaces (offsets kept). `//` line comments only for SCSS/LESS and never right after `:` (URLs). */
export function maskStyleComments(text: string, lineComments: boolean): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      for (let k = i; k < end; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
      i = end;
      continue;
    }
    if (lineComments && c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      let k = i;
      while (k < text.length && text[k] !== '\n') out[k++] = ' ';
      i = k;
      continue;
    }
    i++;
  }
  return out.join('');
}

const IDENT = String.raw`-?(?:[_a-zA-Z -￿]|\\.)(?:[\w -￿-]|\\.)*`;
const CLASS_RE = new RegExp(String.raw`(?<![\w\\-])\.(${IDENT})`, 'g');
const ID_RE = new RegExp(String.raw`(?<![\w\\&-])#(${IDENT})`, 'g');

function unescapeIdent(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, e: string) => (/^[0-9a-fA-F]/.test(e) && e.trim().length > 1 ? String.fromCodePoint(parseInt(e.trim(), 16)) : e));
}

/** Removes attribute selectors (`[href$=".pdf"]`) so their values are never read as classes. Offsets kept. */
function blankAttributeSelectors(s: string): string {
  return s.replace(/\[[^\]]*\]/g, (m) => ' '.repeat(m.length));
}

interface Ctx {
  doc: TextDocument;
  text: string;
  /** Offset added to every range (inline <style> blocks inside an HTML document). */
  base: number;
  toRange(start: number, end: number): Range;
}

function walkSymbols(ctx: Ctx, language: StyleLanguage, symbols: DocumentSymbol[], parents: string[], facts: StylesheetFacts): void {
  for (const s of symbols) {
    if (s.kind === SymbolKind.Class) {
      const start = ctx.doc.offsetAt(s.selectionRange.start);
      const end = ctx.doc.offsetAt(s.selectionRange.end);
      const selector = ctx.text.slice(start, end);
      const scan = blankAttributeSelectors(selector);
      for (const m of scan.matchAll(CLASS_RE)) {
        const from = start + m.index! + 1;
        facts.classes.push({ name: unescapeIdent(m[1]!), range: ctx.toRange(from, from + m[1]!.length), selector: selector.trim() });
      }
      for (const m of scan.matchAll(ID_RE)) {
        const from = start + m.index! + 1;
        facts.ids.push({ name: unescapeIdent(m[1]!), range: ctx.toRange(from, from + m[1]!.length), selector: selector.trim() });
      }
      // `&-suffix` / `&__suffix` under a parent ending in a class: a derived class name (SCSS/LESS nesting).
      const resolved: string[] = [];
      const amp = /^&([\w-]+)/.exec(selector);
      for (const p of parents.length ? parents : ['']) {
        resolved.push(selector.includes('&') ? selector.replace(/&/g, p) : p ? `${p} ${selector}` : selector);
        if (amp && language !== 'css') {
          const last = new RegExp(String.raw`\.(${IDENT})$`).exec(p.trim());
          if (last) facts.classes.push({ name: unescapeIdent(last[1]!) + amp[1]!, range: ctx.toRange(start, start + amp[0].length), selector: selector.trim(), derived: true });
        }
      }
      if (s.children?.length) walkSymbols(ctx, language, s.children, resolved, facts);
      continue;
    }
    if (s.kind === SymbolKind.Variable) {
      const name = s.name.replace(/^[$@]/, '');
      const from = ctx.doc.offsetAt(s.selectionRange.start);
      facts.variables.push({ name, range: ctx.toRange(from, ctx.doc.offsetAt(s.selectionRange.end)) });
    } else if (s.kind === SymbolKind.Method || s.kind === SymbolKind.Function) {
      if (language === 'scss' && s.kind === SymbolKind.Method) {
        facts.mixins.push({ name: s.name, range: ctx.toRange(ctx.doc.offsetAt(s.selectionRange.start), ctx.doc.offsetAt(s.selectionRange.end)) });
      }
    }
    if (s.children?.length) walkSymbols(ctx, language, s.children, parents, facts);
  }
}

function scanUses(ctx: Ctx, language: StyleLanguage, masked: string, facts: StylesheetFacts): void {
  if (language === 'scss') {
    for (const m of masked.matchAll(/(?:(?<![\w$-])([A-Za-z_][\w-]*)\.)?\$([A-Za-z_][\w-]*)(?![\w-])(?!\s*:(?!:))/g)) {
      const at = m.index! + (m[1] ? m[1].length + 1 : 0);
      const use: NamedUse = { name: m[2]!, range: ctx.toRange(at, at + 1 + m[2]!.length) };
      if (m[1]) use.namespace = m[1];
      facts.variableUses.push(use);
    }
    for (const m of masked.matchAll(/@include\s+(?:([A-Za-z_][\w-]*)\.)?([A-Za-z_][\w-]*)/g)) {
      const at = m.index! + m[0].length - m[2]!.length;
      const use: NamedUse = { name: m[2]!, range: ctx.toRange(at, at + m[2]!.length) };
      if (m[1]) use.namespace = m[1];
      facts.mixinUses.push(use);
    }
  } else if (language === 'less') {
    for (const m of masked.matchAll(/(?<![\w@-])@([A-Za-z_][\w-]*)(?![\w-])(?!\s*:)/g)) {
      facts.variableUses.push({ name: m[1]!, range: ctx.toRange(m.index!, m.index! + m[0].length) });
    }
  }
}

function scanImports(ctx: Ctx, language: StyleLanguage, masked: string, ss: ReturnType<LanguageService['parseStylesheet']>, facts: StylesheetFacts): void {
  const links = service(language).findDocumentLinks(ctx.doc, ss, { resolveReference: (ref) => ref });
  for (const l of links) {
    if (!l.target) continue;
    const start = ctx.doc.offsetAt(l.range.start);
    const before = masked.slice(Math.max(0, start - 200), start);
    const at = /@(import|use|forward)\b[^;{}]*$/.exec(before);
    if (!at) continue; // url(...) of an image or font
    const imp: StyleImport = { spec: l.target, range: ctx.toRange(start, ctx.doc.offsetAt(l.range.end)) };
    if (at[1] === 'use' && language === 'scss') {
      const after = /^\s*as\s+([\w-]+|\*)/.exec(masked.slice(ctx.doc.offsetAt(l.range.end)));
      imp.namespace = after ? after[1]! : defaultNamespace(l.target);
    }
    facts.imports.push(imp);
  }
}

/** `@use 'src/_corners.scss'` → `corners`. */
export function defaultNamespace(spec: string): string {
  const last = spec.split('/').pop() ?? spec;
  return last.replace(/^_/, '').replace(/\.(scss|sass|css)$/i, '');
}

/** Parses a stylesheet; `base` shifts ranges for a `<style>` block whose text starts at `base` in `host`. */
export function parseStylesheet(uri: string, text: string, language: StyleLanguage, host?: { doc: TextDocument; base: number }): StylesheetFacts {
  const doc = TextDocument.create(uri, language, 0, text);
  const base = host?.base ?? 0;
  const outer = host?.doc ?? doc;
  const ctx: Ctx = {
    doc,
    text,
    base,
    toRange: (s, e) => ({ start: outer.positionAt(base + s), end: outer.positionAt(base + e) }),
  };
  const facts: StylesheetFacts = { kind: 'stylesheet', language, isModule: !host && isCssModuleUri(uri), classes: [], ids: [], imports: [], variables: [], mixins: [], variableUses: [], mixinUses: [] };
  const ss = service(language).parseStylesheet(doc);
  walkSymbols(ctx, language, service(language).findDocumentSymbols2(doc, ss), [], facts);
  const masked = maskStyleComments(text, language !== 'css');
  scanImports(ctx, language, masked, ss, facts);
  // A definition is not a use of itself.
  const defs = new Set([...facts.variables, ...facts.mixins].map((d: NamedDefinition) => `${d.range.start.line}:${d.range.start.character}`));
  scanUses(ctx, language, masked, facts);
  facts.variableUses = facts.variableUses.filter((u) => !defs.has(`${u.range.start.line}:${u.range.start.character}`));
  // A class selector both defined and derived at the same place keeps the direct one.
  const seen = new Set<string>();
  facts.classes = facts.classes.filter((c: SelectorName) => {
    const k = `${c.name}|${c.range.start.line}:${c.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return facts;
}
