// Stack trace parsing (pure: no vscode import, unit-tested with golden inputs in test/unit/stackTrace.test.ts).
// Recognises .NET (CoreCLR, .NET Framework/ASP.NET, Mono, Unity), JavaScript/TypeScript (V8, Firefox/Safari),
// Python tracebacks and Rust panics/backtraces. Nothing is executed and nothing is looked up here: the result is a
// list of exception groups with frames (type, member, file, line); resolving them is stackTrace.ts's job.

export type FrameLanguage = 'dotnet' | 'javascript' | 'python' | 'rust';
/** Compiler-generated .NET names decoded back to the user method. */
export type CompilerKind = 'async' | 'lambda' | 'localFunction';

export interface StackFrame {
  /** 0-based line of the input text this frame came from. */
  sourceLine: number;
  /** The input line (trimmed, without ANSI colours). */
  raw: string;
  language: FrameLanguage;
  /** Readable function name: "Shop.OrderService.LoadAsync", "handler", "load_orders". */
  function: string;
  /** .NET: dotted declaring type of the user method ("Shop.OrderService", "Shop.Repo`1"). */
  typeName?: string;
  /** .NET: the user method (".ctor", "get_Name", "LoadAsync"). */
  methodName?: string;
  localFunctionName?: string;
  compilerKind?: CompilerKind;
  methodArity?: number;
  /** .NET: printed parameter types; undefined when the frame does not show the user method's parameters. */
  parameterTypes?: string[];
  /** File path as printed (file:// URLs and webpack:// prefixes removed). */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /** Framework, runtime or package code (System.*, node_modules, site-packages, std::...). */
  external: boolean;
  /** .NET: the frame follows "--- End of stack trace from previous location ---" (an await boundary). */
  afterAsyncBoundary?: boolean;
}

export interface ExceptionGroup {
  exceptionType?: string;
  message?: string;
  language?: FrameLanguage;
  /** 0 = outermost; inner exceptions ("--->") are one deeper than the exception that wraps them. */
  depth: number;
  frames: StackFrame[];
}

export interface ParsedTrace {
  groups: ExceptionGroup[];
  frameCount: number;
}

// ---------------------------------------------------------------- line cleanup

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function clean(line: string): string {
  return line.replace(ANSI_RE, '').replace(/\r$/, '').trimEnd();
}

// ---------------------------------------------------------------- .NET

const DOTNET_EXTERNAL_PREFIXES = ['System.', 'Microsoft.', 'Mono.', 'MonoMod.', 'UnityEngine.', 'UnityEditor.', 'Unity.', 'Internal.', 'Interop.', 'Newtonsoft.', 'Xunit.', 'NUnit.', 'Castle.', 'Polly.'];

