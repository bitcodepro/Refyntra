// Inline debug values and hover expressions for C# (Rider-like). Pure: unit-tested with vitest (no vscode).
// A fast syntax pass over the text of the stopped method: no host request, no evaluation here. The provider
// (inlineValues.ts) turns the entries into InlineValueVariableLookup / InlineValueEvaluatableExpression; VS Code asks
// the debug adapter (netcoredbg) for the values. Only names and member chains are produced — never a call — so the
// evaluation has no side effects beyond what the debugger does itself (netcoredbg may run property getters).

export interface InlineEntry {
  line: number;
  start: number;
  end: number;
  name: string;
  /** 'lookup' = a local or parameter (Variables view); 'expression' = a field or `this.x` (evaluated). */
  kind: 'lookup' | 'expression';
  expression?: string;
}

const KEYWORDS = new Set(
  ('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var await async yield when record init get set value nameof dynamic let from select where').split(' '),
);
const CONTROL = /^\s*(if|for|foreach|while|switch|catch|using|lock|fixed|else|do|try|finally|return|checked|unchecked)\b/;

/** Blanks comments, string and char literals (keeps columns) so the scanner never sees names inside them. */
export function maskCode(lines: readonly string[]): string[] {
  const out: string[] = [];
  let block = false;
  for (const line of lines) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      const n = line[i + 1];
      if (block) {
        if (c === '*' && n === '/') { block = false; s += '  '; i += 2; } else { s += ' '; i++; }
        continue;
      }
      if (c === '/' && n === '/') { s += ' '.repeat(line.length - i); break; }
      if (c === '/' && n === '*') { block = true; s += '  '; i += 2; continue; }
      if (c === '"' || c === "'") {
        const verbatim = c === '"' && (line[i - 1] === '@' || line[i - 2] === '@');
        let j = i + 1;
        for (; j < line.length; j++) {
          if (!verbatim && line[j] === '\\') { j++; continue; }
          if (verbatim && line[j] === '"' && line[j + 1] === '"') { j++; continue; }
          if (line[j] === c) break;
        }
        s += c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
        i = j + 1;
        continue;
      }
      s += c;
      i++;
    }
    out.push(s);
  }
  return out;
}

/** The line of the header of the method / constructor / local function / accessor that contains `line`, or -1. */
export function enclosingMethodStart(masked: readonly string[], line: number): number {
  let depth = 0;
  for (let l = Math.min(line, masked.length - 1); l >= 0; l--) {
    const text = masked[l]!;
    const limit = l === line ? text.length : text.length;
    for (let i = limit - 1; i >= 0; i--) {
      const c = text[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth > 0) { depth--; continue; }
        // An opening brace that encloses the line: is it a method body?
        const header = headerBefore(masked, l, i);
        if (header && isMethodHeader(header.text)) return header.line;
      }
    }
    // Expression-bodied member on a single line: `int F(int a) => a + 1;`
    if (l === line && /\)\s*=>/.test(text) && isMethodHeader(text.slice(0, text.indexOf('=>')))) return l;
  }
  return -1;
}

/** True for a top-level statement (C# 9 Program.cs): not inside a type, namespace or method. */
export function isTopLevelStatement(masked: readonly string[], line: number): boolean {
  if (masked.some((l) => /^\s*namespace\s+[\w.]+\s*;/.test(l))) return false;
  if (/^\s*(using|namespace|global\s+using)\b/.test(masked[line] ?? '')) return false;
  let depth = 0;
  for (let l = Math.min(line, masked.length - 1); l >= 0; l--) {
    const text = masked[l]!;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        if (depth > 0) { depth--; continue; }
        const header = headerBefore(masked, l, i);
        if (!header || /\b(class|struct|record|interface|namespace|enum)\b/.test(header.text) || isMethodHeader(header.text)) return false;
      }
    }
  }
  return true;
}

function headerBefore(masked: readonly string[], line: number, col: number): { line: number; text: string } | undefined {
  let text = masked[line]!.slice(0, col);
  let l = line;
  // Walk back over lines until the header text has balanced parentheses (multi-line parameter lists).
  for (let guard = 0; guard < 12; guard++) {
    const trimmed = text.trim();
    const opens = (text.match(/\(/g) ?? []).length;
    const closes = (text.match(/\)/g) ?? []).length;
    if (trimmed.length > 0 && opens === closes && !/^[,)]/.test(trimmed)) return { line: l, text };
    if (l === 0) return trimmed ? { line: l, text } : undefined;
    l--;
    text = `${masked[l]!} ${text}`;
    if (/[;{}]\s*$/.test(masked[l]!.trimEnd()) && opens === closes) return { line: l + 1, text: text.slice(masked[l]!.length + 1) };
  }
  return { line: l, text };
}

