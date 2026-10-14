import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { TestMethodInfo, TestProjectInfo } from '@refyntra/contracts';
import { type DebuggerLocator, buildDotnet, killTree, onPath } from './run';
import { DOTNET_DEBUG_TYPE, PYTHON_DEBUG_TYPE } from './runModel';
import {
  type JunitResult,
  type TestNode,
  type TestOutcome,
  type TrxResult,
  aggregateOutcome,
  buildCargoTree,
  buildDotnetTree,
  buildPytestTree,
  cargoTestArgs,
  dotnetFilter,
  dotnetTestArgs,
  detectTestRunner,
  mtpTestArgs,
  failureLocation,
  matchDotnetResults,
  mergeTests,
  parseCargoList,
  parseCargoTestOutput,
  parseJunitXml,
  parsePytestCollect,
  parseTrx,
  pytestArgs,
  parseCobertura,
  pytestNodeId,
  referencesCoverlet,
  stackLocations,
  testhostProcessId,
  STATUS_ITEM_ID,
  testingStatusText,
} from './testingModel';

// Test runner (ADR-009) on VS Code's native Testing API, with no other extension: C# tests from the host's discovery
// (code/tests, protocol 1.15) run with `dotnet test` (results from a TRX file) and debug with the bundled netcoredbg
// attached to the test host (VSTEST_HOST_DEBUG); pytest (JUnit XML) and cargo test when they are installed. Running
// tests builds and executes workspace code: trusted workspaces only.

export const TEST_CONTROLLER_ID = 'refyntra';

/** One reported outcome (kept for the e2e and the CodeLens). */
export interface ReportedResult {
  outcome: TestOutcome;
  durationMs?: number;
  message?: string;
  location?: { path: string; line: number };
}

export interface TestingState {
  /** Item ids by tree level, depth first ("dotnet:proj:…", …). */
  ids: string[];
  /** Labels of the tree, indented by depth (two blanks per level). */
  outline: string[];
  results: Record<string, ReportedResult>;
  /** Runs started (the e2e waits for a count instead of sleeping). */
  runs: number;
  running: boolean;
  /** The item ids the last run was asked for (request.include), for the e2e of Rerun Failed. */
  lastRun: string[];
  pytest: 'unknown' | 'installed' | 'missing' | 'noInterpreter' | 'noTests';
  cargo: 'unknown' | 'found' | 'missing' | 'noCrate';
  lastDebugProcessId?: number;
  /** Steps of the last debugged test run (process id, attach, session start and end). */
  debugTrace: string[];
}

