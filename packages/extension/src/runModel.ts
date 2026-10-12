// Run and Debug model (pure: no vscode, no file system). Turns what Refyntra knows about the workspace (the host's
// runnable-project model, package.json scripts, Python entry files, Cargo packages) into run targets, run commands and
// debug configurations. ADR-008. The extension side (run.ts) reads files, starts processes and talks to VS Code.
import type { RunnableKind, RunnableProjectInfo } from '@refyntra/contracts';

export type RunLanguage = 'dotnet' | 'node' | 'python' | 'rust';

/** The shape VS Code needs for a debug configuration (structurally vscode.DebugConfiguration). */
export interface DebugConfigLike {
  type: string;
  request: string;
  name: string;
  [key: string]: unknown;
}

/** Debug types Refyntra contributes (package.json `debuggers`). Node uses VS Code's built-in JavaScript debugger. */
export const DOTNET_DEBUG_TYPE = 'refyntra-dotnet';
export const PYTHON_DEBUG_TYPE = 'refyntra-python';
export const LLDB_DEBUG_TYPE = 'refyntra-lldb';

/** A launchSettings.json profile Refyntra can run (commandName "Project"). */
export interface LaunchProfile {
  name: string;
  applicationUrl?: string;
  environmentVariables: Record<string, string>;
  commandLineArgs?: string;
  launchBrowser: boolean;
  launchUrl?: string;
  workingDirectory?: string;
}

export interface RunTarget {
  /** Stable id: `<language>:<path>[#<entry>]`. */
  id: string;
  language: RunLanguage;
  /** What is shown: project, script or file name. */
  label: string;
  /** Short kind label ("console", "web", "npm script", "Python file", "Cargo binary"). */
  kindLabel: string;
  /** Folder the target runs in. */
  cwd: string;
  /** Can be run on this platform. */
  runnable: boolean;
  /** Why not (or a limitation worth showing). */
  note?: string;
  /** .NET: the project as the host reported it. */
  dotnet?: { project: RunnableProjectInfo; projectPath: string; profiles: LaunchProfile[]; outputs: Record<string, string> };
  /** Node: package manager and script. */
  node?: { packageManager: 'npm' | 'pnpm' | 'yarn'; script: string; command: string; devServerUrl?: string };
  /** Python: the file to run, or a module. */
  python?: { program?: string; module?: string };
  /** Rust: Cargo manifest and binary name. */
  rust?: { manifest: string; bin: string; packageName: string };
}

/** The user's choice for a target: profile, framework, configuration. */
export interface RunChoice {
  profile?: string;
  framework?: string;
  configuration: 'Debug' | 'Release';
}

// ---------------------------------------------------------------------------------------------------- .NET

/** Profiles of a launchSettings.json text Refyntra can run (commandName "Project"); IIS Express and others are skipped. */
export function parseLaunchSettings(text: string): LaunchProfile[] {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }
  const profiles = (json as { profiles?: unknown })?.profiles;
  if (!profiles || typeof profiles !== 'object') return [];
  const out: LaunchProfile[] = [];
  for (const [name, raw] of Object.entries(profiles as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.commandName !== undefined && p.commandName !== 'Project') continue;
    const env: Record<string, string> = {};
    if (p.environmentVariables && typeof p.environmentVariables === 'object') {
      for (const [k, v] of Object.entries(p.environmentVariables as Record<string, unknown>)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') env[k] = String(v);
    }
    out.push({
      name,
      ...(typeof p.applicationUrl === 'string' && p.applicationUrl.trim() ? { applicationUrl: p.applicationUrl.trim() } : {}),
      environmentVariables: env,
      ...(typeof p.commandLineArgs === 'string' && p.commandLineArgs.trim() ? { commandLineArgs: p.commandLineArgs.trim() } : {}),
      launchBrowser: p.launchBrowser === true,
      ...(typeof p.launchUrl === 'string' && p.launchUrl.trim() ? { launchUrl: p.launchUrl.trim() } : {}),
      ...(typeof p.workingDirectory === 'string' && p.workingDirectory.trim() ? { workingDirectory: p.workingDirectory.trim() } : {}),
    });
  }
  return out;
}

