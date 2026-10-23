import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runVisible } from './dotnetCli';
import { dacpacName, dbBuildCommand, pickDacpac, sqlProjectKind } from './sqlProjectModel';

const EXCLUDE = '**/{node_modules,bin,obj,.git}/**';

/** What the last database build produced (tests read it). */
export interface DbBuildResult {
  project: string;
  exitCode: number | undefined;
  dacpac: string | undefined;
  error?: string;
}

/** The MSBuild.exe of the newest Visual Studio (vswhere), for legacy SSDT projects; a setting overrides it. */
async function visualStudioMsbuild(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('refyntra').get<string>('database.msbuildPath', '').trim();
  if (configured) return configured;
  if (process.platform !== 'win32') return undefined;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return undefined;
  return new Promise((resolve) => {
    execFile(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { timeout: 15000, windowsHide: true }, (err, out) => {
      resolve(err ? undefined : String(out).split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('msbuild.exe')));
    });
  });
}

function dacpacsUnder(dir: string, depth = 4): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...dacpacsUnder(p, depth - 1));
    else if (/\.dacpac$/i.test(e.name)) out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
  }
  return out;
}

async function pickProject(arg: unknown): Promise<string | undefined> {
  if (arg instanceof vscode.Uri && /\.sqlproj$/i.test(arg.fsPath)) return arg.fsPath;
  if (typeof arg === 'string' && /\.sqlproj$/i.test(arg)) return arg;
  const found = (await vscode.workspace.findFiles('**/*.sqlproj', EXCLUDE, 200)).map((u) => u.fsPath).sort();
  if (found.length === 0) {
    void vscode.window.showWarningMessage('Refyntra: no database project (.sqlproj) in this workspace.');
    return undefined;
  }
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(found.map((f) => ({ label: path.basename(f, '.sqlproj'), description: vscode.workspace.asRelativePath(f, false), file: f })), { placeHolder: 'Database project to build' });
  return pick?.file;
}

/** `refyntra.database.build [uri]`: builds a .sqlproj in the terminal panel and reports the .dacpac it made. */
export async function buildDatabase(isTrusted: () => boolean, arg: unknown, quiet = false): Promise<DbBuildResult | undefined> {
  if (!isTrusted()) {
    void vscode.window.showWarningMessage('Refyntra does not build projects in Restricted Mode. Trust the workspace first.');
    return undefined;
  }
  const project = await pickProject(arg);
  if (!project) return undefined;
  const text = fs.readFileSync(project, 'utf8');
  const kind = sqlProjectKind(text);
  const configuration = vscode.workspace.getConfiguration('refyntra').get<string>('database.configuration', 'Debug') || 'Debug';
  const cmd = dbBuildCommand(kind, project, configuration, kind === 'legacy' ? await visualStudioMsbuild() : undefined);
  if (!cmd) {
    const error =
      process.platform === 'win32'
        ? `${path.basename(project)} is a Visual Studio (SSDT) database project: building it needs Visual Studio with "SQL Server Data Tools", or set refyntra.database.msbuildPath. SDK-style projects (Microsoft.Build.Sql) build with dotnet alone.`
        : `${path.basename(project)} is a Visual Studio (SSDT) database project, which builds only on Windows with Visual Studio. Convert it to an SDK-style project (Microsoft.Build.Sql) to build it with dotnet here.`;
    if (!quiet) void vscode.window.showWarningMessage(`Refyntra: ${error}`);
    return { project, exitCode: undefined, dacpac: undefined, error };
  }
  const started = Date.now() - 2000;
  const exitCode = await runVisible(cmd);
  const dacpac = exitCode === 0 ? pickDacpac(dacpacName(project, text), dacpacsUnder(path.join(path.dirname(project), 'bin')), started) : undefined;
  const result: DbBuildResult = { project, exitCode, dacpac };
  if (quiet) return result;
  if (exitCode !== 0) void vscode.window.showErrorMessage(`Refyntra: building ${path.basename(project)} failed (exit code ${exitCode ?? '?'}); see the terminal.`);
  else if (!dacpac) void vscode.window.showWarningMessage(`Refyntra: ${path.basename(project)} built, but no ${dacpacName(project, text)} was found under bin.`);
  else
    void vscode.window.showInformationMessage(`Refyntra: built ${vscode.workspace.asRelativePath(dacpac, false)}`, 'Reveal in Explorer', 'Copy Path').then((a) => {
      if (a === 'Reveal in Explorer') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dacpac));
      else if (a === 'Copy Path') void vscode.env.clipboard.writeText(dacpac);
    });
  return result;
}

export function registerDatabase(isTrusted: () => boolean): vscode.Disposable {
  return vscode.commands.registerCommand('refyntra.database.build', (arg?: unknown, quiet?: unknown) => buildDatabase(isTrusted, arg, quiet === true));
}
