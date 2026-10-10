import type { Position, TextEditDto } from '@refyntra/contracts';
import type { AdapterDescriptor } from '@refyntra/application';
import { offsetAt } from './text';

// Language families and their text rules. Everything that differs between TypeScript/JavaScript,
// Python and Rust lives in a DelegatedLanguage: ids, names, identifier rules and the conservative text heuristics
// that refuse renames whose effect the public VS Code API cannot show (file operations, macro definitions).

/** Why a delegated rename is refused before or after the provider answered. */
export interface RenameRefusal {
  reasonCode: string;
  message: string;
}

export interface DelegatedLanguage {
  descriptor: AdapterDescriptor;
  /** Long name in messages, e.g. "TypeScript/JavaScript". */
  name: string;
  /** Capability id prefix: `<prefix>.find`, `.related`, `.references`, `.rename`, `.frameworkRelations`. */
  capabilityPrefix: string;
  /** Appended to "no provider answered" messages. */
  noProviderHint: string;
  /** Health message of a ready route. */
  readyMessage: string;
  findLimitation: string;
  frameworkRelationsUnavailable: string;
  renameLimitations: readonly string[];
  /** Identifier around a position (the fallback old name). */
  identifierPattern: RegExp;
  /** An error message when `newName` is not a valid name for a symbol called `oldName`. */
  validateNewName?(newName: string, oldName: string): string | undefined;
  /** Before the provider computes edits: a rename at this position may do what the preview cannot show. */
  positionRefusal(text: string, position: Position): RenameRefusal | undefined;
  /** After the provider answered: refuses edits of one document (sorted) that touch unsafe text. */
  editRefusal?(text: string, edits: readonly TextEditDto[], oldName: string): RenameRefusal | undefined;
}

const capabilityIds = (prefix: string) => [`${prefix}.find`, `${prefix}.related`, `${prefix}.references`, `${prefix}.rename`, `${prefix}.frameworkRelations`];

const lineOf = (text: string, line: number): string | undefined => text.split(/\r\n|\n|\r/)[line];

const POSSIBLE_FILE_OPERATION = 'PossibleFileOperation';

// ---------------------------------------------------------------------------------------------- TypeScript/JavaScript

/** True when an odd number of unescaped quotes precedes the position on its line (a string literal or template). */
function insideJsString(text: string, p: Position): boolean {
  const line = lineOf(text, p.line);
  if (line === undefined) return false;
  let quote: string | undefined;
  for (let i = 0; i < Math.min(p.character, line.length); i++) {
    const c = line[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return false;
  }
  return quote !== undefined;
}

export const TS_JS_ROUTE_ID = 'typescript.vscode-providers';
export const TS_JS_CAPABILITY_IDS = ['typescript.find', 'typescript.related', 'typescript.references', 'typescript.rename', 'typescript.frameworkRelations'] as const;

/** The delegated TypeScript/JavaScript route. No Refyntra process; public VS Code provider commands only. */
export const TS_JS_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'typescript',
  providerRouteId: TS_JS_ROUTE_ID,
  displayName: 'TS/JS',
  languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
  fileExtensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'typescript.rename',
  capabilityIds: [...TS_JS_CAPABILITY_IDS],
};

const commonRenameLimitations = (name: string): string[] => [
  `Provider-managed semantic coverage: the edits come from the installed ${name} rename provider; Refyntra did not compute or validate them semantically.`,
  "The provider's project context, compiler version, snapshot and read set are unknown. Asking it again before the apply checks that it returns the same edit; it does not lock or reveal the provider's internal state.",
  'No compilation check is run (compilation delta: not-run).',
  'Only the text edits the public API lists are applied; Refyntra builds its own edit from them.',
];

export const DELEGATED_LIMITATION = 'Results come from the installed TypeScript/JavaScript provider; completeness unknown.';
export const FRAMEWORK_RELATIONS_UNAVAILABLE =
  'Framework relations (handlers, endpoints, registrations) are not available for TypeScript/JavaScript: Refyntra has no TypeScript/JavaScript framework module.';
export const DELEGATED_RENAME_LIMITATIONS: readonly string[] = commonRenameLimitations('TypeScript/JavaScript');