/** JSON with // and /* comments (launchSettings.json, launch.json) to plain JSON; strings are kept intact. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Splits a command line like the .NET host does for commandLineArgs: whitespace separated, double quotes group. */
export function splitArgs(line: string | undefined): string[] {
  if (!line) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '"') {
      cur += '"';
      i++;
      has = true;
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(c) && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** The first URL of an applicationUrl list ("https://localhost:7001;http://localhost:5001": https first, as Kestrel lists them). */
export function firstUrl(applicationUrl: string | undefined): string | undefined {
  const urls = (applicationUrl ?? '').split(';').map((u) => u.trim()).filter(Boolean);
  return urls[0];
}

/** The URL to open in the browser for a profile: launchUrl relative to the first application URL. */
export function browserUrl(profile: LaunchProfile | undefined, listening?: string): string | undefined {
  const base = listening ?? firstUrl(profile?.applicationUrl);
  if (!base) return undefined;
  const host = base.replace(/\/\/(\+|\*|0\.0\.0\.0|\[::\])(?=[:/]|$)/, '//localhost');
  if (!profile?.launchUrl) return host;
  if (/^https?:\/\//i.test(profile.launchUrl)) return profile.launchUrl;
  return `${host.replace(/\/$/, '')}/${profile.launchUrl.replace(/^\//, '')}`;
}

/** ASP.NET Core's start-up line ("Now listening on: http://localhost:5187"); returns the URL. */
export function listeningUrl(text: string): string | undefined {
  const m = /Now listening on:\s+(https?:\/\/\S+)/.exec(text);
  return m?.[1];
}

export const TARGET_FRAMEWORK_WINDOWS = /-windows/i;

/** The frameworks of a project that can run on this platform (net*-windows only on Windows; netstandard never). */
export function runnableFrameworks(p: RunnableProjectInfo, platform: string): string[] {
  return p.targetFrameworks.filter((t) => !/^netstandard/i.test(t) && (platform === 'win32' || !TARGET_FRAMEWORK_WINDOWS.test(t)));
}

/** The framework to use: the chosen one if valid, else the newest (highest version number). */
export function pickFramework(p: RunnableProjectInfo, platform: string, chosen?: string): string | undefined {
  const fws = runnableFrameworks(p, platform);
  if (chosen && fws.includes(chosen)) return chosen;
  return [...fws].sort((a, b) => frameworkVersion(b) - frameworkVersion(a))[0];
}

function frameworkVersion(tfm: string): number {
  const m = /^net(?:coreapp)?(\d+)(?:\.(\d+))?/i.exec(tfm);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2] ?? 0);
}

/** Path helpers that work on both separators (pure; the extension passes native paths). */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '.';
}
function joinPath(sep: string, ...parts: string[]): string {
  return parts.join(sep).replace(/[\\/]+/g, sep);
}
function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

/**
 * The program the debugger starts: the evaluated output of the framework (Debug configuration of the design-time
 * build) with its configuration folder replaced, or bin/<configuration>/<tfm>/<assembly>.dll next to the project.
 */
export function dotnetProgram(projectPath: string, p: RunnableProjectInfo, framework: string, configuration: string, outputPath?: string): string {
  const sep = sepOf(projectPath);
  if (outputPath) {
    const swapped = outputPath.replace(/([\\/]bin[\\/])(Debug|Release)([\\/])/i, `$1${configuration}$3`);
    if (/\.(dll|exe)$/i.test(swapped)) return swapped.replace(/\.exe$/i, '.dll');
  }
  return joinPath(sep, dirOf(projectPath), 'bin', configuration, framework, `${p.assemblyName ?? baseName(projectPath).replace(/\.\w+proj$/i, '')}.dll`);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** `dotnet build` arguments for a project (no restore prompts, no logo). */
export function dotnetBuildArgs(projectPath: string, framework: string | undefined, configuration: string): string[] {
  return ['build', projectPath, '-c', configuration, ...(framework ? ['-f', framework] : []), '--nologo', '-v', 'q', '-clp:NoSummary;ErrorsOnly'];
}

/** Run without debugging: `dotnet run` (builds, then starts with the profile) or `dotnet watch` for hot reload. */
export function dotnetRunCommand(t: RunTarget, choice: RunChoice, platform: string, watch = false): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const d = t.dotnet!;
  const fw = pickFramework(d.project, platform, choice.framework);
  const profile = d.profiles.find((p) => p.name === choice.profile);
  const args = watch ? ['watch', 'run', '--project', d.projectPath] : ['run', '--project', d.projectPath];
  args.push('-c', choice.configuration);
  if (fw && d.project.targetFrameworks.length > 1) args.push('-f', fw);
  if (profile) args.push('--launch-profile', profile.name);
  else if (d.profiles.length) args.push('--no-launch-profile');
  return { command: 'dotnet', args, cwd: dirOf(d.projectPath), env: { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } };
}

