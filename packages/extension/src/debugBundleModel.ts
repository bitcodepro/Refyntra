// Export Debug Bundle: pure model, no vscode. What the bundle contains is decided here and only here,
// so the unit tests in test/unit/debugBundle.test.ts cover exactly what a user would save.
//
// Contents: extension/host versions, protocol, VS Code version, OS, SDK version, per-adapter health with redacted
// paths, the last N log lines of the output channel, restart counts and timings.
// Never: source text, environment values, network data. Paths under the user's home and the workspace roots are
// replaced by placeholders; project and solution names are replaced by neutral ids unless the user opts in.
import type { HealthSummary } from '@refyntra/domain';

export const DEBUG_BUNDLE_FORMAT = 'refyntra-debug-bundle/1';
export const DEFAULT_LOG_LINES = 200;

export interface DebugBundleInput {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  os: { platform: string; release: string; arch: string };
  health: HealthSummary;
  /** Output channel lines (already filtered by the logger: no text/edit/env fields). */
  logLines: readonly string[];
  homeDir: string | undefined;
  workspaceRoots: readonly string[];
}

export interface DebugBundleOptions {
  /** Keep project and solution names (paths stay redacted). Default: off. */
  includeProjectNames: boolean;
  maxLogLines?: number;
}

export interface Placeholder {
  root: string;
  placeholder: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every spelling a root path can take in logs and messages: native, forward slashes, file URI (encoded or not). */
export function pathVariants(root: string): string[] {
  const trimmed = root.replace(/[\\/]+$/, '');
  if (!trimmed) return [];
  const forward = trimmed.replace(/\\/g, '/');
  const backward = trimmed.replace(/\//g, '\\');
  const variants = new Set<string>([trimmed, forward, backward, JSON.stringify(trimmed).slice(1, -1)]);
  // file URIs as VS Code prints them: file:///c%3A/Users/... (drive colon and non-ASCII percent-encoded).
  const segments = forward.split('/');
  const encoded = segments.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? `${seg[0]}%3A` : encodeURIComponent(seg))).join('/');
  const slash = forward.startsWith('/') ? '' : '/';
  variants.add(`file://${slash}${encoded}`);
  variants.add(`file://${slash}${forward}`);
  variants.add(`file://${slash}${encodeURI(forward)}`);
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Replaces every spelling of each root by its placeholder (longest roots first; case-insensitive). */
export function redactPaths(text: string, placeholders: readonly Placeholder[]): string {
  let out = text;
  const ordered = [...placeholders].filter((p) => p.root.trim()).sort((a, b) => b.root.length - a.root.length);
  for (const p of ordered) {
    for (const v of pathVariants(p.root)) {
      out = out.replace(new RegExp(`${escapeRe(v)}(?=$|[\\\\/"'\\s:;,)\\]}?#]|%5C|%2F)`, 'gi'), p.placeholder);
    }
  }
  return out;
}

/** Replaces whole-name occurrences of project/solution names by neutral ids (longest names first). */
export function redactNames(text: string, names: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [name, id] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (!name) continue;
    out = out.replace(new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, 'g'), id);
  }
  return out;
}

const fileStem = (p: string) => (p.split(/[\\/]/).pop() ?? '').replace(/\.(sln|slnx|csproj)$/i, '');

/** Unstructured host output (raw stderr of MSBuild/BuildHost) may quote anything: it never goes into a bundle. */
const UNSTRUCTURED = /\[host:stderr\]/;
const DURATION = /\] \[([^\]]+)\] (\S+).*\bdurationMs=(\d+)/;

export interface DebugBundle {
  format: string;
  generatedAt: string;
  privacy: {
    note: string;
    projectNamesIncluded: boolean;
    placeholders: string[];
  };
  versions: { extension: string; vscode: string; backends: Array<{ adapter: string; engineVersion?: string; protocol?: string }> };
  os: { platform: string; release: string; arch: string };
  workspaceTrusted: boolean;
  adapters: Array<Record<string, unknown>>;
  timings: Array<{ component: string; operation: string; count: number; maxMs: number; avgMs: number }>;
  log: { lines: string[]; omittedUnstructured: number; limit: number };
}

