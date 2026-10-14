import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { type CliCommand, commandLine } from './projectOpsModel';

export const PROJECT_TASK_TYPE = 'refyntra-dotnet';

/** What ran (tests read it): the command line, how it ran and its exit code. */
export interface CliRecord {
  title: string;
  command: string;
  args: string[];
  cwd: string;
  visible: boolean;
  exitCode: number | undefined;
}

const records: CliRecord[] = [];
export function cliRecords(): CliRecord[] {
  return records.map((r) => ({ ...r, args: [...r.args] }));
}

/**
 * Runs a dotnet CLI command that changes files (sln add, add reference, add package …) as a visible task in the terminal
 * panel: ProcessExecution (no shell: a path with spaces or quotes is one argument). Resolves with the exit code.
 */
export async function runVisible(c: CliCommand, folder?: vscode.WorkspaceFolder): Promise<number | undefined> {
  const record: CliRecord = { title: c.title, command: c.command, args: [...c.args], cwd: c.cwd, visible: true, exitCode: undefined };
  records.push(record);
  const scope = folder ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c.cwd)) ?? vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Workspace;
  const task = new vscode.Task({ type: PROJECT_TASK_TYPE, command: commandLine(c) }, scope, c.title, 'Refyntra', new vscode.ProcessExecution(c.command, c.args, { cwd: c.cwd }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: false, echo: true, showReuseMessage: false };
  return new Promise((resolve) => {
    let execution: vscode.TaskExecution | undefined;
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (!execution || e.execution !== execution) return;
      sub.dispose();
      record.exitCode = e.exitCode;
      resolve(e.exitCode);
    });
    vscode.tasks.executeTask(task).then(
      (x) => {
        execution = x;
      },
      () => {
        sub.dispose();
        resolve(undefined);
      },
    );
  });
}

/** Runs a read-only dotnet CLI command (list, search, new list) and returns its output; bounded by a timeout. */
export function runCapture(c: CliCommand, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const record: CliRecord = { title: c.title, command: c.command, args: [...c.args], cwd: c.cwd, visible: false, exitCode: undefined };
  records.push(record);
  return new Promise((resolve) => {
    execFile(c.command, c.args, { cwd: c.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      record.exitCode = code;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