export interface DotnetDebugConfiguration {
  type: typeof DOTNET_DEBUG_TYPE;
  request: 'launch' | 'attach';
  name: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  stopAtEntry?: boolean;
  justMyCode?: boolean;
  processId?: number | string;
  /** Refyntra: build the project before launching (default true when `project` is set). */
  project?: string;
  framework?: string;
  configuration?: 'Debug' | 'Release';
  launchProfile?: string;
  /** Refyntra: open the browser when the app reports "Now listening on" (web profiles with launchBrowser). */
  launchBrowser?: { enabled: boolean; url?: string };
  noDebug?: boolean;
  [key: string]: unknown;
}

/** A debug configuration for a .NET target (dynamic configuration, F5 without launch.json, Generate launch.json). */
export function dotnetDebugConfiguration(t: RunTarget, choice: RunChoice, platform: string, workspaceFolder?: string): DotnetDebugConfiguration {
  const d = t.dotnet!;
  const fw = pickFramework(d.project, platform, choice.framework) ?? d.project.targetFrameworks[0] ?? 'net10.0';
  const profile = d.profiles.find((p) => p.name === choice.profile) ?? d.profiles[0];
  const rel = (p: string) => (workspaceFolder && p.toLowerCase().startsWith(workspaceFolder.toLowerCase()) ? `\${workspaceFolder}${p.slice(workspaceFolder.length).replace(/\\/g, '/')}` : p);
  const env: Record<string, string> = { ...(profile?.environmentVariables ?? {}) };
  if (profile?.applicationUrl && !env.ASPNETCORE_URLS) env.ASPNETCORE_URLS = profile.applicationUrl;
  if (t.dotnet!.project.kind === 'web' && !env.ASPNETCORE_ENVIRONMENT) env.ASPNETCORE_ENVIRONMENT = 'Development';
  const cwd = profile?.workingDirectory ?? dirOf(d.projectPath);
  const label = `${t.label}${profile && d.profiles.length > 1 ? ` (${profile.name})` : ''}${d.project.targetFrameworks.length > 1 ? ` [${fw}]` : ''}`;
  const cfg: DotnetDebugConfiguration = {
    type: DOTNET_DEBUG_TYPE,
    request: 'launch',
    name: `Refyntra: ${label}`,
    project: rel(d.projectPath),
    framework: fw,
    configuration: choice.configuration,
    program: rel(dotnetProgram(d.projectPath, d.project, fw, choice.configuration, d.outputs[fw])),
    args: splitArgs(profile?.commandLineArgs),
    cwd: rel(cwd),
    env,
    console: 'internalConsole',
    stopAtEntry: false,
    justMyCode: true,
  };
  if (profile) cfg.launchProfile = profile.name;
  if (d.project.kind === 'web') cfg.launchBrowser = { enabled: !!profile?.launchBrowser, ...(profile?.launchUrl ? { url: profile.launchUrl } : {}) };
  return cfg;
}

