// Logpoints and hit counts for netcoredbg, emulated in Refyntra's own DAP layer (ADR-008, "Debugger capabilities").
// netcoredbg ignores `logMessage` and `hitCondition` and stops at such breakpoints. The proxy core sits between VS Code
// and netcoredbg: it sends netcoredbg plain breakpoints (keeping the condition), remembers the extra semantics per
// breakpoint, and when netcoredbg stops at one of them it counts the hit, writes the log line and resumes without
// VS Code ever seeing the stop. No vscode import: unit-tested with a fake adapter.

/** A DAP message (request, response or event); only the fields the proxy reads are typed. */
export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event' | string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  body?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ------------------------------------------------------------------------------------------------ hit conditions

export type HitOperator = '==' | '>=' | '>' | '<' | '<=' | '%';
export interface HitCondition {
  op: HitOperator;
  n: number;
}

/**
 * Parses a hit condition as VS Code's breakpoint editor accepts it: `N` (stop at the Nth hit, like Visual Studio's
 * "hit count is equal to"), `== N` (`=` and `===` too), `>= N`, `> N`, `< N`, `<= N`, `% N` (every Nth hit).
 * Undefined for an empty condition; 'invalid' for anything else.
 */
export function parseHitCondition(text: string | undefined): HitCondition | undefined | 'invalid' {
  if (text === undefined || text.trim() === '') return undefined;
  const m = /^\s*(={1,3}|>=|>|<=|<|%)?\s*(\d+)\s*$/.exec(text);
  if (!m) return 'invalid';
  const n = Number(m[2]);
  const raw = m[1] ?? '==';
  const op: HitOperator = raw.startsWith('=') ? '==' : (raw as HitOperator);
  if (op === '%' && n === 0) return 'invalid';
  return { op, n };
}

/** Whether the breakpoint stops (or logs) at hit number `hits` (1-based). */
export function hitConditionHolds(c: HitCondition | undefined, hits: number): boolean {
  if (!c) return true;
  switch (c.op) {
    case '==':
      return hits === c.n;
    case '>=':
      return hits >= c.n;
    case '>':
      return hits > c.n;
    case '<':
      return hits < c.n;
    case '<=':
      return hits <= c.n;
    case '%':
      return hits % c.n === 0;
  }
}

// ------------------------------------------------------------------------------------------------ log messages

export type LogPart = { text: string } | { expr: string };

/**
 * Splits a logpoint message into text and `{expression}` parts. Expressions may contain balanced braces
 * (`{new[] { 1, 2 }.Length}`) and string or char literals with braces (`{"}" + s}`). `\{`, `\}` and `\\` are literal
 * characters. An unterminated `{` and an empty `{}` stay literal text.
 */
export function parseLogMessage(message: string): LogPart[] {
  const parts: LogPart[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) parts.push({ text });
    text = '';
  };
  while (i < message.length) {
    const ch = message[i]!;
    if (ch === '\\' && i + 1 < message.length && '{}\\'.includes(message[i + 1]!)) {
      text += message[i + 1];
      i += 2;
      continue;
    }
    if (ch !== '{') {
      text += ch;
      i++;
      continue;
    }
    const end = closingBrace(message, i);
    if (end < 0) {
      text += message.slice(i);
      break;
    }
    const expr = message.slice(i + 1, end).trim();
    if (!expr) text += message.slice(i, end + 1);
    else {
      flush();
      parts.push({ expr });
    }
    i = end + 1;
  }
  flush();
  return parts;
}

/** Index of the `}` closing the `{` at `open`, skipping nested braces and string/char literals; -1 if none. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < s.length && s[i] !== ch) i += s[i] === '\\' ? 2 : 1;
      if (i >= s.length) return -1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The log line: text parts as they are, expression parts replaced by their values (in order). */
export function formatLogMessage(parts: readonly LogPart[], values: readonly string[]): string {
  let k = 0;
  return parts.map((p) => ('text' in p ? p.text : (values[k++] ?? ''))).join('');
}

