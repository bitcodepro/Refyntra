import * as vscode from 'vscode';
import type { WorkspaceTarget, WorkspaceTargetProvider } from '@refyntra/application';

const STATE_KEY = 'refyntra.selectedSolution';
const EXCLUDE = '**/{node_modules,bin,obj,.git,.vs,.vscode-test}/**';

/**
 * Solution discovery by safe file listing only (no MSBuild evaluation): .sln/.slnx first, otherwise .csproj.
 * Several candidates → the user picks one (remembered in workspaceState).
 */
export class SolutionService implements WorkspaceTargetProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private prompted = false;

  constructor(private readonly state: vscode.Memento) {}

  async candidates(): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const solutions = await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE, 200);
    const found = solutions.length > 0 ? solutions : await vscode.workspace.findFiles('**/*.csproj', EXCLUDE, 200);
    return found.filter((u) => u.scheme === 'file').sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  selected(): string | undefined {
    return this.state.get<string>(STATE_KEY);
  }

  async resolveTarget(): Promise<WorkspaceTarget> {
    const list = await this.candidates();
    if (list.length === 0) return { kind: 'none', reasonCode: 'NoSolutionFound', message: 'No .sln, .slnx or .csproj file was found in this workspace.' };
    const remembered = this.selected();
    const hit = remembered ? list.find((u) => u.fsPath === remembered) : undefined;
    if (hit) return { kind: 'path', path: hit.fsPath };
    if (list.length === 1) return { kind: 'path', path: list[0]!.fsPath };
    if (!this.prompted) {
      this.prompted = true;
      void vscode.window.showInformationMessage(`Refyntra found ${list.length} solutions/projects. Select the one to load.`, 'Select Solution').then((pick) => {
        if (pick) void vscode.commands.executeCommand('refyntra.selectSolution');
      });
    }
    return { kind: 'none', reasonCode: 'SolutionNotSelected', message: `${list.length} solutions/projects found; select one with "Refyntra: Select Solution".` };
  }

  /** QuickPick of candidates; returns true when the selection changed. */
  async pick(): Promise<boolean> {
    const list = await this.candidates();
    if (list.length === 0) {
      void vscode.window.showWarningMessage('Refyntra: no .sln, .slnx or .csproj file found in this workspace.');
      return false;
    }
    const current = this.selected();
    const choice = await vscode.window.showQuickPick(
      list.map((u) => ({ label: vscode.workspace.asRelativePath(u, false), description: u.fsPath === current ? 'current' : undefined, uri: u })),
      { placeHolder: 'Select the solution or project Refyntra should load', ignoreFocusOut: true },
    );
    if (!choice || choice.uri.fsPath === current) return false;
    await this.state.update(STATE_KEY, choice.uri.fsPath);
    this.changed.fire();
    return true;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