/** Checks and completes a .NET debug configuration (resolveDebugConfiguration). Returns the problem as text. */
export function validateDotnetConfiguration(c: Partial<DotnetDebugConfiguration>): string | undefined {
  if (c.request === 'attach') {
    if (c.processId === undefined || c.processId === '') return 'An attach configuration needs "processId" (for example "${command:refyntra.pickDotnetProcess}").';
    if (!/^\d+$/.test(String(c.processId))) return `"processId" must be a process number, not ${JSON.stringify(c.processId)}.`;
    return undefined;
  }
  if (!c.program && !c.project) return 'A launch configuration needs "program" (the built .dll) or "project" (the .csproj to build and start).';
  if (c.console && !['internalConsole', 'integratedTerminal', 'externalTerminal'].includes(c.console)) return `"console" must be internalConsole, integratedTerminal or externalTerminal, not ${JSON.stringify(c.console)}.`;
  if (c.env && (typeof c.env !== 'object' || Object.values(c.env).some((v) => typeof v !== 'string'))) return '"env" must be an object of string values.';
  if (c.args && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string'))) return '"args" must be an array of strings.';
  return undefined;
}

/** The arguments netcoredbg receives for a launch (its `launch` request reads program, args, cwd, env, stopAtEntry, justMyCode). */
export function netcoredbgLaunchArguments(c: DotnetDebugConfiguration): Record<string, unknown> {
  return {
    program: c.program,
    args: c.args ?? [],
    cwd: c.cwd,
    env: c.env ?? {},
    stopAtEntry: !!c.stopAtEntry,
    justMyCode: c.justMyCode !== false,
    enableStepFiltering: true,
  };
}

/** Kind label for the UI. */
export function kindLabel(kind: RunnableKind | string): string {
  switch (kind) {
    case 'console':
      return 'console app';
    case 'web':
      return 'web app';
    case 'worker':
      return 'worker service';
    case 'winforms':
      return 'Windows Forms app';
    case 'wpf':
      return 'WPF app';
    case 'test':
      return 'test project';
    case 'library':
      return 'class library';
    case 'maui':
      return '.NET MAUI app';
    case 'blazor-wasm':
      return 'Blazor WebAssembly app';
    default:
      return kind;
  }
}

/** Run targets of the host's project model (runnable ones first; the others are listed with their reason). */
export function dotnetTargets(projects: readonly RunnableProjectInfo[], toPath: (uri: string) => string, profilesOf: (p: RunnableProjectInfo) => LaunchProfile[], platform: string): RunTarget[] {
  return projects
    .filter((p) => p.kind !== 'library')
    .map((p) => {
      const projectPath = toPath(p.projectUri);
      const platformOk = !p.windowsOnly || platform === 'win32';
      const runnable = p.runnable && platformOk && runnableFrameworks(p, platform).length > 0;
      const note = !p.runnable ? p.reason ?? undefined : !platformOk ? `${kindLabel(p.kind)}s run on Windows only; this is ${platformName(platform)}.` : runnableFrameworks(p, platform).length === 0 ? 'No target framework of this project runs on this platform.' : p.reason ?? undefined;
      return {
        id: `dotnet:${projectPath}`,
        language: 'dotnet' as const,
        label: p.name,
        kindLabel: kindLabel(p.kind),
        cwd: dirOf(projectPath),
        runnable,
        ...(note ? { note } : {}),
        dotnet: { project: p, projectPath, profiles: p.launchSettingsUri ? profilesOf(p) : [], outputs: Object.fromEntries(p.outputs.filter((o) => o.targetFramework).map((o) => [o.targetFramework!, toPath(o.outputUri)])) },
      };
    })
    .sort((a, b) => Number(b.runnable) - Number(a.runnable) || a.label.localeCompare(b.label));
}

function platformName(platform: string): string {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
}

// ---------------------------------------------------------------------------------------------------- Node

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'develop', 'preview'];