/** "at Ns.Type.Method(Int32 id) in C:\src\File.cs:line 42" (CoreCLR/.NET Framework) and Mono "at Ns.Type.Method (int x) [0x00000] in /src/File.cs:42". */
const DOTNET_AT_RE = /(?:^|\s)at\s+(?<fn>[^\s()]+?)\s?\((?<args>[^()]*(?:\([^()]*\)[^()]*)*)\)(?:\s+\[0x[0-9a-fA-F]+\])?(?:\s+in\s+(?<file>.+?)(?::line\s+(?<line>\d+)|:(?<line2>\d+))?)?\s*$/;
/** Localised .NET runtimes: "bei Ns.T.M() in C:\x.cs:Zeile 42", "à Ns.T.M() dans C:\x.cs:ligne 42". Requires the file part. */
const DOTNET_LOCALISED_RE = /(?:^|\s)\p{L}+\s+(?<fn>[^\s()]+\.[^\s()]+?)\((?<args>[^()]*)\)\s+\p{L}+\s+(?<file>.+?):\p{L}+\s+(?<line>\d+)\s*$/u;
/** Unity: "Player.Update () (at Assets/Scripts/Player.cs:42)" and "UnityEngine.Debug:Log (object)". */
const UNITY_RE = /^(?<fn>[\w.$<>`+|[\],:]+?)\s?\((?<args>[^()]*)\)\s*(?:\(at\s+(?<file>.+):(?<line>\d+)\))?\s*$/;

/** Splits "A.B.<M>d__5.MoveNext" at dots outside angle brackets; "Type..ctor" keeps ".ctor" as one segment. */
function splitDotted(name: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) {
      if (cur === '' && out.length > 0 && (name.startsWith('ctor', i + 1) || name.startsWith('cctor', i + 1))) {
        cur = '.';
        continue;
      }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.filter((s, i, a) => s !== '' || i === a.length - 1);
}

/** Splits at commas outside <>, [] and (). */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface DecodedDotnetName {
  typeName: string;
  methodName: string;
  localFunctionName?: string;
  compilerKind?: CompilerKind;
  methodArity?: number;
  display: string;
}

const DISPLAY_CLASS_RE = /^<>c(?:__DisplayClass[\w]*)?(?:`\d+)?$/;
const STATE_MACHINE_RE = /^<(?<inner>.+)>d(?:__\d+)?(?:`\d+)?$/;
const LAMBDA_RE = /^<(?<m>[^<>]+)>b__[\w]+$/;
const LOCAL_FN_RE = /^<(?<m>[^<>]+)>g__(?<l>[^|]+)\|[\w]+$/;

/**
 * Decodes a .NET frame's function name to the user method: async/iterator state machines ("<M>d__5.MoveNext"),
 * lambdas ("<>c__DisplayClass5_0.<M>b__0", "<>c.<M>b__5_0"), local functions ("<M>g__Local|5_0"), nested types
 * ('+' or '/'), generic methods ("Get[T]") and constructors ("..ctor").
 */
export function decodeDotnetName(fn: string): DecodedDotnetName | undefined {
  let name = fn.trim();
  let methodArity: number | undefined;
  if (name.endsWith(']')) {
    const open = name.lastIndexOf('[', name.length - 2);
    // Only a generic argument list ("[T]", "[TKey,TValue]"), never a nested "[[...]]".
    if (open > 0 && !name.slice(open + 1, -1).includes('[')) {
      methodArity = splitTopLevel(name.slice(open + 1, -1)).length;
      name = name.slice(0, open);
    }
  }
  // Unity prints "Type:Method", Mono IL "Ns.Outer/Inner", reflection "Ns.Outer+Inner".
  name = name.replace(/([^:]):(?!:)/g, '$1.').replace(/[+/]/g, '.');
  const segs = splitDotted(name);
  if (segs.length < 2) return undefined;
  let method = segs.pop()!;
  let kind: CompilerKind | undefined;
  let local: string | undefined;
  for (let guard = 0; guard < 8; guard++) {
    const last = segs[segs.length - 1];
    const sm = method === 'MoveNext' && last ? STATE_MACHINE_RE.exec(last) : null;
    if (sm) {
      segs.pop();
      method = sm.groups!.inner!;
      kind ??= 'async';
      continue;
    }
    const smInline = STATE_MACHINE_RE.exec(method);
    if (smInline && method.startsWith('<<')) {
      method = smInline.groups!.inner!;
      kind ??= 'async';
      continue;
    }
    const lf = LOCAL_FN_RE.exec(method);
    if (lf) {
      method = lf.groups!.m!;
      local = lf.groups!.l!;
      kind = 'localFunction';
      continue;
    }
    const lambda = LAMBDA_RE.exec(method);
    if (lambda) {
      method = lambda.groups!.m!;
      kind = kind === 'localFunction' ? kind : 'lambda';
      continue;
    }
    break;
  }
  while (segs.length > 1 && DISPLAY_CLASS_RE.test(segs[segs.length - 1]!)) segs.pop();
  if (segs.length === 0 || segs.some((s) => s.startsWith('<'))) {
    // Still compiler-generated (an unknown pattern): keep the raw name, no member to resolve.
    if (segs.length === 0) return undefined;
  }
  const typeName = segs.join('.');
  const suffix = kind === 'async' ? ' (async)' : kind === 'lambda' ? ' (lambda)' : kind === 'localFunction' ? ` › ${local} (local function)` : '';
  return {
    typeName,
    methodName: method,
    ...(local ? { localFunctionName: local } : {}),
    ...(kind ? { compilerKind: kind } : {}),
    ...(methodArity !== undefined ? { methodArity } : {}),
    display: `${typeName}.${method}${suffix}`,
  };
}

/** "Int32 id, String name" → ["Int32", "String"]; Unity "(object)" → ["object"]. */
export function dotnetParameterTypes(args: string): string[] {
  return splitTopLevel(args).map((p) => {
    const t = p.replace(/\s+/g, ' ').trim();
    const sp = t.lastIndexOf(' ');
    // "ref Int32 x" / "Int32& x" / "List`1 items" → the type part; a single token is a type (Unity prints types only).
    if (sp < 0) return t;
    const head = t.slice(0, sp).trim();
    return /^(ref|out|in|params|this)$/.test(head) ? t : head;
  });
}