export const TS_JS_LANGUAGE: DelegatedLanguage = {
  descriptor: TS_JS_DESCRIPTOR,
  name: 'TypeScript/JavaScript',
  capabilityPrefix: 'typescript',
  noProviderHint: 'The built-in "TypeScript and JavaScript Language Features" extension may be disabled or still starting.',
  readyMessage: 'Delegated to the installed TypeScript/JavaScript language features through public VS Code provider commands. Results are not owned by Refyntra; completeness unknown.',
  findLimitation: DELEGATED_LIMITATION,
  frameworkRelationsUnavailable: FRAMEWORK_RELATIONS_UNAVAILABLE,
  renameLimitations: DELEGATED_RENAME_LIMITATIONS,
  identifierPattern: /[A-Za-z_$][\w$]*/g,
  // Inside a string literal (a module path): the provider may rename the file, which the public WorkspaceEdit API
  // does not list (entries() has text edits only), so the preview could not show it.
  positionRefusal: (text, p) =>
    insideJsString(text, p)
      ? { reasonCode: POSSIBLE_FILE_OPERATION, message: 'Renaming inside a string (such as a module path) may rename a file; the public VS Code API does not show file operations, so Refyntra cannot preview this rename.' }
      : undefined,
};

// ---------------------------------------------------------------------------------------------- Python

const PY_IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/** Hard keywords (soft keywords such as match, case, type and _ are valid names). */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

/** Python rule: a Unicode identifier (XID_Start or `_`, then XID_Continue) that is not a hard keyword. */
export function validatePythonName(newName: string): string | undefined {
  if (!PY_IDENTIFIER.test(newName)) return `"${newName}" is not a valid Python identifier.`;
  if (PYTHON_KEYWORDS.has(newName)) return `"${newName}" is a Python keyword.`;
  return undefined;
}

/** True inside a '…' or "…" string on the line (prefixes like f/r/b do not matter; `#` starts a comment). */
function insidePyString(text: string, p: Position): boolean {
  const line = lineOf(text, p.line);
  if (line === undefined) return false;
  let quote: string | undefined;
  for (let i = 0; i < Math.min(p.character, line.length); i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (line.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = undefined;
      }
    } else if (c === '#') return false;
    else if (c === "'" || c === '"') {
      quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length - 1;
    }
  }
  return quote !== undefined;
}

/** Character spans of module paths in an import line (`import a.b as c, d` / `from .a.b import x`). */
export function pythonModuleSpans(line: string): Array<[number, number]> {
  const from = /^(\s*from\s+)([.\p{XID_Continue}]+)(?=\s+import\b)/u.exec(line);
  if (from) return [[from[1]!.length, from[1]!.length + from[2]!.length]];
  const imp = /^(\s*import\s+)(.*)$/u.exec(line);
  if (!imp) return [];
  const spans: Array<[number, number]> = [];
  let at = imp[1]!.length;
  for (const part of imp[2]!.split(',')) {
    const m = /^(\s*)([.\p{XID_Continue}]+)/u.exec(part);
    if (m) spans.push([at + m[1]!.length, at + m[1]!.length + m[2]!.length]);
    at += part.length + 1;
  }
  return spans;
}

const inSpans = (spans: ReadonlyArray<[number, number]>, ch: number) => spans.some(([a, b]) => a <= ch && ch <= b);

const PY_MODULE_REFUSAL: RenameRefusal = {
  reasonCode: POSSIBLE_FILE_OPERATION,
  message: 'This rename touches a module path in an import; the provider may rename or move the module file, which the public VS Code API does not show, so Refyntra cannot preview it.',
};

export const PYTHON_ROUTE_ID = 'python.vscode-providers';
export const PYTHON_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'python',
  providerRouteId: PYTHON_ROUTE_ID,
  displayName: 'Python',
  languageIds: ['python'],
  fileExtensions: ['.py', '.pyi'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'python.rename',
  capabilityIds: capabilityIds('python'),
};

