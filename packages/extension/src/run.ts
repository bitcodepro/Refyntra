import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { pythonInterpreter } from './lspServers';
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
  nodeTargets,
  parseLaunchSettings,
  pickFramework,
  pythonDebugConfiguration,
  pythonEntryLine,
  pythonTarget,
  runnableFrameworks,
  rustEntryLine,
  rustTargets,
  statusText,
  stripJsonComments,
  targetForFile,
  validateDotnetConfiguration,
  validatePythonConfiguration,
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
  stop(): void;
  readonly done: Promise<number | null>;
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
    child.on('close', (code) => {
      if (this.child !== child) return;
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

type TreeNode = { kind: 'group'; label: string; targets: RunTarget[] } | { kind: 'target'; target: RunTarget } | { kind: 'profile'; target: RunTarget; profile: LaunchProfile } | { kind: 'message'; text: string };

/** Test seams (e2e): replace pickers and record what would be opened in a browser. */
export interface RunTestHooks {
  pick?: <T extends vscode.QuickPickItem>(items: T[], title: string) => Promise<T | undefined>;
  openedUrls: string[];
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
  readonly hooks: RunTestHooks = { openedUrls: [], debugExitCodes: new Map() };
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
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
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

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
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
        } else if (r.reasonCode !== 'NoSolution') this.dotnetNote = r.message;
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
    const browser = r.target.dotnet?.project.kind === 'web' && profile?.launchBrowser ? profile : undefined;
    return this.startSession(r.target, this.runSteps(r.target, r.choice, watch), `${watch ? 'Watch' : 'Run'}: ${r.target.label}`, browser ? (url) => this.openBrowser(browserUrl(browser, url)) : undefined);
  }

  /** Starts a target in a Refyntra terminal (a VS Code task with a custom execution): output, input, exit code. */
  async startSession(target: RunTarget, steps: { command: string; args: string[]; cwd: string; env: Record<string, string> }[], name: string, onListening?: (url: string) => void): Promise<RunSession> {
    const prev = this.sessions.get(target.id);
    if (prev) {
      prev.stop();
      await Promise.race([prev.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    let resolve!: (code: number | null) => void;
    const done = new Promise<number | null>((r) => (resolve = r));
    let opened = false;
    const state = {
      output: '',
      resolve: (code: number | null) => resolve(code),
      onOutput: (text: string) => {
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
    };
    const task = new vscode.Task(
      { type: 'refyntra-run', target: target.id },
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
    session.execution = await vscode.tasks.executeTask(task);
    void done.then(() => {
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
    if (t) await this.run(t.id);
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
  async debug(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('build or debug projects')) return false;
    const r = await this.resolveTarget(arg);
    if (!r) return false;
    const cfg = this.debugConfiguration(r.target, r.choice);
    if (!cfg) return false;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r.target.cwd)) ?? vscode.workspace.workspaceFolders?.[0];
    return vscode.debug.startDebugging(folder, cfg);
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
    const t = n.target;
    const running = this.sessions.has(t.id) || [...this.debugSessions.values()].some((d) => d.configuration.__refyntraTarget === t.id);
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
    item.id = t.id;
    item.description = `${t.kindLabel}${running ? ' · running' : ''}${selected ? ' · selected' : ''}`;
    item.tooltip = new vscode.MarkdownString(`**${t.label}** (${t.kindLabel})\n\n${t.cwd}${t.note ? `\n\n${t.note}` : ''}`);
    item.contextValue = !t.runnable ? 'refyntra.runTarget.unsupported' : running ? 'refyntra.runTarget.running' : 'refyntra.runTarget';
    item.iconPath = new vscode.ThemeIcon(!t.runnable ? 'circle-slash' : running ? 'debug-stop' : t.language === 'dotnet' ? (t.dotnet?.project.kind === 'web' ? 'globe' : 'terminal') : t.language === 'node' ? 'json' : t.language === 'python' ? 'symbol-misc' : 'package');
    item.accessibilityInformation = { label: `${t.label}, ${t.kindLabel}${running ? ', running' : ''}${!t.runnable ? `, not runnable: ${t.note ?? ''}` : ''}` };
    if (t.runnable) item.command = { command: 'refyntra.selectRunTargetById', title: 'Select', arguments: [t.id] };
    return item;
  }

  getChildren(n?: TreeNode): TreeNode[] {
    if (!n) {
      if (!this.isTrusted()) return [{ kind: 'message', text: 'Restricted Mode: Refyntra does not build or run projects until you trust the workspace.' }];
      const groups: TreeNode[] = [];
      const add = (label: string, lang: RunTarget['language']) => {
        const ts = this.targetsCache.filter((t) => t.language === lang);
        if (ts.length) groups.push({ kind: 'group', label, targets: ts });
      };
      add('.NET', 'dotnet');
      add('Node.js', 'node');
      add('Python', 'python');
      add('Rust', 'rust');
      if (this.dotnetNote && !this.targetsCache.some((t) => t.language === 'dotnet')) groups.unshift({ kind: 'message', text: `.NET: ${this.dotnetNote}` });
      return groups;
    }
    if (n.kind === 'group') return n.targets.map((target) => ({ kind: 'target', target }));
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
  const view = vscode.window.createTreeView(RUN_VIEW, { treeDataProvider: service, showCollapseAll: false });
  const subs: vscode.Disposable[] = [service, view];

  // ---- .NET: netcoredbg
  subs.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DOTNET_DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => {
        const exe = service.debuggers.netcoredbg();
        if (!exe) throw new Error(`.NET debugging is unavailable on ${process.platform}-${process.arch}: this Refyntra package has no netcoredbg (no official build for this platform). Running still works (Ctrl+F5).`);
        return new vscode.DebugAdapterExecutable(exe, ['--interpreter=vscode'], { cwd: path.dirname(exe) });
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
    vscode.commands.registerCommand('refyntra.run', (arg?: unknown) => service.run(arg)),
    vscode.commands.registerCommand('refyntra.runWatch', (arg?: unknown) => service.run(arg, true)),
    vscode.commands.registerCommand('refyntra.debug', (arg?: unknown) => service.debug(arg)),
    vscode.commands.registerCommand('refyntra.stop', (arg?: unknown) => service.stop(arg)),
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
