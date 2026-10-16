import type { Position, Range } from '@refyntra/contracts';
import type { DynamicUse, ModuleImport, ModuleMemberUse, NameUse, ScriptFacts, StyleImport } from './model';

// Class/id uses and stylesheet imports in TypeScript/JavaScript (TS, TSX, JS, JSX) source. Pattern based on
// comment-masked text (no TypeScript engine, nothing evaluated). Recognised forms (docs/guide.md "HTML and CSS"):
//   CSS Modules: import s from './x.module.css' | import * as s from … | const s = require('…')
//                s.foo, s?.foo, s['foo'] (static) — s[expr] is dynamic (unknown)
//   global classes: className="a b", className={'a b'}, class="a b" (JSX), el.className = 'a b',
//                classList.add/remove/toggle/contains/replace('a'), clsx/classnames/classNames/cx/cn/twMerge('a', { b: … })
//   ids: getElementById('x'), id="x" (JSX), querySelector('#x') / querySelector('.a') with one simple selector
//   component stylesheets: import './x.css', Angular styleUrl(s): ['./x.component.scss']
// Template literals and expressions as class names are recorded as dynamic: never guessed.

/** Replaces JS comments with spaces (strings and template literals kept; offsets kept). */
export function maskScriptComments(text: string): string {
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
    if (c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
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
    if (c === '/' && text[i + 1] === '/') {
      let k = i;
      while (k < text.length && text[k] !== '\n') out[k++] = ' ';
      i = k;
      continue;
    }
    i++;
  }
  return out.join('');
}

export class LineMap {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  position(offset: number): Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo]! };
  }
  range(start: number, end: number): Range {
    return { start: this.position(start), end: this.position(end) };
  }
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const STYLE_EXT = String.raw`\.(?:css|scss|less)`;
const MODULE_SPEC = String.raw`(['"])([^'"\n]+\.module${STYLE_EXT})\2`;
const CLASS_TOKEN = /[^\s'"`]+/g;

/** Every whitespace-separated class token of a literal value starting at `at`. */
function tokens(value: string, at: number, form: string, lines: LineMap, out: NameUse[]): void {
  for (const m of value.matchAll(CLASS_TOKEN)) {
    if (!/^-?[_a-zA-Z -￿][\w -￿:/.\-[\]%]*$/.test(m[0])) continue;
    out.push({ name: m[0], range: lines.range(at + m.index!, at + m.index! + m[0].length), form });
  }
}

/** The text between the `(` at `open` and its matching `)` (strings skipped), or undefined when unbalanced. */
function callArgs(text: string, open: number): { start: number; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 4000; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { start: open + 1, end: i };
  }
  return undefined;
}

const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;

