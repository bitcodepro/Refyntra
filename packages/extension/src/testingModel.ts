import type { Range, TestMethodInfo, TestProjectInfo } from '@refyntra/contracts';

// Test runner model (ADR-009): pure functions for the Test Explorer (no vscode import): the test tree of the C#
// host's discovery (code/tests, protocol 1.15), pytest and cargo test; `dotnet test` filters; TRX, JUnit XML and
// cargo test output parsing; matching results to tree items (data cases included); stack frame locations.

export type TestLanguage = 'dotnet' | 'python' | 'rust';
export type TestNodeKind = 'project' | 'namespace' | 'class' | 'method' | 'case' | 'file' | 'module';

/** One node of the test tree, before it becomes a vscode.TestItem. */
export interface TestNode {
  id: string;
  label: string;
  kind: TestNodeKind;
  language: TestLanguage;
  /** File URI string (C#: from the host; Python: the test file). */
  uri?: string;
  range?: Range;
  description?: string;
  children: TestNode[];
  /** The project (.csproj / folder of pyproject / Cargo.toml) the node runs in. */
  project: string;
  /** C#: "Ns.C.M" (method), "Ns.Outer+Inner" (class), "Ns" (namespace). Python: the pytest node id. Rust: the test path. */
  key: string;
  framework?: string;
  /** C# methods: the normalised arguments of a data case; undefined elsewhere. */
  caseArguments?: string[];
  /** C# methods: the names of the other test methods of the class (precise NUnit filters). */
  siblings?: string[];
  skipReason?: string;
}

// ------------------------------------------------------------------------------------------------ C# tree

export const DOTNET_PREFIX = 'dotnet:';

export function dotnetMethodId(projectUri: string, fqn: string): string {
  return `${DOTNET_PREFIX}test:${projectUri}|${fqn}`;
}

export function dotnetCaseId(methodId: string, label: string): string {
  return `${methodId}|${label}`;
}

/** project → namespace → class (nested classes inside their outer class) → method → data cases. */
export function buildDotnetTree(projects: readonly TestProjectInfo[], tests: readonly TestMethodInfo[], projectPath: (uri: string) => string): TestNode[] {
  const out: TestNode[] = [];
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sorted) {
    const mine = tests.filter((t) => t.projectUri === p.projectUri);
    const proj: TestNode = { id: `${DOTNET_PREFIX}proj:${p.projectUri}`, label: p.name, kind: 'project', language: 'dotnet', uri: p.projectUri, children: [], project: projectPath(p.projectUri), key: '', ...(p.frameworks.length ? { description: p.frameworks.join(', ') } : {}) };
    const namespaces = new Map<string, TestNode>();
    const classes = new Map<string, TestNode>();
    const byClass = new Map<string, TestMethodInfo[]>();
    for (const t of mine) {
      const classFqn = classFqnOf(t);
      if (!byClass.has(classFqn)) byClass.set(classFqn, []);
      byClass.get(classFqn)!.push(t);
    }
    for (const t of [...mine].sort((a, b) => a.fullyQualifiedName.localeCompare(b.fullyQualifiedName))) {
      let parent: TestNode = proj;
      if (t.namespace) {
        let ns = namespaces.get(t.namespace);
        if (!ns) {
          ns = { id: `${DOTNET_PREFIX}ns:${p.projectUri}|${t.namespace}`, label: t.namespace, kind: 'namespace', language: 'dotnet', children: [], project: proj.project, key: t.namespace };
          namespaces.set(t.namespace, ns);
          proj.children.push(ns);
        }
        parent = ns;
      }
      let path = t.namespace;
      for (let i = 0; i < t.classes.length; i++) {
        const c = t.classes[i]!;
        path = i === 0 ? (path ? `${path}.${c.name}` : c.name) : `${path}+${c.name}`;
        let node = classes.get(path);
        if (!node) {
          node = { id: `${DOTNET_PREFIX}class:${p.projectUri}|${path}`, label: c.name, kind: 'class', language: 'dotnet', uri: t.uri, range: c.nameRange, children: [], project: proj.project, key: path };
          classes.set(path, node);
          parent.children.push(node);
        }
        parent = node;
      }
      const id = dotnetMethodId(p.projectUri, t.fullyQualifiedName);
      const siblings = (byClass.get(classFqnOf(t)) ?? []).map((x) => x.method).filter((m) => m !== t.method);
      const method: TestNode = {
        id,
        label: t.method,
        kind: 'method',
        language: 'dotnet',
        uri: t.uri,
        range: t.nameRange,
        children: [],
        project: proj.project,
        key: t.fullyQualifiedName,
        framework: t.framework,
        siblings,
        ...(t.skipReason ? { skipReason: t.skipReason, description: 'skipped' } : {}),
      };
      for (const c of t.cases) {
        method.children.push({ id: dotnetCaseId(id, c.label), label: c.label, kind: 'case', language: 'dotnet', uri: t.uri, range: c.range, children: [], project: proj.project, key: t.fullyQualifiedName, framework: t.framework, caseArguments: c.arguments, siblings });
      }
      parent.children.push(method);
    }
    out.push(proj);
  }
  return out;
}

