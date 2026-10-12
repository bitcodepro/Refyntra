// Constructor and DI helpers for C# (ReSharper "Introduce and initialize field", "Generate constructor",
// "Initialize from constructor", "Create field and inject", "Register in DI"). Pure: unit-tested with vitest (no
// vscode). A syntax pass over the document text — offsets in, text edits out. The provider (constructorActions.ts)
// applies edits that touch only the current document directly (one undo step, like other quick fixes) and edits in
// another file (DI registration) through VS Code's refactor preview.
import { maskCode } from './inlineValuesModel';

export interface Edit { offset: number; length: number; text: string }

export interface FieldInfo {
  name: string;
  type: string;
  readonly: boolean;
  isStatic: boolean;
  isConst: boolean;
  hasInitializer: boolean;
  start: number;
  end: number;
  /** Offset of the field name (for "on the field" detection). */
  nameOffset: number;
}

export interface PropertyInfo { name: string; type: string; start: number; end: number; getOnly: boolean; hasInitializer: boolean }

export interface ParameterInfo { name: string; type: string; start: number; end: number }

export interface CtorInfo {
  start: number;
  end: number;
  paramsOpen: number;
  paramsClose: number;
  params: ParameterInfo[];
  /** Offsets of `{` and `}` of the body; undefined for an expression body. */
  bodyOpen?: number;
  bodyClose?: number;
  bodyText: string;
}

export interface ClassInfo {
  kind: 'class' | 'struct' | 'record' | 'record struct';
  name: string;
  isStatic: boolean;
  isPartial: boolean;
  start: number;
  nameOffset: number;
  bodyOpen: number;
  bodyClose: number;
  primaryParams?: ParameterInfo[];
  fields: FieldInfo[];
  properties: PropertyInfo[];
  ctors: CtorInfo[];
  /** Indentation of members. */
  indent: string;
  /** One indentation step. */
  unit: string;
  eol: string;
}

export interface NamingStyle {
  /** Prefix of private instance fields: '_' (default), 'm_' or ''. */
  prefix: string;
  /** Qualify field access with `this.` (always needed when the field name equals the parameter name). */
  useThis: boolean;
  /** Where the style came from (shown in the action title tooltip / docs). */
  source: 'editorconfig' | 'existing fields' | 'default';
}

const KEYWORDS = new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var await async required partial file record init'.split(' '));
const MODIFIERS = /\b(public|private|protected|internal|static|readonly|const|volatile|new|required|unsafe|file|override|virtual|abstract|sealed|extern|partial|async)\b/g;

function maskText(text: string): string {
  return maskCode(text.split('\n')).join('\n');
}

function matchClose(m: string, open: number, o = '{', c = '}'): number {
  let d = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === o) d++;
    else if (m[i] === c && --d === 0) return i;
  }
  return -1;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentAt(text: string, offset: number): string {
  const s = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(s))![0];
}

/** Splits a parameter list (text between the parentheses) into parameters with offsets. */
export function parseParameters(text: string, open: number, close: number): ParameterInfo[] {
  const out: ParameterInfo[] = [];
  let d = 0;
  let segStart = open + 1;
  const push = (end: number) => {
    const raw = text.slice(segStart, end);
    const decl = raw.split('=')[0]!.replace(/\[[^\]]*\]\s*/g, (s, i: number) => (i === raw.search(/\S/) ? ' '.repeat(s.length) : s));
    const m = /^(\s*)((?:(?:this|ref|out|in|params|scoped)\s+)*)(.+?)\s+(@?[A-Za-z_]\w*)\s*$/.exec(decl);
    if (m) out.push({ name: m[4]!, type: m[3]!.trim(), start: segStart + m[1]!.length, end: segStart + raw.trimEnd().length });
    segStart = end + 1;
  };
  for (let i = open + 1; i < close; i++) {
    const c = text[i];
    if (c === '<' || c === '(' || c === '[') d++;
    else if (c === '>' || c === ')' || c === ']') d--;
    else if (c === ',' && d === 0) push(i);
  }
  if (text.slice(open + 1, close).trim()) push(close);
  return out;
}