const EXCLUDE = '**/{node_modules,bin,obj,.git,target,__pycache__,.venv,venv,dist,out}/**';
const isWin = process.platform === 'win32';
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
/** A file URI as a comparable key: VS Code and the host spell drive letters and escapes differently on Windows. */
const fileKey = (uri: string): string => {
  const p = vscode.Uri.parse(uri).fsPath;
  return isWin ? p.toLowerCase() : p;
};

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Runs a short command with a timeout; the output and exit code (null on timeout or a missing program). */
function capture(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

export class TestingService implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController(TEST_CONTROLLER_ID, 'Refyntra Tests');
  readonly runProfile: vscode.TestRunProfile;
  readonly debugProfile: vscode.TestRunProfile;
  readonly coverageProfile: vscode.TestRunProfile;
  private readonly coverageDetails = new Map<string, vscode.FileCoverageDetail[]>();
  private readonly subs: vscode.Disposable[] = [];
  private readonly nodes = new Map<string, TestNode>();
  private readonly items = new Map<string, vscode.TestItem>();
  private dotnetProjects: TestProjectInfo[] = [];
  private dotnetTests: TestMethodInfo[] = [];
  private pythonRoots: TestNode[] = [];
  private rustRoots: TestNode[] = [];
  private readonly results = new Map<string, ReportedResult>();
  private readonly pending = new Set<string>();
  private changeTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private runs = 0;
  private lastRun: string[] = [];
  private running = 0;
  private pytest: TestingState['pytest'] = 'unknown';
  private cargo: TestingState['cargo'] = 'unknown';
  private pytestInterpreter: string | undefined;
  private lastDebugPid: number | undefined;
  private debugTrace: string[] = [];
  private readonly sources = new Set<vscode.CancellationTokenSource>();
  private csharpReady = false;
  private csharpState: string | undefined;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;

  constructor(
    private readonly engine: EngineClient,
    private readonly debuggers: DebuggerLocator,
    private readonly isTrusted: () => boolean,
  ) {
    this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (r, t) => this.enqueue(r, t, false), true, undefined, true);
    this.debugProfile = this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (r, t) => this.enqueue(r, t, true), true);
    // Coverage with coverlet.collector, only when the test project already references it (Refyntra adds no package).
    this.coverageProfile = this.controller.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, (r, t) => this.enqueue(r, t, false), true);
    this.coverageProfile.loadDetailedCoverage = async (_run, fc) => this.coverageDetails.get(fc.uri.toString()) ?? [];
    this.controller.refreshHandler = () => this.refresh(true);
    // The Test Explorer opened (or an item expanded): discover Python and Rust tests too (they compile or import code).
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.refresh(true);
    };
    queueMicrotask(() => this.rebuild());
    this.subs.push(
      this.controller,
      this.lensChanged,
      engine.onDidChangeHealth((h) => {
        const ready = h.adapters.some((a) => a.adapterId === 'csharp' && a.state === 'Ready');
        const state = h.adapters.find((a) => a.adapterId === 'csharp')?.state;
        const changed = state !== this.csharpState;
        this.csharpState = state;
        if (ready && !this.csharpReady) void this.refreshDotnet();
        this.csharpReady = ready;
        if (changed) this.rebuild();
      }),
      engine.onDidInvalidate(() => {
        if (this.csharpReady) void this.refreshDotnet();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'csharp' && e.document.uri.scheme === 'file' && e.contentChanges.length) this.documentChanged(e.document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('refyntra.tests')) this.lensChanged.fire();
      }),
    );
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    for (const s of this.subs) s.dispose();
  }

  // ---------------------------------------------------------------------------------------------- discovery

  async refresh(all = false): Promise<void> {
    await this.refreshDotnet();
    if (all) await Promise.all([this.refreshPython(), this.refreshRust()]);
  }

  /** Full C# discovery (every test project). */
  async refreshDotnet(): Promise<void> {
    if (!this.isTrusted() || typeof this.engine.tests !== 'function') return;
    const r = await this.engine.tests();
    if (r.kind !== 'tests') return;
    this.dotnetProjects = r.result.projects;
    this.dotnetTests = r.result.tests;
    this.rebuild();
  }

  /** Incremental C# discovery: only the edited documents, a moment after the last keystroke. */
  private documentChanged(uri: string): void {
    this.pending.add(uri);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => void this.flushChanges(), 600);
  }

  private async flushChanges(): Promise<void> {
    const uris = [...this.pending];
    this.pending.clear();
    if (!uris.length || !this.csharpReady || typeof this.engine.tests !== 'function') return;
    const r = await this.engine.tests(uris);
    if (r.kind !== 'tests' || !r.result.documents) return;
    this.dotnetProjects = r.result.projects;
    this.dotnetTests = mergeTests(this.dotnetTests, r.result.documents, r.result.tests, fileKey);
    this.rebuild();
  }

  private folders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  }

  async refreshPython(): Promise<void> {
    if (!this.isTrusted()) return;
    const files = await vscode.workspace.findFiles('**/{test_*.py,*_test.py}', EXCLUDE, 200);
    if (files.length === 0) {
      this.pytest = 'noTests';
      this.pythonRoots = [];
      this.rebuild();
      return;
    }
    const python = this.debuggers.python();
    this.pytestInterpreter = python;
    if (!python) {
      this.pytest = 'noInterpreter';
      return;
    }
    const roots: TestNode[] = [];
    let installed = false;
    for (const folder of this.folders()) {
      if (!files.some((f) => f.fsPath.startsWith(folder.uri.fsPath))) continue;
      const version = await capture(python, ['-m', 'pytest', '--version'], folder.uri.fsPath, 30000);
      if (version.code !== 0) continue;
      installed = true;
      const r = await capture(python, ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'], folder.uri.fsPath, 120000);
      const ids = parsePytestCollect(r.stdout);
      roots.push(...buildPytestTree(ids, folder.uri.fsPath, (rel) => vscode.Uri.file(path.join(folder.uri.fsPath, rel)).toString()));
    }
    this.pytest = installed ? 'installed' : 'missing';
    this.pythonRoots = roots;
    this.rebuild();
  }

  async refreshRust(): Promise<void> {
    if (!this.isTrusted()) return;
    const manifests = (await vscode.workspace.findFiles('**/Cargo.toml', EXCLUDE, 20)).filter((m) => !m.fsPath.split(/[\\/]/).includes('target'));
    if (manifests.length === 0) {
      this.cargo = 'noCrate';
      return;
    }
    const cargo = onPath(['cargo'], [path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin')]);
    if (!cargo) {
      this.cargo = 'missing';
      return;
    }
    this.cargo = 'found';
    const roots: TestNode[] = [];
    for (const m of manifests) {
      const dir = path.dirname(m.fsPath);
      const r = await capture(cargo, ['test', '--', '--list'], dir, 600000);
      const names = parseCargoList(r.stdout);
      if (names.length) roots.push(...buildCargoTree(names, dir, path.basename(dir)));
    }
    this.rustRoots = roots;
    this.rebuild();
  }

  /** Health: why a language shows no tests. */
  healthText(): string {
    const parts = ['C# tests (xUnit, NUnit, MSTest) are discovered by the C# host and run with dotnet test; debugging attaches the bundled netcoredbg to the test host.'];
    if (this.pytest === 'missing') parts.push(`Python: pytest is not installed for ${this.pytestInterpreter ?? 'the interpreter'}, so Python tests are not listed (install it with "python -m pip install pytest").`);
    else if (this.pytest === 'noInterpreter') parts.push('Python: no interpreter was found, so Python tests are not listed.');
    else if (this.pytest === 'installed') parts.push('Python: pytest found; tests run with pytest (JUnit XML results).');
    if (this.cargo === 'missing') parts.push('Rust: cargo was not found, so Rust tests are not listed.');
    else if (this.cargo === 'found') parts.push('Rust: tests are listed with cargo test -- --list and run with cargo test (debugging Rust tests is not supported).');
    return parts.join(' ');
  }

  /** Builds the tree from the three sources, reusing existing items (results and expansion stay). */
  private rebuild(): void {
    const roots = [
      ...buildDotnetTree(this.dotnetProjects, this.dotnetTests, (u) => vscode.Uri.parse(u).fsPath),
      ...this.pythonRoots,
      ...this.rustRoots,
    ];
    this.nodes.clear();
    const index = (n: TestNode) => {
      this.nodes.set(n.id, n);
      n.children.forEach(index);
    };
    roots.forEach(index);
    const live = new Set<string>();
    if (roots.length === 0) {
      // No test yet: VS Code would show its "Install Additional Test Extensions" button, which misleads here (Refyntra
      // is the test runner). One status row says what is happening instead; it is not a test and never runs.
      const s = testingStatusText({ trusted: this.isTrusted(), csharpState: this.csharpState, discovered: this.dotnetProjects.length > 0 });
      const item = this.controller.createTestItem(STATUS_ITEM_ID, s.label);
      item.description = s.description;
      item.canResolveChildren = false;
      this.controller.items.replace([item]);
      this.items.clear();
      this.lensChanged.fire();
      return;
    }
    this.sync(this.controller.items, roots, live);
    for (const id of [...this.items.keys()]) if (!live.has(id) && !id.includes('|~')) this.items.delete(id);
    this.lensChanged.fire();
  }

  private sync(collection: vscode.TestItemCollection, nodes: readonly TestNode[], live: Set<string>): void {
    const list: vscode.TestItem[] = [];
    for (const n of nodes) {
      let item = this.items.get(n.id);
      const uri = n.uri ? vscode.Uri.parse(n.uri) : undefined;
      if (!item || item.uri?.toString() !== uri?.toString()) {
        item = this.controller.createTestItem(n.id, n.label, uri);
        this.items.set(n.id, item);
      }
      item.label = n.label;
      item.description = n.description;
      item.range = n.range ? new vscode.Range(n.range.start.line, n.range.start.character, n.range.end.line, n.range.end.character) : undefined;
      item.sortText = n.range ? `${String(n.range.start.line).padStart(6, '0')}` : n.label;
      live.add(n.id);
      // Run-time data cases (MemberData, TestCaseSource) stay until the method disappears.
      const dynamic: vscode.TestItem[] = [];
      item.children.forEach((c) => {
        if (c.id.includes('|~')) dynamic.push(c);
      });
      this.sync(item.children, n.children, live);
      for (const d of dynamic) {
        item.children.add(d);
        live.add(d.id);
      }
      list.push(item);
    }
    collection.replace(list);
  }

  state(): TestingState {
    const ids: string[] = [];
    const outline: string[] = [];
    const walk = (c: vscode.TestItemCollection, depth: number) => {
      const sorted: vscode.TestItem[] = [];
      c.forEach((i) => sorted.push(i));
      sorted.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
      for (const i of sorted) {
        ids.push(i.id);
        outline.push(`${'  '.repeat(depth)}${i.label}`);
        walk(i.children, depth + 1);
      }
    };
    walk(this.controller.items, 0);
    return {
      ids,
      outline,
      results: Object.fromEntries(this.results),
      runs: this.runs,
      running: this.running > 0,
      lastRun: this.lastRun,
      pytest: this.pytest,
      cargo: this.cargo,
      ...(this.lastDebugPid !== undefined ? { lastDebugProcessId: this.lastDebugPid } : {}),
      debugTrace: [...this.debugTrace],
    };
  }

  /** The tree node of an item; a run-time data case (not in the discovered tree) runs as its method. */
  private nodeOf(item: vscode.TestItem): TestNode | undefined {
    return this.nodes.get(item.id) ?? (item.parent ? this.nodeOf(item.parent) : undefined);
  }

  item(id: string): vscode.TestItem | undefined {
    return this.items.get(id);
  }

  /** Runs (or debugs) items by id, as the Test Explorer would; resolves when the run ended. */
  runIds(ids: readonly string[], debug = false, coverage = false): Promise<void> {
    const items = ids.map((i) => this.items.get(i)).filter((i): i is vscode.TestItem => !!i);
    const profile = debug ? this.debugProfile : coverage ? this.coverageProfile : this.runProfile;
    const cts = new vscode.CancellationTokenSource();
    this.sources.add(cts);
    return this.enqueue(new vscode.TestRunRequest(items, undefined, profile), cts.token, debug).finally(() => {
      this.sources.delete(cts);
      cts.dispose();
    });
  }

  /** Cancels the runs started with runIds (their processes are killed). */
  cancelAll(): void {
    for (const s of this.sources) s.cancel();
  }

  // ---------------------------------------------------------------------------------------------- runs

  /** One run at a time (runs from the explorer, CodeLens and continuous runs queue up). */
  private enqueue(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean): Promise<void> {
    if (request.include?.length && request.include.every((i) => i.id === STATUS_ITEM_ID)) return Promise.resolve();
    if (request.continuous) {
      this.watch(request, token);
      return Promise.resolve();
    }
    const next = this.queue.then(() => this.execute(request, token, debug));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Continuous run: on save, the test classes of the saved file (or every requested test after a change elsewhere). */
  private watch(request: vscode.TestRunRequest, token: vscode.CancellationToken): void {
    const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (token.isCancellationRequested) return;
      const lang = doc.languageId;
      if (!['csharp', 'python', 'rust'].includes(lang)) return;
      const scope = request.include ?? this.roots();
      const uri = fileKey(doc.uri.toString());
      const inScope = (item: vscode.TestItem): boolean => {
        for (let p: vscode.TestItem | undefined = item; p; p = p.parent) if (scope.some((s) => s.id === p!.id)) return true;
        return false;
      };
      const classes = new Map<string, vscode.TestItem>();
      for (const [id, n] of this.nodes) {
        if (!n.uri || fileKey(n.uri) !== uri || (n.kind !== 'method' && n.kind !== 'case')) continue;
        const item = this.items.get(id);
        const cls = item?.parent && this.nodes.get(item.parent.id)?.kind !== 'method' ? item.parent : item?.parent?.parent;
        if (cls && inScope(cls)) classes.set(cls.id, cls);
      }
      const include = classes.size ? [...classes.values()] : scope;
      void this.enqueue(new vscode.TestRunRequest(include, request.exclude, request.profile), token, false);
    });
    token.onCancellationRequested(() => sub.dispose());
    this.subs.push(sub);
  }

  private roots(): vscode.TestItem[] {
    const out: vscode.TestItem[] = [];
    this.controller.items.forEach((i) => {
      if (i.id !== STATUS_ITEM_ID) out.push(i);
    });
    return out;
  }

  private async execute(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean): Promise<void> {
    const run = this.controller.createTestRun(request, undefined, true);
    this.runs++;
    this.running++;
    try {
      if (!this.isTrusted()) {
        run.appendOutput(crlf('Refyntra does not build or run tests in Restricted Mode. Trust the workspace first.\n'));
        return;
      }
      const excluded = new Set((request.exclude ?? []).map((i) => i.id));
      const include = (request.include ?? this.roots()).filter((i) => !excluded.has(i.id));
      this.lastRun = include.map((i) => i.id);
      // Group by language and project; a project node selected with its children runs once.
      const groups = new Map<string, { node: TestNode; items: vscode.TestItem[] }>();
      for (const item of include) {
        const n = this.nodeOf(item);
        if (!n) continue;
        const key = `${n.language}|${n.project}`;
        if (!groups.has(key)) groups.set(key, { node: n, items: [] });
        groups.get(key)!.items.push(item);
      }
      for (const { node, items } of groups.values()) {
        if (token.isCancellationRequested) break;
        const leaves = this.leaves(items).filter((i) => !excluded.has(i.id));
        for (const l of leaves) run.enqueued(l);
        const coverage = request.profile?.kind === vscode.TestRunProfileKind.Coverage;
        if (coverage && node.language !== 'dotnet') run.appendOutput(crlf('Coverage is collected for .NET tests only (coverlet.collector); these tests run without it.\n'));
        if (node.language === 'dotnet') await this.runDotnet(run, node.project, items, leaves, token, debug, coverage);
        else if (node.language === 'python') await this.runPython(run, node.project, items, leaves, token, debug);
        else if (debug) for (const l of leaves) run.errored(l, new vscode.TestMessage('Debugging Rust tests is not supported (Refyntra bundles no Rust debugger, ADR-008). Use Run.'));
        else await this.runRust(run, node.project, items, leaves, token);
      }
    } finally {
      this.running--;
      run.end();
    }
  }

  private leaves(items: readonly vscode.TestItem[]): vscode.TestItem[] {
    const out = new Map<string, vscode.TestItem>();
    const walk = (i: vscode.TestItem) => {
      if (i.children.size === 0) out.set(i.id, i);
      else i.children.forEach(walk);
    };
    items.forEach(walk);
    return [...out.values()];
  }

  /** Spawns a process for a run, streams its output into the run, kills its process tree on cancel. */
  private spawnForRun(run: vscode.TestRun, command: string, args: string[], cwd: string, env: Record<string, string>, token: vscode.CancellationToken, onOutput?: (all: string) => void): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      run.appendOutput(crlf(`> ${command} ${args.map((a) => (/[\s;|&]/.test(a) ? `"${a}"` : a)).join(' ')}\n`));
      let child: ChildProcess;
      try {
        child = spawn(command, args, { cwd, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env }, detached: !isWin, windowsHide: true });
      } catch (e) {
        run.appendOutput(crlf(`${String(e)}\n`));
        resolve({ code: null, output: '' });
        return;
      }
      let output = '';
      const onData = (d: Buffer) => {
        const s = d.toString();
        output += s;
        run.appendOutput(crlf(s));
        onOutput?.(output);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const cancel = token.onCancellationRequested(() => killTree(child));
      child.on('error', (e) => {
        run.appendOutput(crlf(`${e.message}\n`));
      });
      child.on('close', (code) => {
        cancel.dispose();
        resolve({ code, output });
      });
    });
  }

  private report(run: vscode.TestRun, item: vscode.TestItem, r: { outcome: TestOutcome; durationMs?: number; message?: string; details?: string; stdout?: string }, testFile?: string, root?: string): void {
    const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(root ?? '', p));
    const reported: ReportedResult = { outcome: r.outcome, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}), ...(r.message ? { message: r.message } : {}) };
    if (r.stdout) run.appendOutput(crlf(`${item.label}:\n${r.stdout}\n`), undefined, item);
    // Visual tests only: durations differ from run to run, so the screenshots leave them out.
    const duration = process.env.REFYNTRA_TEST_NO_DURATIONS === '1' ? undefined : r.durationMs;
    if (r.outcome === 'passed') run.passed(item, duration);
    else if (r.outcome === 'skipped') run.skipped(item);
    else {
      const text = r.message ?? (r.outcome === 'failed' ? 'Failed' : 'Error');
      const msg = new vscode.TestMessage(text);
      const expected = /(?:^|\n)\s*Expected:\s*(.*)\n\s*(?:Actual|But was):\s*(.*)/.exec(r.message ?? '');
      if (expected) {
        msg.expectedOutput = (expected[1] ?? '').trim();
        msg.actualOutput = (expected[2] ?? '').trim();
      }
      const at = failureLocation(r.details, (p) => exists(resolvePath(p)), testFile);
      if (at) {
        const file = resolvePath(at.path);
        msg.location = new vscode.Location(vscode.Uri.file(file), new vscode.Position(Math.max(0, at.line - 1), 0));
        reported.location = { path: file, line: at.line };
      } else if (item.uri && item.range) msg.location = new vscode.Location(item.uri, item.range);
      // The stack trace: in the output of the test, and one message per other frame in the workspace (each opens its
      // line from Test Results, like a clickable stack trace).
      const messages = [msg];
      if (r.details) {
        run.appendOutput(crlf(`${item.label}: ${text}\n${r.details}\n`), msg.location, item);
        for (const f of stackLocations(r.details)) {
          const file = resolvePath(f.path);
          if (!exists(file) || (at && file === resolvePath(at.path) && f.line === at.line)) continue;
          const frame = new vscode.TestMessage(f.text);
          frame.location = new vscode.Location(vscode.Uri.file(file), new vscode.Position(Math.max(0, f.line - 1), 0));
          messages.push(frame);
        }
      }
      if (r.outcome === 'failed') run.failed(item, messages, duration);
      else run.errored(item, messages, duration);
    }
    this.results.set(item.id, reported);
  }

  // ---------------------------------------------------------------------------------------------- .NET

  /** VSTest or Microsoft Testing Platform, from the project file and the nearest global.json. */
  private runnerOf(project: string): ReturnType<typeof detectTestRunner> {
    let xml = '';
    try {
      xml = fs.readFileSync(project, 'utf8');
    } catch {
      return { runner: 'vstest', report: '--report-trx' };
    }
    let globalJson: string | undefined;
    for (let dir = path.dirname(project); ; dir = path.dirname(dir)) {
      const g = path.join(dir, 'global.json');
      if (fs.existsSync(g)) {
        try {
          globalJson = fs.readFileSync(g, 'utf8');
        } catch {
          // unreadable: the SDK reports it
        }
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    return detectTestRunner(xml, globalJson);
  }

  /** Runs or debugs a Microsoft Testing Platform test project; undefined when it could not start (items reported). */
  private async runMtp(
    run: vscode.TestRun,
    project: string,
    report: string,
    filter: string | undefined,
    resultsDirectory: string,
    cwd: string,
    folder: vscode.WorkspaceFolder | undefined,
    leaves: vscode.TestItem[],
    token: vscode.CancellationToken,
    debug: boolean,
    coverage: boolean,
  ): Promise<{ code: number | null; output: string } | undefined> {
    if (coverage) run.appendOutput(crlf(`${path.basename(project)} runs on Microsoft Testing Platform; Refyntra collects coverage for VSTest projects (coverlet.collector) only, so this run has no coverage.\n`));
    if (debug && !this.debuggers.netcoredbg()) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage(`.NET debugging is unavailable on ${process.platform}-${process.arch}: this Refyntra package has no netcoredbg. Use Run.`));
      return undefined;
    }
    if (!(await buildDotnet(project, undefined, 'Debug', folder))) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage('The build failed; see the terminal for the errors.'));
      return undefined;
    }
    const prop = await this.spawnForRun(run, 'dotnet', ['msbuild', project, '-nologo', '-getProperty:TargetPath', '-p:Configuration=Debug'], cwd, {}, token);
    const target = prop.output.trim().split(/\r?\n/).pop()?.trim() ?? '';
    if (!target || !fs.existsSync(target)) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage(`The test application of ${path.basename(project)} was not found after the build (${target || 'no TargetPath'}).`));
      return undefined;
    }
    const args = mtpTestArgs(target, { report, resultsDirectory, ...(filter ? { filter } : {}) });
    if (!debug) return this.spawnForRun(run, 'dotnet', args, cwd, {}, token);
    // Debug: netcoredbg launches the test application directly (attaching to an MTP application that waits for a
    // debugger left its breakpoints pending in netcoredbg).
    const id = ++this.runs;
    const ended = new Promise<void>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.configuration.refyntraTestRun === id) {
          sub.dispose();
          resolve();
        }
      });
      token.onCancellationRequested(() => {
        sub.dispose();
        resolve();
      });
    });
    const ok = await vscode.debug.startDebugging(folder, { type: DOTNET_DEBUG_TYPE, request: 'launch', name: 'Refyntra: Debug tests', program: target, args: args.slice(2), cwd, console: 'internalConsole', justMyCode: false, refyntraTestRun: id });
    if (!ok) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage('The debug session did not start.'));
      return undefined;
    }
    await ended;
    return { code: 0, output: '' };
  }

  private async runDotnet(run: vscode.TestRun, project: string, items: vscode.TestItem[], leaves: vscode.TestItem[], token: vscode.CancellationToken, debug: boolean, coverage = false): Promise<void> {
    if (coverage && !this.hasCoverlet(project)) {
      coverage = false;
      this.coveredFiles = [];
      this.coverageNote = `${path.basename(project)} does not reference coverlet.collector, so no coverage was collected (Refyntra does not add packages to your projects).`;
      run.appendOutput(crlf(`${this.coverageNote}\n`));
      void vscode.window.showInformationMessage(`Refyntra: ${this.coverageNote}`);
    }
    const filter = dotnetFilter(items.map((i) => this.nodeOf(i)).filter((n): n is TestNode => !!n));
    const resultsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-tests-'));
    const cwd = path.dirname(project);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
    for (const l of leaves) run.started(l);
    let session: vscode.DebugSession | undefined;
    try {
      let outcome: { code: number | null; output: string };
      const kind = this.runnerOf(project);
      if (kind.runner === 'mtp') {
        // Microsoft Testing Platform: build, then run (or debug) the test application itself.
        const r = await this.runMtp(run, project, kind.report, filter, resultsDirectory, cwd, folder, leaves, token, debug, coverage);
        if (!r) return;
        outcome = r;
      } else if (debug) {
        if (!this.debuggers.netcoredbg()) {
          for (const l of leaves) run.errored(l, new vscode.TestMessage(`.NET debugging is unavailable on ${process.platform}-${process.arch}: this Refyntra package has no netcoredbg. Use Run.`));
          return;
        }
        // Build once (a task, like F5), then run the tests without building: the test host waits for the debugger
        // (VSTEST_HOST_DEBUG=1), netcoredbg attaches to the printed process id, and the host continues by itself
        // (VSTEST_DEBUG_NOBP=1: no Debugger.Break inside the test host).
        if (!(await buildDotnet(project, undefined, 'Debug', folder))) {
          for (const l of leaves) run.errored(l, new vscode.TestMessage('The build failed; see the terminal for the errors.'));
          return;
        }
        let attached = false;
        this.debugTrace = [];
        // Without a debugger the test host waits forever: stop the run when the session fails or ends early.
        const local = new vscode.CancellationTokenSource();
        const linked = token.onCancellationRequested(() => local.cancel());
        const giveUp = (why: string) => {
          trace(why);
          setTimeout(() => local.cancel(), 15000).unref();
        };
        const trace = (m: string) => {
          this.debugTrace.push(m);
          run.appendOutput(crlf(`[Refyntra] ${m}
`));
        };
        const ended = new Promise<void>((resolve) => {
          const sub = vscode.debug.onDidTerminateDebugSession((s) => {
            if (s === session) {
              giveUp('debug session ended');
              sub.dispose();
              resolve();
            }
          });
        });
        const starting = vscode.debug.onDidStartDebugSession((s) => {
          if (s.configuration.refyntraTestRun === this.runs) {
            session = s;
            trace(`debug session started (${s.type})`);
          }
        });
        token.onCancellationRequested(() => {
          if (session) void vscode.debug.stopDebugging(session);
        });
        outcome = await this.spawnForRun(run, 'dotnet', dotnetTestArgs(project, { ...(filter ? { filter } : {}), resultsDirectory, noBuild: true }), cwd, { VSTEST_HOST_DEBUG: '1', VSTEST_DEBUG_NOBP: '1' }, local.token, (all) => {
          if (attached) return;
          const pid = testhostProcessId(all);
          if (pid === undefined) return;
          attached = true;
          this.lastDebugPid = pid;
          trace(`test host process ${pid} waits for the debugger; attaching netcoredbg`);
          vscode.debug.startDebugging(folder, { type: DOTNET_DEBUG_TYPE, request: 'attach', name: 'Refyntra: Debug tests', processId: pid, justMyCode: true, refyntraTestRun: this.runs }).then(
            (ok) => (ok ? trace('attach requested') : giveUp('the debug session did not start')),
            (e) => giveUp(`attach failed: ${String(e)}`),
          );
        });
        starting.dispose();
        linked.dispose();
        local.dispose();
        if (session) await Promise.race([ended, new Promise((r) => setTimeout(r, 10000))]);
      } else {
        outcome = await this.spawnForRun(run, 'dotnet', dotnetTestArgs(project, { ...(filter ? { filter } : {}), resultsDirectory, coverage }), cwd, {}, token);
      }
      if (token.isCancellationRequested) {
        for (const l of leaves) run.skipped(l);
        return;
      }
      const results: TrxResult[] = [];
      for (const f of fs.readdirSync(resultsDirectory)) if (f.endsWith('.trx')) results.push(...parseTrx(fs.readFileSync(path.join(resultsDirectory, f), 'utf8')));
      if (coverage) this.reportCoverage(run, resultsDirectory);
      const methods = new Map<string, TestNode>();
      for (const n of this.nodes.values()) if (n.kind === 'method' && n.language === 'dotnet' && n.project === project) methods.set(n.key, n);
      const reported = new Set<string>();
      for (const m of matchDotnetResults(results, methods)) {
        let item = this.items.get(m.id);
        if (!item && m.parentId) {
          const parent = this.items.get(m.parentId);
          if (!parent) continue;
          item = this.controller.createTestItem(m.id, m.label ?? m.id, parent.uri);
          if (parent.range) item.range = parent.range;
          parent.children.add(item);
          this.items.set(m.id, item);
          run.started(item);
        }
        if (!item) continue;
        reported.add(item.id);
        this.report(run, item, { outcome: m.result.outcome, ...(m.result.durationMs !== undefined ? { durationMs: m.result.durationMs } : {}), ...(m.result.message ? { message: m.result.message } : {}), ...(m.result.stackTrace ? { details: m.result.stackTrace } : {}), ...(m.result.stdout ? { stdout: m.result.stdout } : {}) }, item.uri?.fsPath);
      }
      // A method whose results all came as run-time cases: its own leaf state is computed from them.
      for (const l of leaves) {
        if (reported.has(l.id)) continue;
        const childOutcomes: TestOutcome[] = [];
        l.children.forEach((c) => {
          const o = this.results.get(c.id);
          if (reported.has(c.id) && o) childOutcomes.push(o.outcome);
        });
        const agg = aggregateOutcome(childOutcomes);
        if (agg) {
          // The method was a leaf when the run started; its run-time cases were added during it.
          if (agg === 'passed') run.passed(l);
          else if (agg === 'skipped') run.skipped(l);
          else run.failed(l, new vscode.TestMessage('A data case failed; see its result.'));
          continue;
        }
        if (results.length === 0) run.errored(l, new vscode.TestMessage(outcome.code === 0 ? 'No test result was reported.' : `dotnet test failed (exit code ${outcome.code ?? 'unknown'}) before reporting results; see the output.`));
        else run.skipped(l);
      }
    } finally {
      fs.rmSync(resultsDirectory, { recursive: true, force: true });
    }
  }

  private coverageNote: string | undefined;

  private hasCoverlet(project: string): boolean {
    const read = (p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    };
    return referencesCoverlet(read(project) ?? '', read(path.join(path.dirname(project), 'obj', 'project.assets.json')));
  }

  /** Every coverage.cobertura.xml under the results directory → FileCoverage of the workspace files it covers. */
  private reportCoverage(run: vscode.TestRun, dir: string): void {
    const reports: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name === 'coverage.cobertura.xml') reports.push(path.join(d, e.name));
      }
    };
    walk(dir);
    const byFile = new Map<string, Map<number, number>>();
    for (const r of reports) {
      const { sources, files } = parseCobertura(fs.readFileSync(r, 'utf8'));
      for (const f of files) {
        const file = path.isAbsolute(f.filename) ? f.filename : sources.map((s) => path.join(s, f.filename)).find(exists);
        if (!file || !exists(file) || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))) continue;
        const lines = byFile.get(file) ?? new Map<number, number>();
        for (const [n, h] of f.lines) lines.set(n, Math.max(lines.get(n) ?? 0, h));
        byFile.set(file, lines);
      }
    }
    for (const [file, lines] of byFile) {
      const uri = vscode.Uri.file(file);
      const details = [...lines].sort((a, b) => a[0] - b[0]).map(([n, h]) => new vscode.StatementCoverage(h, new vscode.Position(n - 1, 0)));
      this.coverageDetails.set(uri.toString(), details);
      run.addCoverage(vscode.FileCoverage.fromDetails(uri, details));
    }
    this.coveredFiles = [...byFile.keys()];
  }

  /** Files of the last coverage run (e2e). */
  coveredFiles: string[] = [];

  // ---------------------------------------------------------------------------------------------- Python

  private async runPython(run: vscode.TestRun, root: string, items: vscode.TestItem[], leaves: vscode.TestItem[], token: vscode.CancellationToken, debug: boolean): Promise<void> {
    const python = this.debuggers.python();
    if (!python) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage('No Python interpreter was found.'));
      return;
    }
    const nodeIds = items.map((i) => this.nodeOf(i)).filter((n): n is TestNode => !!n).map((n) => n.key).filter(Boolean);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-pytest-'));
    const junit = path.join(dir, 'results.xml');
    for (const l of leaves) run.started(l);
    try {
      if (debug) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.join(root, 'x')));
        const ok = await vscode.debug.startDebugging(folder, { type: PYTHON_DEBUG_TYPE, request: 'launch', name: 'Refyntra: Debug tests', module: 'pytest', args: pytestArgs(nodeIds, junit).slice(2), cwd: root, console: 'internalConsole', justMyCode: true, python });
        if (ok) {
          await new Promise<void>((resolve) => {
            const sub = vscode.debug.onDidTerminateDebugSession((s) => {
              if (s.type === PYTHON_DEBUG_TYPE) {
                sub.dispose();
                resolve();
              }
            });
            token.onCancellationRequested(() => void vscode.debug.stopDebugging());
          });
        }
      } else await this.spawnForRun(run, python, pytestArgs(nodeIds, junit), root, {}, token);
      if (token.isCancellationRequested || !exists(junit)) {
        for (const l of leaves) run.skipped(l);
        return;
      }
      const known = new Set<string>();
      for (const n of this.nodes.values()) if (n.language === 'python') known.add(n.key);
      for (const r of parseJunitXml(fs.readFileSync(junit, 'utf8')) as JunitResult[]) {
        const id = pytestNodeId(r.classname, r.name, known);
        const item = id ? this.items.get(`python:${id}`) : undefined;
        if (!item) continue;
        this.report(run, item, { outcome: r.outcome, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}), ...(r.message ? { message: r.message } : {}), ...(r.details ? { details: r.details } : {}), ...(r.stdout ? { stdout: r.stdout } : {}) }, item.uri?.fsPath, root);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------------------------- Rust

  private async runRust(run: vscode.TestRun, dir: string, items: vscode.TestItem[], leaves: vscode.TestItem[], token: vscode.CancellationToken): Promise<void> {
    const cargo = onPath(['cargo'], [path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin')]);
    if (!cargo) {
      for (const l of leaves) run.errored(l, new vscode.TestMessage('cargo was not found.'));
      return;
    }
    for (const l of leaves) run.started(l);
    const nodes = items.map((i) => this.nodeOf(i)).filter((n): n is TestNode => !!n);
    const out = await this.spawnForRun(run, cargo, cargoTestArgs(nodes), dir, {}, token);
    if (token.isCancellationRequested) return;
    for (const r of parseCargoTestOutput(out.output)) {
      const item = this.items.get(`rust:${dir}|${r.name}`);
      if (item) this.report(run, item, { outcome: r.outcome, ...(r.output ? { message: r.output, details: r.output } : {}) }, undefined, dir);
    }
  }

  // ---------------------------------------------------------------------------------------------- CodeLens

  /** "Run | Debug" over C# test classes and methods (setting refyntra.tests.codeLens). */
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('refyntra').get<boolean>('tests.codeLens', true)) return [];
    const uri = fileKey(doc.uri.toString());
    const lenses: vscode.CodeLens[] = [];
    for (const n of this.nodes.values()) {
      if (!n.uri || fileKey(n.uri) !== uri || !n.range || (n.kind !== 'class' && n.kind !== 'method')) continue;
      const range = new vscode.Range(n.range.start.line, 0, n.range.start.line, 0);
      const r = this.results.get(n.id);
      const mark = r ? (r.outcome === 'passed' ? '$(pass) ' : r.outcome === 'skipped' ? '$(debug-step-over) ' : '$(error) ') : '';
      lenses.push(new vscode.CodeLens(range, { title: `${mark}Run`, command: 'refyntra.tests.run', arguments: [n.id], tooltip: `Run ${n.label}` }));
      lenses.push(new vscode.CodeLens(range, { title: 'Debug', command: 'refyntra.tests.debug', arguments: [n.id], tooltip: `Debug ${n.label}` }));
    }
    return lenses;
  }

  /** The test items at a position (innermost first): the method or class whose name or body contains it. */
  itemsAt(uri: string, line: number): string[] {
    const hits: { id: string; size: number }[] = [];
    for (const t of this.dotnetTests) {
      if (fileKey(t.uri) !== fileKey(uri)) continue;
      if (line >= t.range.start.line && line <= t.range.end.line) hits.push({ id: [...this.nodes.values()].find((n) => n.kind === 'method' && n.key === t.fullyQualifiedName && n.uri === t.uri)?.id ?? '', size: t.range.end.line - t.range.start.line });
      for (const c of t.classes) if (line >= c.range.start.line && line <= c.range.end.line) {
        const n = [...this.nodes.values()].find((x) => x.kind === 'class' && x.uri === t.uri && x.range?.start.line === c.nameRange.start.line);
        if (n) hits.push({ id: n.id, size: c.range.end.line - c.range.start.line });
      }
    }
    return [...new Set(hits.filter((h) => h.id).sort((a, b) => a.size - b.size).map((h) => h.id))];
  }

  /** "Run Tests for This Code": the tests Related lists for the symbol at the cursor (or the test itself). */
  async runRelated(uri: string, position: { line: number; character: number }, debug = false): Promise<string[]> {
    const own = this.itemsAt(uri, position.line);
    if (own.length) {
      await this.runIds([own[0]!], debug);
      return [own[0]!];
    }
    const r = await this.engine.related({ uri, position });
    if (r.kind !== 'related') {
      void vscode.window.showInformationMessage(`Refyntra: ${r.message}`);
      return [];
    }
    const ids = new Set<string>();
    for (const g of r.groups) {
      if (g.group !== 'tests') continue;
      for (const rel of g.relations) {
        const loc = rel.target.symbol?.location ?? rel.target.location;
        if (!loc) continue;
        for (const id of this.itemsAt(loc.uri, loc.range.start.line).slice(0, 1)) ids.add(id);
      }
    }
    if (ids.size === 0) {
      void vscode.window.showInformationMessage('Refyntra found no tests that reference this code.');
      return [];
    }
    await this.runIds([...ids], debug);
    return [...ids];
  }
}

export function registerTesting(engine: EngineClient, debuggers: DebuggerLocator, isTrusted: () => boolean): { service: TestingService; disposable: vscode.Disposable } {
  const service = new TestingService(engine, debuggers, isTrusted);
  const subs: vscode.Disposable[] = [
    service,
    vscode.languages.registerCodeLensProvider({ language: 'csharp', scheme: 'file' }, service),
    vscode.commands.registerCommand('refyntra.tests.run', (id: string) => service.runIds([id], false)),
    vscode.commands.registerCommand('refyntra.tests.debug', (id: string) => service.runIds([id], true)),
    vscode.commands.registerCommand('refyntra.tests.runRelated', async () => {
      const e = vscode.window.activeTextEditor;
      if (!e) return [];
      return service.runRelated(e.document.uri.toString(), { line: e.selection.active.line, character: e.selection.active.character });
    }),
  ];
  return { service, disposable: vscode.Disposable.from(...subs) };
}