function isMethodHeader(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (CONTROL.test(t)) return false;
  if (/^(get|set|init|add|remove)$/.test(t) || /\b(get|set|init)$/.test(t)) return true;
  if (!/\)\s*(where\s.*)?$/.test(t) && !/\)\s*:\s*(base|this)\s*\(.*\)$/.test(t)) return false;
  if (/\b(class|struct|record|interface|namespace|new|switch)\b[^(]*$/.test(t.slice(0, t.indexOf('(')))) return false;
  if (/=>\s*$/.test(t) || /=\s*\(?[^)]*\)?\s*=>/.test(t)) return true; // lambda
  return /[A-Za-z_][\w<>,\s?\[\]]*\s*\(/.test(t);
}

const IDENT = '[A-Za-z_@][\\w]*';

/** Parameters of the header text: the last identifier of each top-level comma part (before a default value). */
export function parameterNames(header: string): string[] {
  const open = header.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < header.length; i++) {
    if (header[i] === '(') depth++;
    else if (header[i] === ')' && --depth === 0) { close = i; break; }
  }
  const inner = header.slice(open + 1, close < 0 ? undefined : close);
  const parts: string[] = [];
  let d = 0;
  let cur = '';
  for (const c of inner) {
    if (c === '<' || c === '(' || c === '[') d++;
    if (c === '>' || c === ')' || c === ']') d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const names: string[] = [];
  for (const p of parts) {
    const decl = p.split('=')[0]!.trim();
    const m = new RegExp(`(${IDENT})\\s*$`).exec(decl);
    if (m && decl.includes(' ') && !KEYWORDS.has(m[1]!)) names.push(m[1]!.replace(/^@/, ''));
  }
  return names;
}

/**
 * The inline values of a stopped frame: names declared, assigned or used as parameters on the lines of the stopped
 * method from its header up to the stopped line, limited to [visibleStart, visibleEnd]. One entry per name per line.
 */