/** The innermost class/struct/record whose declaration or body contains `offset`. */
export function findClass(text: string, offset: number): ClassInfo | undefined {
  const m = maskText(text);
  const re = /\b(?:(record\s+struct|record\s+class|record|class|struct))\s+(@?[A-Za-z_]\w*)/g;
  let best: ClassInfo | undefined;
  for (const hit of m.matchAll(re)) {
    const declStart = lineStart(m, hit.index!);
    const before = m.slice(declStart, hit.index!);
    if (/[=(]|\bnew\b|\bwhere\b/.test(before)) continue;
    const bodyOpen = m.indexOf('{', hit.index!);
    const semi = m.indexOf(';', hit.index!);
    if (bodyOpen < 0 || (semi >= 0 && semi < bodyOpen)) continue; // `record R(int A);`
    const bodyClose = matchClose(m, bodyOpen);
    if (bodyClose < 0 || offset < declStart || offset > bodyClose) continue;
    if (best && hit.index! < best.start) continue;
    const kindRaw = hit[1]!.replace(/\s+/g, ' ');
    const kind: ClassInfo['kind'] = kindRaw === 'record class' ? 'record' : (kindRaw as ClassInfo['kind']);
    const name = hit[2]!;
    const header = m.slice(hit.index! + hit[0].length, bodyOpen);
    let primaryParams: ParameterInfo[] | undefined;
    const genericEnd = header.trimStart().startsWith('<') ? matchClose(m, hit.index! + hit[0].length + header.indexOf('<'), '<', '>') : hit.index! + hit[0].length - 1;
    const afterName = m.slice(genericEnd + 1, bodyOpen);
    const po = afterName.search(/^\s*\(/);
    if (po === 0) {
      const open = genericEnd + 1 + afterName.indexOf('(');
      primaryParams = parseParameters(text, open, matchClose(m, open, '(', ')'));
    }
    const mods = m.slice(declStart, hit.index!);
    best = {
      kind,
      name,
      isStatic: /\bstatic\b/.test(mods),
      isPartial: /\bpartial\b/.test(mods),
      start: declStart,
      nameOffset: hit.index! + hit[0].length - name.length,
      bodyOpen,
      bodyClose,
      ...(primaryParams ? { primaryParams } : {}),
      fields: [],
      properties: [],
      ctors: [],
      indent: '',
      unit: '    ',
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    };
  }
  if (!best) return undefined;
  readMembers(text, m, best);
  return best;
}

function readMembers(text: string, m: string, c: ClassInfo): void {
  const classIndent = indentAt(text, c.start);
  c.unit = /\t/.test(classIndent) ? '\t' : detectUnit(text);
  c.indent = classIndent + c.unit;
  let i = c.bodyOpen + 1;
  let segStart = i;
  let firstMember = true;
  while (i < c.bodyClose) {
    const ch = m[i];
    if (ch === '{' || ch === ';' || (ch === '=' && m[i + 1] === '>')) {
      const head = m.slice(segStart, i);
      let end: number;
      if (ch === '{') {
        end = matchClose(m, i);
        let j = end + 1;
        while (/\s/.test(m[j] ?? '')) j++;
        if (m[j] === '=' && m[j + 1] !== '>') end = m.indexOf(';', j); // property initializer
      } else if (ch === '=') end = m.indexOf(';', i);
      else end = i;
      if (end < 0) break;
      classifyMember(text, m, c, segStart, head, i, end, firstMember);
      firstMember = false;
      i = end + 1;
      segStart = i;
      continue;
    }
    i++;
  }
}

function detectUnit(text: string): string {
  const counts = new Map<number, number>();
  for (const l of text.split('\n')) {
    const n = /^( +)\S/.exec(l)?.[1]!.length;
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const smallest = [...counts.keys()].sort((a, b) => a - b)[0];
  return ' '.repeat(smallest === 2 ? 2 : 4);
}

function classifyMember(text: string, m: string, c: ClassInfo, segStart: number, head: string, at: number, end: number, _first: boolean): void {
  const lead = head.search(/\S/);
  if (lead < 0) return;
  const start = segStart + lead;
  const h = head.trim().replace(/^(\[[^\]]*\]\s*)+/, '');
  if (/\b(class|struct|interface|enum|record|delegate|event)\b/.test(h)) return;
  const ctorRe = new RegExp(`^(?:(?:public|private|protected|internal|static)\\s+)*${c.name.replace('@', '\\@')}\\s*\\(`);
  if (ctorRe.test(h) && !/\bstatic\b/.test(h.split('(')[0]!)) {
    const paramsOpen = m.indexOf('(', start);
    const paramsClose = matchClose(m, paramsOpen, '(', ')');
    const ctor: CtorInfo = { start, end: end + 1, paramsOpen, paramsClose, params: parseParameters(text, paramsOpen, paramsClose), bodyText: text.slice(paramsClose + 1, end + 1) };
    if (m[at] === '{') {
      ctor.bodyOpen = at;
      ctor.bodyClose = end;
    }
    c.ctors.push(ctor);
    return;
  }
  const beforeEq = h.split(/=(?!>)/)[0]!;
  if (beforeEq.includes('(')) return; // method, operator, indexer-like
  if (m[at] === '{' || (m[at] === '=' && m[at + 1] === '>')) {
    const pm = /(\S+(?:<[^>]*>)?\??(?:\[\])?)\s+(@?[A-Za-z_]\w*)\s*$/.exec(h.replace(MODIFIERS, ' ').replace(/\s+/g, ' '));
    if (!pm || h.includes('this[')) return;
    const body = m.slice(at, end + 1);
    c.properties.push({ name: pm[2]!, type: pm[1]!, start, end: end + 1, getOnly: m[at] === '{' && /\bget\b/.test(body) && !/\bset\b/.test(body), hasInitializer: /}\s*=/.test(body) });
    return;
  }
  // Field(s): `private readonly IFoo _foo;`, `int a, b = 1;`
  const mods = (h.match(MODIFIERS) ?? []).join(' ');
  const rest = h.replace(MODIFIERS, ' ').trim();
  const decl = /^(\S+?(?:<.*>)?\??(?:\[\])?)\s+(.+)$/s.exec(rest);
  if (!decl) return;
  const type = decl[1]!;
  if (KEYWORDS.has(type) && !/^(bool|byte|char|decimal|double|float|int|long|object|sbyte|short|string|uint|ulong|ushort)$/.test(type)) return;
  for (const part of splitTop(decl[2]!)) {
    const nm = /^\s*(@?[A-Za-z_]\w*)\s*(=)?/.exec(part);
    if (!nm) continue;
    const nameOffset = text.indexOf(nm[1]!, start + h.length - rest.length - 1 >= 0 ? start : start);
    c.fields.push({
      name: nm[1]!,
      type,
      readonly: /\breadonly\b/.test(mods),
      isStatic: /\bstatic\b/.test(mods),
      isConst: /\bconst\b/.test(mods),
      hasInitializer: Boolean(nm[2]),
      start,
      end: end + 1,
      nameOffset: findWord(m, nm[1]!, start, end),
    });
    void nameOffset;
  }
}

function findWord(m: string, word: string, from: number, to: number): number {
  const re = new RegExp(`\\b${word.replace('@', '\\@')}\\b`, 'g');
  re.lastIndex = from;
  const hit = re.exec(m);
  return hit && hit.index < to ? hit.index : from;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of s) {
    if ('<([{'.includes(ch)) d++;
    if ('>)]}'.includes(ch)) d--;
    if (ch === ',' && d === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- naming

/** Reads the private-field naming rule and `this.` qualification from .editorconfig text (for *.cs sections). */
export function namingFromEditorConfig(editorconfig: string): Partial<NamingStyle> | undefined {
  const lines = editorconfig.split(/\r?\n/).map((l) => l.replace(/[#;].*$/, '').trim());
  const kv = new Map<string, string>();
  let applies = true;
  for (const l of lines) {
    const sec = /^\[(.*)\]$/.exec(l);
    if (sec) {
      applies = /\*|\.cs\b|\{.*cs.*\}/.test(sec[1]!);
      continue;
    }
    const p = /^([^=]+?)\s*=\s*(.*)$/.exec(l);
    if (p && applies) kv.set(p[1]!.toLowerCase(), p[2]!.split(':')[0]!.trim());
  }
  const out: Partial<NamingStyle> = {};
  const q = kv.get('dotnet_style_qualification_for_field');
  if (q) out.useThis = q === 'true';
  for (const [k, v] of kv) {
    const rule = /^dotnet_naming_rule\.([\w-]+)\.symbols$/.exec(k);
    if (!rule) continue;
    const kinds = kv.get(`dotnet_naming_symbols.${v}.applicable_kinds`) ?? '';
    const access = kv.get(`dotnet_naming_symbols.${v}.applicable_accessibilities`) ?? '*';
    const modifiers = kv.get(`dotnet_naming_symbols.${v}.required_modifiers`) ?? '';
    if (!/\bfield\b|\*/.test(kinds) || !/private|\*/.test(access) || /\b(const|static)\b/.test(modifiers)) continue;
    const style = kv.get(`dotnet_naming_rule.${rule[1]}.style`);
    if (!style) continue;
    const prefix = kv.get(`dotnet_naming_style.${style}.required_prefix`);
    const cap = kv.get(`dotnet_naming_style.${style}.capitalization`);
    if (prefix !== undefined || cap === 'camel_case') {
      out.prefix = prefix ?? '';
      break;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** The naming style: .editorconfig first, then the class's (or file's) existing private instance fields, then `_camel`. */
export function namingStyle(c: ClassInfo | undefined, editorconfig?: string, fileText?: string): NamingStyle {
  const fromConfig = editorconfig ? namingFromEditorConfig(editorconfig) : undefined;
  if (fromConfig?.prefix !== undefined) return { prefix: fromConfig.prefix, useThis: fromConfig.useThis ?? fromConfig.prefix === '', source: 'editorconfig' };
  const names = (c?.fields ?? []).filter((f) => !f.isStatic && !f.isConst).map((f) => f.name);
  const pool = names.length ? names : [...(fileText ?? '').matchAll(/\bprivate\s+(?:readonly\s+)?[\w<>,.?\[\] ]+?\s+(@?[A-Za-z_]\w*)\s*[;=]/g)].map((x) => x[1]!);
  const underscore = pool.filter((n) => n.startsWith('_')).length;
  const mPrefix = pool.filter((n) => n.startsWith('m_')).length;
  const camel = pool.filter((n) => /^[a-z]/.test(n) && !n.startsWith('m_')).length;
  const useThis = fromConfig?.useThis;
  if (pool.length && mPrefix > underscore && mPrefix >= camel) return { prefix: 'm_', useThis: useThis ?? false, source: 'existing fields' };
  if (pool.length && camel > underscore) return { prefix: '', useThis: useThis ?? true, source: 'existing fields' };
  if (pool.length) return { prefix: '_', useThis: useThis ?? false, source: 'existing fields' };
  return { prefix: '_', useThis: useThis ?? false, source: 'default' };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function bareName(name: string): string {
  return name.replace(/^@/, '').replace(/^(m_|s_|_)/, '');
}

export function fieldNameFor(param: string, style: NamingStyle): string {
  return `${style.prefix}${lowerFirst(bareName(param))}`;
}

export function propertyNameFor(param: string): string {
  return upperFirst(bareName(param));
}

const RESERVED = new Set([...KEYWORDS, 'string', 'object', 'int', 'bool', 'event', 'operator', 'class']);
export function parameterNameFor(member: string): string {
  const n = lowerFirst(bareName(member));
  return RESERVED.has(n) ? `@${n}` : n;
}

/** Parameter name from a type: `IOrderRepository` → `orderRepository`, `ILogger<X>` → `logger`. */
export function parameterNameForType(type: string): string {
  const t = type.replace(/<.*$/, '').replace(/\?$/, '').split('.').pop()!;
  return parameterNameFor(/^I[A-Z]/.test(t) ? t.slice(1) : t);
}

function assignTarget(field: string, param: string, style: NamingStyle): string {
  return style.useThis || field === param.replace(/^@/, '') ? `this.${field}` : field;
}

// ---------------------------------------------------------------- queries

export function isAssignedInCtor(ctor: CtorInfo, member: string): boolean {
  return new RegExp(`(?<![\\w.])(this\\.)?${member.replace('@', '\\@')}\\s*(\\?\\?)?=(?![=>])`).test(maskText(ctor.bodyText));
}

/** Readonly instance fields (and get-only auto-properties) not initialised and not assigned in any constructor. */
export function unassignedMembers(c: ClassInfo): { name: string; type: string; kind: 'field' | 'property' }[] {
  const assigned = (n: string) => c.ctors.some((k) => isAssignedInCtor(k, n) || /:\s*this\s*\(/.test(maskText(k.bodyText).split('{')[0]!));
  const out: { name: string; type: string; kind: 'field' | 'property' }[] = [];
  for (const f of c.fields) if (f.readonly && !f.isStatic && !f.hasInitializer && !assigned(f.name)) out.push({ name: f.name, type: f.type, kind: 'field' });
  for (const p of c.properties) if (p.getOnly && !p.hasInitializer && !assigned(p.name)) out.push({ name: p.name, type: p.type, kind: 'property' });
  return out;
}

/** Fields and properties a "Generate constructor" can take: instance, settable from a constructor, not initialised. */
export function constructorCandidates(c: ClassInfo): { name: string; type: string; kind: 'field' | 'property'; preselect: boolean }[] {
  const unassigned = new Set(unassignedMembers(c).map((u) => u.name));
  return [
    ...c.fields.filter((f) => !f.isStatic && !f.isConst && !f.hasInitializer).map((f) => ({ name: f.name, type: f.type, kind: 'field' as const, preselect: f.readonly && unassigned.has(f.name) })),
    ...c.properties.filter((p) => !p.hasInitializer).map((p) => ({ name: p.name, type: p.type, kind: 'property' as const, preselect: p.getOnly && unassigned.has(p.name) })),
  ];
}

/** The constructor parameter at `offset` (in a constructor's parameter list or a primary constructor). */
export function parameterAt(c: ClassInfo, offset: number): { ctor?: CtorInfo; param: ParameterInfo; primary: boolean } | undefined {
  for (const k of c.ctors) {
    const p = k.params.find((x) => offset >= x.start && offset <= x.end);
    if (p) return { ctor: k, param: p, primary: false };
  }
  const p = c.primaryParams?.find((x) => offset >= x.start && offset <= x.end);
  return p ? { param: p, primary: true } : undefined;
}

export function fieldAt(c: ClassInfo, offset: number): FieldInfo | undefined {
  return c.fields.find((f) => offset >= f.start && offset <= f.end && (c.fields.filter((x) => x.start === f.start).length === 1 || (offset >= f.nameOffset && offset <= f.nameOffset + f.name.length)));
}

// ---------------------------------------------------------------- edits

function fieldInsertOffset(text: string, c: ClassInfo): number {
  const last = [...c.fields].filter((f) => !f.isConst).sort((a, b) => b.end - a.end)[0] ?? [...c.fields].sort((a, b) => b.end - a.end)[0];
  if (last) return lineEnd(text, last.end);
  return lineEnd(text, c.bodyOpen);
}

function lineEnd(text: string, offset: number): number {
  const n = text.indexOf('\n', offset);
  return n < 0 ? text.length : n + 1;
}

function ctorInsertOffset(text: string, c: ClassInfo): { offset: number; leadingBlank: boolean } {
  const lastField = [...c.fields, ...c.properties].sort((a, b) => b.end - a.end)[0];
  if (lastField) return { offset: lineEnd(text, lastField.end), leadingBlank: true };
  return { offset: lineEnd(text, c.bodyOpen), leadingBlank: false };
}

export function fieldDeclaration(c: ClassInfo, type: string, name: string, initializer?: string): string {
  return `${c.indent}private readonly ${type} ${name}${initializer ? ` = ${initializer}` : ''};${c.eol}`;
}

/** Adds `param` to the constructor's parameter list. */
export function addParameterEdit(text: string, ctor: CtorInfo, type: string, name: string): Edit {
  const inner = text.slice(ctor.paramsOpen + 1, ctor.paramsClose);
  return { offset: ctor.paramsClose, length: 0, text: inner.trim() ? `, ${type} ${name}` : `${type} ${name}` };
}

/** Adds statements at the end of the constructor body (block bodies; expression bodies are converted). */
export function addStatementsEdit(text: string, c: ClassInfo, ctor: CtorInfo, statements: string[]): Edit {
  const body = c.indent + c.unit;
  if (ctor.bodyOpen === undefined || ctor.bodyClose === undefined) {
    const arrow = text.indexOf('=>', ctor.paramsClose);
    const expr = text.slice(arrow + 2, ctor.end - 1).trim();
    let from = arrow;
    while (from > 0 && /[ 	]/.test(text[from - 1]!)) from--;
    return { offset: from, length: ctor.end - from, text: `${c.eol}${c.indent}{${c.eol}${body}${expr};${c.eol}${statements.map((s) => `${body}${s}${c.eol}`).join('')}${c.indent}}` };
  }
  const closeLine = lineStart(text, ctor.bodyClose);
  const onlyWs = /^\s*$/.test(text.slice(closeLine, ctor.bodyClose));
  if (onlyWs) return { offset: closeLine, length: 0, text: statements.map((s) => `${body}${s}${c.eol}`).join('') };
  // `{ }` on one line
  const inside = text.slice(ctor.bodyOpen + 1, ctor.bodyClose).trim();
  let from = ctor.bodyOpen;
  while (from > 0 && /[ 	]/.test(text[from - 1]!)) from--;
  const ownLine = from === lineStart(text, from);
  return { offset: from, length: ctor.bodyClose - from + 1, text: `${ownLine ? c.indent : `${c.eol}${c.indent}`}{${c.eol}${inside ? `${body}${inside}${c.eol}` : ''}${statements.map((s) => `${body}${s}${c.eol}`).join('')}${c.indent}}` };
}

export interface Member { name: string; type: string; kind: 'field' | 'property' }

/** A new constructor that takes and assigns `members`. */
export function newConstructorEdit(text: string, c: ClassInfo, members: Member[], style: NamingStyle): Edit {
  const params = members.map((mb) => ({ mb, p: parameterNameFor(mb.name) }));
  const at = ctorInsertOffset(text, c);
  const body = c.indent + c.unit;
  const lines = [
    `${c.indent}public ${c.name.replace(/^@/, '')}(${params.map((x) => `${x.mb.type} ${x.p}`).join(', ')})`,
    `${c.indent}{`,
    ...params.map((x) => `${body}${assignTarget(x.mb.name, x.p, x.mb.kind === 'property' ? { ...style, useThis: false } : style)} = ${x.p};`),
    `${c.indent}}`,
  ];
  return { offset: at.offset, length: 0, text: `${at.leadingBlank ? c.eol : ''}${lines.join(c.eol)}${c.eol}` };
}

export type PlanResult = { edits: Edit[]; note?: string } | { refused: string };

/** "Create and initialize field '_b'" / "Initialize field '_x'" (existing) / "Create and initialize property 'B'". */
export function planIntroduce(text: string, c: ClassInfo, at: { ctor?: CtorInfo; param: ParameterInfo; primary: boolean }, style: NamingStyle, mode: 'field' | 'property' | { existing: string }): PlanResult {
  const p = at.param;
  if (at.primary) {
    if (mode === 'property') return { edits: [{ offset: fieldInsertOffset(text, c), length: 0, text: `${c.indent}public ${p.type} ${propertyNameFor(p.name)} { get; } = ${p.name};${c.eol}` }] };
    if (typeof mode === 'object') return { refused: `'${mode.existing}' already exists: initialise it with '= ${p.name};' (primary constructor parameters are in scope in initialisers).` };
    const name = fieldNameFor(p.name, style);
    if (taken(c, name)) return { refused: `A member named '${name}' already exists.` };
    return { edits: [{ offset: fieldInsertOffset(text, c), length: 0, text: fieldDeclaration(c, p.type, name, p.name) }], note: 'Primary constructor: the field is initialised from the parameter (no constructor body).' };
  }
  const ctor = at.ctor!;
  if (typeof mode === 'object') {
    const target = mode.existing;
    const isProp = c.properties.some((x) => x.name === target);
    return { edits: [addStatementsEdit(text, c, ctor, [`${assignTarget(target, p.name, isProp ? { ...style, useThis: false } : style)} = ${p.name};`])] };
  }
  if (mode === 'property') {
    const name = propertyNameFor(p.name);
    if (taken(c, name)) return { refused: `A member named '${name}' already exists.` };
    return { edits: [{ offset: fieldInsertOffset(text, c), length: 0, text: `${c.indent}public ${p.type} ${name} { get; }${c.eol}` }, addStatementsEdit(text, c, ctor, [`${name} = ${p.name};`])] };
  }
  const name = fieldNameFor(p.name, style);
  if (taken(c, name)) return { refused: `A member named '${name}' already exists.` };
  return { edits: [{ offset: fieldInsertOffset(text, c), length: 0, text: fieldDeclaration(c, p.type, name) }, addStatementsEdit(text, c, ctor, [`${assignTarget(name, p.name, style)} = ${p.name};`])] };
}

function taken(c: ClassInfo, name: string): boolean {
  return c.fields.some((f) => f.name === name) || c.properties.some((p) => p.name === name) || c.name === name;
}

/** Constructor parameters not assigned to anything in the body (and not passed to `: base(...)`/`: this(...)`). */
export function unassignedParameters(text: string, ctor: CtorInfo): ParameterInfo[] {
  const body = maskText(text.slice(ctor.paramsClose + 1, ctor.end));
  return ctor.params.filter((p) => !new RegExp(`(?<![\\w.])${p.name.replace('@', '\\@')}\\b`).test(body));
}

/** "Initialize all unassigned parameters from constructor": one field per unused parameter (or an existing unassigned member of that type). */
export function planInitializeAll(text: string, c: ClassInfo, ctor: CtorInfo, style: NamingStyle): PlanResult {
  const params = unassignedParameters(text, ctor);
  if (params.length === 0) return { refused: 'Every constructor parameter is already used.' };
  const free = unassignedMembers(c);
  const fields: string[] = [];
  const statements: string[] = [];
  for (const p of params) {
    const existing = free.find((u) => u.type === p.type);
    if (existing) {
      free.splice(free.indexOf(existing), 1);
      statements.push(`${assignTarget(existing.name, p.name, existing.kind === 'property' ? { ...style, useThis: false } : style)} = ${p.name};`);
      continue;
    }
    const name = fieldNameFor(p.name, style);
    if (taken(c, name)) return { refused: `A member named '${name}' already exists.` };
    fields.push(fieldDeclaration(c, p.type, name));
    statements.push(`${assignTarget(name, p.name, style)} = ${p.name};`);
  }
  const edits: Edit[] = [];
  if (fields.length) edits.push({ offset: fieldInsertOffset(text, c), length: 0, text: fields.join('') });
  edits.push(addStatementsEdit(text, c, ctor, statements));
  return { edits };
}

/**
 * "Initialize from constructor" for members: adds a parameter and an assignment to the constructor (creates one when the
 * class has none). With several constructors the caller picks one (`ctor`); chained `: this(...)` constructors are skipped.
 */
export function planInitializeMembers(text: string, c: ClassInfo, members: Member[], style: NamingStyle, ctor?: CtorInfo): PlanResult {
  if (members.length === 0) return { refused: 'Nothing to initialise.' };
  if (c.isStatic) return { refused: 'A static class has no instance constructor.' };
  if (c.primaryParams) return { refused: `'${c.name}' has a primary constructor: add the parameter to it and initialise the member with '= parameter;' (an explicit constructor would have to call ': this(...)').` };
  if (!ctor) {
    const usable = c.ctors.filter((k) => !/:\s*this\s*\(/.test(text.slice(k.paramsClose + 1, k.bodyOpen ?? k.end)));
    if (c.ctors.length === 0) return { edits: [newConstructorEdit(text, c, members, style)] };
    if (usable.length !== 1) return { refused: 'Choose a constructor.' };
    ctor = usable[0]!;
  }
  const edits: Edit[] = [];
  const names = new Set(ctor.params.map((p) => p.name));
  const statements: string[] = [];
  let paramText = '';
  for (const mb of members) {
    let p = parameterNameFor(mb.name);
    const sameType = ctor.params.find((x) => x.type === mb.type && !isUsed(text, ctor!, x.name));
    if (sameType) p = sameType.name;
    else {
      while (names.has(p)) p = `${p}1`;
      names.add(p);
      paramText += `${paramText || text.slice(ctor.paramsOpen + 1, ctor.paramsClose).trim() ? ', ' : ''}${mb.type} ${p}`;
    }
    statements.push(`${assignTarget(mb.name, p, mb.kind === 'property' ? { ...style, useThis: false } : style)} = ${p};`);
  }
  if (paramText) edits.push({ offset: ctor.paramsClose, length: 0, text: paramText });
  edits.push(addStatementsEdit(text, c, ctor, statements));
  return { edits };
}

function isUsed(text: string, ctor: CtorInfo, name: string): boolean {
  return new RegExp(`(?<![\\w.])${name}\\b`).test(maskText(text.slice(ctor.paramsClose + 1, ctor.end)));
}

/** "Generate constructor" for a class without a matching one: creates a new constructor (never edits an existing one). */
export function planGenerateConstructor(text: string, c: ClassInfo, members: Member[], style: NamingStyle): PlanResult {
  if (members.length === 0) return { refused: 'Choose at least one field or property.' };
  if (c.isStatic) return { refused: 'A static class has no instance constructor.' };
  if (c.primaryParams) return { refused: `'${c.name}' has a primary constructor; another constructor would have to call ': this(...)'. Use "Create field from primary constructor parameter" instead.` };
  const sig = members.map((m) => m.type).join(',');
  if (c.ctors.some((k) => k.params.map((p) => p.type).join(',') === sig)) return { refused: 'A constructor with these parameter types already exists.' };
  return { edits: [newConstructorEdit(text, c, members, style)] };
}

// ---------------------------------------------------------------- undeclared identifiers

/** An identifier at `offset` that looks like a missing field (`_repo.Get(id)`, `_logger.Log...`), when the class does not declare it. */
export function undeclaredFieldAt(text: string, c: ClassInfo, offset: number): { name: string; start: number; end: number } | undefined {
  const m = maskText(text);
  let s = offset;
  let e = offset;
  while (s > 0 && /[\w]/.test(m[s - 1]!)) s--;
  while (e < m.length && /[\w]/.test(m[e]!)) e++;
  const name = m.slice(s, e);
  if (!/^_?[A-Za-z_]\w*$/.test(name) || m[s - 1] === '.' || KEYWORDS.has(name)) return undefined;
  if (!name.startsWith('_') && !/^m_/.test(name)) return undefined; // only field-shaped names; others are too ambiguous
  if (c.fields.some((f) => f.name === name) || c.properties.some((p) => p.name === name)) return undefined;
  if (s < c.bodyOpen || e > c.bodyClose) return undefined;
  // Declared as a local or parameter of the enclosing member?
  if (new RegExp(`\\b[\\w<>,?\\[\\]]+\\s+${name}\\s*[=;,)]`).test(m.slice(c.bodyOpen, c.bodyClose))) return undefined;
  return { name, start: s, end: e };
}

/** The type of a missing field from its use, when it is a well-known pattern; undefined = ask the user. */
export function inferFieldType(text: string, c: ClassInfo, name: string): string | undefined {
  const bare = bareName(name);
  if (/^logger$/i.test(bare)) return `ILogger<${c.name}>`;
  if (/^(mediator)$/i.test(bare)) return 'IMediator';
  if (/^(configuration|config)$/i.test(bare)) return 'IConfiguration';
  if (/^httpClientFactory$/i.test(bare)) return 'IHttpClientFactory';
  if (/^httpClient$/i.test(bare)) return 'HttpClient';
  if (/^(serviceProvider)$/i.test(bare)) return 'IServiceProvider';
  if (/^(timeProvider)$/i.test(bare)) return 'TimeProvider';
  // `_x = new Foo(...)` somewhere → Foo
  const nw = new RegExp(`\\b${name}\\s*=\\s*new\\s+([A-Za-z_][\\w.<>]*)\\s*\\(`).exec(maskText(text));
  if (nw) return nw[1];
  return undefined;
}

/** Types to offer for a missing field, best first: names that match the field (interfaces first), then the rest. */
export function rankTypeCandidates(fieldName: string, types: readonly { name: string; isInterface: boolean }[]): string[] {
  const bare = bareName(fieldName).toLowerCase();
  const score = (t: { name: string; isInterface: boolean }) => {
    const n = t.name.replace(/<.*$/, '').toLowerCase();
    const core = t.isInterface && /^i[a-z]/.test(n) ? n.slice(1) : n;
    return (core === bare ? 0 : core.endsWith(bare) || bare.endsWith(core) ? 1 : core.includes(bare) ? 2 : 3) * 2 + (t.isInterface ? 0 : 1);
  };
  return [...new Map(types.map((t) => [t.name, t])).values()].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name)).map((t) => t.name);
}

/** Field + constructor parameter + assignment for a missing field. */
export function planCreateInjectedField(text: string, c: ClassInfo, name: string, type: string, style: NamingStyle): PlanResult {
  if (c.primaryParams) {
    const p = parameterNameFor(name);
    const open = text.lastIndexOf(')', c.bodyOpen);
    return { edits: [{ offset: open, length: 0, text: `${c.primaryParams.length ? ', ' : ''}${type} ${p}` }, { offset: fieldInsertOffset(text, c), length: 0, text: fieldDeclaration(c, type, name, p) }] };
  }
  const field: Edit = { offset: fieldInsertOffset(text, c), length: 0, text: fieldDeclaration(c, type, name) };
  const init = planInitializeMembers(text, { ...c, fields: [...c.fields] }, [{ name, type, kind: 'field' }], style);
  if ('refused' in init) return init;
  // The field and a new constructor may share an insertion point: field first.
  return { edits: [field, ...init.edits] };
}

/** `new A(` in other files' text: a constructor change is safe only when nobody constructs the class directly. */
export function directConstructions(className: string, files: readonly { uri: string; text: string }[]): { uri: string; offset: number }[] {
  const re = new RegExp(`\\bnew\\s+(?:[\\w.]+\\.)?${className}\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
  const out: { uri: string; offset: number }[] = [];
  for (const f of files) for (const hit of maskText(f.text).matchAll(re)) out.push({ uri: f.uri, offset: hit.index! });
  // Target-typed `new(` cannot be attributed by text; callers refuse when the class name appears next to `new(`.
  return out;
}

// ---------------------------------------------------------------- DI registration

export type Lifetime = 'Scoped' | 'Transient' | 'Singleton';

export interface RegistrationTarget {
  uri: string;
  /** Insert offset (start of a line). */
  offset: number;
  indent: string;
  receiver: string;
  label: string;
  eol: string;
}

/** Places that register services: top-level Program.cs (`builder.Services.Add…`), `this IServiceCollection` extension methods, `ConfigureServices`. */
export function findRegistrationTargets(files: readonly { uri: string; text: string }[]): RegistrationTarget[] {
  const out: RegistrationTarget[] = [];
  for (const f of files) {
    const m = maskText(f.text);
    const eol = f.text.includes('\r\n') ? '\r\n' : '\n';
    const short = f.uri.replace(/^.*[\\/]/, '');
    // Extension methods / ConfigureServices.
    const ext = /\b(?:public|internal)\s+(?:static\s+)?(?:IServiceCollection|void)\s+(\w+)\s*\(\s*(this\s+)?IServiceCollection\s+(\w+)[^)]*\)/g;
    let inMethods: [number, number][] = [];
    for (const hit of m.matchAll(ext)) {
      const open = m.indexOf('{', hit.index!);
      const arrow = m.indexOf('=>', hit.index!);
      if (open < 0 || (arrow >= 0 && arrow < open)) continue;
      const close = matchClose(m, open);
      inMethods.push([open, close]);
      const ret = new RegExp(`\\breturn\\s+${hit[3]}\\s*;`).exec(m.slice(open, close));
      const at = ret ? lineStart(m, open + ret.index) : lineStart(m, close);
      const indent = indentAt(f.text, open) + (/\t/.test(indentAt(f.text, open)) ? '\t' : '    ');
      out.push({ uri: f.uri, offset: at, indent, receiver: hit[3]!, label: `${hit[1]}(${hit[2] ? 'this ' : ''}IServiceCollection ${hit[3]}) in ${short}`, eol });
    }
    // Top-level statements: builder.Services.AddX(...); — after the last one.
    const regs = [...m.matchAll(/^([ \t]*)(\w+)\.Services\.(?:Add|TryAdd)\w*/gm)].filter((h) => !inMethods.some(([a, b]) => h.index! > a && h.index! < b));
    if (regs.length) {
      const last = regs[regs.length - 1]!;
      const end = statementEnd(m, last.index!);
      out.push({ uri: f.uri, offset: lineEnd(m, end), indent: last[1]!, receiver: `${last[2]}.Services`, label: `${last[2]}.Services in ${short}`, eol });
      continue;
    }
    const builder = /^([ \t]*)var\s+(\w+)\s*=\s*(?:WebApplication|Host)\.Create(?:Slim)?(?:Application)?Builder\b/m.exec(m);
    if (builder) out.push({ uri: f.uri, offset: lineEnd(m, statementEnd(m, builder.index)), indent: builder[1]!, receiver: `${builder[2]}.Services`, label: `${builder[2]}.Services in ${short}`, eol });
    inMethods = [];
  }
  return out;
}

function statementEnd(m: string, from: number): number {
  let d = 0;
  for (let i = from; i < m.length; i++) {
    const ch = m[i];
    if ('({['.includes(ch!)) d++;
    else if (')}]'.includes(ch!)) d--;
    else if (ch === ';' && d <= 0) return i;
  }
  return m.length - 1;
}

/** Classes implementing `iface` (text: `class X : ..., IFoo`), for the interface → implementation pair. */
export function implementationsOf(iface: string, files: readonly { uri: string; text: string }[]): string[] {
  const bare = iface.replace(/<.*$/, '').split('.').pop()!;
  const re = new RegExp(`\\bclass\\s+(\\w+)(?:<[^>]*>)?(?:\\s*\\([^)]*\\))?\\s*:\\s*[^{]*\\b${bare}\\b(?!\\.)`, 'g');
  const out = new Set<string>();
  for (const f of files) for (const hit of maskText(f.text).matchAll(re)) if (!/\babstract\s+class\s+$/.test(maskText(f.text).slice(Math.max(0, hit.index! - 20), hit.index! + 6))) out.add(hit[1]!);
  return [...out];
}

/** Text search for an existing registration (fallback when the DI relations are unavailable). */
export function isRegisteredByText(type: string, files: readonly { uri: string; text: string }[]): boolean {
  const bare = type.replace(/<.*$/, '').split('.').pop()!;
  const re = new RegExp(`\\.(?:Try)?Add(?:Keyed)?(?:Scoped|Transient|Singleton|HostedService|DbContext|HttpClient)\\w*\\s*<\\s*(?:[\\w.]+\\.)?${bare}\\b|typeof\\(\\s*(?:[\\w.]+\\.)?${bare}\\b`);
  return files.some((f) => re.test(maskText(f.text)));
}

export function registrationEdit(t: RegistrationTarget, lifetime: Lifetime, service: string, implementation?: string): Edit {
  const generic = implementation && implementation !== service ? `${service}, ${implementation}` : service;
  return { offset: t.offset, length: 0, text: `${t.indent}${t.receiver}.Add${lifetime}<${generic}>();${t.eol}` };
}

/** Is the type an interface by convention (`IFoo`)? Used for the pair offer; the C# host decides nothing here. */
export function looksLikeInterface(type: string): boolean {
  return /^I[A-Z]/.test(type.replace(/<.*$/, '').split('.').pop()!);
}

/** Types the container supplies itself (never offered for registration). */
export function isFrameworkProvided(type: string): boolean {
  return /^(ILogger(<.*>)?|ILoggerFactory|IConfiguration|IServiceProvider|IServiceScopeFactory|IHostEnvironment|IWebHostEnvironment|IHostApplicationLifetime|IOptions(Snapshot|Monitor)?<.*>|IHttpClientFactory|HttpClient|TimeProvider|IMediator|ISender|IPublisher|CancellationToken)$/.test(type.trim());
}
