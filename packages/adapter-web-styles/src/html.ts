import { TokenType, getLanguageService } from 'vscode-html-languageservice';
import type { HtmlFacts, NameUse, ScriptFacts, StylesheetFacts } from './model';
import { LineMap, parseScript } from './script';
import { parseStylesheet } from './stylesheet';

// HTML facts through the official vscode-html-languageservice scanner (bundled, in-process): class and id attributes,
// <link rel="stylesheet" href>, <style> blocks (parsed as CSS) and <script> blocks (scanned like a script file).
// Attribute values with template syntax ({{ }}, ${ }) are recorded as dynamic and never split into class names.

let html: ReturnType<typeof getLanguageService> | undefined;

/** The text with everything before `offset` blanked (newlines kept), so an embedded block keeps its document positions. */
function embedded(text: string, offset: number, body: string): string {
  return text.slice(0, offset).replace(/[^\r\n]/g, ' ') + body;
}

interface Attr {
  name: string;
  value?: string;
  /** Offset of the value's first character (inside the quotes). */
  valueAt?: number;
}

export function parseHtml(uri: string, text: string): HtmlFacts {
  html ??= getLanguageService();
  const lines = new LineMap(text);
  const facts: HtmlFacts = { kind: 'html', classUses: [], idUses: [], links: [], inline: [], dynamic: [] };
  const scanner = html.createScanner(text);
  let tag = '';
  let attrs: Attr[] = [];
  let lastAttr: Attr | undefined;
  const addTokens = (value: string, at: number, form: string, out: NameUse[]) => {
    for (const m of value.matchAll(/\S+/g)) out.push({ name: m[0], range: lines.range(at + m.index!, at + m.index! + m[0].length), form });
  };
  const closeTag = () => {
    for (const a of attrs) {
      const n = a.name.toLowerCase();
      const ng = /^\[class\.([\w-]+)\]$/.exec(a.name);
      if (ng && a.valueAt !== undefined) {
        // Angular [class.name]="expr": the class name is static.
        facts.classUses.push({ name: ng[1]!, range: lines.range(a.valueAt, a.valueAt), form: '[class.…]' });
      }
      if (a.value === undefined || a.valueAt === undefined) continue;
      const dynamic = /\{\{|\$\{|<%|\{%/.test(a.value);
      if (n === 'class') {
        if (dynamic) facts.dynamic.push({ form: 'class="…" with template syntax', range: lines.range(a.valueAt, a.valueAt + a.value.length) });
        else addTokens(a.value, a.valueAt, 'class="…"', facts.classUses);
      } else if (n === 'id' && !dynamic && a.value.trim()) {
        const v = a.value.trim();
        const at = a.valueAt + a.value.indexOf(v);
        facts.idUses.push({ name: v, range: lines.range(at, at + v.length), form: 'id="…"' });
      }
    }
    if (tag === 'link') {
      const rel = attrs.find((a) => a.name.toLowerCase() === 'rel')?.value?.toLowerCase().split(/\s+/) ?? [];
      const href = attrs.find((a) => a.name.toLowerCase() === 'href');
      if (rel.includes('stylesheet') && href?.value && href.valueAt !== undefined) facts.links.push({ spec: href.value, range: lines.range(href.valueAt, href.valueAt + href.value.length) });
    }
    attrs = [];
    lastAttr = undefined;
  };
  for (let t = scanner.scan(); t !== TokenType.EOS; t = scanner.scan()) {
    switch (t) {
      case TokenType.StartTag:
        tag = scanner.getTokenText().toLowerCase();
        attrs = [];
        break;
      case TokenType.AttributeName:
        lastAttr = { name: scanner.getTokenText() };
        attrs.push(lastAttr);
        break;
      case TokenType.AttributeValue:
        if (lastAttr) {
          const raw = scanner.getTokenText();
          const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0];
          lastAttr.value = quoted ? raw.slice(1, -1) : raw;
          lastAttr.valueAt = scanner.getTokenOffset() + (quoted ? 1 : 0);
        }
        break;
      case TokenType.StartTagClose:
      case TokenType.StartTagSelfClose:
        closeTag();
        break;
      case TokenType.Styles: {
        const sheet: StylesheetFacts = parseStylesheet(uri, embedded(text, scanner.getTokenOffset(), scanner.getTokenText()), 'css');
        sheet.isModule = false;
        facts.inline.push(sheet);
        break;
      }
      case TokenType.Script: {
        const s: ScriptFacts = parseScript(embedded(text, scanner.getTokenOffset(), scanner.getTokenText()));
        facts.classUses.push(...s.classUses);
        facts.idUses.push(...s.idUses);
        facts.dynamic.push(...s.dynamic);
        break;
      }
      default:
        break;
    }
  }
  return facts;
}