export const PYTHON_LANGUAGE: DelegatedLanguage = {
  descriptor: PYTHON_DESCRIPTOR,
  name: 'Python',
  capabilityPrefix: 'python',
  noProviderHint:
    'No Python language provider answered for this document.',
  readyMessage: 'Python language provider. Results are not owned by Refyntra; completeness unknown.',
  findLimitation: 'Results come from the installed Python language provider; completeness unknown.',
  frameworkRelationsUnavailable: 'Framework relations (handlers, endpoints, registrations) are not available for Python: Refyntra has no Python framework module.',
  renameLimitations: [
    ...commonRenameLimitations('Python'),
    'Dynamic code is not covered: getattr/setattr/__getattr__, names in strings (such as __all__ entries or string annotations the provider does not resolve), keys of keyword-argument dictionaries and other runtime lookups may keep the old name.',
    'Renames that touch a module path in an import are refused (the provider may rename or move a file).',
  ],
  identifierPattern: /[\p{XID_Start}_]\p{XID_Continue}*/gu,
  validateNewName: (newName) => validatePythonName(newName),
  positionRefusal: (text, p) => {
    if (insidePyString(text, p)) return { reasonCode: 'InsideString', message: 'Renaming inside a Python string is not supported: the provider would only see text, not a symbol.' };
    const line = lineOf(text, p.line);
    return line !== undefined && inSpans(pythonModuleSpans(line), p.character) ? PY_MODULE_REFUSAL : undefined;
  },
  editRefusal: (text, edits) => {
    for (const e of edits) {
      const line = lineOf(text, e.range.start.line);
      if (line !== undefined && inSpans(pythonModuleSpans(line), e.range.start.character)) return PY_MODULE_REFUSAL;
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------------------------- Rust

const RUST_IDENT = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/** Strict and reserved keywords (2015–2024 editions). */
export const RUST_KEYWORDS: ReadonlySet<string> = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized',
  'virtual', 'yield', 'try', 'gen',
]);
/** Keywords that cannot be raw identifiers. */
const RUST_NO_RAW = new Set(['crate', 'self', 'super', 'Self', '_']);

/** Rust rule: an identifier or raw identifier (`r#match`); a lifetime (`'a`) only replaces a lifetime. */
export function validateRustName(newName: string, oldName: string): string | undefined {
  if (oldName.startsWith("'")) {
    const id = newName.slice(1);
    if (!newName.startsWith("'") || !RUST_IDENT.test(id) || id === '_' || id === 'static' || RUST_KEYWORDS.has(id)) return `"${newName}" is not a valid lifetime name (such as 'a).`;
    return undefined;
  }
  if (newName.startsWith("'")) return 'Only a lifetime can be renamed to a lifetime name.';
  const raw = newName.startsWith('r#');
  const id = raw ? newName.slice(2) : newName;
  if (!RUST_IDENT.test(id) || id === '_') return `"${newName}" is not a valid Rust identifier.`;
  if (raw && RUST_NO_RAW.has(id)) return `r#${id} is not allowed as a raw identifier.`;
  if (!raw && RUST_KEYWORDS.has(id)) return `"${id}" is a Rust keyword; use r#${id} for a raw identifier.`;
  return undefined;
}

/** True inside a "…" or raw r#"…"# string on the line; '…' char literals and lifetimes are skipped. */
function insideRustString(text: string, p: Position): boolean {
  const line = lineOf(text, p.line);
  if (line === undefined) return false;
  const end = Math.min(p.character, line.length);
  for (let i = 0; i < end; i++) {
    const c = line[i]!;
    if (c === '/' && line[i + 1] === '/') return false;
    if (c === "'") {
      const ch = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/u.exec(line.slice(i));
      if (ch) i += ch[0].length - 1;
      continue;
    }
    const raw = /^b?r(#*)"/.exec(line.slice(i));
    if (raw && (i === 0 || !/[\p{XID_Continue}]/u.test(line[i - 1]!))) {
      const close = line.indexOf(`"${raw[1]}`, i + raw[0].length);
      if (close < 0 || close >= end) return true;
      i = close + raw[1]!.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) if (line[j] === '\\') j++;
      if (j >= end) return true;
      i = j;
    }
  }
  return false;
}

/** Offset ranges of `macro_rules!` bodies (delimiters included), skipping strings and comments. */
export function macroRulesBodies(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const head = /macro_rules!\s*(?:r#)?[\p{XID_Start}_]\p{XID_Continue}*\s*([({[])/gu;
  for (const m of text.matchAll(head)) {
    const start = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl;
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        i = close < 0 ? text.length : close + 1;
      } else if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      } else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push([start, Math.min(i + 1, text.length)]);
  }
  return out;
}

