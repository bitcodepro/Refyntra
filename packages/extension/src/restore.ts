import * as path from 'node:path';
import * as vscode from 'vscode';

export const RESTORE_TASK_TYPE = 'refyntra-restore';

/**
 * `refyntra.runRestore [path]`: runs `dotnet restore <path>` as a task shown in the terminal panel. Only after a user
 * click (the command is offered as a recovery action, never run automatically), only in a trusted workspace and only
 * for a .sln/.slnx/.csproj inside an open workspace folder. Backend-supplied arguments are untrusted:
 * the path is passed to `dotnet` as one process argument (ProcessExecution, no shell), so `$(...)`, backticks, `%VAR%`
 * or quotes in a file name are never interpreted.
 *
 * The Health page's "Restore packages" button uses the same function (quiet: it restarts the backend itself).
 */
export async function runRestore(isTrusted: () => boolean, target: unknown, opts: { quiet?: boolean } = {}): Promise<vscode.TaskExecution | undefined> {
  if (!isTrusted()) {
    void vscode.window.showWarningMessage('Refyntra does not run dotnet restore in Restricted Mode. Trust the workspace first.');
    return undefined;
  }
  const file = typeof target === 'string' ? target : '';
  if (!/\.(sln|slnx|csproj)$/i.test(file) || !path.isAbsolute(file)) {
    void vscode.window.showWarningMessage('Refyntra: restore needs a .sln, .slnx or .csproj path.');
    return undefined;
  }
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => {
    const rel = path.relative(f.uri.fsPath, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!folder) {
    void vscode.window.showWarningMessage('Refyntra: the restore target is outside the open workspace folders.');
    return undefined;
  }
  const execution = new vscode.ProcessExecution('dotnet', ['restore', file], { cwd: path.dirname(file) });
  const task = new vscode.Task({ type: RESTORE_TASK_TYPE, target: file }, folder, `dotnet restore ${path.basename(file)}`, 'Refyntra', execution, []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, echo: true };
  const running = await vscode.tasks.executeTask(task);
  // The Health page restarts the backend by itself when its restore succeeds (opts.quiet).
  if (!opts.quiet)
    void vscode.window.showInformationMessage('Refyntra: after the restore finishes, run "Refyntra: Restart Backend" to reload the projects.', 'Restart Backend').then((pick) => {
    if (pick) void vscode.commands.executeCommand('refyntra.restartBackend');
  });
  return running;
}