export function inlineValueEntries(lines: readonly string[], stoppedLine: number, visibleStart = 0, visibleEnd = Number.MAX_SAFE_INTEGER): InlineEntry[] {
  const masked = maskCode(lines);
  const scope = enclosingMethodStart(masked, stoppedLine);
  const topLevel = scope < 0 && isTopLevelStatement(masked, stoppedLine);
  if (scope < 0 && !topLevel) return [];
  const start = topLevel ? 0 : scope;
  const locals = new Set<string>();
  const out: InlineEntry[] = [];
  const seen = new Set<string>();
  const add = (line: number, col: number, name: string, kind: InlineEntry['kind'], expression?: string) => {
    const key = `${line}:${expression ?? name}`;
    if (seen.has(key) || KEYWORDS.has(name)) return;
    seen.add(key);
    if (line < visibleStart || line > visibleEnd) return;
    out.push({ line, start: col, end: col + (expression ?? name).length, name, kind, ...(expression ? { expression } : {}) });
  };

  // Header (possibly several lines): parameters.
  let headerText = '';
  let headerEnd = start;
  for (let l = start; l <= stoppedLine && !topLevel; l++) {
    headerText += `${masked[l]!} `;
    headerEnd = l;
    if (/[{]|=>/.test(masked[l]!)) break;
  }
  for (const p of parameterNames(headerText)) {
    locals.add(p);
    for (let l = start; l <= headerEnd; l++) {
      const m = new RegExp(`\\b@?${p}\\b`).exec(masked[l]!);
      if (m) { add(l, m.index, p, 'lookup'); break; }
    }
  }

  const declRe = new RegExp(`(?:\\b(?:var|${IDENT}(?:<[^;=()]*?>)?(?:\\[\\])?\\??)\\s+)(${IDENT})\\s*(?==[^=>]|;|\\bin\\b|\\))`, 'g');
  const outVarRe = new RegExp(`\\bout\\s+(?:var|${IDENT})\\s+(${IDENT})`, 'g');
  const tupleRe = /\b(?:var\s*)?\(([^()]*)\)\s*=[^=>]/g;
  const assignRe = new RegExp(`(?<![.\\w])(this\\.)?(${IDENT})\\s*(?:[+\\-*/%&|^]|\\?\\?|<<|>>)?=(?![=>])|(?<![.\\w])(this\\.)?(${IDENT})\\s*(?:\\+\\+|--)|(?:\\+\\+|--)(this\\.)?(${IDENT})\\b`, 'g');
  const usedParamRe = new RegExp(`(?<![.\\w])(${IDENT})\\b`, 'g');
  // A field read: `_name` / `m_name` or `this.Member`, not called (`(`) and not assigned (assignments are found above).
  const fieldReadRe = /(?<![.\w])(this\.)?((?:_|m_)\w*|(?<=this\.)[A-Za-z_]\w*)\b(?!\s*\()(?!\s*(?:[-+*/%&|^]|\?\?|<<|>>)?=(?!=))/g;

  for (let l = headerEnd; l <= stoppedLine && l < masked.length; l++) {
    if (topLevel && /^\s*(using|global\s+using)\b/.test(masked[l]!)) continue;
    const text = l === headerEnd && !topLevel ? masked[l]!.slice(Math.max(0, masked[l]!.search(/[{]|=>/))) : masked[l]!;
    const offset = masked[l]!.length - text.length;
    if (l > headerEnd && enclosingMethodStart(masked, l) !== scope) continue; // nested local function / lambda body
    for (const m of text.matchAll(declRe)) {
      const name = m[1]!;
      const before = text.slice(0, m.index);
      if (KEYWORDS.has(name) || /\b(return|new|is|case)\s*$/.test(before) || /\bnew\s+[\w.<>]*$/.test(before)) continue;
      const typeWord = /^\s*([\w@]+)/.exec(m[0])?.[1];
      if (typeWord && (typeWord === 'return' || typeWord === 'await' || typeWord === 'else' || typeWord === 'throw')) continue;
      locals.add(name);
      add(l, offset + m.index! + m[0].lastIndexOf(name), name, 'lookup');
    }
    for (const m of text.matchAll(outVarRe)) { locals.add(m[1]!); add(l, offset + m.index! + m[0].lastIndexOf(m[1]!), m[1]!, 'lookup'); }
    for (const m of text.matchAll(tupleRe)) {
      let col = m.index! + m[0].indexOf('(') + 1;
      for (const part of m[1]!.split(',')) {
        const nm = new RegExp(`(${IDENT})\\s*$`).exec(part.trim())?.[1];
        if (nm && !KEYWORDS.has(nm)) { locals.add(nm); add(l, offset + col + part.lastIndexOf(nm), nm, 'lookup'); }
        col += part.length + 1;
      }
    }
    for (const m of text.matchAll(assignRe)) {
      const isThis = Boolean(m[1] ?? m[3] ?? m[5]);
      const name = (m[2] ?? m[4] ?? m[6])!;
      const col = offset + m.index! + m[0].indexOf(isThis ? 'this.' : name);
      if (isThis) add(l, col, name, 'expression', `this.${name}`);
      else if (locals.has(name)) add(l, col, name, 'lookup');
      else if (!/^[A-Z]/.test(name) || /^_/.test(name)) add(l, col, name, 'expression', name); // a field (implicit this)
    }
    // Fields read on the line (an `if` condition, an argument): `_name`, `this.Name`.
    if (l > headerEnd || topLevel) {
      for (const m of text.matchAll(fieldReadRe)) {
        const name = m[2]!;
        if (locals.has(name) || KEYWORDS.has(name)) continue;
        add(l, offset + m.index!, name, 'expression', m[1] ? `this.${name}` : name);
      }
    }
    // Parameters and known locals that appear on later lines (Rider shows them on the line where they are used last).
    if (l > headerEnd || topLevel) {
      for (const m of text.matchAll(usedParamRe)) {
        if (locals.has(m[1]!) && text[m.index! + m[1]!.length] !== '(') add(l, offset + m.index!, m[1]!, 'lookup');
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** Shortens a debugger value for inline display. */
export function truncateValue(value: string, max = 60): string {
  const one = value.replace(/\s*\r?\n\s*/g, ' ');
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * The member chain under the cursor for hover evaluation: `a.B.C` when hovering C (up to the hovered segment), `this.x`.
 * Returns undefined over a call (`F(` / `.F(`), a keyword or a literal — nothing with side effects is evaluated.
 */
export function evaluatableChain(lineText: string, character: number): { start: number; end: number; expression: string } | undefined {
  const masked = maskCode([lineText])[0]!;
  const isId = (c: string | undefined) => !!c && /[\w@]/.test(c);
  let s = character;
  let e = character;
  if (!isId(masked[s]) && isId(masked[s - 1])) s = e = character - 1;
  if (!isId(masked[s])) return undefined;
  while (isId(masked[s - 1])) s--;
  while (isId(masked[e])) e++;
  const word = masked.slice(s, e);
  if (/^\d/.test(word) || (KEYWORDS.has(word) && word !== 'this' && word !== 'base')) return undefined;
  let after = e;
  while (masked[after] === ' ') after++;
  if (masked[after] === '(' || masked[after] === '<' && /^<[\w.,\s<>]*>\s*\(/.test(masked.slice(after))) return undefined;
  // Extend left over `.Ident` / `?.Ident` segments; stop at a call, an indexer or anything else.
  let start = s;
  for (;;) {
    let p = start - 1;
    while (masked[p] === ' ') p--;
    if (masked[p] !== '.') break;
    p--;
    if (masked[p] === '?') p--;
    while (masked[p] === ' ') p--;
    if (!isId(masked[p])) return { start: s, end: e, expression: word }; // `x().Y` or `a[0].Y`: only the word
    let q = p;
    while (isId(masked[q - 1])) q--;
    const seg = masked.slice(q, p + 1);
    if (/^\d/.test(seg) || (KEYWORDS.has(seg) && seg !== 'this' && seg !== 'base')) break;
    start = q;
  }
  const expression = lineText.slice(start, e).replace(/\s+/g, '');
  return { start, end: e, expression };
}
