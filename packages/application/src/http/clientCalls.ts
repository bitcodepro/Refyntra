import type { Range } from '@refyntra/contracts';

// Heuristic HTTP client call detection in TypeScript/JavaScript source (no TypeScript engine, no evaluation).
// A small tokenizer that understands comments, strings, template literals and regular expressions, then a pattern
// matcher over the tokens. Recognised forms (see README "Frontend ↔ backend (heuristic)"):
//   fetch(url[, { method }]), window/globalThis/self.fetch(...)
//   axios.get/post/put/delete/patch/head/options(url), axios(url[, { method }]), axios({ url, method }),
//   axios.request({ url, method }), instances from a same-file axios.create({ baseURL })
//   Angular HttpClient this.http.get<T>(url) (receiver named http/httpClient/_http), AngularJS $http.get(url) and $http({ url, method })
//   ky.get(url), ky(url[, { method }]); superagent.get(url) (also a same-file default import of 'superagent')
// The URL must be a string literal, a template literal (each ${…} is a route parameter), a `+` concatenation of those
// with identifiers (route parameters) or a same-file const. Anything else is reported as not resolvable: never guessed.

export type UrlSegment = { kind: 'literal'; text: string } | { kind: 'param'; name: string };

export interface ClientUrl {
  /** Lower-cased scheme://host[:port] of an absolute URL; absent for a relative URL. */
  origin?: string;
  /** Path segments (query and fragment removed). */
  segments: UrlSegment[];
  /** Display form, e.g. "/api/orders/{id}". */
  path: string;
}

export interface ClientCall {
  /** e.g. "fetch", "axios.get", "http.post", "$http", "ky", "superagent.get". */
  form: string;
  /** Upper-case HTTP method; undefined when it is not a literal. */
  method?: string;
  /** The resolved URL; absent when it could not be resolved (see `reason`). */
  url?: ClientUrl;
  /** Why the URL was not resolved. */
  reason?: string;
  /** Source text of the URL argument (shortened). */
  raw: string;
  /** From the callee to the closing parenthesis. */
  range: Range;
}

// ------------------------------------------------------------------ tokenizer

interface Tok {
  k: 'id' | 'str' | 'tpl' | 'num' | 'punc' | 'regex';
  /** Identifier/punctuator text, or the cooked value of a string. */
  v: string;
  start: number;
  end: number;
  /** Template literal: literal parts (cooked) and expression source texts between them. */
  quasis?: string[];
  exprs?: string[];
}

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];

function isIdStart(c: string): boolean {
  return /[A-Za-z_$À-￿]/.test(c);
}
function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$À-￿]/.test(c);
}

function cookEscape(src: string, i: number): [string, number] {
  const c = src[i + 1] ?? '';
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (c in map) return [map[c]!, i + 2];
  if (c === '\r' && src[i + 2] === '\n') return ['', i + 3];
  if (c === '\n' || c === '\r') return ['', i + 2];
  if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) return [String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), i + 4];
  if (c === 'u') {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2));
    if (braced) return [String.fromCodePoint(Math.min(parseInt(braced[1]!, 16), 0x10ffff)), i + 3 + braced[0].length - 1];
    if (/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) return [String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), i + 6];
  }
  return [c, i + 2];
}

/** Skips a `${ … }` expression body starting after `${`; returns the index of the closing `}` (or src.length). */
function skipTemplateExpr(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = scanString(src, i).end;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(src, i).end;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return src.length;
}

/** A quoted string; an unterminated string ends at the end of its line (JSX text with an apostrophe stays harmless). */
function scanString(src: string, i: number): { value: string; end: number } {
  const q = src[i]!;
  let value = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === q) return { value, end: j + 1 };
    if (c === '\n' || c === '\r') return { value, end: j };
    if (c === '\\') {
      const [s, n] = cookEscape(src, j);
      value += s;
      j = n;
      continue;
    }
    value += c;
    j++;
  }
  return { value, end: j };
}

