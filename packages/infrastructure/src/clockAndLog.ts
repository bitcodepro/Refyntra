import type { Clock, Disposable, LogLevel, Logger } from '@refyntra/application';

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback: () => void, ms: number): Disposable {
    const handle = setTimeout(callback, ms);
    return { dispose: () => clearTimeout(handle) };
  },
};

/** Anything with appendLine, e.g. a vscode.OutputChannel. */
export interface LineSink {
  appendLine(line: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys that could carry source text, edits or environment values: never written to the log. */
const REDACTED_KEYS = new Set(['text', 'newtext', 'content', 'contents', 'source', 'edits', 'env', 'environment', 'params', 'preview']);

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v.length > 300 ? JSON.stringify(`${v.slice(0, 300)}…`) : /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    // Nested objects/arrays: text-bearing keys are redacted at any depth.
    const s = JSON.stringify(v, (k, val: unknown) => (k && REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : val));
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

export class SinkLogger implements Logger {
  constructor(
    private readonly sink: LineSink,
    private readonly minLevel: () => LogLevel = () => 'info',
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(level: LogLevel, component: string, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel()]) return;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined) continue;
      parts.push(REDACTED_KEYS.has(k.toLowerCase()) ? `${k}=[redacted]` : `${k}=${formatValue(v)}`);
    }
    try {
      this.sink.appendLine(`${this.now().toISOString()} [${level}] [${component}] ${message}${parts.length ? ` ${parts.join(' ')}` : ''}`);
    } catch {
      // A closed output channel must not break the caller.
    }
  }
}
