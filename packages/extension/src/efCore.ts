import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { EfContextInfo, EfMigrationsResult, Location } from '@refyntra/contracts';
import { openLocation } from './convert';
import { DOTNET_DEBUG_TYPE } from './runModel';
import {
  type EfCommand,
  type EfContextStatus,
  type EfNode,
  type EfTarget,
  type EfToolState,
  INSTALL_DOTNET_EF,
  buildEfTree,
  displayCommand,
  efArgs,
  efContextKey,
  efHealthText,
  manifestHasDotnetEf,
  migrationNameProblem,
  parseDebuggerString,
  parseEfVersion,
  parseMigrationsList,
  selectionProblem,
  statusFromList,
  toQueryStringExpressions,
  touchesDatabase,
} from './efCoreModel';

// EF Core tools (ADR-011), with no other extension: the "Refyntra EF Core" view (DbContexts → migrations from the
// host's efcore/migrations, protocol 1.18), dotnet-ef commands as visible VS Code tasks (trusted workspaces only, the
// exact command shown, a confirmation before anything that connects to a database) and Show SQL for LINQ in a
// refyntra-dotnet debug session. Refyntra never installs dotnet-ef and has no Drop Database command.

export const EF_VIEW = 'refyntra.efCoreView';
export const EF_TASK_TYPE = 'refyntra-ef';
const SQL_SCHEME = 'refyntra-sql';
const STARTUP_KEY = 'refyntra.ef.startupProject:';

/** Options the integration tests pass instead of answering prompts (honoured only in Test mode). */
export interface EfTestOptions {
  name?: string;
  startupProject?: string;
  confirmed?: boolean;
  migration?: string;
  idempotent?: boolean;
}

export interface EfCoreState {
  outline: string[];
  contexts: number;
  tool: EfToolState;
  /** The last dotnet command line Refyntra built (shown in the task / confirmation). */
  lastCommand?: { args: string[]; display: string; cwd: string };
  lastExitCode?: number;
  lastSql?: string;
  lastSqlMessage?: string;
  refreshes: number;
}

class SqlDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private n = 0;
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }
  add(title: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SQL_SCHEME, path: `/${++this.n}/${title.replace(/[^A-Za-z0-9_.-]+/g, '_')}.sql` });
    this.texts.set(uri.toString(), text);
    return uri;
  }
  dispose(): void {
    this.changed.dispose();
  }
}