function scanTemplate(src: string, i: number): { quasis: string[]; exprs: string[]; end: number } {
  const quasis: string[] = [];
  const exprs: string[] = [];
  let cur = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '`') {
      quasis.push(cur);
      return { quasis, exprs, end: j + 1 };
    }
    if (c === '\\') {
      const [s, n] = cookEscape(src, j);
      cur += s;
      j = n;
      continue;
    }
    if (c === '$' && src[j + 1] === '{') {
      quasis.push(cur);
      cur = '';
      const close = skipTemplateExpr(src, j + 2);
      exprs.push(src.slice(j + 2, close).trim());
      j = close + 1;
      continue;
    }
    cur += c;
    j++;
  }
  quasis.push(cur);
  return { quasis, exprs, end: j };
}

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.k === 'punc') return ![')', ']', '}', '++', '--'].includes(prev.v);
  if (prev.k === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  return false;
}

function scanRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\n' || c === '\r') return j;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && isIdPart(src[j]!)) j++;
      return j;
    }
    j++;
  }
  return j;
}

/** Tokens of a source text; comments and whitespace are dropped. Never throws. */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '﻿' || c === ' ') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = scanString(src, i);
      out.push({ k: 'str', v: s.value, start: i, end: s.end });
      i = s.end;
      continue;
    }
    if (c === '`') {
      const t = scanTemplate(src, i);
      out.push({ k: 'tpl', v: '', start: i, end: t.end, quasis: t.quasis, exprs: t.exprs });
      i = t.end;
      continue;
    }
    if (c === '/' && regexAllowed(out[out.length - 1])) {
      const e = scanRegex(src, i);
      out.push({ k: 'regex', v: src.slice(i, e), start: i, end: e });
      i = e;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      out.push({ k: 'num', v: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (isIdStart(c) || c === '#' || c === '@') {
      let j = i + 1;
      while (j < src.length && isIdPart(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i)) ?? c;
    out.push({ k: 'punc', v: p, start: i, end: i + p.length });
    i += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ positions

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') starts.push(i + 1);
    else if (c === '\r' && src[i + 1] !== '\n') starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}

// ------------------------------------------------------------------ expression evaluation

type Part = { lit: string } | { param: string };
type Eval = { ok: true; parts: Part[] } | { ok: false; reason: string };

const STATEMENT_START = new Set(['const', 'let', 'var', 'function', 'export', 'import', 'class', 'return', 'if', 'for', 'while', 'async', 'interface', 'type']);

function lineOf(starts: number[], offset: number): number {
  return positionAt(starts, offset).line;
}

/** Index after a balanced group starting at tokens[i] (an opening bracket). */
function skipGroup(t: Tok[], i: number): number {
  const open = t[i]!.v;
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    const v = t[j]!;
    if (v.k !== 'punc') continue;
    if (v.v === open) depth++;
    else if (v.v === close) {
      depth--;
      if (depth === 0) return j + 1;
    } else if (open === '<' && (v.v === ';' || v.v === '{' || v.v === ')')) return -1;
    else if (open === '<' && v.v === '>>') {
      depth -= 2;
      if (depth <= 0) return j + 1;
    }
  }
  return -1;
}

/** Splits the tokens of an argument list (between the parentheses) at top-level commas. */
function splitArgs(t: Tok[], from: number, to: number): Array<[number, number]> {
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let j = from; j < to; j++) {
    const v = t[j]!;
    if (v.k === 'punc') {
      if (v.v === '(' || v.v === '[' || v.v === '{') depth++;
      else if (v.v === ')' || v.v === ']' || v.v === '}') depth--;
      else if (v.v === ',' && depth === 0) {
        args.push([start, j]);
        start = j + 1;
      }
    }
  }
  if (start < to) args.push([start, to]);
  return args;
}

interface FileFacts {
  src: string;
  starts: number[];
  tokens: Tok[];
  /** Same-file `const NAME = <expr>` (declared once): token range of the initializer. */
  consts: Map<string, [number, number]>;
  /** Library aliases: local name → library ('axios' | 'ky' | 'superagent'). */
  libs: Map<string, string>;
  /** axios instances: local name → token range of the baseURL expression (or null: no baseURL). */
  axiosInstances: Map<string, [number, number] | null>;
}

const MAX_CONST_DEPTH = 6;

function paramName(text: string): string {
  const ids = text.match(/[A-Za-z_$][\w$]*/g);
  const last = ids?.[ids.length - 1];
  return last ?? 'param';
}

function evalTemplate(f: FileFacts, tok: Tok, depth: number): Eval {
  const parts: Part[] = [];
  const quasis = tok.quasis ?? [''];
  const exprs = tok.exprs ?? [];
  for (let i = 0; i < quasis.length; i++) {
    if (quasis[i]) parts.push({ lit: quasis[i]! });
    if (i < exprs.length) {
      const e = exprs[i]!;
      if (/^[A-Za-z_$][\w$]*$/.test(e) && f.consts.has(e)) {
        const r = evalConst(f, e, depth + 1);
        if (!r.ok) return r;
        parts.push(...r.parts);
      } else parts.push({ param: paramName(e) });
    }
  }
  return { ok: true, parts };
}

function evalConst(f: FileFacts, name: string, depth: number): Eval {
  if (depth > MAX_CONST_DEPTH) return { ok: false, reason: 'constants nest too deeply' };
  const range = f.consts.get(name)!;
  return evalExpr(f, range[0], range[1], depth);
}

/** Evaluates a URL expression: literals, templates, same-file consts and identifiers (parameters) joined by `+`. */
function evalExpr(f: FileFacts, from: number, to: number, depth = 0): Eval {
  const t = f.tokens;
  if (from >= to) return { ok: false, reason: 'no URL argument' };
  // Parenthesised whole expression: unwrap.
  if (t[from]!.v === '(' && t[from]!.k === 'punc' && skipGroup(t, from) === to) return evalExpr(f, from + 1, to - 1, depth);
  const parts: Part[] = [];
  let i = from;
  let expectOperand = true;
  while (i < to) {
    const tok = t[i]!;
    if (!expectOperand) {
      if (tok.k === 'punc' && tok.v === '+') {
        expectOperand = true;
        i++;
        continue;
      }
      // `as const`, a type assertion or a non-null assertion at the end changes nothing.
      if (tok.k === 'id' && tok.v === 'as') break;
      if (tok.k === 'punc' && tok.v === '!' && i === to - 1) break;
      return { ok: false, reason: `the URL is not a literal (operator "${tok.v}")` };
    }
    expectOperand = false;
    if (tok.k === 'str') {
      parts.push({ lit: tok.v });
      i++;
      continue;
    }
    if (tok.k === 'tpl') {
      const r = evalTemplate(f, tok, depth);
      if (!r.ok) return r;
      parts.push(...r.parts);
      i++;
      continue;
    }
    if (tok.k === 'num') {
      parts.push({ lit: tok.v });
      i++;
      continue;
    }
    if (tok.k === 'id') {
      // Member chain / call: a.b.c, a?.b, f(x), a[0]
      let j = i + 1;
      let simple = true;
      while (j < to) {
        const n = t[j]!;
        if (n.k === 'punc' && (n.v === '.' || n.v === '?.') && t[j + 1]?.k === 'id') {
          j += 2;
          simple = false;
          continue;
        }
        if (n.k === 'punc' && (n.v === '(' || n.v === '[')) {
          const e = skipGroup(t, j);
          if (e < 0 || e > to) return { ok: false, reason: 'unbalanced expression' };
          j = e;
          simple = false;
          continue;
        }
        break;
      }
      if (simple && f.consts.has(tok.v)) {
        const r = evalConst(f, tok.v, depth + 1);
        if (!r.ok) return r;
        parts.push(...r.parts);
      } else {
        const last = [...t.slice(i, j)].reverse().find((x) => x.k === 'id' && x.v !== 'toString');
        parts.push({ param: last?.v ?? tok.v });
      }
      i = j;
      continue;
    }
    if (tok.k === 'punc' && tok.v === '(') {
      const e = skipGroup(t, i);
      if (e < 0 || e > to) return { ok: false, reason: 'unbalanced expression' };
      const r = evalExpr(f, i + 1, e - 1, depth + 1);
      if (!r.ok) return r;
      parts.push(...r.parts);
      i = e;
      continue;
    }
    return { ok: false, reason: `the URL is not a literal ("${tok.v}")` };
  }
  if (expectOperand) return { ok: false, reason: 'incomplete expression' };
  return { ok: true, parts };
}

/** Builds the URL from evaluated parts; parameters must fill whole path segments. */
export function partsToUrl(parts: readonly Part[]): { url: ClientUrl } | { reason: string } {
  if (parts.length === 0 || !('lit' in parts[0]!)) return { reason: 'the URL starts with a value that is not known in this file' };
  // Flatten into characters with parameter markers; cut at the query or fragment (only in literal text).
  type Piece = { lit: string } | { param: string };
  const pieces: Piece[] = [];
  outer: for (const p of parts) {
    if ('param' in p) {
      pieces.push(p);
      continue;
    }
    const q = p.lit.search(/[?#]/);
    if (q >= 0) {
      if (q > 0) pieces.push({ lit: p.lit.slice(0, q) });
      break outer;
    }
    pieces.push(p);
  }
  let head = '';
  let k = 0;
  while (k < pieces.length && 'lit' in pieces[k]!) head += (pieces[k++] as { lit: string }).lit;
  head = head.trim();
  let origin: string | undefined;
  const abs = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(head);
  if (abs) {
    const scheme = (abs[1] ?? '').toLowerCase();
    if (scheme && scheme !== 'http:' && scheme !== 'https:') return { reason: `not an HTTP URL (${scheme})` };
    if (k < pieces.length && abs[0].length === head.length) return { reason: 'the host name is not known in this file' };
    origin = `${scheme}//${abs[2]!.toLowerCase()}`;
    head = head.slice(abs[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(head)) {
    return { reason: 'not an HTTP URL' };
  }
  if (head.startsWith('./')) head = head.slice(1);
  if (head.startsWith('../')) return { reason: 'a relative URL that goes up a level' };
  // Segments: split literal text on '/', parameters must be alone in their segment.
  const segments: UrlSegment[] = [];
  let cur: { text: string; params: string[] } = { text: '', params: [] };
  const flush = (): string | undefined => {
    if (cur.params.length === 0) {
      if (cur.text.length > 0) segments.push({ kind: 'literal', text: safeDecode(cur.text) });
    } else if (cur.params.length === 1 && cur.text.length === 0) segments.push({ kind: 'param', name: cur.params[0]! });
    else return 'a parameter fills only part of a path segment';
    cur = { text: '', params: [] };
    return undefined;
  };
  const rest: Piece[] = [{ lit: head }, ...pieces.slice(k)];
  for (const p of rest) {
    if ('param' in p) {
      cur.params.push(p.param);
      continue;
    }
    const pieces2 = p.lit.split('/');
    for (let x = 0; x < pieces2.length; x++) {
      if (x > 0) {
        const err = flush();
        if (err) return { reason: err };
      }
      cur.text += pieces2[x]!;
    }
  }
  const err = flush();
  if (err) return { reason: err };
  const path = '/' + segments.map((s) => (s.kind === 'literal' ? s.text : `{${s.name}}`)).join('/');
  return { url: { ...(origin ? { origin } : {}), segments, path } };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ file facts

function collectFacts(src: string): FileFacts {
  const tokens = tokenize(src);
  const starts = lineStarts(src);
  const consts = new Map<string, [number, number]>();
  const dup = new Set<string>();
  const libs = new Map<string, string>([
    ['axios', 'axios'],
    ['ky', 'ky'],
    ['superagent', 'superagent'],
  ]);
  const axiosInstances = new Map<string, [number, number] | null>();
  const t = tokens;
  const LIBS = new Set(['axios', 'ky', 'superagent']);
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    // import X from 'lib' / import * as X from 'lib'
    if (tok.k === 'id' && tok.v === 'import') {
      let j = i + 1;
      if (t[j]?.v === '*' && t[j + 1]?.v === 'as') j += 2;
      const name = t[j];
      if (name?.k === 'id' && t[j + 1]?.v === 'from' && t[j + 2]?.k === 'str' && LIBS.has(t[j + 2]!.v)) libs.set(name.v, t[j + 2]!.v);
      continue;
    }
    if (tok.k !== 'id' || (tok.v !== 'const' && tok.v !== 'let' && tok.v !== 'var')) continue;
    const name = t[i + 1];
    if (name?.k !== 'id') continue;
    let j = i + 2;
    // Optional type annotation: `: Type` up to '='.
    if (t[j]?.v === ':') {
      while (j < t.length && !(t[j]!.k === 'punc' && (t[j]!.v === '=' || t[j]!.v === ';'))) j++;
    }
    if (t[j]?.v !== '=') continue;
    const initStart = j + 1;
    // Initializer end: top-level ';' or ',' or a new statement on a later line.
    let depth = 0;
    let k = initStart;
    for (; k < t.length; k++) {
      const v = t[k]!;
      if (v.k === 'punc') {
        if (v.v === '(' || v.v === '[' || v.v === '{') depth++;
        else if (v.v === ')' || v.v === ']' || v.v === '}') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (v.v === ';' || v.v === ',')) break;
      }
      if (depth === 0 && k > initStart) {
        const prev = t[k - 1]!;
        const newLine = lineOf(starts, v.start) > lineOf(starts, prev.end);
        if (newLine && !(prev.k === 'punc' && prev.v === '+') && !(v.k === 'punc' && (v.v === '+' || v.v === '.' || v.v === '?.')) && (v.k === 'id' || v.k === 'str' || v.k === 'tpl' || STATEMENT_START.has(v.v))) break;
      }
    }
    // require('lib')
    if (t[initStart]?.v === 'require' && t[initStart + 1]?.v === '(' && t[initStart + 2]?.k === 'str' && LIBS.has(t[initStart + 2]!.v)) {
      libs.set(name.v, t[initStart + 2]!.v);
      continue;
    }
    // X = axios.create({ baseURL: ... })
    const callee = t[initStart];
    if (callee?.k === 'id' && libs.get(callee.v) === 'axios' && t[initStart + 1]?.v === '.' && t[initStart + 2]?.v === 'create' && t[initStart + 3]?.v === '(') {
      const close = skipGroup(t, initStart + 3);
      const cfg = close > 0 && t[initStart + 4]?.v === '{' ? objectProps(t, initStart + 5, close - 2) : undefined;
      axiosInstances.set(name.v, cfg?.get('baseURL') ?? null);
      continue;
    }
    if (tok.v !== 'const') continue;
    if (consts.has(name.v)) dup.add(name.v);
    consts.set(name.v, [initStart, k]);
  }
  for (const d of dup) consts.delete(d);
  return { src, starts, tokens, consts, libs, axiosInstances };
}

/** `{ key: expr, ... }` between from (after '{') and to (the '}'): property name → token range of the value. */
function objectProps(t: Tok[], from: number, to: number): Map<string, [number, number]> | undefined {
  if (t[from - 1]?.v !== '{') return undefined;
  const out = new Map<string, [number, number]>();
  for (const [a, b] of splitArgs(t, from, to)) {
    const key = t[a];
    if (!key || (key.k !== 'id' && key.k !== 'str')) continue;
    if (t[a + 1]?.v === ':') out.set(key.v, [a + 2, b]);
    else if (a + 1 === b && key.k === 'id') out.set(key.v, [a, b]); // shorthand { url }
  }
  return out;
}

// ------------------------------------------------------------------ call recognition

const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const HTTP_RECEIVER = /^(_?http|_?httpClient|\$http)$/i;

function literalMethod(f: FileFacts, range: [number, number] | undefined): string | undefined {
  if (!range) return undefined;
  const r = evalExpr(f, range[0], range[1]);
  if (!r.ok || r.parts.length !== 1 || !('lit' in r.parts[0]!)) return undefined;
  const m = r.parts[0].lit.trim().toUpperCase();
  return /^[A-Z]+$/.test(m) ? m : undefined;
}

function rangeOf(f: FileFacts, start: number, end: number): Range {
  return { start: positionAt(f.starts, start), end: positionAt(f.starts, end) };
}

function rawText(f: FileFacts, range: [number, number] | undefined): string {
  if (!range || range[0] >= range[1]) return '';
  const s = f.src.slice(f.tokens[range[0]]!.start, f.tokens[range[1] - 1]!.end).replace(/\s+/g, ' ');
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function prefixed(base: Part[] | undefined, url: Eval): Eval {
  if (!base || !url.ok) return url;
  return { ok: true, parts: [...base, ...url.parts] };
}

/** Finds the HTTP client calls of one TS/JS file. Pure; never throws. */
export function scanClientCalls(src: string): ClientCall[] {
  let f: FileFacts;
  try {
    f = collectFacts(src);
  } catch {
    return [];
  }
  const t = f.tokens;
  const calls: ClientCall[] = [];
  const emit = (form: string, calleeStart: number, open: number, urlRange: [number, number] | undefined, method: string | undefined, base?: Part[], baseReason?: string) => {
    const close = skipGroup(t, open);
    if (close < 0) return;
    const range = rangeOf(f, t[calleeStart]!.start, t[close - 1]!.end);
    const raw = rawText(f, urlRange);
    const call: ClientCall = { form, raw, range, ...(method ? { method } : {}) };
    if (baseReason) {
      calls.push({ ...call, reason: baseReason });
      return;
    }
    const ev = urlRange ? prefixed(base, evalExpr(f, urlRange[0], urlRange[1])) : ({ ok: false, reason: 'no URL argument' } as Eval);
    if (!ev.ok) {
      calls.push({ ...call, reason: ev.reason });
      return;
    }
    const u = partsToUrl(ev.parts);
    calls.push('url' in u ? { ...call, url: u.url } : { ...call, reason: u.reason });
  };
  const argsOf = (open: number): Array<[number, number]> => {
    const close = skipGroup(t, open);
    return close < 0 ? [] : splitArgs(t, open + 1, close - 1);
  };
  const configOf = (arg: [number, number] | undefined) => (arg && t[arg[0]]?.v === '{' && skipGroup(t, arg[0]) === arg[1] ? objectProps(t, arg[0] + 1, arg[1] - 1) : undefined);

  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.k !== 'id') continue;
    const prev = t[i - 1];
    const afterDot = prev?.k === 'punc' && (prev.v === '.' || prev.v === '?.');
    // Skip declarations like `function fetch(`, `get(` in a class body (method definitions are not calls).
    const declared = prev?.k === 'id' && (prev.v === 'function' || prev.v === 'async' || prev.v === 'get' || prev.v === 'set');

    // fetch(url, init)
    if (tok.v === 'fetch' && t[i + 1]?.v === '(' && !declared) {
      const globalRecv = afterDot && ['window', 'globalThis', 'self'].includes(t[i - 2]?.v ?? '') && !(t[i - 3]?.k === 'punc' && t[i - 3]!.v === '.');
      if (afterDot && !globalRecv) continue;
      const start = globalRecv ? i - 2 : i;
      const args = argsOf(i + 1);
      const init = args[1];
      const cfg = configOf(init);
      const method = !init ? 'GET' : cfg ? (cfg.has('method') ? literalMethod(f, cfg.get('method')) : 'GET') : undefined;
      emit('fetch', start, i + 1, args[0], method);
      continue;
    }
    // Angular HttpClient: <receiver>.http.get<T>(url) where the receiver chain ends with http/httpClient/_http.
    if (HTTP_RECEIVER.test(tok.v) && t[i + 1]?.v === '.' && t[i + 2]?.k === 'id' && VERBS.has(t[i + 2]!.v)) {
      // `this.http.get(...)` — the callee starts at `this` when present.
      const start = afterDot && t[i - 2]?.v === 'this' ? i - 2 : i;
      let open = i + 3;
      if (t[open]?.v === '<') {
        const e = skipGroup(t, open);
        if (e < 0) continue;
        open = e;
      }
      if (t[open]?.v !== '(') continue;
      emit(`${tok.v}.${t[i + 2]!.v}`, start, open, argsOf(open)[0], t[i + 2]!.v.toUpperCase());
      continue;
    }
    if (afterDot) continue;
    const lib = f.libs.get(tok.v);
    const inst = f.axiosInstances.has(tok.v) ? f.axiosInstances.get(tok.v) : undefined;
    const isInstance = f.axiosInstances.has(tok.v);
    const isNgHttp = tok.v === '$http';
    let baseParts: Part[] | undefined;
    let baseReason: string | undefined;
    if (isInstance && inst) {
      const b = evalExpr(f, inst[0], inst[1]);
      if (b.ok) baseParts = b.parts;
      else baseReason = `the baseURL of ${tok.v} is not a literal (${b.reason})`;
    }
    const kind = isInstance ? 'axios' : isNgHttp ? 'ng' : lib;
    if (kind) {
      const name = tok.v;
      // lib.verb(url, ...)
      if (t[i + 1]?.v === '.' && t[i + 2]?.k === 'id') {
        const verbTok = t[i + 2]!;
        let open = i + 3;
        if (t[open]?.v === '<') {
          const e = skipGroup(t, open);
          if (e < 0) continue;
          open = e;
        }
        if (t[open]?.v !== '(') continue;
        const verb = verbTok.v === 'del' && kind === 'superagent' ? 'delete' : verbTok.v;
        if (VERBS.has(verb)) {
          emit(`${name}.${verbTok.v}`, i, open, argsOf(open)[0], verb.toUpperCase(), baseParts, baseReason);
        } else if (verb === 'request' && (kind === 'axios' || kind === 'ng')) {
          const cfg = configOf(argsOf(open)[0]);
          if (cfg) emit(`${name}.request`, i, open, cfg.get('url'), cfg.has('method') ? literalMethod(f, cfg.get('method')) : 'GET', baseParts, baseReason);
        }
        continue;
      }
      // lib(url, cfg) / lib({ url, method })
      if (t[i + 1]?.v === '(' && kind !== 'superagent') {
        const args = argsOf(i + 1);
        const first = configOf(args[0]);
        if (first) {
          if (kind === 'ky') continue;
          emit(name, i, i + 1, first.get('url'), first.has('method') ? literalMethod(f, first.get('method')) : 'GET', baseParts, baseReason);
        } else if (kind !== 'ng') {
          const cfg = configOf(args[1]);
          const method = !args[1] ? 'GET' : cfg ? (cfg.has('method') ? literalMethod(f, cfg.get('method')) : 'GET') : undefined;
          emit(name, i, i + 1, args[0], method, baseParts, baseReason);
        }
      }
      continue;
    }
  }
  return calls;
}