export function buildDebugBundle(input: DebugBundleInput, options: DebugBundleOptions): DebugBundle {
  const placeholders: Placeholder[] = [];
  input.workspaceRoots.forEach((root, i) => placeholders.push({ root, placeholder: input.workspaceRoots.length > 1 ? `<workspace-${i + 1}>` : '<workspace>' }));
  if (input.homeDir) placeholders.push({ root: input.homeDir, placeholder: '<home>' });

  const names = new Map<string, string>();
  if (!options.includeProjectNames) {
    let n = 0;
    let s = 0;
    for (const a of input.health.adapters) {
      if (a.solutionPath) {
        const stem = fileStem(a.solutionPath);
        if (stem && !names.has(stem)) names.set(stem, `solution-${++s}`);
      }
      for (const p of a.projects) {
        for (const nm of [p.name, fileStem(p.projectPath)]) if (nm && !names.has(nm)) names.set(nm, `project-${++n}`);
      }
    }
  }
  const redact = (s: string) => redactNames(redactPaths(s, placeholders), names);

  const adapters = input.health.adapters.map((a) => ({
    adapter: a.adapterId,
    route: a.providerRouteId,
    state: a.state,
    reasonCode: a.reasonCode,
    message: a.message,
    sdk: a.sdk ? { version: a.sdk.version, path: a.sdk.path } : undefined,
    solutionPath: a.solutionPath,
    hostDescription: a.hostDescription,
    restartCount: a.restartCount,
    lastLoadDurationMs: a.lastLoadDurationMs,
    recoveryActions: a.recoveryActions.map((r) => r.command),
    projects: a.projects.map((p) => ({
      name: p.name,
      projectPath: p.projectPath,
      targetFramework: p.targetFramework,
      state: p.state,
      documentCount: p.documentCount,
      diagnostics: p.diagnostics.map((d) => ({ severity: d.severity, message: d.message })),
    })),
    diagnostics: a.diagnostics.map((d) => ({ severity: d.severity, message: d.message, projectPath: d.projectPath })),
  }));

  const limit = options.maxLogLines ?? DEFAULT_LOG_LINES;
  const structured = input.logLines.filter((l) => !UNSTRUCTURED.test(l));
  const lines = structured.slice(-limit);

  const stats = new Map<string, { component: string; operation: string; count: number; maxMs: number; total: number }>();
  for (const l of structured) {
    const m = DURATION.exec(l);
    if (!m) continue;
    const component = m[1] ?? '';
    const operation = m[2] ?? '';
    const key = `${component} ${operation}`;
    const e = stats.get(key) ?? { component, operation, count: 0, maxMs: 0, total: 0 };
    const ms = Number(m[3]);
    e.count++;
    e.total += ms;
    e.maxMs = Math.max(e.maxMs, ms);
    stats.set(key, e);
  }

  const bundle: DebugBundle = {
    format: DEBUG_BUNDLE_FORMAT,
    generatedAt: input.generatedAt,
    privacy: {
      note: 'Local file written by you. No source text, no environment values; paths under your home and workspace are replaced by placeholders. Nothing is sent anywhere.',
      projectNamesIncluded: options.includeProjectNames,
      placeholders: [...new Set(placeholders.map((p) => p.placeholder))],
    },
    versions: {
      extension: input.extensionVersion,
      vscode: input.vscodeVersion,
      backends: input.health.adapters.filter((a) => a.backend).map((a) => ({ adapter: a.adapterId, engineVersion: a.backend?.engineVersion, protocol: a.backend?.protocol })),
    },
    os: { ...input.os },
    workspaceTrusted: input.health.workspaceTrusted,
    adapters,
    timings: [...stats.values()].map((e) => ({ component: e.component, operation: e.operation, count: e.count, maxMs: e.maxMs, avgMs: Math.round(e.total / e.count) })),
    log: { lines, omittedUnstructured: input.logLines.length - structured.length, limit },
  };
  return deepMapStrings(bundle, (s, key) => (key === 'format' || key === 'generatedAt' ? s : redact(s)));
}

function deepMapStrings<T>(value: T, f: (s: string, key: string | undefined) => string, key?: string): T {
  if (typeof value === 'string') return f(value, key) as T;
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, f, key)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = deepMapStrings(v, f, k);
    return out as T;
  }
  return value;
}

/** The exact bytes that are previewed and then saved. */
export function renderDebugBundle(bundle: DebugBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Fixed-size ring of output-channel lines (the bundle's log source). */
export class LogRing {
  private readonly lines: string[] = [];
  constructor(private readonly capacity = 1000) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }
  snapshot(): string[] {
    return [...this.lines];
  }
}
