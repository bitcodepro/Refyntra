// Pure parts of the Rider-style debugger extras for .NET (debugExtras.ts): the netcoredbg capability table, the Smart
// Step Into picker items and the exception-type breakpoints merged into VS Code's setExceptionBreakpoints. No vscode
// import: unit-tested directly.
import type { StepIntoReason, StepIntoTarget, StepIntoTargetsResult } from '@refyntra/contracts';

/**
 * What the bundled netcoredbg 3.2.0-1092 does, from its DAP `initialize` response and a probe of each request
 * (ADR-008, "Debugger capabilities"; the Docker e2e compares the live response with this table).
 */
export const NETCOREDBG_CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsFunctionBreakpoints: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: false,
  supportsLogPoints: false,
  supportsSetVariable: true,
  supportsSetExpression: true,
  supportsExceptionInfoRequest: true,
  supportsExceptionFilterOptions: true,
  supportsExceptionOptions: false,
  supportsTerminateRequest: true,
  supportsCancelRequest: true,
  supportsStepInTargetsRequest: false,
  supportsGotoTargetsRequest: false,
  supportsRestartFrame: false,
  supportsDataBreakpoints: false,
  supportsCompletionsRequest: false,
} as const;

/** The capability names the e2e compares (absent in the response = false). */
export const NETCOREDBG_CAPABILITY_NAMES = Object.keys(NETCOREDBG_CAPABILITIES) as (keyof typeof NETCOREDBG_CAPABILITIES)[];

/** The Health line on the .NET debugger features: what works, what Refyntra adds, what netcoredbg cannot do. */
export function dotnetDebugFeaturesText(): string {
  return (
    '.NET debugger features: conditional breakpoints, function breakpoints, Run to Cursor, Break on Exception Types ' +
    '(exact type names), Smart Step Into (Refyntra, through the C# host), hit counts and logpoints (Refyntra emulates ' +
    'them: each hit is a real stop and resume, so they slow hot loops). Not supported by netcoredbg, so not offered: ' +
    'Set Next Statement (Jump to Cursor), Edit and Continue (Hot Reload while paused), Restart Frame and data breakpoints.'
  );
}

export const REASON_TEXT: Record<StepIntoReason, string> = {
  metadata: 'no source in the solution (a library or framework method): Refyntra cannot step into it',
  noBody: 'abstract or interface member: the method that runs is chosen at run time',
  delegate: 'a delegate call: the method that runs is known only at run time',
  implicit: 'a compiler-generated constructor: there is no source to stop in',
};

export interface StepIntoItem {
  label: string;
  description: string;
  detail?: string;
  target: StepIntoTarget;
  /** False when Refyntra cannot step into the call (the reason is in `detail`). */
  enabled: boolean;
}

/** The picker items, in the order the calls run; calls that cannot be stepped into stay listed with the reason. */
export function stepIntoItems(result: StepIntoTargetsResult): StepIntoItem[] {
  return result.targets.map((t) => {
    const enabled = !!t.breakAt;
    const notes: string[] = [];
    if (!enabled) notes.push(REASON_TEXT[t.reason ?? 'metadata']);
    else if (t.isVirtual) notes.push('virtual: stops only if this implementation runs (an override may run instead)');
    return {
      label: `${enabled ? '$(debug-step-into)' : '$(circle-slash)'} ${t.label}`,
      description: t.detail,
      ...(notes.length ? { detail: notes.join('; ') } : {}),
      target: t,
      enabled,
    };
  });
}

/** 1-based line of a path, as DAP reports frames. */
export interface SourceLine {
  path: string;
  line: number;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
export const samePath = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return /^[A-Z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export type SmartStepStop = 'target' | 'returned' | 'elsewhere';

/** Where a Smart Step Into stopped: in the chosen call, at the next statement (the call was not made), or elsewhere. */
export function classifyStop(at: SourceLine | undefined, target: SourceLine, guard: SourceLine | undefined): SmartStepStop {
  if (!at) return 'elsewhere';
  if (samePath(at.path, target.path) && at.line === target.line) return 'target';
  if (guard && samePath(at.path, guard.path) && at.line === guard.line) return 'returned';
  return 'elsewhere';
}

/** A .NET exception type name netcoredbg can match: the full name (namespace and type), as the runtime reports it. */
export function isExceptionTypeName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_`]*)+(\+[A-Za-z_][A-Za-z0-9_`]*)*$/.test(s.trim());
}

/** Common exception types offered in the picker (any other full name can be typed). */
export const COMMON_EXCEPTION_TYPES = [
  'System.InvalidOperationException',
  'System.ArgumentException',
  'System.ArgumentNullException',
  'System.ArgumentOutOfRangeException',
  'System.NullReferenceException',
  'System.NotImplementedException',
  'System.NotSupportedException',
  'System.FormatException',
  'System.InvalidCastException',
  'System.IndexOutOfRangeException',
  'System.Collections.Generic.KeyNotFoundException',
  'System.IO.IOException',
  'System.IO.FileNotFoundException',
  'System.UnauthorizedAccessException',
  'System.TimeoutException',
  'System.OperationCanceledException',
  'System.Threading.Tasks.TaskCanceledException',
  'System.Net.Http.HttpRequestException',
  'System.Text.Json.JsonException',
] as const;

export interface ExceptionBreakpointsArgs {
  filters?: string[];
  filterOptions?: { filterId: string; condition?: string }[];
  exceptionOptions?: unknown[];
}

/**
 * The setExceptionBreakpoints Refyntra sends after VS Code's own one when exception types are configured: the filters
 * the user ticked plus netcoredbg's `all` filter with the type names as its condition (netcoredbg breaks when an
 * exception of exactly one of these types is thrown; base types and wildcards do not match). Undefined when nothing
 * needs to be added: no types, or `all` is ticked (every exception breaks anyway).
 */
export function exceptionBreakpointsWithTypes(vs: ExceptionBreakpointsArgs | undefined, types: readonly string[]): ExceptionBreakpointsArgs | undefined {
  const names = [...new Set(types.map((t) => t.trim()).filter(isExceptionTypeName))];
  if (names.length === 0) return undefined;
  const ticked = new Set<string>([...(vs?.filters ?? []), ...(vs?.filterOptions ?? []).filter((f) => !f.condition).map((f) => f.filterId)]);
  if (ticked.has('all')) return undefined;
  return { filters: [...ticked], filterOptions: [{ filterId: 'all', condition: names.join(',') }] };
}

/** Whether a setExceptionBreakpoints was sent by Refyntra (its `all` filter carries a condition). */
export function isRefyntraExceptionRequest(args: ExceptionBreakpointsArgs | undefined): boolean {
  return !!args?.filterOptions?.some((f) => f.filterId === 'all' && !!f.condition);
}
