import type { EfContextInfo, EfMigrationsResult, Location } from '@refyntra/contracts';

// Pure part of the EF Core tools (no vscode import): the tree model, the dotnet-ef command lines, parsing of
// `dotnet ef` output and of debugger results. Unit-tested (test/unit/efCore.test.ts).

/** Applied/pending per migration id, from an explicit "Check status" (dotnet ef migrations list --json). */
export interface EfContextStatus {
  /** id → applied; ids the database knows but the source does not are listed in `unknown`. */
  applied: Map<string, boolean>;
  /** False when dotnet ef could not reach the database (no applied flags in its output). */
  connected: boolean;
  checkedAt: string;
}

export type EfNodeKind = 'context' | 'migration' | 'snapshot' | 'configuration' | 'info';

export interface EfNode {
  kind: EfNodeKind;
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** Codicon id. */
  icon: string;
  /** For `contextValue` (menus): refyntra.ef.<kind>[.last]. */
  contextValue: string;
  location?: Location | null;
  context?: EfContextInfo;
  migrationId?: string;
  children?: EfNode[];
}

const contextKey = (c: EfContextInfo) => `${c.projectUri}#${c.fullName}`;
export { contextKey as efContextKey };

/** The tree: DbContexts (alphabetical, as the host sends them) → migrations in id order, snapshot, configurations. */
export function buildEfTree(result: EfMigrationsResult | undefined, status: ReadonlyMap<string, EfContextStatus> = new Map()): EfNode[] {
  if (!result) return [];
  const sameName = new Set(result.contexts.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i));
  return result.contexts.map((c) => {
    const key = contextKey(c);
    const st = status.get(key);
    const children: EfNode[] = c.migrations.map((m, i) => {
      const applied = st?.connected ? st.applied.get(m.id) : undefined;
      const state = applied === undefined ? undefined : applied ? 'applied' : 'pending';
      return {
        kind: 'migration' as const,
        id: `${key}/m/${m.id}`,
        label: m.name,
        description: [m.id.slice(0, 14).match(/^\d{14}$/) ? formatTimestamp(m.id.slice(0, 14)) : undefined, state].filter(Boolean).join(' · ') || undefined,
        tooltip: `${m.id}${state ? ` (${state})` : ''}\n${c.name} migration ${i + 1} of ${c.migrations.length}`,
        icon: state === 'applied' ? 'pass' : state === 'pending' ? 'circle-large-outline' : 'git-commit',
        contextValue: i === c.migrations.length - 1 ? 'refyntra.ef.migration.last' : 'refyntra.ef.migration',
        location: m.location ?? m.designerLocation ?? null,
        context: c,
        migrationId: m.id,
      };
    });
    if (c.migrations.length === 0) children.push({ kind: 'info', id: `${key}/none`, label: 'No migrations yet', description: 'Add Migration creates the first one', icon: 'info', contextValue: 'refyntra.ef.info', context: c });
    if (c.snapshot) children.push({ kind: 'snapshot', id: `${key}/snapshot`, label: 'Model snapshot', description: c.snapshot.name, icon: 'file-code', contextValue: 'refyntra.ef.snapshot', location: c.snapshot.location ?? null, context: c });
    for (const cfg of c.configurations)
      children.push({ kind: 'configuration', id: `${key}/cfg/${cfg.name}`, label: cfg.name, description: 'configuration', icon: 'settings-gear', contextValue: 'refyntra.ef.configuration', location: cfg.location ?? null, context: c });
    const pending = st?.connected ? c.migrations.filter((m) => st.applied.get(m.id) === false).length : undefined;
    const stale = !!st?.connected && c.migrations.some((m) => !st.applied.has(m.id));
    const statusText = !st ? undefined : !st.connected ? 'status unknown (database not reachable)' : stale ? 'status out of date (check again)' : pending ? `${pending} pending` : 'up to date';
    return {
      kind: 'context' as const,
      id: key,
      label: c.name,
      description: [sameName.has(c.name) ? c.projectName : undefined, `${c.migrations.length} migration${c.migrations.length === 1 ? '' : 's'}`, statusText].filter(Boolean).join(' · '),
      tooltip: `${c.fullName}\nProject: ${c.projectName}${c.migrationsNamespace ? `\nMigrations: ${c.migrationsNamespace}` : ''}${st ? `\nStatus checked ${st.checkedAt}` : '\nApplied/pending: use Check Status (runs dotnet ef migrations list)'}`,
      icon: 'database',
      contextValue: 'refyntra.ef.context',
      location: c.onModelCreating ?? c.location ?? null,
      context: c,
      children,
    };
  });
}