function isDotnetExternal(typeName: string): boolean {
  return typeName === 'System' || DOTNET_EXTERNAL_PREFIXES.some((p) => typeName.startsWith(p));
}

function noFile(file: string | undefined): boolean {
  if (!file) return true;
  const f = file.trim();
  return f === '' || f === '<filename unknown>' || /^<[0-9a-fA-F]{8,}>$/.test(f) || f === '<unknown>';
}

function dotnetFrame(index: number, raw: string, fn: string, args: string, file: string | undefined, line: string | undefined): StackFrame | undefined {
  const d = decodeDotnetName(fn);
  if (!d) return undefined;
  const hasFile = !noFile(file);
  const showsUserParameters = d.compilerKind === undefined;
  return {
    sourceLine: index,
    raw,
    language: 'dotnet',
    function: d.display,
    typeName: d.typeName,
    methodName: d.methodName,
    ...(d.localFunctionName ? { localFunctionName: d.localFunctionName } : {}),
    ...(d.compilerKind ? { compilerKind: d.compilerKind } : {}),
    ...(d.methodArity !== undefined ? { methodArity: d.methodArity } : {}),
    ...(showsUserParameters ? { parameterTypes: dotnetParameterTypes(args) } : {}),
    ...(hasFile ? { file: file!.trim() } : {}),
    ...(hasFile && line && Number(line) > 0 ? { line: Number(line) } : {}),
    external: isDotnetExternal(d.typeName),
  };
}

// ---------------------------------------------------------------- JavaScript / TypeScript

/** V8: "at fn (file:1:2)", "at async fn (file:1:2)", "at new C (file:1:2)", "at file:1:2". */
const V8_RE = /(?:^|\s)at\s+(?:(?<fn>[^()]+?)\s+\()?(?<file>[^()\s][^()]*?):(?<line>\d+):(?<col>\d+)\)?\s*$/;
/** Firefox / Safari: "fn@file:1:2", "@file:1:2". */
const GECKO_RE = /(?:^|\s)(?<fn>[^@\s]*)@(?<file>\S+?):(?<line>\d+):(?<col>\d+)\s*$/;

/** file:///C:/x.js → C:/x.js; webpack:///./src/x.ts → src/x.ts; drops ?query and #hash. */
export function cleanScriptPath(file: string): string {
  let f = file.trim();
  if (/^file:\/\//i.test(f)) {
    f = f.replace(/^file:\/\//i, '');
    try {
      f = decodeURIComponent(f);
    } catch {
      /* keep as printed */
    }
    if (/^\/[A-Za-z]:[/\\]/.test(f)) f = f.slice(1);
  }
  f = f.replace(/^webpack:\/\/[^/]*\//i, '').replace(/^(?:webpack-internal|vite|ng):\/\/\/?/i, '').replace(/^\.\//, '');
  f = f.replace(/[?#].*$/, '');
  return f;
}

function isJsExternal(file: string): boolean {
  return /(^|[\\/])node_modules[\\/]/.test(file) || /^(node:|internal[\\/]|<anonymous>|native\b|eval\b)/.test(file) || /^https?:\/\//i.test(file) || /^(chrome|moz|safari)-extension:/i.test(file);
}

function jsFrame(index: number, raw: string, fn: string | undefined, file: string, line: string, col: string): StackFrame {
  const f = cleanScriptPath(file);
  const name = (fn ?? '').replace(/^async\s+/, '').replace(/^new\s+/, '').trim() || '(anonymous)';
  return { sourceLine: index, raw, language: 'javascript', function: name, file: f, line: Number(line), column: Number(col), external: isJsExternal(f) };
}

// ---------------------------------------------------------------- Python

const PY_FRAME_RE = /File "(?<file>[^"]+)", line (?<line>\d+)(?:, in (?<fn>.+?))?\s*$/;

function isPyExternal(file: string): boolean {
  return /(site|dist)-packages/.test(file) || /^<(frozen|string|stdin)/.test(file) || /[\\/]lib[\\/]python[\d.]*[\\/]/i.test(file) || /[\\/]Lib[\\/](?!site-packages)/.test(file);
}

// ---------------------------------------------------------------- Rust

const RUST_PANIC_RE = /thread '(?<thread>[^']*)'(?: \(\d+\))? panicked at (?:'(?<msg>.*)', )?(?<file>[^\s:'][^:]*?):(?<line>\d+):(?<col>\d+):?\s*$/;
const RUST_FRAME_HEAD_RE = /^\s*(?<n>\d+):\s+(?:0x[0-9a-fA-F]+\s+-\s+)?(?<fn>\S.*?)\s*$/;
const RUST_AT_RE = /^\s*at\s+(?<file>.+?):(?<line>\d+)(?::(?<col>\d+))?\s*$/;

