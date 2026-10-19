import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { NetcoredbgProxyAdapter } from './dotnetDebugProxy';
import { pythonInterpreter } from './lspServers';
import { WatchIndicator, rudeEditPolicy } from './watchStatus';
import { watchArgs } from './watchModel';
import {
  DOTNET_DEBUG_TYPE,
  type DotnetDebugConfiguration,
  LLDB_DEBUG_TYPE,
  type LaunchProfile,
  PYTHON_DEBUG_TYPE,
  type RunChoice,
  type RunTarget,
  browserUrl,
  cargoRunArgs,
  csharpEntryLine,
  dotnetBuildArgs,
  dotnetDebugConfiguration,
  dotnetRunCommand,
  dotnetTargets,
  isPythonEntry,
  listeningUrl,
  lldbDebugConfiguration,
  lldbEnv,
  netcoredbgLaunchArguments,
  nodeDebugConfigurations,
  nodeScriptTarget,
  nodeTargets,
  parseLaunchSettings,
  pickFramework,
  pythonDebugConfiguration,
  pythonEntryLine,
  pythonTarget,
  runnableFrameworks,
  rustEntryLine,
  rustTargets,
  groupBySolution,
  groupEntryOf,
  groupSessionName,
  resolveGroupEntry,
  parseRunGroups,
  readinessEndpoint,
  type RunGroup,
  solutionProjectPaths,
  statusText,
  stripJsonComments,
  targetForFile,
  validateDotnetConfiguration,
  validatePythonConfiguration,
  isWebKind,
  blazorWasmBrowserConfiguration,
} from './runModel';

// Run and Debug (ADR-008): Refyntra runs and debugs projects itself, with no other extension. .NET: the bundled Samsung
// netcoredbg (MIT) as the debug adapter; Python: the bundled debugpy (MIT) run by the user's interpreter; Rust: cargo
// run, and lldb-dap from an installed LLVM when present (detected, not bundled); Node: configurations for VS Code's
// built-in JavaScript debugger. Running and building execute project code, so everything here needs a trusted workspace.

export const RUN_VIEW = 'refyntra.runView';
const SELECTION_KEY = 'refyntra.run.selection';
const EXCLUDE = '**/{node_modules,bin,obj,.git,target,__pycache__,.venv,venv,dist,out}/**';

const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Looks a program up on PATH (never runs it). */
export function onPath(names: readonly string[], extraDirs: readonly string[] = []): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const n of names) for (const d of dirs) for (const e of exts) if (exists(path.join(d, n + e))) return path.join(d, n + e);
  return undefined;
}

// ------------------------------------------------------------------------------------------------ debug adapters

export interface DebuggerStatus {
  netcoredbg: { path?: string; version?: string; reason?: string };
  debugpy: { path?: string; version?: string };
  python?: string;
  lldbDap?: string;
  cargo?: string;
  dotnet?: string;
  /** The test runner's note for Health (testing.ts). */
  tests?: string;
}

/** Where the bundled debug adapters are (debuggers/ in the VSIX; staged by servers.mjs --debuggers in a checkout). */
export class DebuggerLocator {
  constructor(private readonly extensionPath: string) {}

  netcoredbg(): string | undefined {
    const p = path.join(this.extensionPath, 'debuggers', 'netcoredbg', process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg');
    if (!exists(p)) return undefined;
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        fs.chmodSync(p, 0o755);
      }
    }
    return p;
  }

  debugpyRoot(): string | undefined {
    const root = path.join(this.extensionPath, 'debuggers', 'debugpy');
    return exists(path.join(root, 'debugpy', 'adapter', '__main__.py')) ? root : undefined;
  }

  private version(dir: string): string | undefined {
    try {
      return fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8').split(/\r?\n/)[0];
    } catch {
      return undefined;
    }
  }

  python(): string | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    return pythonInterpreter(folders) ?? onPath(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']);
  }

  lldbDap(): string | undefined {
    const extra = process.platform === 'win32' ? ['C:\\Program Files\\LLVM\\bin'] : ['/usr/local/opt/llvm/bin', '/opt/homebrew/opt/llvm/bin', ...[21, 20, 19, 18].map((v) => `/usr/lib/llvm-${v}/bin`)];
    return onPath(['lldb-dap', 'lldb-dap-21', 'lldb-dap-20', 'lldb-dap-19', 'lldb-dap-18', 'lldb-vscode'], extra);
  }

  status(): DebuggerStatus {
    const ncd = this.netcoredbg();
    const dp = this.debugpyRoot();
    const python = this.python();
    const lldb = this.lldbDap();
    const cargo = onPath(['cargo'], [path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin')]);
    const dotnet = onPath(['dotnet']);
    return {
      netcoredbg: ncd
        ? { path: ncd, ...(this.version(path.dirname(ncd)) ? { version: this.version(path.dirname(ncd))! } : {}) }
        : { reason: `netcoredbg (the .NET debugger Refyntra bundles) has no official build for ${process.platform}-${process.arch}, or this package does not include it. Running .NET projects (Ctrl+F5) still works; debugging them is unavailable on this platform.` },
      debugpy: dp ? { path: dp, ...(this.version(dp) ? { version: this.version(dp)! } : {}) } : {},
      ...(python ? { python } : {}),
      ...(lldb ? { lldbDap: lldb } : {}),
      ...(cargo ? { cargo } : {}),
      ...(dotnet ? { dotnet } : {}),
    };
  }
}

// ------------------------------------------------------------------------------------------------ process runner

export interface RunSession {
  target: RunTarget;
  pid?: number;
  exitCode?: number | null;
  output: string;
  execution?: vscode.TaskExecution;
  /** The terminal VS Code opened for this run (the one a click on the running target shows). */
  terminal?: vscode.Terminal;
  /** Run with Hot Reload: the dotnet watch status bar indicator. */
  watch?: WatchIndicator;
  stop(): void;
  readonly done: Promise<number | null>;
}

const HIDDEN_KEY = 'refyntra.run.hidden';

/** The targets of a command argument: a Run view row, several selected rows, or a target id. */
function targetsOf(arg: unknown): RunTarget[] {
  const one = (x: unknown): RunTarget | undefined => {
    const n = x as { kind?: string; target?: RunTarget } | undefined;
    return n && typeof n === 'object' && (n.kind === 'target' || n.kind === 'profile') ? n.target : undefined;
  };
  if (Array.isArray(arg)) return arg.map(one).filter((t): t is RunTarget => !!t);
  const t = one(arg);
  return t ? [t] : [];
}

/** The group name of a command argument: a name, or the Run view's group node. */
function groupNameOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  return (arg as { group?: { name?: string } } | undefined)?.group?.name;
}

/** Resolves true once a TCP connection to host:port succeeds (polled every 500 ms), false after the timeout. */
function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 500);
      };
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', retry);
      socket.setTimeout(2000, retry);
    };
    attempt();
  });
}

