import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RefyntraEngine } from '@refyntra/application';
import type { ProjectStructure, SolutionStructureResult } from '@refyntra/contracts';
import { runCapture, runVisible } from './dotnetCli';
import { NuGetPanel, type NuGetPanels, registerNuGet } from './nugetPanel';
import { type ProjectFileCompletion, registerProjectFileEditing } from './projectFile';
import { addReference, newList, newProject, parseTemplateList, planRenameProject, removeReference, slnAdd, slnRemove, type TemplateInfo } from './projectOpsModel';
import type { RunService } from './run';
import { type SolutionNode, buildSolutionTree, indexTree, outline, pathToFile } from './solutionExplorerModel';
import type { TestingService } from './testing';
import type { VsCodeEditApplier } from './editApplier';

export const SOLUTION_VIEW = 'refyntra.solutionView';
const UNLOADED_KEY = 'refyntra.solution.unloaded';
const DECORATION_QUERY = 'refyntra-sol';
const PROJECT_FILE = /\.(csproj|props|targets|sln|slnx)$/i;
const IN_OUTPUT = /[\\/](bin|obj)[\\/]/i;

/** Test hooks: QuickPick / InputBox / confirmation answers instead of UI (e2e and visual tests never type into dialogs). */
export interface SolutionTestHooks {
  pick?: (items: readonly vscode.QuickPickItem[], title: string) => Promise<vscode.QuickPickItem | undefined>;
  input?: (prompt: string, value: string) => Promise<string | undefined>;
  confirm?: (message: string) => Promise<boolean>;
  /** Rename Project: apply the edit without VS Code's refactor preview. */
  applyWithoutPreview?: boolean;
}

interface Snapshot {
  title: string;
  files: { path: string; before: string; after?: string }[];
}

const fsPath = (uri: string) => vscode.Uri.parse(uri, true).fsPath;
const slash = (p: string) => p.replace(/\\/g, '/');

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** A file's text as a TextDocument has it: an open document's text, else the disk text without a UTF-8 BOM. */
function docText(p: string): string {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === p.toLowerCase());
  return open ? open.getText() : (readText(p) ?? '').replace(/^﻿/, '');
}

/** Linked and excluded items get a badge and a muted colour (FileDecorationProvider on a marked resource URI). */
class SolutionDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.query.startsWith(`${DECORATION_QUERY}=`)) return undefined;
    const kind = uri.query.slice(DECORATION_QUERY.length + 1);
    if (kind === 'linked') return new vscode.FileDecoration('↗', 'Linked file (outside the project folder)');
    if (kind === 'excluded') return new vscode.FileDecoration('⊘', 'Excluded from the project', new vscode.ThemeColor('disabledForeground'));
    if (kind === 'unloaded') return new vscode.FileDecoration(undefined, 'Unloaded in Refyntra', new vscode.ThemeColor('disabledForeground'));
    return undefined;
  }
}