export class EfCoreService implements vscode.TreeDataProvider<EfNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<EfNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: EfMigrationsResult | undefined;
  private nodes: EfNode[] = [];
  private readonly status = new Map<string, EfContextStatus>();
  private tool: EfToolState = { state: 'unknown' };
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private csharpReady = false;
  readonly sql = new SqlDocuments();
  readonly output = vscode.window.createOutputChannel('Refyntra EF Core');
  private st: Omit<EfCoreState, 'outline' | 'contexts' | 'tool'> = { refreshes: 0 };

  constructor(
    private readonly engine: EngineClient,
    private readonly memento: vscode.Memento,
    private readonly isTrusted: () => boolean,
    private readonly testMode: boolean,
  ) {
    this.subs.push(
      this.changed,
      this.output,
      engine.onDidChangeHealth((h) => {
        const ready = h.adapters.some((a) => a.adapterId === 'csharp' && (a.state === 'Ready' || a.state === 'Partial'));
        if (ready && !this.csharpReady) void this.refresh();
        this.csharpReady = ready;
      }),
      engine.onDidInvalidate(() => {
        if (this.csharpReady) this.schedule();
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
    this.sql.dispose();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 800);
  }

  // ---------------------------------------------------------------------------------------------- tree

  getTreeItem(n: EfNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    if (n.description) item.description = n.description;
    if (n.tooltip) item.tooltip = n.tooltip;
    item.iconPath = new vscode.ThemeIcon(n.icon);
    item.contextValue = n.contextValue;
    if (n.location) item.command = { command: 'refyntra.ef.open', title: 'Open', arguments: [n] };
    return item;
  }

  getChildren(n?: EfNode): EfNode[] {
    return n ? (n.children ?? []) : this.nodes;
  }

  async refresh(): Promise<void> {
    if (!this.engine.efMigrations) return;
    const r = await this.engine.efMigrations();
    this.result = r.kind === 'migrations' ? r.result : undefined;
    this.render();
    this.st.refreshes++;
  }

  private render(): void {
    this.nodes = buildEfTree(this.result, this.status);
    void vscode.commands.executeCommand('setContext', 'refyntra.efCore.available', (this.result?.contexts.length ?? 0) > 0);
    this.changed.fire(undefined);
  }

  state(): EfCoreState {
    const outline: string[] = [];
    const walk = (ns: EfNode[], depth: number) => {
      for (const n of ns) {
        outline.push(`${'  '.repeat(depth)}${n.label}${n.description ? ` — ${n.description}` : ''}`);
        if (n.children) walk(n.children, depth + 1);
      }
    };
    walk(this.nodes, 0);
    return { ...this.st, outline, contexts: this.result?.contexts.length ?? 0, tool: this.tool };
  }

  /** The Health line, or undefined in a workspace without DbContexts. */
  healthText(): string | undefined {
    const n = this.result?.contexts.length ?? 0;
    return n > 0 ? efHealthText(this.tool, n) : undefined;
  }

  // ---------------------------------------------------------------------------------------------- dotnet-ef

  private folderOf(file: string): vscode.WorkspaceFolder | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find((f) => {
      const rel = path.relative(f.uri.fsPath, file);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  /** `dotnet ef --version` in the project's folder (a local tool manifest above it is honoured by dotnet itself). */
  async detectTool(cwd: string): Promise<EfToolState> {
    let localManifest = false;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const m = path.join(dir, '.config', 'dotnet-tools.json');
      try {
        if (manifestHasDotnetEf(fs.readFileSync(m, 'utf8'))) {
          localManifest = true;
          break;
        }
      } catch {
        /* no manifest here */
      }
      if (path.dirname(dir) === dir) break;
    }
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      execFile('dotnet', ['ef', '--version'], { cwd, timeout: 120000, windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
      ),
    );
    const version = out.code === 0 ? parseEfVersion(out.stdout) : undefined;
    this.tool = version ? { state: 'found', version, source: localManifest ? 'local' : 'global' } : { state: 'missing', localManifest, detail: (out.stderr || out.stdout).trim().split(/\r?\n/)[0] };
    return this.tool;
  }

  private async requireTool(cwd: string): Promise<boolean> {
    const t = this.tool.state === 'found' ? this.tool : await this.detectTool(cwd);
    if (t.state === 'found') return true;
    const msg = t.state === 'missing' && t.localManifest
      ? 'Refyntra: dotnet-ef is in the local tool manifest but not restored. Run "dotnet tool restore" in a terminal yourself.'
      : `Refyntra: dotnet-ef was not found. Install it yourself, for example with: ${INSTALL_DOTNET_EF} (Refyntra never installs tools).`;
    void vscode.window.showWarningMessage(msg, 'Show Health').then((p) => p && vscode.commands.executeCommand('refyntra.showHealth'));
    return false;
  }

  private async pickContext(node: unknown, title: string): Promise<EfContextInfo | undefined> {
    const n = node as EfNode | undefined;
    if (n?.context) return n.context;
    if (!this.result) await this.refresh();
    const contexts = this.result?.contexts ?? [];
    if (contexts.length === 0) {
      void vscode.window.showInformationMessage('Refyntra: no EF Core DbContext was found in the loaded projects.');
      return undefined;
    }
    if (contexts.length === 1) return contexts[0];
    const pick = await vscode.window.showQuickPick(contexts.map((c) => ({ label: c.name, description: c.projectName, detail: c.fullName, c })), { title, placeHolder: 'Choose a DbContext' });
    return pick?.c;
  }

  /** The startup project: remembered per DbContext; asked once when there is a choice. */
  private async startupProject(c: EfContextInfo, opts: EfTestOptions | undefined): Promise<string | undefined> {
    const migrationsProject = vscode.Uri.parse(c.migrationsProjectUri).fsPath;
    if (opts?.startupProject) return opts.startupProject;
    const key = STARTUP_KEY + efContextKey(c);
    const saved = this.memento.get<string>(key);
    if (saved && fs.existsSync(saved)) return saved;
    const candidates = new Set<string>([migrationsProject]);
    if (this.engine.runnableProjects) {
      const r = await this.engine.runnableProjects();
      if (r.kind === 'projects') for (const p of r.result.projects) if (p.runnable && p.kind !== 'test') candidates.add(vscode.Uri.parse(p.projectUri).fsPath);
    }
    let chosen: string | undefined;
    if (candidates.size === 1) chosen = migrationsProject;
    else {
      const pick = await vscode.window.showQuickPick(
        [...candidates].map((p) => ({ label: path.basename(p, '.csproj'), description: vscode.workspace.asRelativePath(p), p })),
        { title: `Startup project for ${c.name}`, placeHolder: 'dotnet ef builds and runs this project to create the DbContext (remembered)' },
      );
      chosen = pick?.p;
    }
    if (chosen) await this.memento.update(key, chosen);
    return chosen;
  }

  private async target(c: EfContextInfo, opts: EfTestOptions | undefined): Promise<EfTarget | undefined> {
    const startup = await this.startupProject(c, opts);
    if (!startup) return undefined;
    return { project: vscode.Uri.parse(c.migrationsProjectUri).fsPath, startupProject: startup, context: c.fullName };
  }

  private gate(): boolean {
    if (this.isTrusted()) return true;
    void vscode.window.showWarningMessage('Refyntra does not run dotnet ef in Restricted Mode: it builds and runs code from this workspace. Trust the workspace first.', 'Manage Workspace Trust').then((p) => p && vscode.commands.executeCommand('workbench.trust.manage'));
    return false;
  }

  private async confirm(cmd: EfCommand, display: string, what: string, opts: EfTestOptions | undefined): Promise<boolean> {
    if (!touchesDatabase(cmd)) return true;
    if (this.testMode && opts?.confirmed !== undefined) return opts.confirmed;
    const ok = await vscode.window.showWarningMessage(
      `${what}\n\nThis connects to the database configured for the startup project. Refyntra will run:\n${display}`,
      { modal: true },
      'Run',
    );
    return ok === 'Run';
  }

  /** Runs `dotnet ef …` as a visible task (no shell) and resolves with its exit code. */
  private async runTask(args: string[], cwd: string, label: string): Promise<number | undefined> {
    const display = displayCommand('dotnet', args);
    this.st.lastCommand = { args, display, cwd };
    const folder = this.folderOf(cwd);
    const execution = new vscode.ProcessExecution('dotnet', args, { cwd, env: { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    const task = new vscode.Task({ type: EF_TASK_TYPE, label }, folder ?? vscode.TaskScope.Workspace, display, 'Refyntra EF Core', execution, []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, echo: true };
    const exec = await vscode.tasks.executeTask(task);
    const code = await new Promise<number | undefined>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution !== exec) return;
        sub.dispose();
        resolve(e.exitCode);
      });
    });
    this.st.lastExitCode = code;
    if (code !== 0) void vscode.window.showErrorMessage(`Refyntra: ${label} failed (exit code ${code ?? 'unknown'}). The terminal shows the output of dotnet ef.`);
    return code;
  }

  private prepare(c: EfContextInfo): string | undefined {
    if (!this.gate()) return undefined;
    return path.dirname(vscode.Uri.parse(c.migrationsProjectUri).fsPath);
  }

  async addMigration(node?: unknown, opts?: EfTestOptions): Promise<number | undefined> {
    const c = await this.pickContext(node, 'Add Migration');
    if (!c) return undefined;
    const cwd = this.prepare(c);
    if (!cwd || !(await this.requireTool(cwd))) return undefined;
    const name = this.testMode && opts?.name !== undefined ? opts.name : await vscode.window.showInputBox({ title: `Add Migration (${c.name})`, prompt: 'Name of the new migration', placeHolder: 'AddCustomerEmail', validateInput: (v) => migrationNameProblem(v) });
    if (!name || migrationNameProblem(name)) return undefined;
    const t = await this.target(c, opts);
    if (!t) return undefined;
    const code = await this.runTask(efArgs({ kind: 'add', name }, t), cwd, `Add Migration ${name}`);
    if (code === 0) await this.refreshAfterFiles();
    return code;
  }

  async removeLastMigration(node?: unknown, opts?: EfTestOptions): Promise<number | undefined> {
    const c = await this.pickContext(node, 'Remove Last Migration');
    if (!c) return undefined;
    const cwd = this.prepare(c);
    if (!cwd || !(await this.requireTool(cwd))) return undefined;
    const last = c.migrations.at(-1);
    if (!last) {
      void vscode.window.showInformationMessage(`Refyntra: ${c.name} has no migrations to remove.`);
      return undefined;
    }
    const t = await this.target(c, opts);
    if (!t) return undefined;
    const cmd: EfCommand = { kind: 'remove' };
    const args = efArgs(cmd, t);
    if (!(await this.confirm(cmd, displayCommand('dotnet', args), `Remove the last migration "${last.name}" of ${c.name}? dotnet ef refuses when it is already applied to the database.`, opts))) return undefined;
    const code = await this.runTask(args, cwd, `Remove Migration ${last.name}`);
    if (code === 0) await this.refreshAfterFiles();
    return code;
  }

  async updateDatabase(node?: unknown, opts?: EfTestOptions): Promise<number | undefined> {
    const n = node as EfNode | undefined;
    const c = await this.pickContext(node, 'Update Database');
    if (!c) return undefined;
    const cwd = this.prepare(c);
    if (!cwd || !(await this.requireTool(cwd))) return undefined;
    let migration = n?.kind === 'migration' ? n.migrationId : opts?.migration;
    if (!migration && !(this.testMode && opts)) {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Latest migration', id: '' }, ...[...c.migrations].reverse().map((m) => ({ label: m.name, description: m.id, id: m.id })), { label: '0', description: 'Revert every migration', id: '0' }],
        { title: `Update Database (${c.name})`, placeHolder: 'Target migration' },
      );
      if (!pick) return undefined;
      migration = pick.id || undefined;
    }
    const t = await this.target(c, opts);
    if (!t) return undefined;
    const cmd: EfCommand = migration ? { kind: 'update', migration } : { kind: 'update' };
    const args = efArgs(cmd, t);
    if (!(await this.confirm(cmd, displayCommand('dotnet', args), `Update the database of ${c.name} to ${migration ?? 'the latest migration'}?`, opts))) return undefined;
    const code = await this.runTask(args, cwd, `Update Database ${c.name}`);
    if (code === 0 && this.status.has(efContextKey(c))) this.status.delete(efContextKey(c));
    this.render();
    return code;
  }

  async generateScript(node?: unknown, opts?: EfTestOptions): Promise<number | undefined> {
    const n = node as EfNode | undefined;
    const c = await this.pickContext(node, 'Generate SQL Script');
    if (!c) return undefined;
    const cwd = this.prepare(c);
    if (!cwd || !(await this.requireTool(cwd))) return undefined;
    let idempotent = opts?.idempotent;
    if (idempotent === undefined && !(this.testMode && opts)) {
      const pick = await vscode.window.showQuickPick([
        { label: 'Idempotent', description: 'checks the migrations history table; safe to run on any database version', v: true },
        { label: 'Plain', description: 'from the first to the last migration', v: false },
      ], { title: `Generate SQL Script (${c.name})` });
      if (!pick) return undefined;
      idempotent = pick.v;
    }
    const t = await this.target(c, opts);
    if (!t) return undefined;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-ef-'));
    const output = path.join(dir, 'script.sql');
    const from = n?.kind === 'migration' ? previousId(c, n.migrationId!) : undefined;
    const to = n?.kind === 'migration' ? n.migrationId : undefined;
    try {
      const code = await this.runTask(efArgs({ kind: 'script', idempotent: !!idempotent, output, ...(from ? { from } : {}), ...(to ? { to } : {}) }, t), cwd, `Generate SQL Script ${c.name}`);
      if (code === 0 && fs.existsSync(output)) {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: fs.readFileSync(output, 'utf8') });
        await vscode.window.showTextDocument(doc, { preview: false });
      }
      return code;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Applied/pending, only on this explicit action: dotnet ef migrations list --json (connects to the database). */
  async checkStatus(node?: unknown, opts?: EfTestOptions): Promise<EfContextStatus | undefined> {
    const c = await this.pickContext(node, 'Check Migration Status');
    if (!c) return undefined;
    const cwd = this.prepare(c);
    if (!cwd || !(await this.requireTool(cwd))) return undefined;
    const t = await this.target(c, opts);
    if (!t) return undefined;
    const cmd: EfCommand = { kind: 'list' };
    const args = efArgs(cmd, t);
    const display = displayCommand('dotnet', args);
    if (!(await this.confirm(cmd, display, `Check which migrations of ${c.name} are applied?`, opts))) return undefined;
    this.st.lastCommand = { args, display, cwd };
    this.output.appendLine(`> ${display}`);
    this.output.show(true);
    const out = await vscode.window.withProgress({ location: { viewId: EF_VIEW }, title: 'Checking migrations' }, () =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile('dotnet', args, { cwd, timeout: 600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
        ),
      ),
    );
    this.output.append(out.stdout);
    if (out.stderr) this.output.append(out.stderr);
    this.st.lastExitCode = out.code;
    const parsed = out.code === 0 ? parseMigrationsList(out.stdout) : undefined;
    if (!parsed) {
      void vscode.window.showErrorMessage(`Refyntra: dotnet ef migrations list failed (exit code ${out.code}). See the "Refyntra EF Core" output.`);
      return undefined;
    }
    const st = statusFromList(parsed, new Date().toLocaleTimeString());
    this.status.set(efContextKey(c), st);
    this.render();
    if (!st.connected) void vscode.window.showWarningMessage(`Refyntra: the database of ${c.name} could not be reached, so applied/pending is unknown. See the "Refyntra EF Core" output.`);
    return st;
  }

  /** After dotnet ef wrote or deleted files the host reloads the projects (new files on disk), then the view refreshes. */
  private async refreshAfterFiles(): Promise<void> {
    this.csharpReady = false;
    await this.engine.inputsChanged('EF Core migration files changed');
    await this.refresh();
  }

  async open(node?: unknown): Promise<void> {
    const n = node as EfNode | undefined;
    if (n?.location) await openLocation(n.location as Location);
  }

  async openSnapshot(node?: unknown): Promise<void> {
    const c = await this.pickContext(node, 'Open Model Snapshot');
    if (c?.snapshot?.location) await openLocation(c.snapshot.location);
    else if (c) void vscode.window.showInformationMessage(`Refyntra: ${c.name} has no model snapshot yet.`);
  }

  async openConfiguration(node?: unknown): Promise<void> {
    const c = await this.pickContext(node, 'Open Model Configuration');
    if (!c) return;
    const items = [
      ...(c.onModelCreating ? [{ label: `${c.name}.OnModelCreating`, loc: c.onModelCreating }] : c.location ? [{ label: c.name, loc: c.location }] : []),
      ...c.configurations.filter((x) => x.location).map((x) => ({ label: x.name, description: 'IEntityTypeConfiguration', loc: x.location! })),
    ];
    if (items.length === 0) return;
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: `Configuration of ${c.name}` });
    if (pick) await openLocation(pick.loc);
  }

  // ---------------------------------------------------------------------------------------------- LINQ → SQL

  /** Evaluates ToQueryString() of the selected IQueryable in the stopped refyntra-dotnet session's active frame. */
  async showSql(): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    const session = vscode.debug.activeDebugSession;
    const item = vscode.debug.activeStackItem;
    const frameId = item instanceof vscode.DebugStackFrame ? item.frameId : undefined;
    const selection = editor ? editor.document.getText(editor.selection) : '';
    const done = (message: string) => {
      this.st.lastSqlMessage = message;
      return undefined;
    };
    if (!session || session.type !== DOTNET_DEBUG_TYPE || frameId === undefined) {
      const line = editor?.selection.active.line;
      const msg = 'Show SQL for LINQ evaluates the query in a stopped .NET debug session (Refyntra Run and Debug). Start debugging, stop at a breakpoint where the query exists, select it and run the command again.';
      done(msg);
      if (editor && line !== undefined && editor.document.languageId === 'csharp') {
        void vscode.window.showInformationMessage(msg, `Add Breakpoint at Line ${line + 1}`).then((p) => {
          if (p) vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(editor.document.uri, new vscode.Position(line, 0)))]);
        });
      } else void vscode.window.showInformationMessage(msg);
      return undefined;
    }
    const problem = selectionProblem(selection);
    if (problem) {
      void vscode.window.showWarningMessage(`Refyntra: ${problem}`);
      return done(problem);
    }
    let lastError = '';
    for (const expression of toQueryStringExpressions(selection)) {
      try {
        const r = (await session.customRequest('evaluate', { expression, frameId, context: 'repl' })) as { result?: string };
        const sql = parseDebuggerString(r?.result);
        if (sql !== undefined) {
          this.st.lastSql = sql;
          const uri = this.sql.add('query', `-- ${selection.trim().replace(/\s+/g, ' ')}\n-- ToQueryString() in ${session.name}; parameters are shown as DECLAREs or comments by the provider.\n\n${sql}\n`);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.languages.setTextDocumentLanguage(doc, 'sql');
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          done('ok');
          return sql;
        }
        lastError = r?.result ?? 'no result';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    const msg = `The debugger could not evaluate ToQueryString() for the selection (${lastError}). Select an IQueryable variable or expression that exists in the current frame; lambdas are often not evaluable by the debugger, so select a variable that holds the query.`;
    void vscode.window.showWarningMessage(`Refyntra: ${msg}`);
    return done(msg);
  }
}

