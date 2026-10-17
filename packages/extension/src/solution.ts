import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkspaceTarget, WorkspaceTargetProvider } from '@refyntra/application';

const STATE_KEY = 'refyntra.selectedSolution';
/** The remembered choice "All projects in folder" (instead of one solution's path). */
export const ALL_PROJECTS = '*all-projects*';
const ALL_PROJECTS_FILE = 'all-projects.refyntra-projects';
const EXCLUDE = '**/{node_modules,bin,obj,.git,.vs,.vscode-test}/**';

/**
 * Solution discovery by safe file listing only (no MSBuild evaluation): .sln/.slnx first, otherwise .csproj.
 * Several candidates → all projects of the folder are loaded together (a project list in the extension's storage, not
 * in the workspace), unless the user picked one solution (remembered in workspaceState).
 */
export class SolutionService implements WorkspaceTargetProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly state: vscode.Memento,
    /** The extension's storage folder for this workspace (the project list goes there). */
    private readonly storageDir?: string,
  ) {}

  /** Every project file of the folder, sorted (the "All projects" workspace). */
  async allProjects(): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const found = await vscode.workspace.findFiles('**/*.csproj', EXCLUDE, 2000);
    return found.filter((u) => u.scheme === 'file').sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /** Writes the project list the host loads; undefined without a storage folder or projects. */
  private async writeProjectList(): Promise<string | undefined> {
    if (!this.storageDir) return undefined;
    const projects = await this.allProjects();
    if (projects.length === 0) return undefined;
    const file = path.join(this.storageDir, ALL_PROJECTS_FILE);
    fs.mkdirSync(this.storageDir, { recursive: true });
    const text = projects.map((u) => u.fsPath).join('\n') + '\n';
    // Unchanged list: the file keeps its time stamp (no reload for nothing).
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    return file;
  }

  async candidates(): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const solutions = await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE, 200);
    const found = solutions.length > 0 ? solutions : await vscode.workspace.findFiles('**/*.csproj', EXCLUDE, 200);
    return found.filter((u) => u.scheme === 'file').sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  selected(): string | undefined {
    return this.state.get<string>(STATE_KEY);
  }

  /** The selection for Health: a solution path, or "All projects in folder". */
  describeSelected(): string | undefined {
    const s = this.selected();
    return s === ALL_PROJECTS ? 'All projects in folder' : s;
  }

  async resolveTarget(): Promise<WorkspaceTarget> {
    const list = await this.candidates();
    if (list.length === 0) return { kind: 'none', reasonCode: 'NoSolutionFound', message: 'No .sln, .slnx or .csproj file was found in this workspace.' };
    const remembered = this.selected();
    const hit = remembered ? list.find((u) => u.fsPath === remembered) : undefined;
    if (hit) return { kind: 'path', path: hit.fsPath };
    if (list.length === 1 && remembered !== ALL_PROJECTS) return { kind: 'path', path: list[0]!.fsPath };
    // Several solutions (or the user chose it): every project of the folder in one workspace, nothing to pick.
    const all = await this.writeProjectList();
    if (all) return { kind: 'path', path: all };
    return { kind: 'none', reasonCode: 'SolutionNotSelected', message: `${list.length} solutions/projects found; select one with "Refyntra: Select Solution".` };
  }

  /** QuickPick of candidates; returns true when the selection changed. */
  async pick(): Promise<boolean> {
    const list = await this.candidates();
    if (list.length === 0) {
      void vscode.window.showWarningMessage('Refyntra: no .sln, .slnx or .csproj file found in this workspace.');
      return false;
    }
    const current = this.selected() ?? (list.length > 1 ? ALL_PROJECTS : undefined);
    const projects = (await this.allProjects()).length;
    const items: { label: string; description?: string; detail?: string; key: string }[] = [];
    if (this.storageDir && projects > 0)
      items.push({ label: '$(folder-library) All projects in folder', description: current === ALL_PROJECTS ? 'current' : undefined, detail: `${projects} projects, every solution together`, key: ALL_PROJECTS });
    for (const u of list) items.push({ label: vscode.workspace.asRelativePath(u, false), description: u.fsPath === current ? 'current' : undefined, key: u.fsPath });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Select what Refyntra loads for C# navigation and refactoring', ignoreFocusOut: true });
    if (!choice || choice.key === current) return false;
    await this.state.update(STATE_KEY, choice.key);
    this.changed.fire();
    return true;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