function classFqnOf(t: TestMethodInfo): string {
  const nested = t.classes.map((c) => c.name).join('+');
  return t.namespace ? `${t.namespace}.${nested}` : nested;
}

/** Replaces the tests of `documents` (an incremental result) in a full list. */
export function mergeTests(previous: readonly TestMethodInfo[], documents: readonly string[], updated: readonly TestMethodInfo[], key: (uri: string) => string = (u) => u): TestMethodInfo[] {
  const changed = new Set(documents.map(key));
  return [...previous.filter((t) => !changed.has(key(t.uri))), ...updated];
}

// ------------------------------------------------------------------------------------------------ dotnet test

/**
 * The `dotnet test --filter` of the selected nodes of one project; undefined runs the whole project. Methods of
 * xUnit and MSTest: `FullyQualifiedName=` (their names carry no data arguments). NUnit adds the arguments to the
 * name, so: contains, minus the sibling methods whose names start with it. Classes: `Ns.C.` and `Ns.C+` (nested).
 * Data cases run their method (adapters do not filter single data rows). No parentheses or escapes: test adapters
 * parse filters differently, but all of them understand `|`, `&`, `=`, `~` and `!~`.
 */
export function dotnetFilter(nodes: readonly Pick<TestNode, 'kind' | 'key' | 'framework' | 'siblings'>[]): string | undefined {
  if (nodes.some((n) => n.kind === 'project')) return undefined;
  const parts: string[] = [];
  const add = (p: string) => {
    if (!parts.includes(p)) parts.push(p);
  };
  for (const n of nodes) {
    if (n.kind === 'namespace') add(`FullyQualifiedName~${n.key}.`);
    else if (n.kind === 'class') {
      add(`FullyQualifiedName~${n.key}.`);
      add(`FullyQualifiedName~${n.key}+`);
    } else if (n.kind === 'method' || n.kind === 'case') {
      if (n.framework === 'NUnit') {
        const method = n.key.slice(n.key.lastIndexOf('.') + 1);
        const prefix = n.key.slice(0, n.key.length - method.length);
        const excluded = (n.siblings ?? []).filter((s) => s.startsWith(method) && s !== method).map((s) => `FullyQualifiedName!~${prefix}${s}`);
        add([`FullyQualifiedName~${n.key}`, ...excluded].join('&'));
      } else add(`FullyQualifiedName=${n.key}`);
    }
  }
  return parts.length ? parts.join('|') : undefined;
}

export function dotnetTestArgs(project: string, opts: { filter?: string; resultsDirectory: string; noBuild?: boolean; configuration?: string; coverage?: boolean }): string[] {
  return [
    'test',
    project,
    '--nologo',
    '-c',
    opts.configuration ?? 'Debug',
    '--logger',
    'trx',
    '--results-directory',
    opts.resultsDirectory,
    ...(opts.filter ? ['--filter', opts.filter] : []),
    ...(opts.noBuild ? ['--no-build'] : []),
    ...(opts.coverage ? ['--collect', 'XPlat Code Coverage'] : []),
  ];
}