export class SolutionExplorer implements vscode.TreeDataProvider<SolutionNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SolutionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: SolutionStructureResult | undefined;
  private roots: SolutionNode[] = [];
  private index = indexTree([]);
  private message: string | undefined;
  private view: vscode.TreeView<SolutionNode> | undefined;
  private loading: Promise<void> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastUndo: Snapshot | undefined;
  private refreshCount = 0;
  hooks: SolutionTestHooks = {};

  constructor(
    private readonly engine: RefyntraEngine,
    private readonly state: vscode.Memento,
    private readonly isTrusted: () => boolean,
    private readonly run: RunService,
    private readonly testing: TestingService,
    private readonly editApplier: VsCodeEditApplier,
  ) {}

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.changed.dispose();
  }

  attach(view: vscode.TreeView<SolutionNode>): void {
    this.view = view;
  }

  // ---------------------------------------------------------------- model

  structure(): SolutionStructureResult | undefined {
    return this.result;
  }

  project(uri: string | undefined): ProjectStructure | undefined {
    return uri ? this.result?.projects.find((p) => p.projectUri === uri) : undefined;
  }

  unloaded(): Set<string> {
    return new Set(this.state.get<string[]>(UNLOADED_KEY, []));
  }

  private options() {
    const cfg = vscode.workspace.getConfiguration('refyntra.solutionExplorer');
    const sel = this.run.selection().target;
    const startup = sel?.dotnet ? vscode.Uri.file(sel.dotnet.projectPath).toString() : undefined;
    return { excludedFiles: cfg.get<'hide' | 'grey'>('excludedFiles', 'hide'), unloaded: this.unloaded(), ...(startup ? { startupProjectUri: startup } : {}) };
  }

  private rebuild(): void {
    this.roots = this.result ? buildSolutionTree(this.result, this.options()) : [];
    this.index = indexTree(this.roots);
    this.changed.fire(undefined);
  }

  /** Asks the host for the solution model again (after loads, project operations and file changes). */
  refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        if (!this.isTrusted()) {
          this.result = undefined;
          this.message = 'Trust the workspace to see the solution (loading runs MSBuild evaluation).';
          return;
        }
        const o = await this.engine.solutionStructure();
        if (o.kind === 'structure') {
          this.result = o.result;
          this.message = o.result.projects.length ? undefined : 'No projects in the loaded solution.';
        } else {
          this.result = undefined;
          this.message = o.message;
        }
      } catch (e) {
        this.result = undefined;
        this.message = `The solution could not be read: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        this.refreshCount++;
        this.loading = undefined;
        this.rebuild();
      }
    })();
    return this.loading;
  }

  /** Reloads the workspace in the host (project files changed), then the tree. */
  async reloadAndRefresh(reason: string): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    await this.engine.reloadWorkspace(reason);
    await this.refresh();
  }

  /** Debounced reload (file watcher, saves). */
  scheduleReload(reason: string, delayMs = 800): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reloadAndRefresh(reason);
    }, delayMs);
  }

  visible(): boolean {
    return !!this.view?.visible;
  }

  // ---------------------------------------------------------------- tree

  getChildren(n?: SolutionNode): SolutionNode[] {
    if (n) return n.children;
    if (!this.roots.length && this.message) return [{ id: 'message', kind: 'message', label: this.message, icon: 'info', context: 'refyntra.sol.message', children: [] }];
    return this.roots;
  }

  getParent(n: SolutionNode): SolutionNode | undefined {
    return this.index.parent.get(n.id);
  }

  getTreeItem(n: SolutionNode): vscode.TreeItem {
    const expanded = n.kind === 'solution' || n.kind === 'folder';
    const item = new vscode.TreeItem(n.label, n.children.length ? (expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    if (n.description) item.description = n.description;
    if (n.tooltip) item.tooltip = n.tooltip;
    item.contextValue = n.context;
    const muted = n.excluded || n.context.includes('.unloaded') || n.description?.includes('(not loaded)') || n.description?.includes('(load failed)');
    if ((n.kind === 'file' || n.kind === 'solutionItem') && n.uri) {
      const mark = n.linked ? 'linked' : n.excluded ? 'excluded' : undefined;
      item.resourceUri = vscode.Uri.parse(n.uri, true).with(mark ? { query: `${DECORATION_QUERY}=${mark}` } : {});
      if (n.linked || n.excluded) item.iconPath = new vscode.ThemeIcon(n.icon, n.excluded ? new vscode.ThemeColor('disabledForeground') : undefined);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(n.uri, true)] };
    } else {
      item.iconPath = new vscode.ThemeIcon(n.icon, muted ? new vscode.ThemeColor('disabledForeground') : undefined);
    }
    item.accessibilityInformation = { label: [n.label, n.description, n.linked ? 'linked file' : '', n.excluded ? 'excluded from the project' : ''].filter(Boolean).join(', ') };
    return item;
  }

  /** Text outline (e2e and visual checks). */
  outline(maxDepth = 8): string[] {
    return outline(this.getChildren(), 0, maxDepth);
  }

  node(id: string): SolutionNode | undefined {
    return this.index.byId.get(id);
  }

  refreshes(): number {
    return this.refreshCount;
  }

  /** Selects the node of a file (Reveal Active File / sync with the editor). */
  async revealFile(uri: vscode.Uri, focus = false): Promise<SolutionNode | undefined> {
    const chain = pathToFile(this.roots, uri.toString());
    const target = chain?.[chain.length - 1];
    if (!target || !this.view) return target;
    await this.view.reveal(target, { select: true, focus, expand: false });
    return target;
  }

  /** Expands a node by id (visual tests show a deterministic tree). */
  async expand(id: string, levels = 1): Promise<boolean> {
    const n = this.index.byId.get(id);
    if (!n || !this.view) return false;
    await this.view.reveal(n, { select: false, focus: false, expand: levels });
    return true;
  }

  // ---------------------------------------------------------------- UI helpers

  private async pick<T extends vscode.QuickPickItem>(items: T[], title: string): Promise<T | undefined> {
    if (this.hooks.pick) return (await this.hooks.pick(items, title)) as T | undefined;
    return vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
  }

  private async input(prompt: string, value: string, validate?: (v: string) => string | undefined): Promise<string | undefined> {
    if (this.hooks.input) return this.hooks.input(prompt, value);
    return vscode.window.showInputBox({ prompt, value, validateInput: validate });
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    if (this.hooks.confirm) return this.hooks.confirm(message);
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  private requireTrust(what: string): boolean {
    if (this.isTrusted()) return true;
    void vscode.window.showWarningMessage(`Refyntra does not ${what} in Restricted Mode. Trust the workspace first.`, 'Manage Workspace Trust').then((p) => p && vscode.commands.executeCommand('workbench.trust.manage'));
    return false;
  }

  private solutionPath(): string | undefined {
    return this.result?.solutionUri ? fsPath(this.result.solutionUri) : undefined;
  }

  private projectOf(arg: unknown): ProjectStructure | undefined {
    const n = arg as SolutionNode | undefined;
    if (n && typeof n === 'object' && typeof n.projectUri === 'string') return this.project(n.projectUri);
    if (typeof arg === 'string') return this.result?.projects.find((p) => p.projectUri === arg || fsPath(p.projectUri) === arg || p.name === arg);
    if (arg instanceof vscode.Uri) return this.result?.projects.find((p) => p.projectUri === arg.toString());
    return undefined;
  }

  private async chooseProject(arg: unknown, title: string, filter: (p: ProjectStructure) => boolean = () => true): Promise<ProjectStructure | undefined> {
    const direct = this.projectOf(arg);
    if (direct) return direct;
    if (!this.result) await this.refresh();
    const list = (this.result?.projects ?? []).filter(filter);
    if (list.length === 1) return list[0];
    const p = await this.pick(list.map((x) => ({ label: x.name, description: x.targetFrameworks.join('; '), detail: fsPath(x.projectUri), project: x })), title);
    return (p as { project?: ProjectStructure } | undefined)?.project;
  }

  /** Runs a file-changing CLI command with an undo snapshot of `files`, reloads, refreshes and offers Undo. */
  async mutate(title: string, files: string[], command: Parameters<typeof runVisible>[0]): Promise<boolean> {
    const snapshot: Snapshot = { title, files: files.map((p) => ({ path: p, before: readText(p) ?? '' })) };
    const code = await runVisible(command);
    if (code !== 0) {
      void vscode.window.showErrorMessage(`Refyntra: ${command.title} failed${code === undefined ? '' : ` (exit code ${code})`}. See the terminal for details.`);
      return false;
    }
    for (const f of snapshot.files) f.after = readText(f.path);
    const changed = snapshot.files.some((f) => f.after !== f.before);
    if (changed) this.lastUndo = snapshot;
    await this.reloadAndRefresh(title);
    if (changed)
      void vscode.window.showInformationMessage(`Refyntra: ${title}.`, 'Undo').then((pick) => {
        if (pick === 'Undo') void this.undo();
      });
    return true;
  }

  /** Direct file edits (Directory.Packages.props versions) with the same undo, reload and refresh as CLI operations. */
  async editFiles(title: string, edits: { path: string; text: string }[], before?: string, command?: Parameters<typeof runVisible>[0]): Promise<boolean> {
    const snapshot: Snapshot = { title, files: edits.map((e) => ({ path: e.path, before: before ?? readText(e.path) ?? '', after: e.text })) };
    // The prepared text may already be stale, or the editor may hold unsaved changes. Refuse both before writing.
    const blocked = snapshot.files.filter((f) => this.hasUnsavedEdits(f.path) || readText(f.path) !== f.before);
    if (blocked.length) {
      void vscode.window.showWarningMessage(`Refyntra: cannot ${title}: ${blocked.map((f) => path.basename(f.path)).join(', ')} changed or has unsaved edits. Save or review it and try again.`);
      return false;
    }
    for (const e of edits) fs.writeFileSync(e.path, e.text, 'utf8');
    this.lastUndo = snapshot;
    let failure: string | undefined;
    if (command) {
      try {
        const code = await runVisible(command);
        if (code !== 0) failure = `${command.title} ${code === undefined ? 'did not finish' : `failed (exit code ${code})`}. The file edit was kept; review it or use Undo.`;
      } catch (e) {
        failure = `${command.title} failed: ${e instanceof Error ? e.message : String(e)}. The file edit was kept; review it or use Undo.`;
      }
    }
    await this.reloadAndRefresh(title);
    const changed = snapshot.files.some((f) => this.hasUnsavedEdits(f.path) || readText(f.path) !== f.after);
    const notice = failure ? vscode.window.showErrorMessage(`Refyntra: ${failure}`, 'Undo')
      : changed ? vscode.window.showWarningMessage(`Refyntra: files changed while ${title} was running. Their changes were kept; review them and restore packages again.`, 'Undo')
      : vscode.window.showInformationMessage(`Refyntra: ${title}.`, 'Undo');
    void notice.then((pick) => {
      if (pick === 'Undo') void this.undo();
    });
    return !failure && !changed;
  }

  private hasUnsavedEdits(file: string): boolean {
    const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.scheme === 'file' && key(doc.uri.fsPath) === key(file));
  }

  /** Undoes the last project operation: restores the files it changed, when nobody changed them since. */
  async undo(): Promise<string[]> {
    const s = this.lastUndo;
    if (!s) {
      void vscode.window.showInformationMessage('Refyntra: nothing to undo.');
      return [];
    }
    const blocked = s.files.filter((f) => this.hasUnsavedEdits(f.path) || readText(f.path) !== f.after);
    if (blocked.length) {
      void vscode.window.showWarningMessage(`Refyntra: cannot undo "${s.title}": ${blocked.map((f) => path.basename(f.path)).join(', ')} changed since or has unsaved edits.`);
      return [];
    }
    for (const f of s.files) fs.writeFileSync(f.path, f.before, 'utf8');
    this.lastUndo = undefined;
    await this.reloadAndRefresh(`undo ${s.title}`);
    return s.files.map((f) => f.path);
  }

  // ---------------------------------------------------------------- context menu commands

  async open(n?: SolutionNode): Promise<void> {
    if (n?.uri) await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(n.uri, true));
  }

  async revealInExplorer(n?: SolutionNode): Promise<void> {
    if (n?.uri) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(n.uri, true));
  }

  async revealInOS(n?: SolutionNode): Promise<void> {
    if (n?.uri) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.parse(n.uri, true));
  }

  async copyPath(n?: SolutionNode): Promise<string | undefined> {
    if (!n?.uri) return undefined;
    const p = fsPath(n.uri);
    await vscode.env.clipboard.writeText(p);
    return p;
  }

  private runTargetId(p: ProjectStructure): string {
    return `dotnet:${fsPath(p.projectUri)}`;
  }

  async runProject(arg?: unknown, debug = false): Promise<unknown> {
    const p = await this.chooseProject(arg, debug ? 'Debug project' : 'Run project');
    if (!p) return undefined;
    await this.run.refresh();
    return debug ? this.run.debug(this.runTargetId(p)) : this.run.run(this.runTargetId(p));
  }

  async setStartup(arg?: unknown): Promise<boolean> {
    const p = await this.chooseProject(arg, 'Set as startup project');
    if (!p) return false;
    const targets = await this.run.refresh();
    const t = targets.find((x) => x.id === this.runTargetId(p));
    if (!t || !t.runnable) {
      void vscode.window.showWarningMessage(`Refyntra: ${p.name} cannot be started (${t?.note ?? p.kind}).`);
      return false;
    }
    await this.run.select(t);
    this.rebuild();
    return true;
  }

  async runTests(arg?: unknown, debug = false): Promise<boolean> {
    const p = await this.chooseProject(arg, 'Run tests of', (x) => x.kind === 'test');
    if (!p) return false;
    const id = `dotnet:proj:${p.projectUri}`;
    if (!this.testing.item(id)) await this.testing.refresh();
    if (!this.testing.item(id)) {
      void vscode.window.showWarningMessage(`Refyntra: no tests were discovered in ${p.name}.`);
      return false;
    }
    await this.testing.runIds([id], debug);
    return true;
  }

  async unload(arg?: unknown, unload = true): Promise<void> {
    const p = await this.chooseProject(arg, unload ? 'Unload project' : 'Reload project');
    if (!p) return;
    const set = this.unloaded();
    if (unload) set.add(p.projectUri);
    else set.delete(p.projectUri);
    await this.state.update(UNLOADED_KEY, [...set]);
    this.rebuild();
  }

  // ---------------------------------------------------------------- project operations

  async addProjectToSolution(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('change the solution')) return false;
    const sln = this.solutionPath();
    if (!sln) {
      void vscode.window.showWarningMessage('Refyntra: open a .sln or .slnx to add projects to it.');
      return false;
    }
    const inSolution = new Set((this.result?.projects ?? []).map((p) => fsPath(p.projectUri).toLowerCase()));
    const files = (await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj,.git}/**', 500)).filter((u) => !inSolution.has(u.fsPath.toLowerCase()));
    const items: (vscode.QuickPickItem & { file?: string })[] = files.map((u) => ({ label: path.basename(u.fsPath, '.csproj'), description: vscode.workspace.asRelativePath(u, false), file: u.fsPath }));
    items.push({ label: '$(folder-opened) Browse…', description: 'Choose a project file' });
    const pick = await this.pick(items, 'Add project to solution');
    if (!pick) return false;
    let file = pick.file;
    if (!file) {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'C# projects': ['csproj'] }, defaultUri: vscode.Uri.file(path.dirname(sln)) });
      file = chosen?.[0]?.fsPath;
    }
    if (!file) return false;
    return this.mutate(`added ${path.basename(file)} to ${path.basename(sln)}`, [sln], slnAdd(sln, file, this.folderPathOf(arg)));
  }

  /** The solution folder path ("src/Libraries") of a folder node, for `dotnet sln add --solution-folder`. */
  private folderPathOf(arg: unknown): string | undefined {
    const n = arg as SolutionNode | undefined;
    if (!n || typeof n !== 'object' || n.kind !== 'folder') return undefined;
    const names: string[] = [];
    for (let x: SolutionNode | undefined = n; x && x.kind === 'folder'; x = this.getParent(x)) names.unshift(x.label);
    return names.join('/');
  }

  async removeFromSolution(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('change the solution')) return false;
    const sln = this.solutionPath();
    const p = await this.chooseProject(arg, 'Remove project from solution');
    if (!sln || !p) return false;
    if (!(await this.confirm(`Remove ${p.name} from ${path.basename(sln)}? The project files stay on disk.`, 'Remove'))) return false;
    return this.mutate(`removed ${p.name} from ${path.basename(sln)}`, [sln], slnRemove(sln, fsPath(p.projectUri)));
  }

  async templates(cwd: string): Promise<TemplateInfo[]> {
    const r = await runCapture(newList(cwd));
    return parseTemplateList(r.stdout);
  }

  async newProject(arg?: unknown): Promise<string | undefined> {
    if (!this.requireTrust('create projects')) return undefined;
    const sln = this.solutionPath();
    const root = sln ? path.dirname(sln) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    const templates = await this.templates(root);
    if (!templates.length) {
      void vscode.window.showWarningMessage('Refyntra: dotnet new list returned no C# project templates.');
      return undefined;
    }
    const t = await this.pick(
      templates.map((x) => ({ label: x.name, description: x.shortNames.join(', '), detail: x.tags, template: x.shortNames[0]! })),
      'New project: template',
    );
    const template = (t as { template?: string } | undefined)?.template;
    if (!template) return undefined;
    const name = await this.input('Project name', '', (v) => (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v) ? undefined : 'Letters, digits, "_", "." and "-"; not starting with a digit.'));
    if (!name) return undefined;
    const out = await this.input('Folder for the project', path.join(root, name));
    if (!out) return undefined;
    if (fs.existsSync(out) && fs.readdirSync(out).length) {
      void vscode.window.showWarningMessage(`Refyntra: ${out} is not empty.`);
      return undefined;
    }
    const code = await runVisible(newProject(template, name, out));
    if (code !== 0) {
      void vscode.window.showErrorMessage(`Refyntra: dotnet new ${template} failed. See the terminal for details.`);
      return undefined;
    }
    const proj = fs.existsSync(out) ? fs.readdirSync(out).find((f) => /\.csproj$/i.test(f)) : undefined;
    if (sln && proj) await this.mutate(`added ${proj} to ${path.basename(sln)}`, [sln], slnAdd(sln, path.join(out, proj), this.folderPathOf(arg)));
    else await this.reloadAndRefresh('new project');
    return proj ? path.join(out, proj) : out;
  }

  async addProjectReference(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('change project references')) return false;
    const p = await this.chooseProject(arg, 'Add project reference to');
    if (!p) return false;
    const existing = new Set(p.projectReferences.map((r) => r.projectUri));
    const candidates = (this.result?.projects ?? []).filter((x) => x.projectUri !== p.projectUri && !existing.has(x.projectUri));
    if (!candidates.length) {
      void vscode.window.showInformationMessage(`Refyntra: ${p.name} already references every other project.`);
      return false;
    }
    const pick = await this.pick(candidates.map((x) => ({ label: x.name, description: x.targetFrameworks.join('; '), target: x })), `Add project reference to ${p.name}`);
    const target = (pick as { target?: ProjectStructure } | undefined)?.target;
    if (!target) return false;
    const proj = fsPath(p.projectUri);
    return this.mutate(`${p.name} references ${target.name}`, [proj], addReference(proj, fsPath(target.projectUri)));
  }

  async removeProjectReference(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('change project references')) return false;
    const n = arg as SolutionNode | undefined;
    let p = this.projectOf(arg);
    let refUri = n && typeof n === 'object' && n.kind === 'projectRef' ? n.uri : undefined;
    if (!p) p = await this.chooseProject(undefined, 'Remove project reference from', (x) => x.projectReferences.length > 0);
    if (!p) return false;
    if (!refUri) {
      const pick = await this.pick(p.projectReferences.map((r) => ({ label: r.name, uri: r.projectUri })), `Remove project reference from ${p.name}`);
      refUri = (pick as { uri?: string } | undefined)?.uri;
    }
    if (!refUri) return false;
    const proj = fsPath(p.projectUri);
    return this.mutate(`${p.name} no longer references ${path.basename(fsPath(refUri), '.csproj')}`, [proj], removeReference(proj, fsPath(refUri)));
  }

  async renameProject(arg?: unknown): Promise<boolean> {
    if (!this.requireTrust('rename projects')) return false;
    const p = await this.chooseProject(arg, 'Rename project');
    if (!p) return false;
    const projPath = fsPath(p.projectUri);
    const newName = await this.input(`New name for ${p.name}`, p.name);
    if (!newName || newName === p.name) return false;
    const sln = this.solutionPath();
    const dir = path.dirname(projPath);
    const siblings = fs.readdirSync(dir).filter((f) => /\.[a-z]+proj$/i.test(f) && f !== path.basename(projPath)).map((f) => slash(path.join(dir, f)));
    const others = (this.result?.projects ?? [])
      .filter((x) => x.projectUri !== p.projectUri)
      .map((x) => ({ path: slash(fsPath(x.projectUri)), text: docText(fsPath(x.projectUri)) }));
    const plan = planRenameProject({
      projectPath: slash(projPath),
      newName,
      projectText: docText(projPath),
      ...(sln ? { solution: { path: slash(sln), text: docText(sln) } } : {}),
      others,
      siblingsInFolder: siblings,
      exists: (x) => fs.existsSync(x),
    });
    if ('refused' in plan) {
      void vscode.window.showWarningMessage(`Refyntra cannot rename ${p.name}: ${plan.refused}`);
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    const meta = (label: string): vscode.WorkspaceEditEntryMetadata => ({ label, needsConfirmation: !this.hooks.applyWithoutPreview });
    if (plan.folderRename) edit.renameFile(vscode.Uri.file(plan.folderRename.from), vscode.Uri.file(plan.folderRename.to), undefined, meta('Rename the project folder'));
    edit.renameFile(vscode.Uri.file(plan.fileRename.from), vscode.Uri.file(plan.fileRename.to), undefined, meta('Rename the project file'));
    for (const e of plan.edits) {
      const lines = e.oldText.split('\n');
      const range = new vscode.Range(0, 0, lines.length - 1, lines[lines.length - 1]!.length);
      edit.replace(vscode.Uri.file(e.path), range, e.newText, meta(e.description));
    }
    const ok = await this.editApplier.applyCodeActionEdit(edit);
    if (!ok) return false;
    // The edited solution and project files are saved (MSBuild and dotnet read them from disk).
    for (const e of plan.edits) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && slash(d.uri.fsPath).toLowerCase() === e.path.toLowerCase());
      if (!doc) {
        void vscode.window.showWarningMessage(`Refyntra: ${path.basename(e.path)} was not updated (${e.description}).`);
        continue;
      }
      if (doc.isDirty && !(await doc.save())) void vscode.window.showWarningMessage(`Refyntra: ${path.basename(e.path)} could not be saved.`);
    }
    await this.reloadAndRefresh(`renamed ${p.name}`);
    if (plan.notes.length) void vscode.window.showInformationMessage(`Refyntra renamed ${p.name} to ${newName}. ${plan.notes.join('. ')}`);
    return true;
  }

  async editProjectFile(arg?: unknown): Promise<void> {
    let p = this.projectOf(arg);
    if (!p) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active) p = this.result?.projects.find((x) => active.toString().startsWith(x.projectUri.slice(0, x.projectUri.lastIndexOf('/') + 1)));
    }
    p ??= await this.chooseProject(undefined, 'Edit project file');
    if (p) await vscode.window.showTextDocument(vscode.Uri.parse(p.projectUri, true));
  }
}

export interface SolutionExplorerApi {
  explorer: SolutionExplorer;
  nuget: NuGetPanels;
  projectFile: ProjectFileCompletion;
}

export function registerSolutionExplorer(context: vscode.ExtensionContext, engine: RefyntraEngine, isTrusted: () => boolean, run: RunService, testing: TestingService, editApplier: VsCodeEditApplier): { api: SolutionExplorerApi; disposable: vscode.Disposable } {
  const explorer = new SolutionExplorer(engine, context.workspaceState, isTrusted, run, testing, editApplier);
  const view = vscode.window.createTreeView(SOLUTION_VIEW, { treeDataProvider: explorer, showCollapseAll: true });
  explorer.attach(view);
  const nuget = registerNuGet(context, explorer, isTrusted);
  // Versions for PackageReference completion: the same source handling as the NuGet panel (a panel that is never shown).
  const versionLoader = new NuGetPanel('versions', explorer, () => explorer.structure()?.projects ?? [], 'NuGet versions', () => undefined);
  const projectFile = registerProjectFileEditing(explorer, (id) => (isTrusted() ? versionLoader.loadVersions(id) : Promise.resolve([])));
  const subs: vscode.Disposable[] = [explorer, view, nuget.disposable, projectFile.disposable, vscode.window.registerFileDecorationProvider(new SolutionDecorations())];
  const cmd = (id: string, f: (arg?: unknown) => unknown) => subs.push(vscode.commands.registerCommand(id, f));
  cmd('refyntra.solution.show', async () => {
    await vscode.commands.executeCommand(`${SOLUTION_VIEW}.focus`);
    if (!explorer.structure()) await explorer.refresh();
  });
  cmd('refyntra.solution.refresh', () => explorer.reloadAndRefresh('refresh'));
  cmd('refyntra.solution.revealActive', async () => {
    await vscode.commands.executeCommand(`${SOLUTION_VIEW}.focus`);
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) await explorer.revealFile(uri, true);
  });
  cmd('refyntra.solution.open', (n) => explorer.open(n as SolutionNode));
  cmd('refyntra.solution.revealInExplorer', (n) => explorer.revealInExplorer(n as SolutionNode));
  cmd('refyntra.solution.revealInOS', (n) => explorer.revealInOS(n as SolutionNode));
  cmd('refyntra.solution.copyPath', (n) => explorer.copyPath(n as SolutionNode));
  cmd('refyntra.solution.run', (n) => explorer.runProject(n, false));
  cmd('refyntra.solution.debug', (n) => explorer.runProject(n, true));
  cmd('refyntra.solution.runTests', (n) => explorer.runTests(n, false));
  cmd('refyntra.solution.setStartup', (n) => explorer.setStartup(n));
  cmd('refyntra.solution.unloadProject', (n) => explorer.unload(n, true));
  cmd('refyntra.solution.reloadProject', (n) => explorer.unload(n, false));
  cmd('refyntra.solution.addProject', (n) => explorer.addProjectToSolution(n));
  cmd('refyntra.solution.removeProject', (n) => explorer.removeFromSolution(n));
  cmd('refyntra.solution.newProject', (n) => explorer.newProject(n));
  cmd('refyntra.solution.addReference', (n) => explorer.addProjectReference(n));
  cmd('refyntra.solution.removeReference', (n) => explorer.removeProjectReference(n));
  cmd('refyntra.solution.renameProject', (n) => explorer.renameProject(n));
  cmd('refyntra.solution.undo', () => explorer.undo());
  cmd('refyntra.editProjectFile', (n) => explorer.editProjectFile(n));

  // Refresh when the host finished (re)loading; reload the host when project files are saved (ADR-013).
  let lastHealth = '';
  subs.push(
    engine.onDidChangeHealth(() => {
      const csharp = engine.health().adapters.find((a) => a.adapterId === 'csharp');
      const key = `${csharp?.state ?? ''}|${csharp?.sessionEpoch ?? ''}`;
      if (key === lastHealth) return;
      lastHealth = key;
      if (csharp?.state === 'Ready' || csharp?.state === 'Partial') void explorer.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme !== 'file' || !PROJECT_FILE.test(d.uri.fsPath) || IN_OUTPUT.test(d.uri.fsPath) || !isTrusted()) return;
      explorer.scheduleReload(`saved ${path.basename(d.uri.fsPath)}`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refyntra.solutionExplorer')) void explorer.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed || !explorer.visible() || !vscode.workspace.getConfiguration('refyntra.solutionExplorer').get<boolean>('autoReveal', true)) return;
      void explorer.revealFile(ed.document.uri);
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible && !explorer.structure()) void explorer.refresh();
    }),
  );
  // Files created or deleted while the view is open: reload the host (new files join their project) and the tree.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{cs,csproj,props,targets,sln,slnx}', false, true, false);
  const onFile = (u: vscode.Uri) => {
    if (!explorer.visible() || IN_OUTPUT.test(u.fsPath) || !isTrusted()) return;
    explorer.scheduleReload(`file ${path.basename(u.fsPath)} changed`, 1500);
  };
  subs.push(watcher, watcher.onDidCreate(onFile), watcher.onDidDelete(onFile));
  return { api: { explorer, nuget: nuget.panels, projectFile: projectFile.provider }, disposable: vscode.Disposable.from(...subs) };
}