function previousId(c: EfContextInfo, id: string): string | undefined {
  const i = c.migrations.findIndex((m) => m.id === id);
  return i > 0 ? c.migrations[i - 1]!.id : i === 0 ? '0' : undefined;
}

export function registerEfCore(context: vscode.ExtensionContext, engine: EngineClient, isTrusted: () => boolean): { service: EfCoreService; disposable: vscode.Disposable } {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const service = new EfCoreService(engine, context.workspaceState, isTrusted, testMode);
  const view = vscode.window.createTreeView(EF_VIEW, { treeDataProvider: service, showCollapseAll: true });
  const t = (o: unknown) => (testMode && o && typeof o === 'object' ? (o as EfTestOptions) : undefined);
  void vscode.commands.executeCommand('setContext', 'refyntra.efCore.available', false);
  const disposable = vscode.Disposable.from(
    service,
    view,
    vscode.workspace.registerTextDocumentContentProvider(SQL_SCHEME, service.sql),
    vscode.commands.registerCommand('refyntra.ef.refresh', () => service.refresh()),
    vscode.commands.registerCommand('refyntra.ef.open', (n?: unknown) => service.open(n)),
    vscode.commands.registerCommand('refyntra.ef.openSnapshot', (n?: unknown) => service.openSnapshot(n)),
    vscode.commands.registerCommand('refyntra.ef.openConfiguration', (n?: unknown) => service.openConfiguration(n)),
    vscode.commands.registerCommand('refyntra.ef.checkStatus', (n?: unknown, o?: unknown) => service.checkStatus(n, t(o))),
    vscode.commands.registerCommand('refyntra.ef.addMigration', (n?: unknown, o?: unknown) => service.addMigration(n, t(o))),
    vscode.commands.registerCommand('refyntra.ef.removeLastMigration', (n?: unknown, o?: unknown) => service.removeLastMigration(n, t(o))),
    vscode.commands.registerCommand('refyntra.ef.updateDatabase', (n?: unknown, o?: unknown) => service.updateDatabase(n, t(o))),
    vscode.commands.registerCommand('refyntra.ef.generateScript', (n?: unknown, o?: unknown) => service.generateScript(n, t(o))),
    vscode.commands.registerCommand('refyntra.ef.showSql', () => service.showSql()),
  );
  return { service, disposable };
}