/** The testhost process id that `dotnet test` prints with VSTEST_HOST_DEBUG=1, or undefined. */
export function testhostProcessId(output: string): number | undefined {
  // Windows: "Name: testhost"; Linux and macOS: "Name: dotnet" (the host runs as `dotnet exec testhost.dll`).
  const m = /Process Id:\s*(\d+),\s*Name:\s*\S+/i.exec(output);
  return m ? Number(m[1]) : undefined;
}

// ------------------------------------------------------------------------------------------------ TRX

export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'errored';

export interface TrxResult {
  className: string;
  /** The method name without data arguments. */
  methodName: string;
  /** The display name of the result: "Ns.C.M(a: 1, b: 2)", "M(1,2)", "M (1,2)". */
  testName: string;
  outcome: TestOutcome;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
  stdout?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_: string, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e] ?? ''),
  );
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : undefined;
}

function element(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? decodeXml(m[1]!).replace(/\r\n/g, '\n') : undefined;
}

/** "00:00:01.2500000" → 1250. */
export function parseDuration(text: string | undefined): number | undefined {
  const m = text ? /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(text) : null;
  if (!m) return undefined;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** The results of a VSTest TRX file (`--logger trx`): outcome, duration, error message, stack trace and output. */
export function parseTrx(xml: string): TrxResult[] {
  const methods = new Map<string, { className: string; name: string }>();
  for (const m of xml.matchAll(/<UnitTest\s[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/UnitTest>/g)) {
    const tm = /<TestMethod\s[^>]*>/.exec(m[2]!);
    if (!tm) continue;
    methods.set(m[1]!, { className: attr(tm[0], 'className') ?? '', name: attr(tm[0], 'name') ?? '' });
  }
  const out: TrxResult[] = [];
  for (const m of xml.matchAll(/<UnitTestResult\s([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const tag = ` ${m[1]}`;
    const testId = attr(tag, 'testId') ?? '';
    const testName = attr(tag, 'testName') ?? '';
    const def = methods.get(testId);
    const outcomeText = (attr(tag, 'outcome') ?? '').toLowerCase();
    const outcome: TestOutcome = outcomeText === 'passed' ? 'passed' : outcomeText === 'failed' ? 'failed' : outcomeText === 'notexecuted' || outcomeText === 'inconclusive' ? 'skipped' : 'errored';
    const body = m[3] ?? '';
    const methodName = (def?.name ?? testName).replace(/\s*\(.*$/s, '');
    const r: TrxResult = { className: def?.className ?? '', methodName: methodName.slice(methodName.lastIndexOf('.') + 1), testName, outcome };
    const d = parseDuration(attr(tag, 'duration'));
    if (d !== undefined) r.durationMs = d;
    const message = element(body, 'Message');
    if (message) r.message = message;
    const stack = element(body, 'StackTrace');
    if (stack) r.stackTrace = stack;
    const stdout = element(body, 'StdOut');
    if (stdout) r.stdout = stdout;
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ result matching

/** The data arguments of a result display name ("M(a: 1, b: \"x\")" → ["1", "x"]), normalised; [] without any. */
export function displayArguments(testName: string): string[] {
  const open = testName.indexOf('(');
  if (open < 0 || !testName.trimEnd().endsWith(')')) return [];
  const inner = testName.trimEnd().slice(open + 1, -1);
  return splitTopLevel(inner).map((a) => normalizeArgument(a.replace(/^\s*[A-Za-z_]\w*\s*:\s*(?=[^:])/, '')));
}

/** Splits on commas outside quotes and brackets. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) cur += text[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map((s) => s.trim());
}

/** The same normalisation as the host's TestDiscovery.NormalizeArgument (quotes, numeric suffixes, enum types, blanks, case). */
export function normalizeArgument(text: string): string {
  let t = text.trim();
  if (t.startsWith('@')) t = t.slice(1);
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) t = t.slice(1, -1);
  else {
    const num = /^([-+]?\d[\d_]*(\.\d+)?([eE][-+]?\d+)?)[dDfFmMlLuU]{0,2}$/.exec(t);
    if (num) t = num[1]!.replace(/_/g, '');
    else if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(t)) t = t.slice(t.lastIndexOf('.') + 1);
  }
  return t.replace(/\s+/g, '').toLowerCase();
}

export interface MatchedResult {
  /** The tree item to report on (a method, a source data case, or a run-time case to add under `parentId`). */
  id: string;
  /** Set when the result is a data case that is not in the source tree: add it under this method. */
  parentId?: string;
  label?: string;
  result: TrxResult;
}

/**
 * Maps TRX results to tree items: class + method name to the method node; data arguments to its source case (the
 * same normalised arguments), else a run-time case item under the method (MemberData, TestCaseSource, …).
 */
export function matchDotnetResults(results: readonly TrxResult[], methods: ReadonlyMap<string, TestNode>): MatchedResult[] {
  const out: MatchedResult[] = [];
  for (const r of results) {
    const fqn = `${r.className}.${r.methodName}`;
    const method = methods.get(fqn) ?? methods.get(fqn.replace(/\+/g, '.'));
    if (!method) continue;
    const args = displayArguments(r.testName);
    if (args.length === 0 && !/\(.*\)\s*$/.test(r.testName)) {
      out.push({ id: method.id, result: r });
      continue;
    }
    const key = args.join('\u0001');
    const source = method.children.find((c) => c.caseArguments && c.caseArguments.join('\u0001') === key);
    if (source) {
      out.push({ id: source.id, result: r });
      continue;
    }
    const label = r.testName.slice(r.testName.indexOf('('));
    out.push({ id: dotnetCaseId(method.id, `~${label}`), parentId: method.id, label, result: r });
  }
  return out;
}

/** A parent's outcome from its children's: failed beats errored beats passed beats skipped. */
export function aggregateOutcome(outcomes: readonly TestOutcome[]): TestOutcome | undefined {
  if (outcomes.length === 0) return undefined;
  for (const o of ['failed', 'errored', 'passed'] as const) if (outcomes.includes(o)) return o;
  return 'skipped';
}

// ------------------------------------------------------------------------------------------------ stack traces

export interface FrameLocation {
  path: string;
  /** 1-based. */
  line: number;
  /** The frame without its file part: "at Ns.C.M()", "in test_x". */
  text: string;
}

/** File locations of a .NET (`at X in /p/F.cs:line 12`), Python (`File "p.py", line 3` / `p.py:3: in f`) or Rust (`src/lib.rs:4:9`) trace. */
export function stackLocations(trace: string): FrameLocation[] {
  const out: FrameLocation[] = [];
  for (const line of trace.split(/\r?\n/)) {
    let m = /\sin\s(.+?):line\s(\d+)\s*$/.exec(line);
    if (!m) m = /File "(.+?)", line (\d+)/.exec(line);
    if (!m) m = /^(\S+\.py):(\d+):/.exec(line.trim());
    if (!m) m = /(?:^|\s|at\s)((?:[A-Za-z]:)?[^\s:]+\.rs):(\d+)(?::\d+)?/.exec(line);
    if (m) out.push({ path: m[1]!, line: Number(m[2]), text: line.replace(m[0], '').trim().replace(/^,\s*/, '') || line.trim() });
  }
  return out;
}

/** The frame to show a failure at: the first one in `preferred` (the test's file), else the first one that `exists`. */
export function failureLocation(trace: string | undefined, exists: (p: string) => boolean, preferred?: string): FrameLocation | undefined {
  if (!trace) return undefined;
  const frames = stackLocations(trace).filter((f) => exists(f.path));
  const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  return (preferred ? frames.find((f) => same(f.path, preferred)) : undefined) ?? frames[0];
}

// ------------------------------------------------------------------------------------------------ pytest

export const PYTHON_PREFIX = 'python:';

/** Node ids of `python -m pytest --collect-only -q` (lines with "::", before the summary). */
export function parsePytestCollect(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('::') || /^(=|_|ERROR|FAILED|WARNING)/.test(line) || /\s(collected|error|errors|warning|warnings)\b/.test(line)) continue;
    ids.push(line);
  }
  return ids;
}

/** file → class → function → parameter cases, from pytest node ids ("tests/test_a.py::TestC::test_m[1-2]"). */
export function buildPytestTree(nodeIds: readonly string[], root: string, toUri: (relPath: string) => string): TestNode[] {
  const files = new Map<string, TestNode>();
  const nodes = new Map<string, TestNode>();
  const out: TestNode[] = [];
  for (const id of nodeIds) {
    const parts = id.split('::');
    const file = parts[0]!;
    let fileNode = files.get(file);
    if (!fileNode) {
      fileNode = { id: `${PYTHON_PREFIX}${file}`, label: file, kind: 'file', language: 'python', uri: toUri(file), children: [], project: root, key: file };
      files.set(file, fileNode);
      out.push(fileNode);
    }
    let parent = fileNode;
    let path = file;
    for (let i = 1; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const part = parts[i]!;
      const bracket = last ? part.indexOf('[') : -1;
      const name = bracket > 0 ? part.slice(0, bracket) : part;
      path = `${path}::${name}`;
      let node = nodes.get(path);
      if (!node) {
        node = { id: `${PYTHON_PREFIX}${path}`, label: name, kind: last ? 'method' : 'class', language: 'python', uri: fileNode.uri, children: [], project: root, key: path };
        nodes.set(path, node);
        parent.children.push(node);
      }
      parent = node;
      if (bracket > 0) {
        const caseId = `${path}${part.slice(bracket)}`;
        parent.children.push({ id: `${PYTHON_PREFIX}${caseId}`, label: part.slice(bracket), kind: 'case', language: 'python', uri: fileNode.uri, children: [], project: root, key: caseId });
      }
    }
  }
  return out;
}

/** The pytest node id of a JUnit XML testcase ("tests.test_a.TestC" + "test_m[1]" → "tests/test_a.py::TestC::test_m[1]"), resolved against the known ids. */
export function pytestNodeId(classname: string, name: string, known: ReadonlySet<string>): string | undefined {
  const segs = classname.split('.');
  for (let i = segs.length; i >= 1; i--) {
    const file = `${segs.slice(0, i).join('/')}.py`;
    const id = [file, ...segs.slice(i), name].join('::');
    if (known.has(id)) return id;
  }
  return undefined;
}

export interface JunitResult {
  classname: string;
  name: string;
  outcome: TestOutcome;
  durationMs?: number;
  message?: string;
  details?: string;
  stdout?: string;
}

/** The testcases of a JUnit XML report (pytest --junitxml). */
export function parseJunitXml(xml: string): JunitResult[] {
  const out: JunitResult[] = [];
  for (const m of xml.matchAll(/<testcase\s([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = ` ${m[1]}`;
    const body = m[3] ?? '';
    const r: JunitResult = { classname: attr(tag, 'classname') ?? '', name: attr(tag, 'name') ?? '', outcome: 'passed' };
    const time = attr(tag, 'time');
    if (time && !Number.isNaN(Number(time))) r.durationMs = Math.round(Number(time) * 1000);
    const problem = /<(failure|error|skipped)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (problem) {
      r.outcome = problem[1] === 'failure' ? 'failed' : problem[1] === 'error' ? 'errored' : 'skipped';
      const msg = attr(` ${problem[2]}`, 'message');
      if (msg) r.message = msg;
      if (problem[4]) r.details = decodeXml(problem[4]);
    }
    const out1 = element(body, 'system-out');
    if (out1) r.stdout = out1;
    out.push(r);
  }
  return out;
}

export function pytestArgs(nodeIds: readonly string[], junitFile: string): string[] {
  return ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${junitFile}`, ...nodeIds];
}

// ------------------------------------------------------------------------------------------------ cargo test

export const RUST_PREFIX = 'rust:';

/** Test names of `cargo test -- --list` ("tests::adds: test"). */
export function parseCargoList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+): test$/.exec(line.trim());
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** module → test, from cargo test names ("a::b::c"). */
export function buildCargoTree(names: readonly string[], manifestDir: string, crate: string): TestNode[] {
  const root: TestNode = { id: `${RUST_PREFIX}${manifestDir}`, label: crate, kind: 'project', language: 'rust', children: [], project: manifestDir, key: '' };
  const modules = new Map<string, TestNode>();
  for (const name of [...names].sort()) {
    const parts = name.split('::');
    let parent = root;
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? `${path}::${parts[i]!}` : parts[i]!;
      let m = modules.get(path);
      if (!m) {
        m = { id: `${RUST_PREFIX}${manifestDir}|${path}::`, label: parts[i]!, kind: 'module', language: 'rust', children: [], project: manifestDir, key: `${path}::` };
        modules.set(path, m);
        parent.children.push(m);
      }
      parent = m;
    }
    parent.children.push({ id: `${RUST_PREFIX}${manifestDir}|${name}`, label: parts[parts.length - 1]!, kind: 'method', language: 'rust', children: [], project: manifestDir, key: name });
  }
  return [root];
}

export interface CargoResult {
  name: string;
  outcome: TestOutcome;
  output?: string;
}

/** `test a::b ... ok|FAILED|ignored` lines plus the `---- a::b stdout ----` sections of failures. */
export function parseCargoTestOutput(stdout: string): CargoResult[] {
  const out: CargoResult[] = [];
  for (const m of stdout.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) out.push({ name: m[1]!, outcome: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped' });
  for (const m of stdout.matchAll(/^---- (\S+) stdout ----\r?\n([\s\S]*?)(?=^---- |^failures:|^test result:)/gm)) {
    const r = out.find((x) => x.name === m[1]);
    if (r) r.output = m[2]!.trim();
  }
  return out;
}

/** `cargo test` arguments for selected nodes: exact test names, module prefixes, or everything. */
export function cargoTestArgs(nodes: readonly Pick<TestNode, 'kind' | 'key'>[]): string[] {
  if (nodes.length === 0 || nodes.some((n) => n.kind === 'project')) return ['test'];
  const methods = nodes.filter((n) => n.kind === 'method').map((n) => n.key);
  const modules = nodes.filter((n) => n.kind === 'module').map((n) => n.key);
  if (modules.length === 0) return ['test', '--', '--exact', ...methods];
  return ['test', '--', ...modules, ...methods];
}

// ------------------------------------------------------------------------------------------------ coverage

export interface CoberturaFile {
  /** As written in the report: absolute, or relative to one of `sources`. */
  filename: string;
  /** 1-based line → hits (the most hits when several classes of the file list the line). */
  lines: Map<number, number>;
}

/** Line coverage of a Cobertura report (coverlet.collector `XPlat Code Coverage`), merged per file. */
export function parseCobertura(xml: string): { sources: string[]; files: CoberturaFile[] } {
  const sources = [...xml.matchAll(/<source>([\s\S]*?)<\/source>/g)].map((m) => decodeXml(m[1]!).trim()).filter(Boolean);
  const files = new Map<string, CoberturaFile>();
  for (const c of xml.matchAll(/<class\s([^>]*?)>([\s\S]*?)<\/class>/g)) {
    const filename = attr(` ${c[1]!}`, 'filename');
    if (!filename) continue;
    let f = files.get(filename);
    if (!f) {
      f = { filename, lines: new Map() };
      files.set(filename, f);
    }
    // Lines of the class body (methods repeat them): every <line> element counts once per number.
    for (const l of c[2]!.matchAll(/<line\s([^>]*?)\/?>/g)) {
      const n = Number(attr(` ${l[1]!}`, 'number'));
      const hits = Number(attr(` ${l[1]!}`, 'hits'));
      if (!Number.isFinite(n) || !Number.isFinite(hits)) continue;
      f.lines.set(n, Math.max(f.lines.get(n) ?? 0, hits));
    }
  }
  return { sources, files: [...files.values()] };
}

/** True when the project (file text or restored assets) references coverlet.collector. */
export function referencesCoverlet(projectText: string, assetsText?: string): boolean {
  return /coverlet\.collector/i.test(projectText) || (!!assetsText && /"coverlet\.collector\//i.test(assetsText));
}