function formatTimestamp(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`;
}

// ---------------------------------------------------------------- dotnet ef command lines

export interface EfTarget {
  /** The migrations project (.csproj path). */
  project: string;
  /** The startup project (.csproj path). */
  startupProject: string;
  /** The DbContext's full name. */
  context: string;
}

export type EfCommand =
  | { kind: 'add'; name: string }
  | { kind: 'remove' }
  | { kind: 'update'; migration?: string }
  | { kind: 'script'; from?: string; to?: string; idempotent: boolean; output: string }
  | { kind: 'list' };

/** Arguments of `dotnet` (never a shell string): each value is one argument, so spaces and quotes stay literal. */
export function efArgs(cmd: EfCommand, t: EfTarget): string[] {
  const verb: string[] = (() => {
    switch (cmd.kind) {
      case 'add':
        return ['migrations', 'add', cmd.name];
      case 'remove':
        return ['migrations', 'remove'];
      case 'update':
        return ['database', 'update', ...(cmd.migration ? [cmd.migration] : [])];
      case 'script':
        return ['migrations', 'script', ...(cmd.from || cmd.to ? [cmd.from ?? '0'] : []), ...(cmd.to ? [cmd.to] : []), ...(cmd.idempotent ? ['--idempotent'] : []), '--output', cmd.output];
      case 'list':
        return ['migrations', 'list', '--json'];
    }
  })();
  return ['ef', ...verb, '--project', t.project, '--startup-project', t.startupProject, '--context', t.context];
}

/** True for commands that connect to the database (they need the user's confirmation). */
export function touchesDatabase(cmd: EfCommand): boolean {
  return cmd.kind === 'update' || cmd.kind === 'remove' || cmd.kind === 'list';
}

/** The command line as shown to the user (POSIX-style quoting for display only; it is never run through a shell). */
export function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForDisplay).join(' ');
}

function quoteForDisplay(a: string): string {
  if (a !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a)) return a;
  return `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** A migration name dotnet ef accepts as a class name. */
export function migrationNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'Enter a name, e.g. AddCustomerEmail.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Use letters, digits and underscores, starting with a letter (it becomes a C# class name).';
  return undefined;
}

// ---------------------------------------------------------------- parsing dotnet ef output

/**
 * `dotnet ef migrations list --json` prints build lines and then a JSON array of {id, name, safeName, applied}. When
 * the database cannot be reached the array has no `applied` flags (connected false).
 */
export function parseMigrationsList(stdout: string): { migrations: { id: string; applied?: boolean }[]; connected: boolean } | undefined {
  const start = stdout.search(/^\s*\[/m);
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const migrations = data
    .filter((m): m is { id: string; applied?: unknown } => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string')
    .map((m) => (typeof m.applied === 'boolean' ? { id: m.id, applied: m.applied } : { id: m.id }));
  return { migrations, connected: migrations.length === 0 || migrations.every((m) => m.applied !== undefined) };
}

export function statusFromList(parsed: NonNullable<ReturnType<typeof parseMigrationsList>>, checkedAt: string): EfContextStatus {
  return { applied: new Map(parsed.migrations.filter((m) => m.applied !== undefined).map((m) => [m.id, m.applied!])), connected: parsed.connected, checkedAt };
}

/** `dotnet ef --version` → "9.0.10" (the last version-looking line), or undefined. */
export function parseEfVersion(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$/.test(l));
  return lines.at(-1);
}

/** True when a dotnet-tools.json (local tool manifest) lists dotnet-ef. */
export function manifestHasDotnetEf(json: string): boolean {
  try {
    const m = JSON.parse(json) as { tools?: Record<string, unknown> };
    return !!m.tools && Object.keys(m.tools).some((k) => k.toLowerCase() === 'dotnet-ef');
  } catch {
    return false;
  }
}

export type EfToolState =
  | { state: 'unknown' }
  | { state: 'found'; version: string; source: 'local' | 'global' }
  | { state: 'missing'; localManifest: boolean; detail?: string };

export const INSTALL_DOTNET_EF = 'dotnet tool install --global dotnet-ef';

/** The Health line for the EF Core tools. */
export function efHealthText(tool: EfToolState, contexts: number): string {
  const ctx = `${contexts} DbContext${contexts === 1 ? '' : 's'} found from source`;
  switch (tool.state) {
    case 'unknown':
      return `${ctx}; dotnet-ef not checked yet (it is checked when you use an EF Core action).`;
    case 'found':
      return `${ctx}; dotnet-ef ${tool.version} (${tool.source === 'local' ? 'local tool manifest' : 'global or on PATH'}) runs migrations commands as tasks.`;
    case 'missing':
      return tool.localManifest
        ? `${ctx}; dotnet-ef is listed in the local tool manifest but not restored. Run "dotnet tool restore" yourself; Refyntra never installs tools.`
        : `${ctx}; dotnet-ef was not found. Install it yourself with "${INSTALL_DOTNET_EF}" (Refyntra never installs tools). The tree and navigation work without it.`;
  }
}

// ---------------------------------------------------------------- LINQ → SQL in a debug session

/**
 * The expressions to evaluate, in order: EF Core's DebugView.Query (a property, the same text as ToQueryString(); the
 * debugger needs no method call), then the static call and the extension call (some debuggers cannot call methods).
 */
export function toQueryStringExpressions(selection: string): string[] {
  const e = selection.trim().replace(/;+\s*$/, '');
  return [`(${e}).DebugView.Query`, `Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToQueryString(${e})`, `(${e}).ToQueryString()`];
}

/** A debugger's display of a string ("\"SELECT ...\\n...\"") → the string; undefined when it is not a string. */
export function parseDebuggerString(result: string | undefined): string | undefined {
  if (result === undefined) return undefined;
  const t = result.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return undefined;
  const body = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\' || i + 1 >= body.length) {
      out += ch;
      continue;
    }
    const n = body[++i]!;
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case '0': out += '\0'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '\\': out += '\\'; break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += '\\u';
        break;
      }
      default:
        out += '\\' + n;
    }
  }
  return out;
}

/** Why the selection cannot be an IQueryable expression (empty, several statements), or undefined. */
export function selectionProblem(selection: string): string | undefined {
  const t = selection.trim();
  if (!t) return 'Select an IQueryable expression (for example a query variable or db.Orders.Where(...)).';
  if (/;\s*\S/.test(t) || /^\s*(var|return|foreach|if|using)\b/.test(t)) return 'Select only the query expression, not a statement.';
  return undefined;
}