/** Character span of the name in a `mod name;` declaration (a module in its own file), if the line is one. */
function rustModFileSpan(line: string): [number, number] | undefined {
  const m = /^(\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+)((?:r#)?[\p{XID_Start}_]\p{XID_Continue}*)\s*;/u.exec(line);
  return m ? [m[1]!.length, m[1]!.length + m[2]!.length] : undefined;
}

const RUST_MOD_REFUSAL: RenameRefusal = {
  reasonCode: POSSIBLE_FILE_OPERATION,
  message: 'This rename touches a `mod name;` declaration; the provider renames the module file too, which the public VS Code API does not show, so Refyntra cannot preview it.',
};
const RUST_MACRO_REFUSAL: RenameRefusal = {
  reasonCode: 'MacroDefinition',
  message: 'This rename changes text inside a macro_rules! definition; Refyntra cannot check what the macro expands to, so it does not preview this rename.',
};

const insideMacroBody = (text: string, p: Position): boolean => {
  const off = offsetAt(text, p);
  return off !== undefined && macroRulesBodies(text).some(([a, b]) => a < off && off < b);
};

export const RUST_ROUTE_ID = 'rust.vscode-providers';
export const RUST_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'rust',
  providerRouteId: RUST_ROUTE_ID,
  displayName: 'Rust',
  languageIds: ['rust'],
  fileExtensions: ['.rs'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'rust.rename',
  capabilityIds: capabilityIds('rust'),
};

export const RUST_LANGUAGE: DelegatedLanguage = {
  descriptor: RUST_DESCRIPTOR,
  name: 'Rust',
  capabilityPrefix: 'rust',
  noProviderHint: 'No Rust language provider answered for this document (a Cargo project with Cargo.toml may be missing).',
  readyMessage: 'Rust language provider. Results are not owned by Refyntra; completeness unknown.',
  findLimitation: 'Results come from the installed Rust language provider; completeness unknown.',
  frameworkRelationsUnavailable: 'Framework relations (handlers, endpoints, registrations) are not available for Rust: Refyntra has no Rust framework module.',
  renameLimitations: [
    ...commonRenameLimitations('Rust'),
    'Macros: edits inside macro_rules! definitions are refused; names used inside macro invocations are renamed only as far as the provider resolves the expansion.',
    'Code disabled by cfg attributes or Cargo features the provider does not analyse may keep the old name.',
    'Renames that touch a `mod name;` declaration are refused (the provider renames the module file).',
  ],
  identifierPattern: /'?(?:r#)?[\p{XID_Start}_]\p{XID_Continue}*/gu,
  validateNewName: validateRustName,
  positionRefusal: (text, p) => {
    if (insideRustString(text, p)) return { reasonCode: 'InsideString', message: 'Renaming inside a Rust string is not supported: the provider would only see text, not a symbol.' };
    if (insideMacroBody(text, p)) return RUST_MACRO_REFUSAL;
    const line = lineOf(text, p.line);
    const span = line === undefined ? undefined : rustModFileSpan(line);
    return span && inSpans([span], p.character) ? RUST_MOD_REFUSAL : undefined;
  },
  editRefusal: (text, edits) => {
    const bodies = macroRulesBodies(text);
    for (const e of edits) {
      const line = lineOf(text, e.range.start.line);
      const span = line === undefined ? undefined : rustModFileSpan(line);
      if (span && inSpans([span], e.range.start.character)) return RUST_MOD_REFUSAL;
      const a = offsetAt(text, e.range.start);
      const b = offsetAt(text, e.range.end);
      if (a !== undefined && b !== undefined && bodies.some(([s, t]) => a < t && b > s)) return RUST_MACRO_REFUSAL;
    }
    return undefined;
  },
};

// Python and Rust are served by Refyntra's own language-server routes (@refyntra/adapter-lsp: bundled Pyright and
// rust-analyzer). Their identifier rules and refusal heuristics above are shared with those routes; the objects can
// still drive the delegated adapter in unit tests of the heuristics.
export const DELEGATED_LANGUAGES: readonly DelegatedLanguage[] = [TS_JS_LANGUAGE];