export function parseScript(text: string): ScriptFacts {
  const masked = maskScriptComments(text);
  const lines = new LineMap(text);
  const facts: ScriptFacts = { kind: 'script', moduleImports: [], moduleUses: [], styleImports: [], classUses: [], idUses: [], dynamic: [] };

  const addImport = (alias: string, spec: string, specAt: number) => facts.moduleImports.push({ alias, spec, range: lines.range(specAt, specAt + spec.length) } satisfies ModuleImport);
  for (const re of [
    new RegExp(String.raw`\bimport\s+(${ID})\s*(?:,\s*\{[^}]*\}\s*)?from\s*${MODULE_SPEC}`, 'g'),
    new RegExp(String.raw`\bimport\s*\*\s*as\s+(${ID})\s+from\s*${MODULE_SPEC}`, 'g'),
    new RegExp(String.raw`\b(?:const|let|var)\s+(${ID})\s*=\s*require\s*\(\s*${MODULE_SPEC}\s*\)`, 'g'),
  ]) {
    for (const m of masked.matchAll(re)) addImport(m[1]!, m[3]!, m.index! + m[0].lastIndexOf(m[3]!));
  }
  // Side-effect stylesheet imports and Angular component stylesheets.
  for (const m of masked.matchAll(new RegExp(String.raw`\bimport\s*(['"])([^'"\n]+${STYLE_EXT})\1`, 'g'))) {
    if (/\.module\.(css|scss|less)$/i.test(m[2]!)) continue;
    const at = m.index! + m[0].lastIndexOf(m[2]!);
    facts.styleImports.push({ spec: m[2]!, range: lines.range(at, at + m[2]!.length) } satisfies StyleImport);
  }
  for (const m of masked.matchAll(/\bstyleUrls?\s*:\s*(\[[^\]]*\]|(['"])[^'"\n]*\2)/g)) {
    for (const s of m[1]!.matchAll(STRING_LITERAL)) {
      if (!new RegExp(`${STYLE_EXT}$`, 'i').test(s[2]!)) continue;
      const at = m.index! + m[0].indexOf(m[1]!) + s.index! + 1;
      facts.styleImports.push({ spec: s[2]!, range: lines.range(at, at + s[2]!.length) });
    }
  }

  // CSS Modules member accesses.
  for (const alias of new Set(facts.moduleImports.map((i) => i.alias))) {
    const a = alias.replace(/\$/g, '\\$');
    for (const m of masked.matchAll(new RegExp(String.raw`(?<![\w$.])${a}\s*(?:\?\.|\.)\s*(${ID})`, 'g'))) {
      const at = m.index! + m[0].length - m[1]!.length;
      facts.moduleUses.push({ alias, member: m[1]!, range: lines.range(at, at + m[1]!.length) } satisfies ModuleMemberUse);
    }
    for (const m of masked.matchAll(new RegExp(String.raw`(?<![\w$.])${a}\s*(?:\?\.)?\[\s*(?:(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*\])?`, 'g'))) {
      if (m[2] !== undefined) {
        const at = m.index! + m[0].indexOf(m[1]!) + 1;
        facts.moduleUses.push({ alias, member: m[2], range: lines.range(at, at + m[2].length) });
      } else {
        facts.moduleUses.push({ alias, range: lines.range(m.index!, m.index! + m[0].length) });
        facts.dynamic.push({ form: `${alias}[…]`, range: lines.range(m.index!, m.index! + m[0].length) } satisfies DynamicUse);
      }
    }
  }

  // className / class attributes and assignments.
  for (const m of masked.matchAll(/(?:\bclassName|(?<=\s)class)\s*=\s*(\{\s*)?(?:(['"])((?:\\.|(?!\2)[^\\\n])*)\2|(`))/g)) {
    const form = m[0].startsWith('class=') || m[0].startsWith('class ') ? 'class="…"' : 'className';
    if (m[4]) {
      facts.dynamic.push({ form: `${form} template literal`, range: lines.range(m.index!, m.index! + m[0].length) });
      continue;
    }
    const at = m.index! + m[0].length - 1 - m[3]!.length;
    tokens(m[3]!, at, form, lines, facts.classUses);
  }
  for (const m of masked.matchAll(/\.classList\s*\.\s*(add|remove|toggle|contains|replace)\s*\(/g)) {
    const args = callArgs(masked, m.index! + m[0].length - 1);
    if (!args) continue;
    const body = masked.slice(args.start, args.end);
    const literals = [...body.matchAll(STRING_LITERAL)];
    const first = literals[0];
    if (!first) {
      facts.dynamic.push({ form: `classList.${m[1]}`, range: lines.range(m.index! + 1, args.end + 1) });
      continue;
    }
    // toggle('a', cond): only the first argument is a class; add/remove take several.
    for (const s of m[1] === 'toggle' || m[1] === 'contains' ? [first] : literals) tokens(s[2]!, args.start + s.index! + 1, `classList.${m[1]}`, lines, facts.classUses);
  }
  for (const m of masked.matchAll(/(?<![\w$.])(clsx|classnames|classNames|cx|cn|twMerge)\s*\(/g)) {
    const args = callArgs(masked, m.index! + m[0].length - 1);
    if (!args) continue;
    const body = masked.slice(args.start, args.end);
    for (const s of body.matchAll(STRING_LITERAL)) tokens(s[2]!, args.start + s.index! + 1, m[1]!, lines, facts.classUses);
    for (const k of body.matchAll(/[{,]\s*([A-Za-z_][\w-]*)\s*:/g)) {
      const at = args.start + k.index! + k[0].indexOf(k[1]!);
      facts.classUses.push({ name: k[1]!, range: lines.range(at, at + k[1]!.length), form: m[1]! });
    }
    if (body.includes('`')) facts.dynamic.push({ form: `${m[1]} template literal`, range: lines.range(m.index!, args.end + 1) });
  }

  // ids.
  for (const m of masked.matchAll(/\bgetElementById\s*\(\s*(['"])([^'"\s]+)\1/g)) {
    const at = m.index! + m[0].length - 1 - m[2]!.length;
    facts.idUses.push({ name: m[2]!, range: lines.range(at, at + m[2]!.length), form: 'getElementById' });
  }
  for (const m of masked.matchAll(/(?<=\s)id=(['"])([^'"\s]+)\1/g)) {
    const at = m.index! + 4;
    facts.idUses.push({ name: m[2]!, range: lines.range(at, at + m[2]!.length), form: 'id="…"' });
  }
  for (const m of masked.matchAll(/\bquerySelector(?:All)?\s*\(\s*(['"])([.#])(-?[_a-zA-Z][\w-]*)\1\s*\)/g)) {
    const at = m.index! + m[0].indexOf(m[2]! + m[3]!) + 1;
    const use = { name: m[3]!, range: lines.range(at, at + m[3]!.length), form: 'querySelector' };
    (m[2] === '#' ? facts.idUses : facts.classUses).push(use);
  }
  return facts;
}
