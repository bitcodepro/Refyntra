import type { LoadDiagnostic, ProjectContextInfo } from '@refyntra/contracts';
import type { AdapterHealth, HealthSummary } from '@refyntra/domain';

// The Health page for ordinary users (pure: unit-tested with vitest, no vscode import). Top to bottom: one status
// headline per language, what it means, one primary fix, projects grouped by cause in plain words, and the technical
// details (unchanged, collapsed) at the bottom. The webview renders this model; it never decides anything itself.

/** Every action the page can offer. The webview can only ask for one of these by key (see HealthAction.key). */
export type HealthActionId =
  | 'restore'
  | 'showRestoreOutput'
  | 'installSdk'
  | 'openGlobalJson'
  | 'trustWorkspace'
  | 'selectSolution'
  | 'restartBackend'
  | 'exportDebugBundle'
  | 'getStarted'
  | 'copyText'
  | 'showText'
  | 'installRust';

export const HEALTH_ACTION_IDS: readonly HealthActionId[] = ['restore', 'showRestoreOutput', 'installSdk', 'openGlobalJson', 'trustWorkspace', 'selectSolution', 'restartBackend', 'exportDebugBundle', 'getStarted', 'copyText', 'showText', 'installRust'];

export interface HealthAction {
  /** Unique within one model; the webview sends this key back and the extension looks the action up in its own model. */
  key: string;
  id: HealthActionId;
  label: string;
  /** Plain-words explanation (button title / screen readers). */
  hint?: string;
  /** Argument from the backend (restore target, download URL, global.json path); never taken from the webview. */
  arg?: string;
}

export type StatusIcon = 'ok' | 'warning' | 'error' | 'locked' | 'loading' | 'info';

export const ICON_GLYPH: Record<StatusIcon, string> = { ok: '✅', warning: '⚠', error: '⛔', locked: '🔒', loading: '⏳', info: 'ℹ' };

export type ProjectCause = 'missingPackages' | 'missingProjectReference' | 'loadFailed' | 'other';

export interface ProjectProblem {
  cause: ProjectCause;
  /** One plain line, e.g. "NuGet packages not restored (37 missing, e.g. Avalonia 12.1.1)". */
  text: string;
  /** The raw MSBuild / host messages behind this line (shown collapsed). */
  raw: string[];
}

export interface ProjectEntry {
  name: string;
  path: string;
  problems: ProjectProblem[];
}

export type GroupKind = 'works' | 'needsPackages' | 'missingProjectReference' | 'failed' | 'other';

export interface ProjectGroup {
  kind: GroupKind;
  /** "Works", "Needs packages", … */
  title: string;
  /** "App, Infrastructure, Web, Tests, Shared (+3 more)" */
  summary: string;
  projects: ProjectEntry[];
}

export interface LanguageSection {
  adapterId: string;
  icon: StatusIcon;
  headline: string;
  meaning: string;
  primary?: HealthAction;
  /** Further fixes next to the primary one (e.g. Open global.json). */
  more: HealthAction[];
  groups: ProjectGroup[];
}

export type RestoreRun = { state: 'running'; target: string } | { state: 'succeeded'; target: string } | { state: 'failed'; target: string; exitCode?: number | undefined };

/** Debug adapters and tools for Run and Debug (ADR-008); structurally the DebuggerStatus of run.ts. */
export interface DebugHealth {
  netcoredbg: { path?: string; version?: string; reason?: string };
  debugpy: { path?: string; version?: string };
  python?: string;
  lldbDap?: string;
  cargo?: string;
  dotnet?: string;
}

export interface HealthPageInput {
  health: HealthSummary;
  /** Run and Debug section; left out when unknown. */
  debug?: DebugHealth | undefined;
  /** The restore started from this page, if any. */
  restore?: RestoreRun | undefined;
}