/** The package manager of a folder, from its lock file (or the packageManager field). */
export function packageManagerOf(files: readonly string[], packageManagerField?: string): 'npm' | 'pnpm' | 'yarn' {
  const field = (packageManagerField ?? '').split('@')[0];
  if (field === 'pnpm' || field === 'yarn' || field === 'npm') return field;
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

/** Default dev-server URL of a script command (Vite, Next.js, Create React App, Angular, Nuxt, Astro, SvelteKit). */
export function devServerUrl(command: string): string | undefined {
  const port = /(?:--port[ =]|-p\s+)(\d{2,5})/.exec(command)?.[1];
  const known: [RegExp, number][] = [
    [/\bvite\b|\bsvelte-kit dev\b|\bastro dev\b/, 5173],
    [/\bnext (dev|start)\b|\breact-scripts start\b|\bnuxt dev\b|\bremix dev\b/, 3000],
    [/\bng serve\b/, 4200],
    [/\bwebpack(-dev-server| serve)\b/, 8080],
  ];
  for (const [re, def] of known) if (re.test(command)) return `http://localhost:${port ?? def}`;
  return undefined;
}

/** Run targets of a package.json: its runnable scripts (dev/start/serve first). */
export function nodeTargets(pkgPath: string, pkg: { name?: string; scripts?: Record<string, unknown>; packageManager?: string }, folderFiles: readonly string[]): RunTarget[] {
  const scripts = Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !/^(pre|post)/.test(e[0]));
  const pm = packageManagerOf(folderFiles, pkg.packageManager);
  const dir = dirOf(pkgPath);
  const rank = (s: string) => (SCRIPT_ORDER.includes(s) ? SCRIPT_ORDER.indexOf(s) : 100);
  return scripts
    .filter(([s]) => !/^(lint|format|prettier|typecheck|clean|prepare|postinstall)(:|$)/.test(s))
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([script, command]) => {
      const url = devServerUrl(command);
      return {
        id: `node:${pkgPath}#${script}`,
        language: 'node' as const,
        label: `${pkg.name ?? baseName(dir)}: ${script}`,
        kindLabel: `${pm} script`,
        cwd: dir,
        runnable: true,
        node: { packageManager: pm, script, command, ...(url ? { devServerUrl: url } : {}) },
      };
    });
}

/** Debug configurations for a script, for VS Code's built-in JavaScript debugger (generated, not reimplemented). */
export function nodeDebugConfigurations(t: RunTarget, browser: 'msedge' | 'chrome' = 'msedge'): DebugConfigLike[] {
  const n = t.node!;
  const out: DebugConfigLike[] = [
    {
      type: 'node',
      request: 'launch',
      name: `Refyntra: ${n.packageManager} run ${n.script}`,
      runtimeExecutable: n.packageManager,
      runtimeArgs: ['run', n.script],
      cwd: t.cwd,
      console: 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
    },
  ];
  if (n.devServerUrl) out.push({ type: browser, request: 'launch', name: `Refyntra: ${browser === 'msedge' ? 'Edge' : 'Chrome'} on ${n.devServerUrl}`, url: n.devServerUrl, webRoot: t.cwd });
  return out;
}

// ---------------------------------------------------------------------------------------------------- Python

/** True for a Python file that is meant to be run (`if __name__ == "__main__":`). */
export function isPythonEntry(text: string): boolean {
  return /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(text);
}

export function pythonTarget(file: string, cwd: string): RunTarget {
  return { id: `python:${file}`, language: 'python', label: baseName(file), kindLabel: 'Python file', cwd, runnable: true, python: { program: file } };
}

export interface PythonDebugConfiguration {
  type: typeof PYTHON_DEBUG_TYPE;
  request: 'launch' | 'attach';
  name: string;
  program?: string;
  module?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  python?: string;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  justMyCode?: boolean;
  stopOnEntry?: boolean;
  connect?: { host?: string; port: number };
  [key: string]: unknown;
}

export function pythonDebugConfiguration(t: RunTarget, interpreter: string | undefined): PythonDebugConfiguration {
  return {
    type: PYTHON_DEBUG_TYPE,
    request: 'launch',
    name: `Refyntra: Python ${t.label}`,
    ...(t.python?.module ? { module: t.python.module } : { program: t.python?.program ?? '${file}' }),
    cwd: t.cwd,
    console: 'integratedTerminal',
    justMyCode: true,
    ...(interpreter ? { python: interpreter } : {}),
  };
}

export function validatePythonConfiguration(c: Partial<PythonDebugConfiguration>): string | undefined {
  if (c.request === 'attach') return c.connect && typeof c.connect.port === 'number' ? undefined : 'A Python attach configuration needs "connect": {"host", "port"} (debugpy listening in the program). Attaching to a process id is not supported by the bundled debugpy.';
  if (!c.program && !c.module) return 'A Python launch configuration needs "program" (a .py file) or "module".';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------- Rust

/** Binaries of a Cargo.toml: [[bin]] names, else the package itself when src/main.rs exists. Minimal TOML reading. */
export function cargoBinaries(toml: string, hasMainRs: boolean): { packageName?: string; bins: string[] } {
  let section = '';
  let packageName: string | undefined;
  const bins: string[] = [];
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const s = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (s) {
      section = line.startsWith('[[') ? `[[${s[1]!.trim()}]]` : s[1]!.trim();
      continue;
    }
    const kv = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (!kv) continue;
    if (section === 'package') packageName = kv[1];
    else if (section === '[[bin]]') bins.push(kv[1]!);
  }
  if (bins.length === 0 && hasMainRs && packageName) bins.push(packageName);
  return { ...(packageName ? { packageName } : {}), bins };
}