function rustName(fn: string): string {
  return fn.replace(/::h[0-9a-f]{16}$/, '');
}

function isRustExternal(fn: string, file: string | undefined): boolean {
  if (file && (/[\\/]rustc[\\/][0-9a-f]+[\\/]/.test(file) || /\.cargo[\\/](registry|git)[\\/]/.test(file) || /\.rustup[\\/]/.test(file))) return true;
  return /^<?(std|core|alloc|backtrace|tokio|futures|rayon)::/.test(fn) || /^(rust_begin_unwind|__rust|_start|__libc_start|main$|__scrt_common_main|BaseThreadInitThunk|RtlUserThreadStart|invoke_main)/.test(fn);
}

// ---------------------------------------------------------------- exception headers

/** "System.InvalidOperationException: msg", "TypeError: msg", "app.errors.NotFound Error: msg", "ValueError: msg". */
const HEADER_RE = /(?:^|[\s\]>|)])(?<type>(?:[A-Za-z_$][\w$`]*\.)*[\w$`]*?(?:Exception|Error|Exit|Interrupt|Fault|Panic))(?<rest>:.*|\s*)$/;

function header(text: string): { type: string; message?: string } | undefined {
  const m = HEADER_RE.exec(text);
  if (!m) return undefined;
  const msg = m.groups!.rest!.replace(/^:\s?/, '').trim();
  return msg ? { type: m.groups!.type!, message: msg } : { type: m.groups!.type! };
}

// ---------------------------------------------------------------- parser

export function parseStackTrace(text: string): ParsedTrace {
  const lines = text.split(/\n/);
  const groups: ExceptionGroup[] = [];
  /** Exception nesting: the last element receives frames. */
  let stack: ExceptionGroup[] = [];
  let pendingBoundary = false;
  let rust: { awaitingMessage: boolean; pendingFn?: { name: string; line: number; raw: string } } | undefined;

  const newGroup = (h: { type?: string; message?: string } | undefined, language: FrameLanguage | undefined, depth: number): ExceptionGroup => {
    const g: ExceptionGroup = { depth, frames: [], ...(h?.type ? { exceptionType: h.type } : {}), ...(h?.message ? { message: h.message } : {}), ...(language ? { language } : {}) };
    groups.push(g);
    return g;
  };
  const current = (language: FrameLanguage): ExceptionGroup => {
    let g = stack[stack.length - 1];
    if (!g) {
      g = newGroup(undefined, language, 0);
      stack = [g];
    }
    g.language ??= language;
    return g;
  };
  const push = (f: StackFrame) => {
    const g = current(f.language);
    if (pendingBoundary && f.language === 'dotnet') f.afterAsyncBoundary = true;
    pendingBoundary = false;
    g.frames.push(f);
  };
  const flushRustFn = () => {
    const p = rust?.pendingFn;
    if (!p) return;
    rust!.pendingFn = undefined;
    const name = rustName(p.name);
    push({ sourceLine: p.line, raw: p.raw, language: 'rust', function: name, external: isRustExternal(name, undefined) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]!);
    const t = line.trim();
    if (!t) continue;

    // ---- Rust
    const panic = RUST_PANIC_RE.exec(t);
    if (panic) {
      flushRustFn();
      const g = newGroup({ type: 'panic', ...(panic.groups!.msg ? { message: panic.groups!.msg } : {}) }, 'rust', 0);
      stack = [g];
      rust = { awaitingMessage: !panic.groups!.msg };
      const file = panic.groups!.file!;
      push({ sourceLine: i, raw: t, language: 'rust', function: '(panic location)', file, line: Number(panic.groups!.line), column: Number(panic.groups!.col), external: isRustExternal('', file) });
      continue;
    }
    if (rust) {
      if (rust.awaitingMessage) {
        rust.awaitingMessage = false;
        if (!/^(note:|stack backtrace:)/.test(t)) {
          stack[stack.length - 1]!.message = t;
          continue;
        }
      }
      if (/^stack backtrace:/.test(t) || /^note: /.test(t)) continue;
      const at = RUST_AT_RE.exec(line);
      if (at && rust.pendingFn) {
        const p = rust.pendingFn;
        rust.pendingFn = undefined;
        const name = rustName(p.name);
        const file = at.groups!.file!.trim();
        push({ sourceLine: p.line, raw: `${p.raw} ${t}`, language: 'rust', function: name, file, line: Number(at.groups!.line), ...(at.groups!.col ? { column: Number(at.groups!.col) } : {}), external: isRustExternal(name, file) });
        continue;
      }
      const head = RUST_FRAME_HEAD_RE.exec(line);
      if (head) {
        flushRustFn();
        rust.pendingFn = { name: head.groups!.fn!, line: i, raw: t };
        continue;
      }
      flushRustFn();
    }

    // ---- .NET structure lines
    if (/^-{3}\s*End of inner exception stack trace\s*-{3}$/i.test(t)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (/^-{3}\s*End of stack trace from previous location/i.test(t)) {
      pendingBoundary = true;
      continue;
    }

    // ---- Python
    if (/^Traceback \(most recent call last\):?$/.test(t)) {
      const g = newGroup(undefined, 'python', 0);
      stack = [g];
      continue;
    }
    const py = PY_FRAME_RE.exec(t);
    if (py) {
      const file = py.groups!.file!;
      push({ sourceLine: i, raw: t, language: 'python', function: py.groups!.fn?.trim() || '<module>', file, line: Number(py.groups!.line), external: isPyExternal(file) });
      continue;
    }

    // ---- JavaScript (before .NET: "at fn (file:1:2)" ends with line:column)
    const v8 = V8_RE.exec(t);
    if (v8) {
      const file = v8.groups!.file!;
      if (/\.rs$/.test(file)) {
        push({ sourceLine: i, raw: t, language: 'rust', function: '(unknown)', file, line: Number(v8.groups!.line), column: Number(v8.groups!.col), external: isRustExternal('', file) });
      } else push(jsFrame(i, t, v8.groups!.fn, file, v8.groups!.line!, v8.groups!.col!));
      continue;
    }

    // ---- .NET frames
    const at = DOTNET_AT_RE.exec(t) ?? DOTNET_LOCALISED_RE.exec(t);
    if (at) {
      const g = at.groups!;
      const f = dotnetFrame(i, t, g.fn!, g.args ?? '', g.file, g.line ?? g.line2);
      if (f) {
        push(f);
        continue;
      }
    }
    const gecko = GECKO_RE.exec(t);
    if (gecko && !/^\S+@\S+\.\w+$/.test(t.split(':')[0] ?? '')) {
      push(jsFrame(i, t, gecko.groups!.fn, gecko.groups!.file!, gecko.groups!.line!, gecko.groups!.col!));
      continue;
    }
    const unity = UNITY_RE.exec(t);
    if (unity && (unity.groups!.file || /\w:\w/.test(unity.groups!.fn!))) {
      const f = dotnetFrame(i, t, unity.groups!.fn!, unity.groups!.args ?? '', unity.groups!.file, unity.groups!.line);
      if (f) {
        push(f);
        continue;
      }
    }

    // ---- exception headers (".NET ---> inner" chains on one line)
    const parts = t.split(/\s*--->\s*/);
    const first = parts[0] ?? '';
    const innerOnly = /^--->/.test(t);
    const top = stack[stack.length - 1];
    // Indented lines inside a Python traceback are source excerpts ("    raise ValueError"), not the exception line.
    const pythonExcerpt = top?.language === 'python' && /^\s/.test(line);
    const h0 = innerOnly || pythonExcerpt ? undefined : header(first);
    if (h0) {
      const g = stack[stack.length - 1];
      if (g && g.language === 'python' && !g.exceptionType) {
        g.exceptionType = h0.type;
        if (h0.message) g.message = h0.message;
      } else if (g && g.frames.length === 0 && !g.exceptionType) {
        g.exceptionType = h0.type;
        if (h0.message) g.message = h0.message;
      } else {
        stack = [newGroup(h0, undefined, 0)];
      }
    }
    for (const part of parts.slice(1)) {
      const h = header(part) ?? { type: part.split(':')[0]!.trim(), message: part.split(':').slice(1).join(':').trim() };
      if (!h.type) continue;
      const parent = stack[stack.length - 1];
      const inner = newGroup(h, parent?.language, (parent?.depth ?? -1) + 1);
      stack.push(inner);
    }
  }
  flushRustFn();
  const kept = groups.filter((g) => g.frames.length > 0 || (groups.length === 1 && g.exceptionType));
  return { groups: kept, frameCount: kept.reduce((n, g) => n + g.frames.length, 0) };
}