export interface HealthPageModel {
  sections: LanguageSection[];
  /** Restore progress / failure banner. */
  restoreBanner?: { icon: StatusIcon; text: string; action?: HealthAction };
  secondary: HealthAction[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Names joined with ", " and "(+n more)" after `max`. */
export function nameList(names: readonly string[], max = 5): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')}, … (+${names.length - max} more)`;
}

// ---- causes ------------------------------------------------------------------------------------------------------

type DiagCause = 'missingAssets' | 'missingPackages' | 'missingProjectReference' | 'loadFailed' | 'other';

/** The host's structured cause when present, otherwise a heuristic on the message (older hosts, raw MSBuild text). */
export function diagnosticCause(d: LoadDiagnostic): DiagCause {
  if (d.cause === 'missingAssets' || d.cause === 'missingPackages' || d.cause === 'missingProjectReference') return d.cause;
  const m = d.message;
  if (/package\(s\) listed in project\.assets\.json are missing|NU110[0-9]|Unable to find package|package .* (?:is|was) not found/i.test(m)) return 'missingPackages';
  if (/project\.assets\.json|assets file|NuGet package restore|dotnet restore|packages are not restored|NETSDK1004/i.test(m)) return 'missingAssets';
  if (/Referenced project not found|project reference .* (?:does not exist|not found)|MSB9008/i.test(m)) return 'missingProjectReference';
  if (/could not be loaded|failed to load/i.test(m)) return 'loadFailed';
  return 'other';
}

function packageDetail(msgs: readonly string[]): string {
  for (const m of msgs) {
    const r = /(\d+) package\(s\)[^(]*\(e\.g\. ([^,)]+)/.exec(m);
    if (r) {
      const example = r[2]!.trim().replace(/[/\\]/, ' ');
      return ` (${r[1]} missing, e.g. ${example})`;
    }
  }
  return '';
}

function projectProblems(p: ProjectContextInfo): ProjectProblem[] {
  const by = new Map<DiagCause, string[]>();
  for (const d of p.diagnostics) {
    if (d.severity !== 'error' && p.state === 'loaded') continue;
    const c = diagnosticCause(d);
    by.set(c, [...(by.get(c) ?? []), d.message]);
  }
  const out: ProjectProblem[] = [];
  const pkg = [...(by.get('missingAssets') ?? []), ...(by.get('missingPackages') ?? [])];
  if (pkg.length) out.push({ cause: 'missingPackages', text: `NuGet packages not restored${packageDetail(by.get('missingPackages') ?? [])}`, raw: pkg });
  const ref = by.get('missingProjectReference');
  if (ref?.length) {
    const names = ref.map((m) => /Referenced project not found: (.+?)\. References/.exec(m)?.[1]).filter((x): x is string => !!x).map(basename);
    out.push({ cause: 'missingProjectReference', text: names.length ? `A project it references is missing: ${[...new Set(names)].join(', ')}` : 'A project it references is missing', raw: ref });
  }
  const failed = by.get('loadFailed') ?? [];
  if (p.state === 'failed' || failed.length) out.push({ cause: 'loadFailed', text: 'The project could not be loaded', raw: failed });
  const other = by.get('other') ?? [];
  if (other.length && !out.length) out.push({ cause: 'other', text: plural(other.length, 'load error'), raw: other });
  else if (other.length) out[0] = { ...out[0]!, raw: [...out[0]!.raw, ...other] };
  if (!out.length && p.state !== 'loaded') out.push({ cause: 'other', text: 'Loaded only partially', raw: [] });
  return out;
}

const GROUP_TITLE: Record<GroupKind, string> = {
  works: 'Works',
  needsPackages: 'Needs packages',
  missingProjectReference: 'Missing project reference',
  failed: 'Failed to load',
  other: 'Other load problems',
};
const GROUP_ORDER: GroupKind[] = ['needsPackages', 'missingProjectReference', 'failed', 'other', 'works'];

function groupOf(problems: readonly ProjectProblem[]): GroupKind {
  if (!problems.length) return 'works';
  const causes = new Set(problems.map((p) => p.cause));
  if (causes.has('loadFailed')) return 'failed';
  if (causes.has('missingPackages')) return 'needsPackages';
  if (causes.has('missingProjectReference')) return 'missingProjectReference';
  return 'other';
}

export function projectGroups(a: AdapterHealth): ProjectGroup[] {
  const groups = new Map<GroupKind, ProjectEntry[]>();
  for (const p of a.projects) {
    const problems = projectProblems(p);
    const g = groupOf(problems);
    groups.set(g, [...(groups.get(g) ?? []), { name: p.name, path: p.projectPath, problems }]);
  }
  return GROUP_ORDER.filter((k) => groups.has(k)).map((k) => {
    const projects = groups.get(k)!;
    return { kind: k, title: GROUP_TITLE[k], summary: nameList(projects.map((p) => p.name)), projects };
  });
}

// ---- actions -----------------------------------------------------------------------------------------------------

function restoreTarget(a: AdapterHealth): string | undefined {
  const all = [...a.recoveryActions, ...a.diagnostics.flatMap((d) => d.recoveryActions ?? []), ...a.projects.flatMap((p) => p.diagnostics.flatMap((d) => d.recoveryActions ?? []))];
  const r = all.find((x) => x.command === 'refyntra.runRestore' && typeof x.args?.[0] === 'string' && x.args[0]);
  return (r?.args?.[0] as string | undefined) ?? a.solutionPath ?? undefined;
}

/** First https URL in the SDK recovery text (the host names the .NET download page). */
export function sdkDownloadUrl(text: string): string {
  const m = /https:\/\/[^\s)"']+/.exec(text);
  return m ? m[0].replace(/[.,;]+$/, '') : 'https://dotnet.microsoft.com/download/dotnet';
}

/** The global.json path the host's SdkNotFound message names ("<path>global.json asks for .NET SDK …"). */
export function globalJsonPath(text: string): string | undefined {
  const m = /^(.*?global\.json) asks for/i.exec(text.trim());
  return m?.[1];
}

// ---- sections ----------------------------------------------------------------------------------------------------

const TS_HEADLINE: Record<string, string> = {
  Ready: "TypeScript / JavaScript: ready (uses VS Code's built-in language features)",
};

function csharpSection(a: AdapterHealth, trusted: boolean, key: (id: HealthActionId) => string, restore?: RestoreRun): LanguageSection {
  const s = (icon: StatusIcon, headline: string, meaning: string, primary?: HealthAction, more: HealthAction[] = [], groups: ProjectGroup[] = []): LanguageSection => ({
    adapterId: a.adapterId,
    icon,
    headline,
    meaning,
    ...(primary ? { primary } : {}),
    more,
    groups,
  });
  const restart: HealthAction = { key: key('restartBackend'), id: 'restartBackend', label: 'Restart backend', hint: 'Restart the Refyntra C# backend and load the solution again.' };
  if (!trusted || a.state === 'TrustRequired') {
    return s('locked', 'Restricted Mode', `This workspace is not trusted, so Refyntra does not start its ${a.displayName} backend (no MSBuild, restore or build). Find, Related, Actions and Rename are unavailable for ${a.displayName} until you trust the workspace.`, { key: key('trustWorkspace'), id: 'trustWorkspace', label: 'Trust workspace', hint: 'Open Manage Workspace Trust.' });
  }
  const { length: total } = a.projects;
  const groups = projectGroups(a);
  if (a.state === 'Ready') {
    const works = total === 0 ? '' : ` — ${plural(total, 'project')} loaded`;
    return s('ok', `${a.displayName} is ready${works}`, 'Find, Related, Actions and Rename work across the whole solution.', undefined, [], groups);
  }
  if (a.state === 'Loading' || a.state === 'Restarting' || (a.state === 'NotStarted' && a.reasonCode !== 'NoSolutionFound')) {
    return s('loading', a.state === 'Restarting' ? `${a.displayName} is restarting…` : `${a.displayName} is loading…`, 'Refyntra is loading the solution. This page updates by itself when it is done.', undefined, [], groups);
  }
  if (a.reasonCode === 'NoSolutionFound') {
    return s('info', `${a.displayName}: no solution or project found`, 'Refyntra did not find a .sln, .slnx or .csproj file in this workspace, so C# features are off. Open a folder with one, or choose the file. TypeScript and JavaScript work without it.', { key: key('selectSolution'), id: 'selectSolution', label: 'Select solution', hint: 'Choose which .sln, .slnx or .csproj Refyntra loads.' });
  }
  if (a.state === 'Partial') {
    const broken = groups.filter((g) => g.kind !== 'works');
    const affected = broken.reduce((n, g) => n + g.projects.length, 0);
    const kinds = broken.map((g) => g.kind);
    const effect = 'Find, Related and Rename may miss results in these projects.';
    let meaning: string;
    if (kinds.length === 1 && kinds[0] === 'needsPackages') meaning = `${affected} of ${total} projects are missing their NuGet packages, so Refyntra can't fully understand them. ${effect}`;
    else if (kinds.length === 1 && kinds[0] === 'missingProjectReference') meaning = `${affected} of ${total} projects reference a project that does not exist, so code from it is unknown. ${effect}`;
    else if (kinds.length === 1 && kinds[0] === 'failed') meaning = `${affected} of ${total} projects could not be loaded. ${effect}`;
    else if (affected > 0) {
      const parts = broken.map((g) => `${g.projects.length} ${({ needsPackages: 'need NuGet packages', missingProjectReference: 'miss a referenced project', failed: 'failed to load', other: 'have other load errors', works: '' } as const)[g.kind]}`);
      meaning = `${affected} of ${total} projects did not load completely (${parts.join(', ')}). ${effect}`;
    } else meaning = `Some of the solution could not be loaded${a.message ? ` (${a.message})` : ''}. ${effect}`;
    const target = restoreTarget(a);
    let primary: HealthAction | undefined;
    if (kinds.includes('needsPackages') && target) {
      primary = restore?.state === 'running'
        ? undefined
        : { key: key('restore'), id: 'restore', label: 'Restore packages', hint: `Runs dotnet restore for ${basename(target)} in a terminal, then reloads the solution.`, arg: target };
    } else if (kinds.includes('failed') || kinds.includes('other')) primary = restart;
    const more: HealthAction[] = primary && primary.id !== 'restartBackend' ? [restart] : [];
    return s('warning', `${a.displayName} works partially`, meaning, primary, more, groups);
  }
  // Failed / Unsupported: the backend is not running.
  if (a.reasonCode === 'SdkNotFound') {
    const text = `${a.message ?? ''} ${a.recoveryHint ?? ''}`;
    const gj = globalJsonPath(a.message ?? '');
    const more: HealthAction[] = [];
    if (gj) more.push({ key: key('openGlobalJson'), id: 'openGlobalJson', label: 'Open global.json', hint: 'The global.json file that picks the .NET SDK version.', arg: gj });
    more.push(restart);
    const why = gj ? 'The .NET SDK version this solution asks for (in global.json) is not installed.' : 'No .NET SDK was found on this computer.';
    return s('error', `${a.displayName} is not running`, `${why} Refyntra needs the .NET SDK to understand C# code. Install it, then restart the backend.`, { key: key('installSdk'), id: 'installSdk', label: 'Install .NET SDK', hint: 'Opens the .NET download page in your browser.', arg: sdkDownloadUrl(text) }, more, groups);
  }
  const reason = a.message ? ` (${a.message})` : '';
  return s('error', `${a.displayName} is not running`, `The Refyntra ${a.displayName} backend could not start${reason}, so Find, Related, Actions and Rename are unavailable for ${a.displayName}. Restart it; if that does not help, export a debug bundle and report the problem.`, restart, [], groups);
}

/** Python and Rust run on language servers bundled with Refyntra (own processes; no other extension needed). */
const LSP_SECTIONS: Record<string, { server: string; ready: string; meaning: string; trust: string }> = {
  python: {
    server: 'Pyright',
    ready: 'Python: ready (Pyright, bundled with Refyntra)',
    meaning: 'Related, Find and Rename for Python files use the Pyright language server that ships with Refyntra; no other extension is needed. Imports of installed packages resolve when a Python environment is found (python.defaultInterpreterPath or a .venv/venv folder in the workspace).',
    trust: 'This workspace is not trusted, so Refyntra does not start Pyright for Python files. Find, Related, Actions and Rename are unavailable for Python until you trust the workspace.',
  },
  rust: {
    server: 'rust-analyzer',
    ready: 'Rust: ready (rust-analyzer, bundled with Refyntra)',
    meaning: 'Related, Find and Rename for Rust files use the rust-analyzer language server that ships with Refyntra; no other extension is needed. It uses your Rust toolchain (cargo) to load the Cargo project.',
    trust: 'This workspace is not trusted, so Refyntra does not start rust-analyzer (it would run cargo, build scripts and proc-macros of the project). Find, Related, Actions and Rename are unavailable for Rust until you trust the workspace.',
  },
};

export const RUSTUP_URL = 'https://rustup.rs/';

function otherSection(a: AdapterHealth, key: (id: HealthActionId) => string): LanguageSection {
  const name = a.adapterId === 'typescript' ? 'TypeScript / JavaScript' : a.displayName;
  const section = (icon: StatusIcon, headline: string, meaning: string, primary?: HealthAction, more: HealthAction[] = []): LanguageSection => ({ adapterId: a.adapterId, icon, headline, meaning, ...(primary ? { primary } : {}), more, groups: [] });
  const lsp = LSP_SECTIONS[a.adapterId];
  if (lsp) {
    const restart: HealthAction = { key: key('restartBackend'), id: 'restartBackend', label: 'Restart backend', hint: `Restart the Refyntra backends, ${lsp.server} included.` };
    if (a.state === 'TrustRequired') return section('locked', 'Restricted Mode', lsp.trust, { key: key('trustWorkspace'), id: 'trustWorkspace', label: 'Trust workspace', hint: 'Open Manage Workspace Trust.' });
    if (a.state === 'Ready') return section('ok', lsp.ready, lsp.meaning);
    if (a.state === 'Partial' && a.reasonCode === 'CargoNotFound') {
      return section('warning', 'Rust works partially: cargo (the Rust toolchain) was not found', a.message ?? '', { key: key('installRust'), id: 'installRust', label: 'Install Rust', hint: `Opens ${RUSTUP_URL} in your browser. Refyntra does not install anything itself.`, arg: RUSTUP_URL }, [restart]);
    }
    if (a.state === 'Partial') return section('warning', `${name} works partially`, a.message ?? '', undefined, [restart]);
    if (a.state === 'NotStarted') return section('info', `${name}: starts when you open a ${name} file`, a.message ?? '');
    if (a.state === 'Loading' || a.state === 'Restarting') return section('loading', `${name}: ${a.state === 'Restarting' ? 'restarting' : 'loading'}…`, a.message ?? `${lsp.server} is starting.`);
    if (a.reasonCode === 'ServerNotFound') return section('error', `${name} is not available`, a.message ?? `${lsp.server} is not bundled for this platform.`);
    return section('error', `${name} is not running`, `${lsp.server} could not start or stopped${a.message ? ` (${a.message})` : ''}. Restart it; if that does not help, export a debug bundle and report the problem.`, restart);
  }
  if (a.state === 'Ready') {
    return section('ok', TS_HEADLINE[a.state] && a.adapterId === 'typescript' ? TS_HEADLINE[a.state]! : `${name}: ready`, a.adapterId === 'typescript' ? 'Related, Find and Rename for TypeScript and JavaScript files use the language support built into VS Code; nothing to set up.' : '');
  }
  const icon: StatusIcon = a.state === 'Loading' || a.state === 'Restarting' || a.state === 'NotStarted' ? 'loading' : a.state === 'TrustRequired' ? 'locked' : 'warning';
  return section(icon, `${name}: ${a.state === 'NotStarted' ? 'starts when you open a file' : a.state.toLowerCase()}`, a.message ?? '');
}

/** The "Run and debug" section: what can be run and debugged here, and why not. */
export function debugSection(d: DebugHealth, trusted: boolean): LanguageSection {
  const ver = (v: string | undefined) => (v ? v.replace(/\s*\(.*$/, '') : undefined);
  const parts: string[] = [];
  parts.push(d.netcoredbg.path ? `.NET: debugging with the bundled ${ver(d.netcoredbg.version) ?? 'netcoredbg'} (MIT, Samsung); running with dotnet run${d.dotnet ? '' : ' (dotnet was not found on PATH)'}.` : `.NET: ${d.netcoredbg.reason ?? 'netcoredbg is not available.'}`);
  parts.push(d.debugpy.path ? `Python: debugging with the bundled ${ver(d.debugpy.version) ?? 'debugpy'} (MIT) and ${d.python ? `the interpreter ${d.python}` : 'a Python interpreter, but none was found (install Python or create a .venv)'}.` : 'Python: the bundled debugpy is missing; reinstall Refyntra.');
  parts.push(d.lldbDap ? `Rust: cargo run${d.cargo ? '' : ' (cargo was not found)'}; debugging with lldb-dap from the installed LLVM (${d.lldbDap}).` : `Rust: cargo run${d.cargo ? '' : ' (cargo was not found)'}; debugging needs lldb-dap from an installed LLVM, which was not found (Refyntra does not bundle a Rust debugger, see ADR-008).`);
  parts.push('Node.js: package.json scripts run with npm, pnpm or yarn; debugging uses the JavaScript debugger built into VS Code.');
  if (!trusted) return { adapterId: 'debug', icon: 'locked', headline: 'Run and debug: Restricted Mode', meaning: `Building and running execute code from this workspace, so Refyntra runs and debugs nothing until you trust it. ${parts.join(' ')}`, more: [], groups: [] };
  const icon: StatusIcon = d.netcoredbg.path && d.debugpy.path ? 'ok' : 'warning';
  const headline = d.netcoredbg.path ? 'Run and debug: ready' : 'Run and debug: .NET debugging is unavailable on this platform';
  return { adapterId: 'debug', icon, headline, meaning: parts.join(' '), more: [], groups: [] };
}

export function buildHealthPage(input: HealthPageInput): HealthPageModel {
  const { health, restore } = input;
  const used = new Map<string, number>();
  const key = (id: HealthActionId) => {
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
  const ordered = [...health.adapters].sort((x, y) => (x.adapterId === 'csharp' ? -1 : y.adapterId === 'csharp' ? 1 : 0));
  const sections = ordered.map((a) => (a.adapterId === 'csharp' ? csharpSection(a, health.workspaceTrusted, key, restore) : otherSection(a, key)));
  if (input.debug) sections.push(debugSection(input.debug, health.workspaceTrusted));
  const model: HealthPageModel = {
    sections,
    secondary: [
      { key: key('exportDebugBundle'), id: 'exportDebugBundle', label: 'Export debug bundle', hint: 'Save a redacted report (no source code) to attach to an issue.' },
      { key: key('getStarted'), id: 'getStarted', label: 'Get started', hint: 'Open the Refyntra walkthrough.' },
      { key: key('copyText'), id: 'copyText', label: 'Copy as text', hint: 'Copy this page, technical details included, as Markdown.' },
      { key: key('showText'), id: 'showText', label: 'Open as text', hint: 'Open this page as a Markdown document (Refyntra: Show Health (text)).' },
    ],
  };
  if (restore?.state === 'running') model.restoreBanner = { icon: 'loading', text: `Restoring NuGet packages for ${basename(restore.target)}… The solution reloads by itself when the restore finishes.`, action: { key: key('showRestoreOutput'), id: 'showRestoreOutput', label: 'Show restore output' } };
  else if (restore?.state === 'succeeded') model.restoreBanner = { icon: 'ok', text: `Packages restored for ${basename(restore.target)}. Reloading the solution…` };
  else if (restore?.state === 'failed') model.restoreBanner = { icon: 'error', text: `The restore of ${basename(restore.target)} failed${restore.exitCode !== undefined ? ` (exit code ${restore.exitCode})` : ''}. The output shows why (for example no network access or a package that does not exist).`, action: { key: key('showRestoreOutput'), id: 'showRestoreOutput', label: 'Show restore output' } };
  return model;
}

/** Every action in the model, for the message allow-list lookup. */
export function modelActions(m: HealthPageModel): HealthAction[] {
  return [...m.sections.flatMap((s) => [...(s.primary ? [s.primary] : []), ...s.more]), ...(m.restoreBanner?.action ? [m.restoreBanner.action] : []), ...m.secondary];
}

/** Resolves a webview message to an action of the current model; anything else is ignored. */
export function resolveMessage(m: HealthPageModel, msg: unknown): HealthAction | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const { type, key } = msg as { type?: unknown; key?: unknown };
  if (type !== 'action' || typeof key !== 'string') return undefined;
  const a = modelActions(m).find((x) => x.key === key);
  return a && HEALTH_ACTION_IDS.includes(a.id) ? a : undefined;
}

/** Plain-text rendering of the user part of the page (Copy as text, tests, reports). */
export function renderHealthPageText(m: HealthPageModel): string {
  const out: string[] = ['Refyntra Health', ''];
  if (m.restoreBanner) out.push(`${ICON_GLYPH[m.restoreBanner.icon]} ${m.restoreBanner.text}${m.restoreBanner.action ? ` [${m.restoreBanner.action.label}]` : ''}`, '');
  for (const s of m.sections) {
    out.push(`${ICON_GLYPH[s.icon]} ${s.headline}`);
    if (s.meaning) out.push(`   ${s.meaning}`);
    const buttons = [...(s.primary ? [`[${s.primary.label}]`] : []), ...s.more.map((a) => `(${a.label})`)];
    if (buttons.length) out.push(`   ${buttons.join(' ')}`);
    if (s.groups.length) {
      out.push('', '   Projects');
      for (const g of s.groups) {
        out.push(`   ▸ ${g.title}: ${g.summary}`);
        for (const p of g.projects) for (const pr of p.problems) out.push(`       ${p.name}: ${pr.text}${pr.raw.length ? ' ▸ Show MSBuild message' : ''}`);
      }
    }
    out.push('');
  }
  out.push(m.secondary.map((a) => `(${a.label})`).join(' '), '', '▸ Technical details (for troubleshooting)');
  return out.join('\n');
}