/** Kills a process and its children (taskkill /T on Windows, the process group elsewhere). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const pid = child.pid;
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }, 3000).unref();
}

/** Spawns a command the way a terminal would: .cmd/.bat (npm, pnpm, yarn) through cmd.exe on Windows, quoted. */
function spawnCommand(command: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const fullEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  if (process.platform === 'win32' && /^(npm|pnpm|yarn|npx)$/.test(command)) {
    const q = (s: string) => (/^[\w./:=@-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(q).join(' ')}"`], { cwd, env: fullEnv, windowsVerbatimArguments: true });
  }
  return spawn(command, args, { cwd, env: fullEnv, detached: process.platform !== 'win32' });
}

let runInstances = 0;

/** A Pseudoterminal that runs one command, shows its output, forwards input and reports the exit code. */
class ProcessTerminal implements vscode.Pseudoterminal {
  private readonly write = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.write.event;
  readonly onDidClose = this.closed.event;
  private child: ChildProcess | undefined;

  constructor(
    private readonly steps: { command: string; args: string[]; cwd: string; env: Record<string, string> }[],
    private readonly session: { output: string; pid?: number; exitCode?: number | null; resolve(code: number | null): void; onOutput(text: string): void },
  ) {}

  open(): void {
    void this.run(0);
  }

  private async run(i: number): Promise<void> {
    const step = this.steps[i]!;
    this.write.fire(`\x1b[2m> ${[step.command, ...step.args].join(' ')}\x1b[0m\r\n`);
    let child: ChildProcess;
    try {
      child = spawnCommand(step.command, step.args, step.cwd, step.env);
    } catch (e) {
      this.finish(null, `Could not start ${step.command}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.child = child;
    this.session.pid = child.pid;
    const onData = (b: Buffer) => {
      const text = b.toString('utf8');
      this.session.output += text;
      if (this.session.output.length > 200_000) this.session.output = this.session.output.slice(-100_000);
      this.session.onOutput(text);
      this.write.fire(text.replace(/\r?\n/g, '\r\n'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => this.finish(null, `Could not start ${step.command}: ${e.message}`));
    // 'close' waits until every holder of the output pipes is gone; a build server started by the command (dotnet
    // watch) may keep them open after the command itself exited, so its exit counts after a short grace period.
    let closed = false;
    child.on('exit', (code) => setTimeout(() => !closed && child.emit('close', code), 2000).unref());
    child.on('close', (code) => {
      if (closed || this.child !== child) return;
      closed = true;
      if (code === 0 && i + 1 < this.steps.length) {
        void this.run(i + 1);
        return;
      }
      this.finish(code, `${step.command} exited with code ${code ?? 'unknown'}`);
    });
  }

  private finish(code: number | null, message: string): void {
    if (this.session.exitCode !== undefined) return;
    this.child = undefined;
    this.session.exitCode = code;
    this.write.fire(`\r\n\x1b[2m${message}. Press any key to close the terminal.\x1b[0m\r\n`);
    this.session.resolve(code);
  }

  handleInput(data: string): void {
    if (this.session.exitCode !== undefined) {
      this.closed.fire(this.session.exitCode ?? 1);
      return;
    }
    const text = data.replace(/\r/g, '\n');
    this.write.fire(data.replace(/\r/g, '\r\n'));
    this.child?.stdin?.write(text);
  }

  stop(): void {
    if (this.child) killTree(this.child);
  }

  /** The user closed the terminal: stop the program. */
  close(): void {
    this.stop();
  }
}

// ------------------------------------------------------------------------------------------------ the service

type TreeNode =
  | { kind: 'group'; label: string; targets: RunTarget[] }
  | { kind: 'launchGroup'; group: RunGroup }
  | { kind: 'target'; target: RunTarget; inGroup?: string }
  | { kind: 'profile'; target: RunTarget; profile: LaunchProfile }
  | { kind: 'message'; text: string };

/** Test seams (e2e): replace pickers and record what would be opened in a browser. */
export interface RunTestHooks {
  pick?: <T extends vscode.QuickPickItem>(items: T[], title: string) => Promise<T | undefined>;
  openedUrls: string[];
  /** Run groups: whether each waited-for web target became ready. */
  groupReadiness: { target: string; ready: boolean }[];
  /** Tests: the script Run Script… takes (no picker). */
  pickScript?: string;
  /** What refyntra.run.focus showed: the debug session, the target's own terminal or nothing. */
  focused: ('debug' | 'terminal' | 'none')[];
  /** Tests: the targets and the name Create Run Group takes (no pickers). */
  pickMany?: <T extends vscode.QuickPickItem>(items: T[]) => Promise<T[] | undefined>;
  groupName?: string;
  /** Blazor WebAssembly: the browser debug configurations started (tests: no browser in CI). */
  browserDebugConfigurations: Record<string, unknown>[];
  debugExitCodes: Map<string, number>;
}

export class RunService implements vscode.TreeDataProvider<TreeNode>, vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly subs: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem('refyntra.run', vscode.StatusBarAlignment.Left, 49);
  private targetsCache: RunTarget[] = [];
  private dotnetNote: string | undefined;
  private refreshing: Promise<RunTarget[]> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  readonly sessions = new Map<string, RunSession>();
  private readonly terminals = new Map<string, ProcessTerminal>();
  readonly hooks: RunTestHooks = { openedUrls: [], browserDebugConfigurations: [], groupReadiness: [], focused: [], debugExitCodes: new Map() };
  readonly debuggers: DebuggerLocator;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly isTrusted: () => boolean,
  ) {
    this.debuggers = new DebuggerLocator(context.extensionPath);
    this.status.name = 'Refyntra Run';
    this.status.command = 'refyntra.selectRunTarget';
    this.status.tooltip = 'Refyntra: choose what Run (Ctrl+F5) and Debug (F5) start';
    const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,Cargo.toml,launchSettings.json,*.csproj,main.py,app.py,__main__.py,manage.py}');
    this.subs.push(
      this.changed,
      this.lensChanged,
      this.status,
      watcher,
      // Not the package.json files of installed packages (an npm install or a running dev server touches thousands).
      watcher.onDidCreate((u) => this.onWatched(u)),
      watcher.onDidChange((u) => this.onWatched(u)),
      watcher.onDidDelete((u) => this.onWatched(u)),
      engine.onDidChangeHealth((h) => {
        if (h.adapters.some((a) => a.adapterId === 'csharp' && (a.state === 'Ready' || a.state === 'Partial'))) this.scheduleRefresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('refyntra.run')) {
          this.updateContext();
          this.lensChanged.fire();
        }
      }),
    );
    this.updateContext();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const s of this.sessions.values()) s.stop();
    for (const d of this.subs) d.dispose();
  }

  // ---- targets

  targets(): RunTarget[] {
    return this.targetsCache;
  }

  private onWatched(uri: vscode.Uri): void {
    if (/[\\/](node_modules|bin|obj|\.git|\.vscode-test)[\\/]/.test(uri.fsPath)) return;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  /** Project files outside the loaded solution (classified by the host from their files) and the solution groups. */
  private async addOtherProjects(out: RunTarget[]): Promise<void> {
    const ignoreCase = process.platform === 'win32';
    const key = (p: string) => (ignoreCase ? p.toLowerCase() : p);
    const known = new Set(out.filter((t) => t.dotnet).map((t) => key(t.dotnet!.projectPath)));
    const limit = vscode.workspace.getConfiguration('refyntra').get<number>('run.maxProjects', 2000);
    const files = (await vscode.workspace.findFiles('**/*.csproj', EXCLUDE, limit + 1)).map((u) => u.fsPath);
    if (files.length > limit) {
      files.length = limit;
      this.dotnetNote = `More than ${limit} project files: the first ${limit} are listed (setting refyntra.run.maxProjects).`;
    }
    const missing = files.filter((f) => !known.has(key(f)));
    if (missing.length && this.engine.classifyProjects) {
      const projects: import('@refyntra/contracts').RunnableProjectInfo[] = [];
      // In batches: the host reads each project file (a few ms), so a large monorepo is not one long request.
      for (let i = 0; i < missing.length; i += 250) projects.push(...(await this.engine.classifyProjects(missing.slice(i, i + 250).map((f) => vscode.Uri.file(f).toString())).catch(() => [])));
      out.push(...dotnetTargets(projects, (u) => vscode.Uri.parse(u).fsPath, (p) => this.profilesOf(p.launchSettingsUri), process.platform));
    }
    const solutions: { name: string; projects: string[] }[] = [];
    for (const u of await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE, 50)) {
      try {
        solutions.push({ name: path.basename(u.fsPath), projects: solutionProjectPaths(u.fsPath, fs.readFileSync(u.fsPath, 'utf8')) });
      } catch {
        // An unreadable solution file groups nothing.
      }
    }
    const dotnet = out.filter((t) => t.dotnet);
    const groups = groupBySolution(dotnet.map((t) => t.dotnet!.projectPath), solutions, ignoreCase);
    for (const t of dotnet) t.group = groups.get(t.dotnet!.projectPath);
  }

  /** Collects every run target of the workspace (the C# part from the host's project model). */
  refresh(): Promise<RunTarget[]> {
    const run = (async () => {
      const out: RunTarget[] = [];
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
      if (folders.length === 0) return out;
      // .NET (host model, trusted only: the host does not run in Restricted Mode).
      this.dotnetNote = undefined;
      if (this.isTrusted() && this.engine.runnableProjects) {
        const r = await this.engine.runnableProjects();
        if (r.kind === 'projects') {
          out.push(...dotnetTargets(r.result.projects, (u) => vscode.Uri.parse(u).fsPath, (p) => this.profilesOf(p.launchSettingsUri), process.platform));
          if (r.result.state === 'Loading') this.dotnetNote = 'Loading the solution…';
        } else if (r.reasonCode === 'SolutionNotSelected') this.dotnetNote = 'Several solutions: all projects are listed; Refyntra: Select Solution picks the one for C# navigation.';
        else if (r.reasonCode !== 'NoSolutionFound') this.dotnetNote = r.message;
        // Several projects or solutions in one folder: every project file is a target, not only the loaded solution's
        // (the others are classified from their files), grouped by the solution that lists them. Not while the solution
        // loads: the host answers only after loading, and the list refreshes once it is ready.
        if (r.kind === 'projects' ? r.result.state !== 'Loading' : r.reasonCode === 'SolutionNotSelected' || r.reasonCode === 'NoSolutionFound') await this.addOtherProjects(out);
      }
      // Node: package.json scripts.
      for (const uri of await vscode.workspace.findFiles('**/package.json', EXCLUDE, 50)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as { name?: string; scripts?: Record<string, unknown>; packageManager?: string };
          out.push(...nodeTargets(uri.fsPath, pkg, fs.readdirSync(path.dirname(uri.fsPath))));
        } catch {
          // Unreadable package.json: no targets from it.
        }
      }
      // Python: entry files (if __name__ == "__main__") named like entry points.
      for (const uri of await vscode.workspace.findFiles('**/{main.py,app.py,__main__.py,manage.py,run.py}', EXCLUDE, 30)) {
        try {
          const text = fs.readFileSync(uri.fsPath, 'utf8');
          if (isPythonEntry(text) || /manage\.py$/.test(uri.fsPath)) out.push(pythonTarget(uri.fsPath, vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath)));
        } catch {
          // Ignore.
        }
      }
      // Rust: Cargo binaries.
      for (const uri of await vscode.workspace.findFiles('**/Cargo.toml', EXCLUDE, 30)) {
        try {
          out.push(...rustTargets(uri.fsPath, fs.readFileSync(uri.fsPath, 'utf8'), exists(path.join(path.dirname(uri.fsPath), 'src', 'main.rs'))));
        } catch {
          // Ignore.
        }
      }
      this.targetsCache = out;
      this.changed.fire(undefined);
      this.lensChanged.fire();
      this.updateContext();
      return out;
    })();
    this.refreshing = run;
    return run;
  }

  /** Waits for a pending refresh (tests, commands right after start-up). */
  async ready(): Promise<RunTarget[]> {
    if (!this.refreshing) return this.refresh();
    return this.refreshing;
  }

  private profilesOf(launchSettingsUri: string | null | undefined): LaunchProfile[] {
    if (!launchSettingsUri) return [];
    try {
      return parseLaunchSettings(fs.readFileSync(vscode.Uri.parse(launchSettingsUri).fsPath, 'utf8'));
    } catch {
      return [];
    }
  }

  // ---- selection

  selection(): { target: RunTarget | undefined; choice: RunChoice } {
    const saved = this.context.workspaceState.get<{ id?: string; profile?: string; framework?: string; configuration?: 'Debug' | 'Release' }>(SELECTION_KEY) ?? {};
    const target = this.targetsCache.find((t) => t.id === saved.id && t.runnable) ?? this.defaultTarget();
    const choice: RunChoice = { configuration: saved.configuration ?? 'Debug' };
    if (target && saved.id === target.id) {
      if (saved.profile) choice.profile = saved.profile;
      if (saved.framework) choice.framework = saved.framework;
    }
    if (target?.dotnet && !choice.profile && target.dotnet.profiles[0]) choice.profile = target.dotnet.profiles[0].name;
    return { target, choice };
  }

  private defaultTarget(): RunTarget | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.uri.scheme === 'file') {
      const lang = active.languageId === 'csharp' ? 'dotnet' : active.languageId === 'python' ? 'python' : active.languageId === 'rust' ? 'rust' : /^(typescript|javascript)/.test(active.languageId) ? 'node' : undefined;
      const t = lang ? targetForFile(this.targetsCache.filter((x) => x.runnable), active.uri.fsPath, lang) : undefined;
      if (t) return t;
    }
    return this.targetsCache.find((t) => t.runnable);
  }

  async select(target: RunTarget, choice: Partial<RunChoice> = {}): Promise<void> {
    const cur = this.selection();
    const same = cur.target?.id === target.id;
    await this.context.workspaceState.update(SELECTION_KEY, {
      id: target.id,
      profile: choice.profile ?? (same ? cur.choice.profile : undefined),
      framework: choice.framework ?? (same ? cur.choice.framework : undefined),
      configuration: choice.configuration ?? cur.choice.configuration,
    });
    this.updateContext();
    this.changed.fire(undefined);
  }

  private async pick<T extends vscode.QuickPickItem>(items: T[], title: string): Promise<T | undefined> {
    if (this.hooks.pick) return this.hooks.pick(items, title);
    return vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
  }

  /** Status bar / palette: choose the project, then its profile, framework and configuration. */
  async chooseTarget(): Promise<RunTarget | undefined> {
    if (!this.requireTrust('choose what to run')) return undefined;
    const targets = await this.ready();
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(this.dotnetNote ? `Refyntra: nothing to run yet. ${this.dotnetNote}` : 'Refyntra found nothing to run in this workspace: no runnable .NET project, package.json script, Python entry file or Cargo binary.');
      return undefined;
    }
    const pick = await this.pick(
      targets.map((t) => ({ label: t.label, description: t.kindLabel, detail: t.runnable ? t.note : `Not runnable: ${t.note ?? ''}`, target: t })),
      'Refyntra: Select What to Run',
    );
    if (!pick) return undefined;
    if (!pick.target.runnable) {
      void vscode.window.showWarningMessage(`Refyntra cannot run ${pick.target.label}: ${pick.target.note ?? 'not runnable'}`);
      return undefined;
    }
    const t = pick.target;
    const choice: Partial<RunChoice> = {};
    if (t.dotnet) {
      if (t.dotnet.profiles.length > 1) {
        const p = await this.pick(t.dotnet.profiles.map((pr) => ({ label: pr.name, description: pr.applicationUrl ?? '', detail: pr.commandLineArgs ? `Arguments: ${pr.commandLineArgs}` : undefined, profile: pr })), `${t.label}: launch profile`);
        if (!p) return undefined;
        choice.profile = p.profile.name;
      }
      const fws = runnableFrameworks(t.dotnet.project, process.platform);
      if (fws.length > 1) {
        const f = await this.pick(fws.map((fw) => ({ label: fw })), `${t.label}: target framework`);
        if (!f) return undefined;
        choice.framework = f.label;
      }
      const c = await this.pick([{ label: 'Debug' as const }, { label: 'Release' as const }], `${t.label}: configuration`);
      if (!c) return undefined;
      choice.configuration = c.label;
    }
    await this.select(t, choice);
    return t;
  }

  // ---- context, status bar

  private updateContext(): void {
    const { target, choice } = this.selection();
    const any = this.targetsCache.some((t) => t.runnable);
    void vscode.commands.executeCommand('setContext', 'refyntra.run.available', any);
    void vscode.commands.executeCommand('setContext', 'refyntra.run.running', this.sessions.size > 0);
    void vscode.commands.executeCommand('setContext', 'refyntra.run.viewVisible', vscode.workspace.getConfiguration('refyntra').get<boolean>('run.view', true));
    this.status.text = statusText(target, choice);
    this.status.accessibilityInformation = { label: target ? `Refyntra run target: ${target.label}, ${target.kindLabel}${choice.profile ? `, profile ${choice.profile}` : ''}. Choose another` : 'Refyntra: choose what to run' };
    if (any && vscode.workspace.getConfiguration('refyntra').get<boolean>('run.statusBar', true)) this.status.show();
    else this.status.hide();
  }

  statusBarText(): string {
    return this.status.text;
  }

  // ---- trust

  private requireTrust(what: string): boolean {
    if (this.isTrusted()) return true;
    void vscode.window
      .showWarningMessage(`Refyntra does not ${what} in Restricted Mode: building and running execute code from this workspace. Trust the workspace first.`, 'Manage Workspace Trust')
      .then((p) => p && vscode.commands.executeCommand('workbench.trust.manage'));
    return false;
  }

  // ---- run without debugging

  private async resolveTarget(arg: unknown): Promise<{ target: RunTarget; choice: RunChoice } | undefined> {
    await this.ready();
    const node = arg as TreeNode | undefined;
    if (node && typeof node === 'object' && 'kind' in node && (node.kind === 'target' || node.kind === 'profile')) {
      const choice = { ...this.selection().choice };
      if (node.kind === 'profile') choice.profile = node.profile.name;
      else if (this.selection().target?.id !== node.target.id) {
        delete choice.profile;
        delete choice.framework;
        if (node.target.dotnet?.profiles[0]) choice.profile = node.target.dotnet.profiles[0].name;
      }
      await this.select(node.target, choice);
      return { target: node.target, choice };
    }
    if (typeof arg === 'string') {
      const t = this.targetsCache.find((x) => x.id === arg);
      if (t) {
        await this.select(t);
        return this.selection().target ? { target: t, choice: this.selection().choice } : undefined;
      }
    }
    if (arg instanceof vscode.Uri) {
      const lang = arg.fsPath.endsWith('.cs') ? 'dotnet' : arg.fsPath.endsWith('.py') ? 'python' : arg.fsPath.endsWith('.rs') ? 'rust' : undefined;
      const t = lang === 'python' ? pythonTarget(arg.fsPath, vscode.workspace.getWorkspaceFolder(arg)?.uri.fsPath ?? path.dirname(arg.fsPath)) : lang ? targetForFile(this.targetsCache.filter((x) => x.runnable), arg.fsPath, lang) : undefined;
      if (t) {
        if (!this.targetsCache.some((x) => x.id === t.id)) this.targetsCache.push(t);
        await this.select(t);
        return { target: t, choice: this.selection().choice };
      }
    }
    const sel = this.selection();
    if (sel.target) return { target: sel.target, choice: sel.choice };
    const t = await this.chooseTarget();
    return t ? { target: t, choice: this.selection().choice } : undefined;
  }

  /** Steps that run a target without debugging. */
  runSteps(target: RunTarget, choice: RunChoice, watch = false): { command: string; args: string[]; cwd: string; env: Record<string, string> }[] {
    switch (target.language) {
      case 'dotnet':
        return [dotnetRunCommand(target, choice, process.platform, watch)];
      case 'node':
        return [{ command: target.node!.packageManager, args: ['run', target.node!.script], cwd: target.cwd, env: {} }];
      case 'python': {
        const py = this.debuggers.python() ?? (process.platform === 'win32' ? 'python' : 'python3');
        return [{ command: py, args: target.python?.module ? ['-m', target.python.module] : [target.python!.program!], cwd: target.cwd, env: { PYTHONUNBUFFERED: '1' } }];
      }
      case 'rust':
        return [{ command: 'cargo', args: cargoRunArgs(target, choice.configuration === 'Release'), cwd: target.cwd, env: {} }];
    }
  }

  /** Run (Ctrl+F5 without launch.json, the Run view, CodeLens, the editor title): build and start in a terminal. */
  async run(arg?: unknown, watch = false): Promise<RunSession | undefined> {
    if (!this.requireTrust('build or run projects')) return undefined;
    const r = await this.resolveTarget(arg);
    if (!r) return undefined;
    if (!r.target.runnable) {
      void vscode.window.showWarningMessage(`Refyntra cannot run ${r.target.label}: ${r.target.note ?? 'not runnable'}`);
      return undefined;
    }
    const profile = r.target.dotnet?.profiles.find((p) => p.name === r.choice.profile);
    const browser = isWebKind(r.target.dotnet?.project.kind) && profile?.launchBrowser ? profile : undefined;
    const steps = this.runSteps(r.target, r.choice, watch);
    if (watch && r.target.language === 'dotnet') steps[0] = { ...steps[0]!, args: watchArgs(steps[0]!.args, rudeEditPolicy()) };
    return this.startSession(r.target, steps, `${watch ? 'Watch' : 'Run'}: ${r.target.label}`, browser ? (url) => this.openBrowser(browserUrl(browser, url)) : undefined, watch && r.target.language === 'dotnet');
  }

  /** Starts a target in a Refyntra terminal (a VS Code task with a custom execution): output, input, exit code. */
  async startSession(target: RunTarget, steps: { command: string; args: string[]; cwd: string; env: Record<string, string> }[], name: string, onListening?: (url: string) => void, watch = false): Promise<RunSession> {
    const prev = this.sessions.get(target.id);
    if (prev) {
      prev.stop();
      await Promise.race([prev.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    let resolve!: (code: number | null) => void;
    const done = new Promise<number | null>((r) => (resolve = r));
    let opened = false;
    const indicator = watch
      ? new WatchIndicator(
          target.label,
          () => vscode.window.terminals.find((t) => t.name.includes(name))?.show(true),
          () => void this.run(target.id, true),
        )
      : undefined;
    const state = {
      output: '',
      resolve: (code: number | null) => resolve(code),
      onOutput: (text: string) => {
        indicator?.onOutput(text);
        if (opened || !onListening) return;
        const url = listeningUrl(state.output.slice(-2000) + text);
        if (url) {
          opened = true;
          onListening(url);
        }
      },
    } as { output: string; pid?: number; exitCode?: number | null; resolve(code: number | null): void; onOutput(text: string): void };
    let terminal: ProcessTerminal | undefined;
    const session: RunSession = {
      target,
      get output() {
        return state.output;
      },
      get pid() {
        return state.pid;
      },
      get exitCode() {
        return state.exitCode;
      },
      stop: () => terminal?.stop(),
      done,
      ...(indicator ? { watch: indicator } : {}),
    };
    const task = new vscode.Task(
      // A new instance number per start: VS Code treats tasks with equal definitions as the same task (a second start
      // of the same target would reuse the previous execution).
      { type: 'refyntra-run', target: target.id, instance: ++runInstances, ...(watch ? { watch: true } : {}) },
      vscode.TaskScope.Workspace,
      name,
      'Refyntra',
      new vscode.CustomExecution(async () => {
        terminal = new ProcessTerminal(steps, state);
        this.terminals.set(target.id, terminal);
        return terminal;
      }),
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, focus: false };
    task.isBackground = true;
    this.sessions.set(target.id, session);
    this.updateContext();
    this.changed.fire(undefined);
    // The terminal of this start: the first one VS Code opens for a task of this name after executeTask (starts are
    // sequential, so it is not another target's).
    const terminalOpened = vscode.window.onDidOpenTerminal((term) => {
      if (term.name.includes(name)) {
        session.terminal = term;
        terminalOpened.dispose();
      }
    });
    setTimeout(() => terminalOpened.dispose(), 30000);
    session.execution = await vscode.tasks.executeTask(task);
    void done.then(() => {
      indicator?.ended();
      indicator?.dispose();
      if (this.sessions.get(target.id) === session) this.sessions.delete(target.id);
      this.updateContext();
      this.changed.fire(undefined);
    });
    return session;
  }

  stop(arg?: unknown): void {
    const node = arg as TreeNode | undefined;
    const id = node && typeof node === 'object' && 'kind' in node && (node.kind === 'target' || node.kind === 'profile') ? node.target.id : typeof arg === 'string' ? arg : undefined;
    const list = id ? [this.sessions.get(id)].filter((s): s is RunSession => !!s) : [...this.sessions.values()];
    for (const s of list) s.stop();
    // Debug sessions started by Refyntra for this target.
    for (const ds of this.debugSessions.values()) if (!id || ds.configuration.__refyntraTarget === id) void vscode.debug.stopDebugging(ds);
  }

  async restart(arg?: unknown): Promise<void> {
    const node = arg as TreeNode | undefined;
    const id = node && typeof node === 'object' && 'kind' in node && (node.kind === 'target' || node.kind === 'profile') ? node.target.id : [...this.sessions.keys()][0];
    const t = this.targetsCache.find((x) => x.id === id);
    if (t) await this.run(t.id, !!(id && this.sessions.get(id)?.watch));
  }

  openBrowser(url: string | undefined): void {
    if (!url) return;
    this.hooks.openedUrls.push(url);
    if (this.context.extensionMode === vscode.ExtensionMode.Test) return; // tests read openedUrls; no browser in CI
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // ---- debug

  private readonly debugSessions = new Map<string, vscode.DebugSession>();

  /** Debug (F5 without launch.json, the Run view, CodeLens, the editor title): VS Code's own debugging with our configuration. */
  async debug(arg?: unknown, sessionName?: string): Promise<boolean> {
    if (!this.requireTrust('build or debug projects')) return false;
    const r = await this.resolveTarget(arg);
    if (!r) return false;
    if (r.target.dotnet?.project.kind === 'blazor-wasm') return this.debugBlazorWasm(r.target, r.choice, sessionName);
    const cfg = this.debugConfiguration(r.target, r.choice);
    if (!cfg) return false;
    if (sessionName) cfg.name = sessionName;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r.target.cwd)) ?? vscode.workspace.workspaceFolders?.[0];
    return vscode.debug.startDebugging(folder, cfg);
  }

  /**
   * Blazor WebAssembly: the C# runs in the browser, so netcoredbg is not involved. The development server starts like
   * Run (`dotnet run`); when it listens, VS Code's built-in JavaScript debugger opens the app in Edge / Chrome and
   * debugs its C# through the app's debugging proxy (inspectUri). Stopping the browser session leaves the server running.
   */
  async debugBlazorWasm(t: RunTarget, choice: RunChoice, sessionName?: string): Promise<boolean> {
    const profile = t.dotnet!.profiles.find((p) => p.name === choice.profile) ?? t.dotnet!.profiles[0];
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(t.cwd)) ?? vscode.workspace.workspaceFolders?.[0];
    const projectDir = t.dotnet!.projectPath.replace(/[\\/][^\\/]+$/, '');
    let started = false;
    await this.startSession(t, this.runSteps(t, choice, false), sessionName ?? `Debug: ${t.label}`, (url) => {
      if (started) return;
      started = true;
      const cfg = blazorWasmBrowserConfiguration(browserUrl(profile, url) ?? url, profile, projectDir, process.platform);
      if (sessionName) cfg.name = sessionName;
      this.hooks.browserDebugConfigurations.push(cfg);
      if (this.context.extensionMode === vscode.ExtensionMode.Test) return; // no browser in CI; tests read the configuration
      void vscode.debug.startDebugging(folder, cfg as vscode.DebugConfiguration);
    });
    return true;
  }

  /** The debug configuration of a target, or undefined with a message when it cannot be debugged here. */
  debugConfiguration(t: RunTarget, choice: RunChoice): vscode.DebugConfiguration | undefined {
    switch (t.language) {
      case 'dotnet': {
        if (!this.debuggers.netcoredbg()) {
          void vscode.window.showWarningMessage(`Refyntra: .NET debugging is unavailable on ${process.platform}-${process.arch} (no netcoredbg build). Use Run (Ctrl+F5) instead.`, 'Show Health').then((p) => p && vscode.commands.executeCommand('refyntra.showHealth'));
          return undefined;
        }
        return { ...dotnetDebugConfiguration(t, choice, process.platform), __refyntraTarget: t.id };
      }
      case 'python':
        return { ...pythonDebugConfiguration(t, this.debuggers.python()), __refyntraTarget: t.id };
      case 'node':
        return { ...nodeDebugConfigurations(t)[0]!, __refyntraTarget: t.id } as vscode.DebugConfiguration;
      case 'rust':
        if (!this.debuggers.lldbDap()) {
          void vscode.window.showWarningMessage('Refyntra: Rust debugging needs lldb-dap from an installed LLVM (it is not bundled, see ADR-008). Use Run (Ctrl+F5), or install LLVM and restart VS Code.');
          return undefined;
        }
        return { ...lldbDebugConfiguration(t, process.platform), __refyntraTarget: t.id } as vscode.DebugConfiguration;
    }
  }

  /** Dynamic configurations: what VS Code's Run and Debug view and debug dropdown list for a type. */
  async dynamicConfigurations(type: string): Promise<vscode.DebugConfiguration[]> {
    if (!this.isTrusted()) return [];
    const targets = (await this.ready()).filter((t) => t.runnable);
    const out: vscode.DebugConfiguration[] = [];
    for (const t of targets) {
      if (type === DOTNET_DEBUG_TYPE && t.dotnet) {
        const profiles = t.dotnet.profiles.length ? t.dotnet.profiles : [undefined];
        for (const p of profiles) out.push(dotnetDebugConfiguration(t, { configuration: 'Debug', ...(p ? { profile: p.name } : {}) }, process.platform));
      } else if (type === PYTHON_DEBUG_TYPE && t.python) out.push(pythonDebugConfiguration(t, this.debuggers.python()));
      else if (type === 'node' && t.node) out.push(nodeDebugConfigurations(t)[0]!);
      else if ((type === 'msedge' || type === 'chrome') && t.node?.devServerUrl) out.push(nodeDebugConfigurations(t, type)[1]!);
      else if (type === LLDB_DEBUG_TYPE && t.rust && this.debuggers.lldbDap()) out.push(lldbDebugConfiguration(t, process.platform));
    }
    if (type === DOTNET_DEBUG_TYPE && out.length) out.push({ type: DOTNET_DEBUG_TYPE, request: 'attach', name: 'Refyntra: Attach to a .NET process', processId: '${command:refyntra.pickDotnetProcess}' });
    return out;
  }

  /** "Generate launch.json": writes .vscode/launch.json with the configurations of every runnable target. */
  async generateLaunchJson(): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const targets = (await this.ready()).filter((t) => t.runnable);
    const ws = folder.uri.fsPath;
    const configs: Record<string, unknown>[] = [];
    for (const t of targets) {
      if (t.dotnet) {
        const profiles = t.dotnet.profiles.length ? t.dotnet.profiles : [undefined];
        for (const p of profiles) configs.push(dotnetDebugConfiguration(t, { configuration: 'Debug', ...(p ? { profile: p.name } : {}) }, process.platform, ws));
      } else if (t.python) configs.push(pythonDebugConfiguration(t, undefined));
      else if (t.node) configs.push(...nodeDebugConfigurations(t));
      else if (t.rust) configs.push(lldbDebugConfiguration(t, process.platform));
    }
    if (targets.some((t) => t.dotnet)) configs.push({ type: DOTNET_DEBUG_TYPE, request: 'attach', name: 'Refyntra: Attach to a .NET process', processId: '${command:refyntra.pickDotnetProcess}' });
    const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
    let existing: { version?: string; configurations?: Record<string, unknown>[] } = {};
    try {
      existing = JSON.parse(stripJsonComments(fs.readFileSync(file.fsPath, 'utf8'))) as typeof existing;
    } catch {
      // New file.
    }
    const names = new Set((existing.configurations ?? []).map((c) => c.name));
    const merged = { version: existing.version ?? '0.2.0', configurations: [...(existing.configurations ?? []), ...configs.filter((c) => !names.has(c.name))] };
    fs.mkdirSync(path.dirname(file.fsPath), { recursive: true });
    fs.writeFileSync(file.fsPath, JSON.stringify(merged, null, 2) + '\n');
    return file;
  }

  // ---- run groups (refyntra.run.groups): several targets started together

  // ---- hidden targets (per workspace, not in any file): Hide from Run, Show Hidden

  private hiddenIds(): Set<string> {
    return new Set(this.context.workspaceState.get<string[]>(HIDDEN_KEY, []));
  }

  isHidden(t: RunTarget): boolean {
    return this.hiddenIds().has(t.id);
  }

  async setHidden(targets: RunTarget[], hidden: boolean): Promise<void> {
    const ids = this.hiddenIds();
    for (const t of targets) {
      if (hidden) ids.add(t.id);
      else ids.delete(t.id);
    }
    await this.context.workspaceState.update(HIDDEN_KEY, [...ids]);
    this.changed.fire(undefined);
  }

  showHidden = false;

  toggleShowHidden(): void {
    this.showHidden = !this.showHidden;
    void vscode.commands.executeCommand('setContext', 'refyntra.run.showHidden', this.showHidden);
    this.changed.fire(undefined);
  }

  /** Run Script…: another script of a package (build, test, storybook, …) in its own terminal. */
  async runScript(arg?: unknown): Promise<RunSession | undefined> {
    const t = targetsOf(arg)[0] ?? (await this.resolveTarget(arg))?.target;
    const names = Object.keys(t?.node?.scripts ?? {});
    if (!t?.node || names.length === 0) {
      void vscode.window.showInformationMessage('Refyntra: this target has no other scripts.');
      return undefined;
    }
    const script = this.hooks.pickScript ?? (await vscode.window.showQuickPick(names.map((n) => ({ label: n, description: t.node!.scripts![n] })), { title: `Refyntra: Run Script (${t.label})` }))?.label;
    const variant = script ? nodeScriptTarget(t, script) : undefined;
    if (!variant) return undefined;
    if (!this.requireTrust('run scripts')) return undefined;
    return this.startSession(variant, [{ command: variant.node!.packageManager, args: ['run', script!], cwd: variant.cwd, env: {} }], `Run: ${variant.label}`);
  }

  groups(): RunGroup[] {
    return parseRunGroups(vscode.workspace.getConfiguration('refyntra').get('run.groups'));
  }

  /** The runnable targets with their project path relative to their workspace folder (how a group names repeated labels). */
  private groupCandidates(): (RunTarget & { relativePath?: string })[] {
    return this.targetsCache
      .filter((t) => t.runnable)
      .map((t) => {
        const file = t.dotnet?.projectPath;
        const folder = file ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) : undefined;
        return file && folder ? { ...t, relativePath: path.relative(folder.uri.fsPath, file).split(path.sep).join('/') } : t;
      });
  }

  private groupTargets(g: RunGroup): { found: RunTarget[]; missing: string[] } {
    const found: RunTarget[] = [];
    const missing: string[] = [];
    const candidates = this.groupCandidates();
    for (const entry of g.targets) {
      const t = resolveGroupEntry(entry, candidates, process.platform === 'win32');
      if (t === 'ambiguous') missing.push(`${entry} (several projects have this name: use its path, e.g. ${candidates.find((c) => c.label === entry)?.relativePath ?? entry})`);
      else if (t) found.push(this.targetsCache.find((x) => x.id === t.id) ?? t);
      else missing.push(entry);
    }
    return { found, missing };
  }

  isRunning(t: RunTarget): 'run' | 'debug' | undefined {
    if ([...this.debugSessions.values()].some((d) => d.configuration.__refyntraTarget === t.id)) return 'debug';
    return this.sessions.has(t.id) ? 'run' : undefined;
  }

  /** Starts the group's targets in order; a web target is waited for (its port accepts connections) before the next. */
  async startGroup(name?: string, debug = false): Promise<boolean> {
    const g = name ? this.groups().find((x) => x.name === name) : await this.pickGroup(debug ? 'Debug group' : 'Run group');
    if (!g) return false;
    if (!this.targetsCache.length) await this.refresh();
    const { found, missing } = this.groupTargets(g);
    if (missing.length) void vscode.window.showWarningMessage(`Refyntra: ${g.name}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not a runnable target here; the others start.`);
    for (let i = 0; i < found.length; i++) {
      const t = found[i]!;
      if (this.isRunning(t)) continue;
      const ok = debug ? await this.debug(t.id, groupSessionName(g.name, t.label)) : !!(await this.run(t.id));
      if (!ok) return false;
      const profile = (this.selection().target?.id === t.id ? t.dotnet?.profiles.find((p) => p.name === this.selection().choice.profile) : undefined) ?? t.dotnet?.profiles[0];
      const endpoint = isWebKind(t.dotnet?.project.kind) ? readinessEndpoint(profile?.applicationUrl) : undefined;
      if (endpoint && g.waitForReady !== false && i < found.length - 1) {
        const ready = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Refyntra: waiting for ${t.label} (${endpoint.host}:${endpoint.port})` }, () => waitForPort(endpoint.host, endpoint.port, 120000));
        this.hooks.groupReadiness.push({ target: t.label, ready });
        if (!ready) void vscode.window.showWarningMessage(`Refyntra: ${t.label} did not listen on ${endpoint.host}:${endpoint.port} within 2 minutes; the next ones start anyway.`);
      }
    }
    this.changed.fire(undefined);
    return true;
  }

  async stopGroup(name?: string): Promise<void> {
    const g = name ? this.groups().find((x) => x.name === name) : await this.pickGroup('Stop group');
    if (!g) return;
    for (const t of this.groupTargets(g).found) {
      this.stop(t.id);
      for (const d of [...this.debugSessions.values()].filter((s) => s.configuration.__refyntraTarget === t.id)) await vscode.debug.stopDebugging(d);
    }
    this.changed.fire(undefined);
  }

  /** Create Run Group: pick targets (in start order) and a name; saved in the workspace settings (shareable). */
  async createGroup(): Promise<RunGroup | undefined> {
    if (!this.targetsCache.length) await this.refresh();
    const items = this.targetsCache.filter((t) => t.runnable).map((t) => ({ label: t.label, description: `${t.kindLabel}${t.group ? ` · ${t.group}` : ''}`, target: t }));
    const picked = this.hooks.pickMany ? await this.hooks.pickMany(items) : await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Refyntra: Create Run Group', placeHolder: 'The targets that start together (they start in this order)' });
    if (!picked?.length) return undefined;
    const name = this.hooks.groupName ?? (await vscode.window.showInputBox({ title: 'Refyntra: Create Run Group', prompt: 'Name of the group', value: picked.map((p) => p.label).join(' + ') }));
    if (!name?.trim()) return undefined;
    const candidates = this.groupCandidates();
    const group: RunGroup = { name: name.trim(), targets: picked.map((p) => groupEntryOf(candidates.find((c) => c.id === p.target.id) ?? p.target, candidates)) };
    const cfg = vscode.workspace.getConfiguration('refyntra');
    const groups = this.groups().filter((g) => g.name !== group.name);
    await cfg.update('run.groups', [...groups, group], vscode.ConfigurationTarget.Workspace);
    this.changed.fire(undefined);
    return group;
  }

  async deleteGroup(name?: string): Promise<void> {
    const g = name ? this.groups().find((x) => x.name === name) : await this.pickGroup('Delete group');
    if (!g) return;
    await vscode.workspace.getConfiguration('refyntra').update('run.groups', this.groups().filter((x) => x.name !== g.name), vscode.ConfigurationTarget.Workspace);
    this.changed.fire(undefined);
  }

  private async pickGroup(title: string): Promise<RunGroup | undefined> {
    const groups = this.groups();
    if (groups.length === 0) {
      const pick = await vscode.window.showInformationMessage('Refyntra: no run group yet. A run group starts several projects together (for example a backend and a frontend).', 'Create Run Group');
      if (pick) await this.createGroup();
      return undefined;
    }
    if (groups.length === 1) return groups[0];
    const pick = await vscode.window.showQuickPick(groups.map((g) => ({ label: g.name, description: g.targets.join(' → '), g })), { title: `Refyntra: ${title}` });
    return pick?.g;
  }

  /** Shows what a running target runs in: its debug session (Call Stack) or its terminal. */
  async focus(arg?: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : (arg as { target?: RunTarget } | undefined)?.target?.id;
    const debugSession = [...this.debugSessions.values()].find((d) => d.configuration.__refyntraTarget === id);
    if (debugSession) {
      await vscode.commands.executeCommand('workbench.view.debug');
      await vscode.commands.executeCommand('workbench.debug.action.focusCallStackView');
      return;
    }
    const s = id ? this.sessions.get(id) : undefined;
    if (s?.terminal && vscode.window.terminals.includes(s.terminal)) s.terminal.show();
    this.hooks.focused.push(debugSession ? 'debug' : s?.terminal ? 'terminal' : 'none');
  }

  // ---- tree

  getTreeItem(n: TreeNode): vscode.TreeItem {
    if (n.kind === 'message') {
      const item = new vscode.TreeItem(n.text);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    if (n.kind === 'group') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'refyntra.runGroup';
      return item;
    }
    if (n.kind === 'launchGroup') {
      const { found } = this.groupTargets(n.group);
      const running = found.filter((t) => this.isRunning(t)).length;
      const item = new vscode.TreeItem(n.group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `launchGroup:${n.group.name}`;
      item.iconPath = new vscode.ThemeIcon(running ? 'layers-active' : 'layers');
      item.description = running ? `${running} of ${found.length} running` : n.group.targets.join(' → ');
      item.contextValue = running ? 'refyntra.launchGroup.running' : 'refyntra.launchGroup';
      item.tooltip = `Run group: ${n.group.targets.join(' → ')}${n.group.waitForReady === false ? '' : '\nWeb projects are waited for (their port) before the next one starts.'}`;
      return item;
    }
    const t = n.target;
    const state = this.isRunning(t);
    const running = !!state;
    if (n.kind === 'profile') {
      const item = new vscode.TreeItem(n.profile.name);
      item.description = n.profile.applicationUrl ?? '';
      item.contextValue = running ? 'refyntra.runProfile.running' : 'refyntra.runProfile';
      item.iconPath = new vscode.ThemeIcon(this.selection().target?.id === t.id && this.selection().choice.profile === n.profile.name ? 'pass-filled' : 'circle-large-outline');
      item.tooltip = `Launch profile ${n.profile.name}${n.profile.applicationUrl ? ` (${n.profile.applicationUrl})` : ''}${n.profile.launchBrowser ? ', opens the browser' : ''}`;
      return item;
    }
    const selected = this.selection().target?.id === t.id;
    const item = new vscode.TreeItem(t.label, t.dotnet && t.dotnet.profiles.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = n.kind === 'target' && n.inGroup ? `${n.inGroup}/${t.id}` : t.id;
    item.description = `${t.kindLabel}${state === 'debug' ? ' · debugging' : state === 'run' ? ' · running' : ''}${selected ? ' · selected' : ''}`;
    item.tooltip = new vscode.MarkdownString(`**${t.label}** (${t.kindLabel})\n\n${t.cwd}${t.note ? `\n\n${t.note}` : ''}`);
    item.contextValue = !t.runnable ? 'refyntra.runTarget.unsupported' : running ? 'refyntra.runTarget.running' : 'refyntra.runTarget';
    if (this.isHidden(t)) {
      item.contextValue += '.hidden';
      item.description = `${String(item.description ?? '')} · hidden`;
    }
    if (t.node?.scripts) item.contextValue += '.scripts';
    item.iconPath = new vscode.ThemeIcon(!t.runnable ? 'circle-slash' : state === 'debug' ? 'debug-alt' : running ? 'debug-stop' : t.language === 'dotnet' ? (isWebKind(t.dotnet?.project.kind) ? 'globe' : 'terminal') : t.language === 'node' ? 'json' : t.language === 'python' ? 'symbol-misc' : 'package');
    item.accessibilityInformation = { label: `${t.label}, ${t.kindLabel}${running ? ', running' : ''}${!t.runnable ? `, not runnable: ${t.note ?? ''}` : ''}` };
    // A running target opens what it runs in (its debug session or its terminal); otherwise a click selects it.
    if (running) item.command = { command: 'refyntra.run.focus', title: 'Show', arguments: [t.id] };
    else if (t.runnable) item.command = { command: 'refyntra.selectRunTargetById', title: 'Select', arguments: [t.id] };
    return item;
  }

  getChildren(n?: TreeNode): TreeNode[] {
    if (!n) {
      if (!this.isTrusted()) return [{ kind: 'message', text: 'Restricted Mode: Refyntra does not build or run projects until you trust the workspace.' }];
      const groups: TreeNode[] = this.groups().map((group) => ({ kind: 'launchGroup', group }));
      const add = (label: string, lang: RunTarget['language']) => {
        // Only what can start here: test projects (Test Explorer), libraries and apps of another OS are left out.
        const ts = this.targetsCache.filter((t) => t.language === lang && t.runnable);
        if (ts.length) groups.push({ kind: 'group', label, targets: ts });
      };
      // .NET: one group per solution when the workspace has several (Backend.sln, Tools.sln, Other projects).
      const dotnet = this.targetsCache.filter((t) => t.language === 'dotnet' && t.runnable);
      const solutions = [...new Set(dotnet.map((t) => t.group ?? ''))];
      if (solutions.length > 1) for (const s of solutions) groups.push({ kind: 'group', label: `.NET · ${s || 'Other projects'}`, targets: dotnet.filter((t) => (t.group ?? '') === s) });
      else add('.NET', 'dotnet');
      add('Node.js', 'node');
      add('Python', 'python');
      add('Rust', 'rust');
      if (this.dotnetNote && !this.targetsCache.some((t) => t.language === 'dotnet')) groups.unshift({ kind: 'message', text: `.NET: ${this.dotnetNote}` });
      return groups;
    }
    if (n.kind === 'group') return n.targets.filter((t) => this.showHidden || !this.isHidden(t)).map((target) => ({ kind: 'target', target }));
    if (n.kind === 'launchGroup') return this.groupTargets(n.group).found.map((target) => ({ kind: 'target', target, inGroup: n.group.name }));
    if (n.kind === 'target' && n.target.dotnet && n.target.dotnet.profiles.length > 1) return n.target.dotnet.profiles.map((profile) => ({ kind: 'profile', target: n.target, profile }));
    return [];
  }

  // ---- CodeLens "Run | Debug"

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file' || !this.isTrusted() || !vscode.workspace.getConfiguration('refyntra').get<boolean>('run.codeLens', true)) return [];
    let line: number | undefined;
    let target: RunTarget | undefined;
    if (doc.languageId === 'csharp') {
      target = targetForFile(this.targetsCache.filter((t) => t.runnable), doc.uri.fsPath, 'dotnet');
      if (target) line = csharpEntryLine(doc.getText(), path.basename(doc.uri.fsPath));
    } else if (doc.languageId === 'python') {
      line = pythonEntryLine(doc.getText());
      if (line !== undefined) target = this.targetsCache.find((t) => t.python?.program && path.resolve(t.python.program) === path.resolve(doc.uri.fsPath)) ?? pythonTarget(doc.uri.fsPath, vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(doc.uri.fsPath));
    } else if (doc.languageId === 'rust') {
      target = targetForFile(this.targetsCache.filter((t) => t.runnable), doc.uri.fsPath, 'rust');
      if (target) line = rustEntryLine(doc.getText());
    }
    if (line === undefined || !target) return [];
    const range = new vscode.Range(line, 0, line, 0);
    const arg = doc.languageId === 'python' ? doc.uri : target.id;
    return [
      new vscode.CodeLens(range, { title: '$(play) Run', tooltip: `Run ${target.label} without debugging`, command: 'refyntra.run', arguments: [arg] }),
      new vscode.CodeLens(range, { title: '$(debug-alt) Debug', tooltip: `Debug ${target.label}`, command: 'refyntra.debug', arguments: [arg] }),
    ];
  }

  // ---- debug adapter plumbing (registered in registerRun)

  trackDebugSession(s: vscode.DebugSession, started: boolean): void {
    const id = s.configuration.__refyntraTarget as string | undefined;
    if (started) this.debugSessions.set(s.id, s);
    else this.debugSessions.delete(s.id);
    if (id) this.changed.fire(undefined);
    void vscode.commands.executeCommand('setContext', 'refyntra.run.running', this.sessions.size > 0 || this.debugSessions.size > 0);
  }
}

// ------------------------------------------------------------------------------------------------ attach picker

interface ProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
}

function listProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => {
        if (err) return resolve([]);
        try {
          const list = JSON.parse(out) as { ProcessId: number; Name: string; CommandLine: string | null }[];
          resolve(list.map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine ?? '' })));
        } catch {
          resolve([]);
        }
      });
      return;
    }
    if (process.platform === 'linux') {
      const out: ProcessInfo[] = [];
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
          const name = fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim();
          out.push({ pid: Number(d), name, commandLine: cmd });
        } catch {
          // Gone or not ours.
        }
      }
      return resolve(out);
    }
    execFile('ps', ['-axo', 'pid=,comm=,args='], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(
        out
          .split('\n')
          .map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => ({ pid: Number(m[1]), name: path.basename(m[2]!), commandLine: m[3]! })),
      );
    });
  });
}