export function rustTargets(manifest: string, toml: string, hasMainRs: boolean): RunTarget[] {
  const { packageName, bins } = cargoBinaries(toml, hasMainRs);
  if (!packageName) return [];
  const dir = dirOf(manifest);
  return bins.map((bin) => ({ id: `rust:${manifest}#${bin}`, language: 'rust' as const, label: bin, kindLabel: 'Cargo binary', cwd: dir, runnable: true, rust: { manifest, bin, packageName } }));
}

export function cargoRunArgs(t: RunTarget, release: boolean): string[] {
  const r = t.rust!;
  return ['run', '--manifest-path', r.manifest, '--bin', r.bin, ...(release ? ['--release'] : [])];
}

export function lldbDebugConfiguration(t: RunTarget, platform: string): DebugConfigLike {
  const r = t.rust!;
  const sep = sepOf(t.cwd);
  return {
    type: LLDB_DEBUG_TYPE,
    request: 'launch',
    name: `Refyntra: Rust ${r.bin}`,
    program: joinPath(sep, t.cwd, 'target', 'debug', `${r.bin}${platform === 'win32' ? '.exe' : ''}`),
    cargo: { manifest: r.manifest, bin: r.bin },
    args: [],
    cwd: t.cwd,
  };
}

/** lldb-dap wants env as "KEY=VALUE" strings. */
export function lldbEnv(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
}

// ---------------------------------------------------------------------------------------------------- CodeLens

/** Where "Run | Debug" goes in a C# file: `static … Main(` or the first top-level statement of Program.cs. */
export function csharpEntryLine(text: string, fileName: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const main = lines.findIndex((l) => /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(l));
  if (main >= 0) return main;
  if (!/^program\.cs$/i.test(fileName)) return undefined;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (inComment) {
      if (l.includes('*/')) inComment = false;
      continue;
    }
    if (l.startsWith('/*')) {
      inComment = !l.includes('*/');
      continue;
    }
    if (!l || l.startsWith('//') || l.startsWith('#') || /^using\s+[\w.=\s]+;$/.test(l) || /^global\s+using\b/.test(l)) continue;
    if (/^(namespace|public|internal|static|sealed|abstract|partial|class|record|struct|interface|enum|\[)/.test(l)) return undefined;
    return i;
  }
  return undefined;
}

export function pythonEntryLine(text: string): number | undefined {
  const i = text.split(/\r?\n/).findIndex((l) => /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(l));
  return i >= 0 ? i : undefined;
}

export function rustEntryLine(text: string): number | undefined {
  const i = text.split(/\r?\n/).findIndex((l) => /^\s*(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/.test(l));
  return i >= 0 ? i : undefined;
}

/** The project whose folder contains a file (deepest project folder wins). */
export function targetForFile<T extends { cwd: string; language: RunLanguage }>(targets: readonly T[], file: string, language: RunLanguage): T | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
  const f = norm(file);
  return targets
    .filter((t) => t.language === language && f.startsWith(`${norm(t.cwd)}/`))
    .sort((a, b) => norm(b.cwd).length - norm(a.cwd).length)[0];
}

/** Text of the status bar item for a selected target. */
export function statusText(t: RunTarget | undefined, choice: RunChoice | undefined): string {
  if (!t) return '$(play) Run…';
  const parts = [t.label];
  if (choice?.profile && (t.dotnet?.profiles.length ?? 0) > 1) parts.push(choice.profile);
  if (choice?.framework && (t.dotnet?.project.targetFrameworks.length ?? 0) > 1) parts.push(choice.framework);
  if (choice?.configuration === 'Release') parts.push('Release');
  return `$(play) ${parts.join(' · ')}`;
}