// ------------------------------------------------------------------------------------------------ the proxy core

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
function samePath(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return /^[A-Z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}
const sourceKey = (p: string) => {
  const x = norm(p);
  return /^[A-Z]:/.test(x) ? x.toLowerCase() : x;
};

/** A breakpoint whose log message or hit condition the proxy carries out. */
export interface EmulatedBreakpoint {
  id?: number;
  path: string;
  line: number;
  hitCondition?: HitCondition;
  logMessage?: LogPart[];
  hits: number;
}

type StepKind = 'next' | 'stepIn' | 'stepOut';
interface StepContext {
  kind: StepKind;
  /** Stack depth when the user's step started. */
  depth: number;
  /** The proxy stepped out of a frame the hidden hit was in. */
  unwound: boolean;
  phase: 'stepping' | 'unwinding' | 'finishing';
}

export interface DapProxyStats {
  /** Stops at emulated breakpoints the client never saw (resumed by the proxy). */
  swallowedStops: number;
  /** Log lines written for logpoints. */
  logLines: string[];
  /** netcoredbg's own initialize response body (before the proxy adds its capabilities). */
  adapterCapabilities?: Record<string, unknown>;
}

/** The capabilities the proxy adds to netcoredbg's initialize response. */
export const EMULATED_CAPABILITIES = { supportsLogPoints: true, supportsHitConditionalBreakpoints: true } as const;

/**
 * The DAP proxy between VS Code (the client) and netcoredbg (the adapter). Every request to the adapter gets the
 * proxy's own sequence number (its own requests share the numbering); responses go back with the client's number.
 * Events are handled one at a time in order, so a stop being handled finishes before the next event is looked at.
 */
export class DapProxyCore {
  private adapterSeq = 1;
  private clientSeq = 1;
  private readonly clientRequests = new Map<number, { seq: number; command: string; args: any }>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly internal = new Map<number, (r: DapMessage) => void>();
  private readonly bySource = new Map<string, EmulatedBreakpoint[]>();
  private readonly steps = new Map<number, StepContext>();
  private pauseRequested = false;
  private events: Promise<void> = Promise.resolve();
  private requests: Promise<void> = Promise.resolve();
  readonly stats: DapProxyStats = { swallowedStops: 0, logLines: [] };

  constructor(
    private readonly sendToClient: (m: DapMessage) => void,
    private readonly sendToAdapter: (m: DapMessage) => void,
  ) {}

  /** The emulated breakpoints (tests, diagnostics). */
  emulated(): EmulatedBreakpoint[] {
    return [...this.bySource.values()].flat();
  }

  private hasEmulated(): boolean {
    for (const l of this.bySource.values()) if (l.length) return true;
    return false;
  }

  /** Settles when every queued request and event has been handled (tests). */
  async idle(): Promise<void> {
    let before: [Promise<void>, Promise<void>];
    do {
      before = [this.requests, this.events];
      await Promise.all(before);
    } while (before[0] !== this.requests || before[1] !== this.events);
  }

  // ---- client → adapter

  fromClient(m: DapMessage): void {
    if (m.type !== 'request') {
      this.sendToAdapter({ ...m, seq: this.adapterSeq++ });
      return;
    }
    // Requests keep their order; only steps wait (for the stack depth) when emulated breakpoints exist.
    this.requests = this.requests.then(() => this.clientRequest(m)).catch(() => undefined);
  }

  private async clientRequest(m: DapMessage): Promise<void> {
    let args = m.arguments;
    const threadId: number | undefined = typeof args?.threadId === 'number' ? args.threadId : undefined;
    switch (m.command) {
      case 'setBreakpoints':
        args = { ...args, breakpoints: (args?.breakpoints ?? []).map(({ hitCondition: _h, logMessage: _l, ...rest }: Record<string, unknown>) => rest) };
        break;
      case 'pause':
        this.pauseRequested = true;
        break;
      case 'continue':
        if (threadId === undefined || args?.singleThread !== true) this.steps.clear();
        else this.steps.delete(threadId);
        break;
      case 'next':
      case 'stepIn':
      case 'stepOut':
        if (threadId !== undefined) {
          this.steps.delete(threadId);
          if (this.hasEmulated()) {
            const depth = await this.depth(threadId);
            if (depth !== undefined) this.steps.set(threadId, { kind: m.command, depth, unwound: false, phase: 'stepping' });
          }
        }
        break;
    }
    const seq = this.adapterSeq++;
    this.clientRequests.set(seq, { seq: m.seq, command: m.command ?? '', args: m.arguments });
    this.sendToAdapter({ ...m, seq, ...(args !== undefined ? { arguments: args } : {}) });
  }

  /** A request of the proxy itself; its response never reaches the client. */
  private request(command: string, args: unknown): Promise<DapMessage> {
    const seq = this.adapterSeq++;
    return new Promise((resolve) => {
      this.internal.set(seq, resolve);
      this.sendToAdapter({ seq, type: 'request', command, arguments: args });
    });
  }

  // ---- adapter → client

  fromAdapter(m: DapMessage): void {
    if (m.type === 'response' && typeof m.request_seq === 'number') {
      const own = this.internal.get(m.request_seq);
      if (own) {
        this.internal.delete(m.request_seq);
        own(m);
        return;
      }
      const req = this.clientRequests.get(m.request_seq);
      if (req) {
        this.clientRequests.delete(m.request_seq);
        this.toClient(this.clientResponse(m, req));
        return;
      }
    }
    if (m.type === 'event') {
      this.events = this.events.then(() => this.event(m)).catch(() => undefined);
      return;
    }
    this.toClient(m);
  }

  private toClient(m: DapMessage): void {
    this.sendToClient({ ...m, seq: this.clientSeq++ });
  }

  private clientResponse(m: DapMessage, req: { seq: number; command: string; args: any }): DapMessage { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r: DapMessage = { ...m, request_seq: req.seq };
    if (req.command === 'initialize' && m.success) {
      this.stats.adapterCapabilities = { ...(m.body ?? {}) };
      r.body = { ...(m.body ?? {}), ...EMULATED_CAPABILITIES };
    }
    if (req.command === 'setBreakpoints') r.body = this.breakpointsSet(req.args, m);
    return r;
  }

  /** Remembers the log messages and hit conditions of a source's breakpoints (netcoredbg got plain ones). */
  private breakpointsSet(args: any, m: DapMessage): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
    const path: string | undefined = args?.source?.path;
    if (!path) return m.body;
    const key = sourceKey(path);
    const old = this.bySource.get(key) ?? [];
    const requested: { line: number; hitCondition?: string; logMessage?: string }[] = args?.breakpoints ?? [];
    const answered: { id?: number; line?: number; verified?: boolean; message?: string }[] = m.success ? (m.body?.breakpoints ?? []) : [];
    const next: EmulatedBreakpoint[] = [];
    const out = answered.map((b, i) => {
      const req = requested[i];
      if (!req || (!req.hitCondition && !req.logMessage)) return b;
      const hc = parseHitCondition(req.hitCondition);
      const line = b.line ?? req.line;
      const prev = old.find((o) => (b.id !== undefined ? o.id === b.id : o.line === line));
      const e: EmulatedBreakpoint = { ...(b.id !== undefined ? { id: b.id } : {}), path, line, hits: prev?.hits ?? 0, ...(hc && hc !== 'invalid' ? { hitCondition: hc } : {}), ...(req.logMessage ? { logMessage: parseLogMessage(req.logMessage) } : {}) };
      if (e.hitCondition || e.logMessage) next.push(e);
      if (hc === 'invalid') return { ...b, message: `Hit condition "${req.hitCondition}" is not understood (use N, == N, >= N, > N, < N, <= N or % N): it is ignored.` };
      return b;
    });
    if (next.length) this.bySource.set(key, next);
    else this.bySource.delete(key);
    return m.body ? { ...m.body, breakpoints: out } : m.body;
  }

  private async event(e: DapMessage): Promise<void> {
    if (e.event === 'stopped') return this.stopped(e);
    if (e.event === 'exited' || e.event === 'terminated') {
      this.steps.clear();
      this.pauseRequested = false;
    }
    this.toClient(e);
  }

  private async stopped(e: DapMessage): Promise<void> {
    const threadId: number | undefined = e.body?.threadId;
    const ctx = threadId !== undefined ? this.steps.get(threadId) : undefined;
    if (threadId !== undefined && (e.body?.reason === 'breakpoint' || e.body?.reason === 'function breakpoint') && this.hasEmulated()) {
      const hit = await this.matchEmulated(e, threadId);
      if (hit) {
        let stop = false;
        for (const b of hit.breakpoints) {
          b.hits++;
          const holds = hitConditionHolds(b.hitCondition, b.hits);
          if (holds && b.logMessage) await this.log(b, hit.frameId);
          if (holds && !b.logMessage) stop = true;
        }
        // A plain breakpoint at the same place (another id the adapter reported) stops as usual.
        if (hit.others) stop = true;
        if (!stop) {
          this.stats.swallowedStops++;
          if (this.pauseRequested) return this.forwardStop(e, threadId, 'pause');
          if (ctx) return this.resumeStep(ctx, e, threadId);
          await this.request('continue', { threadId });
          return;
        }
      }
    } else if (ctx && ctx.phase === 'unwinding' && e.body?.reason === 'step' && threadId !== undefined) {
      return this.resumeStep(ctx, e, threadId);
    }
    this.forwardStop(e, threadId);
  }

  private forwardStop(e: DapMessage, threadId: number | undefined, reason?: string): void {
    if (threadId !== undefined) this.steps.delete(threadId);
    this.pauseRequested = false;
    if (!reason) {
      this.toClient(e);
      return;
    }
    const { hitBreakpointIds: _ids, description: _d, ...body } = e.body ?? {};
    this.toClient({ ...e, body: { ...body, reason } });
  }

  /**
   * A hidden hit interrupted the user's step (netcoredbg ends a step at a breakpoint). Finish the step the way it
   * would have gone: step out of the frames below the one the step started in, then (Step Over) finish the line.
   */
  private async resumeStep(ctx: StepContext, e: DapMessage, threadId: number): Promise<void> {
    if (ctx.kind === 'stepIn') return this.forwardStop(e, threadId, 'step');
    const d = await this.depth(threadId);
    const target = ctx.kind === 'stepOut' ? ctx.depth - 1 : ctx.depth;
    if (d !== undefined && d > target) {
      ctx.phase = 'unwinding';
      ctx.unwound = true;
      await this.request('stepOut', { threadId });
      return;
    }
    if (ctx.kind === 'next' && ctx.unwound && d === ctx.depth) {
      ctx.phase = 'finishing';
      await this.request('next', { threadId });
      return;
    }
    this.forwardStop(e, threadId, 'step');
  }

  /** The emulated breakpoints this stop is for (by the reported ids, else by the top frame's file and line). */
  private async matchEmulated(e: DapMessage, threadId: number): Promise<{ breakpoints: EmulatedBreakpoint[]; frameId?: number; others: boolean } | undefined> {
    const all = this.emulated();
    const ids: unknown = e.body?.hitBreakpointIds;
    const frame = await this.topFrame(threadId);
    if (Array.isArray(ids) && ids.length) {
      const bps = all.filter((b) => b.id !== undefined && ids.includes(b.id));
      if (!bps.length) return undefined;
      return { breakpoints: bps, ...(frame ? { frameId: frame.id } : {}), others: ids.some((id) => !bps.some((b) => b.id === id)) };
    }
    if (!frame?.source?.path) return undefined;
    const bps = all.filter((b) => b.line === frame.line && samePath(b.path, frame.source!.path!));
    return bps.length ? { breakpoints: bps, frameId: frame.id, others: false } : undefined;
  }

  private async topFrame(threadId: number): Promise<{ id: number; line: number; source?: { path?: string } } | undefined> {
    const r = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    return r.success ? r.body?.stackFrames?.[0] : undefined;
  }

  private async depth(threadId: number): Promise<number | undefined> {
    const r = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    if (!r.success) return undefined;
    if (typeof r.body?.totalFrames === 'number' && r.body.totalFrames > 0) return r.body.totalFrames;
    const all = await this.request('stackTrace', { threadId, startFrame: 0, levels: 0 });
    return all.success ? (all.body?.stackFrames?.length ?? undefined) : undefined;
  }

  private async log(b: EmulatedBreakpoint, frameId: number | undefined): Promise<void> {
    const parts = b.logMessage ?? [];
    const values: string[] = [];
    for (const p of parts) {
      if (!('expr' in p)) continue;
      const r = await this.request('evaluate', { expression: p.expr, ...(frameId !== undefined ? { frameId } : {}), context: 'watch' });
      values.push(r.success ? String(r.body?.result ?? '') : `<error: ${r.message ?? r.body?.error?.format ?? 'cannot evaluate'}>`);
    }
    const text = formatLogMessage(parts, values);
    this.stats.logLines.push(text);
    const name = norm(b.path).split('/').pop();
    this.toClient({ seq: 0, type: 'event', event: 'output', body: { category: 'console', output: `${text}\n`, source: { name, path: b.path }, line: b.line } });
  }
}