/** True for a process that runs .NET (dotnet host, or a command line with a .dll). Heuristic for sorting only. */
export function looksDotnet(p: { name: string; commandLine: string }): boolean {
  return /^dotnet(\.exe)?$/i.test(p.name) || /\.dll(\s|"|$)/i.test(p.commandLine);
}

// ------------------------------------------------------------------------------------------------ registration

export function registerRun(context: vscode.ExtensionContext, engine: EngineClient, isTrusted: () => boolean): { service: RunService; disposable: vscode.Disposable } {
  const service = new RunService(context, engine, isTrusted);
  const view = vscode.window.createTreeView(RUN_VIEW, { treeDataProvider: service, showCollapseAll: false, canSelectMany: true });
  const subs: vscode.Disposable[] = [service, view];

  // ---- .NET: netcoredbg
  subs.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DOTNET_DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => {
        const exe = service.debuggers.netcoredbg();
        if (!exe) throw new Error(`.NET debugging is unavailable on ${process.platform}-${process.arch}: this Refyntra package has no netcoredbg (no official build for this platform). Running still works (Ctrl+F5).`);
        // netcoredbg behind Refyntra's DAP proxy, which adds logpoints and hit counts (ADR-008).
        return new vscode.DebugAdapterInlineImplementation(new NetcoredbgProxyAdapter(exe));
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(
      DOTNET_DEBUG_TYPE,
      {
        resolveDebugConfiguration: async (_folder, config) => {
          if (!isTrusted()) {
            void vscode.window.showWarningMessage('Refyntra does not build or debug in Restricted Mode. Trust the workspace first.');
            return undefined;
          }
          // F5 / Ctrl+F5 with no launch.json: VS Code passes an empty configuration; use the selected run target.
          if (!config.type && !config.request && !config.name) {
            await service.ready();
            const sel = service.selection();
            const t = sel.target?.language === 'dotnet' ? sel.target : service.targets().find((x) => x.runnable && x.language === 'dotnet');
            if (!t) {
              void vscode.window.showInformationMessage('Refyntra found no runnable .NET project. Open a solution with a console, web, worker or desktop app.');
              return undefined;
            }
            if (config.noDebug) {
              await service.run(t.id);
              return undefined;
            }
            return service.debugConfiguration(t, sel.target?.id === t.id ? sel.choice : { configuration: 'Debug' });
          }
          return config;
        },
        resolveDebugConfigurationWithSubstitutedVariables: async (folder, config) => {
          const c = config as unknown as DotnetDebugConfiguration;
          const problem = validateDotnetConfiguration(c);
          if (problem) {
            void vscode.window.showErrorMessage(`Refyntra: ${problem}`);
            return null as unknown as undefined; // null: VS Code opens launch.json
          }
          if (c.request === 'attach') return { ...config, processId: Number(c.processId) };
          // Build first (the preLaunch step), unless "build": false.
          if (c.project && c.build !== false) {
            const ok = await buildDotnet(c.project, c.framework, c.configuration ?? 'Debug', folder);
            if (!ok) return undefined;
          }
          if (c.program && !fs.existsSync(c.program)) {
            void vscode.window.showErrorMessage(`Refyntra: the program to debug does not exist: ${c.program}. Build the project first, or check "program" in launch.json.`);
            return undefined;
          }
          if (c.console && c.console !== 'internalConsole') {
            // netcoredbg starts the program itself and has no runInTerminal: output goes to the Debug Console.
            void vscode.window.setStatusBarMessage('Refyntra: netcoredbg shows program output in the Debug Console (console: internalConsole).', 8000);
          }
          if (c.noDebug) {
            const t: RunTarget = { id: `dotnet:${c.project ?? c.program}`, language: 'dotnet', label: c.name, kindLabel: '.NET', cwd: c.cwd ?? path.dirname(c.program!), runnable: true };
            const program = c.program!;
            await service.startSession(t, [{ command: program.endsWith('.dll') ? 'dotnet' : program, args: [...(program.endsWith('.dll') ? [program] : []), ...(c.args ?? [])], cwd: t.cwd, env: c.env ?? {} }], `Run: ${c.name}`, c.launchBrowser?.enabled ? (u) => service.openBrowser(browserUrl({ name: '', environmentVariables: {}, launchBrowser: true, ...(c.launchBrowser?.url ? { launchUrl: c.launchBrowser.url } : {}) }, u)) : undefined);
            return undefined;
          }
          return { ...config, ...netcoredbgLaunchArguments(c) };
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Initial,
    ),
    vscode.debug.registerDebugConfigurationProvider(DOTNET_DEBUG_TYPE, { provideDebugConfigurations: () => service.dynamicConfigurations(DOTNET_DEBUG_TYPE) }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
  );

  // ---- Python: debugpy (bundled) run by the user's interpreter
  subs.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(PYTHON_DEBUG_TYPE, {
      createDebugAdapterDescriptor: (session) => {
        const root = service.debuggers.debugpyRoot();
        if (!root) throw new Error('The bundled debugpy is missing from this installation of Refyntra. Reinstall the extension.');
        const python = (session.configuration.python as string | undefined) ?? service.debuggers.python();
        if (!python) throw new Error('Python debugging needs a Python interpreter: none was found (python.defaultInterpreterPath, a .venv/venv folder or python on PATH). Install Python, then try again.');
        return new vscode.DebugAdapterExecutable(python, ['-m', 'debugpy.adapter'], { env: { PYTHONPATH: root, PYDEVD_USE_CYTHON: 'NO', PYDEVD_DISABLE_FILE_VALIDATION: '1' } });
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(
      PYTHON_DEBUG_TYPE,
      {
        resolveDebugConfiguration: async (_folder, config) => {
          if (!isTrusted()) {
            void vscode.window.showWarningMessage('Refyntra does not run or debug Python in Restricted Mode. Trust the workspace first.');
            return undefined;
          }
          if (!config.type && !config.request && !config.name) {
            const doc = vscode.window.activeTextEditor?.document;
            if (doc?.languageId !== 'python') return undefined;
            const t = pythonTarget(doc.uri.fsPath, vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(doc.uri.fsPath));
            if (config.noDebug) {
              await service.run(doc.uri);
              return undefined;
            }
            return service.debugConfiguration(t, { configuration: 'Debug' });
          }
          return config;
        },
        resolveDebugConfigurationWithSubstitutedVariables: (_folder, config) => {
          const problem = validatePythonConfiguration(config as Partial<import('./runModel').PythonDebugConfiguration>);
          if (problem) {
            void vscode.window.showErrorMessage(`Refyntra: ${problem}`);
            return null as unknown as undefined;
          }
          const python = (config.python as string | undefined) ?? service.debuggers.python();
          // debugpy reads "python" as the debuggee interpreter; the bundled debugpy goes on its PYTHONPATH.
          const root = service.debuggers.debugpyRoot();
          const env = { ...((config.env as Record<string, string>) ?? {}), PYDEVD_USE_CYTHON: 'NO', PYDEVD_DISABLE_FILE_VALIDATION: '1' };
          return root ? { ...config, ...(python ? { python } : {}), env } : config;
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Initial,
    ),
    vscode.debug.registerDebugConfigurationProvider(PYTHON_DEBUG_TYPE, { provideDebugConfigurations: () => service.dynamicConfigurations(PYTHON_DEBUG_TYPE) }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
  );

  // ---- Rust: lldb-dap from an installed LLVM (detected, not bundled)
  subs.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(LLDB_DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => {
        const exe = service.debuggers.lldbDap();
        if (!exe) throw new Error('Rust debugging needs lldb-dap from an installed LLVM (not bundled with Refyntra, see ADR-008). Install LLVM, or use Run (Ctrl+F5).');
        return new vscode.DebugAdapterExecutable(exe, []);
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(
      LLDB_DEBUG_TYPE,
      {
        resolveDebugConfigurationWithSubstitutedVariables: async (folder, config) => {
          if (!isTrusted()) return undefined;
          const cargo = config.cargo as { manifest?: string; bin?: string } | undefined;
          if (cargo?.manifest) {
            const ok = await runTask(new vscode.ProcessExecution('cargo', ['build', '--manifest-path', cargo.manifest, ...(cargo.bin ? ['--bin', cargo.bin] : [])]), `cargo build ${cargo.bin ?? ''}`.trim(), folder);
            if (!ok) return undefined;
          }
          return { ...config, env: lldbEnv(config.env as Record<string, string> | undefined) };
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Initial,
    ),
    vscode.debug.registerDebugConfigurationProvider(LLDB_DEBUG_TYPE, { provideDebugConfigurations: () => service.dynamicConfigurations(LLDB_DEBUG_TYPE) }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
  );

  // ---- Node / browsers: configurations for VS Code's built-in JavaScript debugger (js-debug)
  for (const type of ['node', 'msedge', 'chrome']) subs.push(vscode.debug.registerDebugConfigurationProvider(type, { provideDebugConfigurations: () => service.dynamicConfigurations(type) }, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

  // ---- web: open the browser when the app is listening; exit codes; running state
  subs.push(
    vscode.debug.registerDebugAdapterTrackerFactory(DOTNET_DEBUG_TYPE, {
      createDebugAdapterTracker: (session) => {
        const cfg = session.configuration as DotnetDebugConfiguration;
        let buffer = '';
        let opened = false;
        return {
          onDidSendMessage: (m: { type?: string; event?: string; body?: { output?: string; exitCode?: number } }) => {
            if (m.type !== 'event') return;
            if (m.event === 'output' && cfg.launchBrowser?.enabled && !opened && m.body?.output) {
              buffer = (buffer + m.body.output).slice(-4000);
              const url = listeningUrl(buffer);
              if (url) {
                opened = true;
                service.openBrowser(browserUrl({ name: '', environmentVariables: {}, launchBrowser: true, ...(cfg.launchBrowser.url ? { launchUrl: cfg.launchBrowser.url } : {}) }, url));
              }
            }
            if (m.event === 'exited' && typeof m.body?.exitCode === 'number') service.hooks.debugExitCodes.set(session.id, m.body.exitCode);
          },
        };
      },
    }),
    vscode.debug.registerDebugAdapterTrackerFactory(PYTHON_DEBUG_TYPE, {
      createDebugAdapterTracker: (session) => ({
        onDidSendMessage: (m: { type?: string; event?: string; body?: { exitCode?: number } }) => {
          if (m.type === 'event' && m.event === 'exited' && typeof m.body?.exitCode === 'number') service.hooks.debugExitCodes.set(session.id, m.body.exitCode);
        },
      }),
    }),
    vscode.debug.onDidStartDebugSession((s) => service.trackDebugSession(s, true)),
    vscode.debug.onDidTerminateDebugSession((s) => service.trackDebugSession(s, false)),
  );

  // ---- commands, CodeLens
  subs.push(
    vscode.languages.registerCodeLensProvider([{ language: 'csharp', scheme: 'file' }, { language: 'python', scheme: 'file' }, { language: 'rust', scheme: 'file' }], service),
    // Several rows selected in the Run view (Ctrl/Shift+click): Run, Debug, Stop and Hide act on each of them.
    vscode.commands.registerCommand('refyntra.run', async (arg?: unknown, all?: unknown) => {
      const many = targetsOf(all);
      if (many.length > 1) {
        for (const t of many) await service.run(t.id);
        return undefined;
      }
      return service.run(arg);
    }),
    vscode.commands.registerCommand('refyntra.run.hide', (arg?: unknown, all?: unknown) => service.setHidden(targetsOf(all).length ? targetsOf(all) : targetsOf(arg), true)),
    vscode.commands.registerCommand('refyntra.run.unhide', (arg?: unknown, all?: unknown) => service.setHidden(targetsOf(all).length ? targetsOf(all) : targetsOf(arg), false)),
    vscode.commands.registerCommand('refyntra.run.showHidden', () => service.toggleShowHidden()),
    vscode.commands.registerCommand('refyntra.run.hideShown', () => service.toggleShowHidden()),
    vscode.commands.registerCommand('refyntra.run.runScript', (arg?: unknown) => service.runScript(arg)),
    vscode.commands.registerCommand('refyntra.runWatch', (arg?: unknown) => service.run(arg, true)),
    vscode.commands.registerCommand('refyntra.showWatchTerminal', () => [...service.sessions.values()].find((s) => s.watch)?.watch?.reveal()),
    vscode.commands.registerCommand('refyntra.debug', async (arg?: unknown, all?: unknown) => {
      const many = targetsOf(all);
      if (many.length > 1) {
        for (const t of many) await service.debug(t.id);
        return true;
      }
      return service.debug(arg);
    }),
    vscode.commands.registerCommand('refyntra.stop', (arg?: unknown, all?: unknown) => {
      const many = targetsOf(all);
      if (many.length > 1) for (const t of many) service.stop(t.id);
      else service.stop(arg);
    }),
    vscode.commands.registerCommand('refyntra.run.createGroup', () => service.createGroup()),
    vscode.commands.registerCommand('refyntra.run.runGroup', (arg?: unknown) => service.startGroup(groupNameOf(arg), false)),
    vscode.commands.registerCommand('refyntra.run.debugGroup', (arg?: unknown) => service.startGroup(groupNameOf(arg), true)),
    vscode.commands.registerCommand('refyntra.run.stopGroup', (arg?: unknown) => service.stopGroup(groupNameOf(arg))),
    vscode.commands.registerCommand('refyntra.run.deleteGroup', (arg?: unknown) => service.deleteGroup(groupNameOf(arg))),
    vscode.commands.registerCommand('refyntra.run.focus', (arg?: unknown) => service.focus(arg)),
    vscode.commands.registerCommand('refyntra.restart', (arg?: unknown) => service.restart(arg)),
    vscode.commands.registerCommand('refyntra.selectRunTarget', () => service.chooseTarget()),
    vscode.commands.registerCommand('refyntra.selectRunTargetById', async (id: string) => {
      const t = service.targets().find((x) => x.id === id);
      if (t) await service.select(t);
    }),
    vscode.commands.registerCommand('refyntra.run.refresh', () => service.refresh()),
    vscode.commands.registerCommand('refyntra.generateLaunchJson', async () => {
      if (!isTrusted()) {
        void vscode.window.showWarningMessage('Refyntra reads the project model only in a trusted workspace. Trust the workspace first.');
        return undefined;
      }
      const file = await service.generateLaunchJson();
      if (file) await vscode.window.showTextDocument(file);
      return file;
    }),
    vscode.commands.registerCommand('refyntra.pickDotnetProcess', async () => {
      const list = (await listProcesses()).filter((p) => p.pid !== process.pid);
      const items = list
        .sort((a, b) => Number(looksDotnet(b)) - Number(looksDotnet(a)) || a.name.localeCompare(b.name))
        .map((p) => ({ label: `${p.name} (${p.pid})`, description: looksDotnet(p) ? '.NET' : '', detail: p.commandLine.slice(0, 300), pid: p.pid }));
      const pick = await vscode.window.showQuickPick(items, { title: 'Refyntra: Attach to a .NET process', matchOnDetail: true, placeHolder: 'Type to filter by name, process id or command line' });
      return pick ? String(pick.pid) : undefined;
    }),
  );
  void service.refresh();
  return { service, disposable: vscode.Disposable.from(...subs) };
}

/** Runs a task and resolves true when its process exits with 0. */
async function runTask(execution: vscode.ProcessExecution, name: string, folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
  const task = new vscode.Task({ type: 'refyntra-build', name }, folder ?? vscode.TaskScope.Workspace, name, 'Refyntra', execution, []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Shared, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  const code = await new Promise<number | undefined>((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== exec) return;
      sub.dispose();
      resolve(e.exitCode);
    });
  });
  if (code !== 0) {
    void vscode.window.showErrorMessage(`Refyntra: ${name} failed (exit code ${code ?? 'unknown'}). See the terminal for the errors.`);
    return false;
  }
  return true;
}

/** The preLaunch step of a .NET debug session: `dotnet build` of the project as a VS Code task. */
export function buildDotnet(project: string, framework: string | undefined, configuration: string, folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
  return runTask(new vscode.ProcessExecution('dotnet', dotnetBuildArgs(project, framework, configuration), { env: { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } }), `dotnet build ${path.basename(project)}`, folder);
}
