import type { TestOutcome, TrxResult } from './testingModel';

/**
 * The vstest.console design-mode protocol (version 7), as Visual Studio and other IDEs use it: messages are JSON
 * `{ Version?, MessageType, Payload }` written as .NET BinaryWriter strings (7-bit encoded length + UTF-8). Pure helpers:
 * framing, the test cases and results Refyntra reads. No VS Code, no sockets.
 */

export const VSTEST_PROTOCOL_VERSION = 7;

export interface VsTestMessage {
  MessageType: string;
  Payload?: unknown;
  Version?: number;
}

/** A discovered test case (only the fields Refyntra reads; the whole object is sent back to run it). */
export interface VsTestCase {
  Id: string;
  FullyQualifiedName: string;
  DisplayName: string;
  CodeFilePath?: string | null;
  LineNumber?: number;
  Source?: string;
  [key: string]: unknown;
}

export interface VsTestResult {
  TestCase: VsTestCase;
  /** 0 None, 1 Passed, 2 Failed, 3 Skipped, 4 NotFound. */
  Outcome: number;
  ErrorMessage?: string | null;
  ErrorStackTrace?: string | null;
  Duration?: string;
  DisplayName?: string | null;
  Messages?: { Category?: string; Text?: string }[];
}

export function encodeMessage(m: VsTestMessage): Buffer {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  const len: number[] = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([Buffer.from(len), body]);
}

/** Feeds bytes in; returns the complete messages (keeps a partial one for the next call). Throws on malformed JSON. */
export class MessageReader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): VsTestMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: VsTestMessage[] = [];
    for (;;) {
      let n = 0;
      let shift = 0;
      let i = 0;
      for (;;) {
        if (i >= this.buf.length || shift > 28) return out;
        const b = this.buf[i++]!;
        n |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      if (this.buf.length < i + n) return out;
      const text = this.buf.subarray(i, i + n).toString('utf8');
      this.buf = this.buf.subarray(i + n);
      out.push(JSON.parse(text) as VsTestMessage);
    }
  }
}

const OUTCOMES: Record<number, TestOutcome> = { 1: 'passed', 2: 'failed', 3: 'skipped' };

/** "Ns.C.M(1,2,3)" (NUnit puts the arguments in the name) → class "Ns.C", method "M". */
export function splitFullyQualifiedName(fqn: string): { className: string; methodName: string } {
  const bare = fqn.replace(/\(.*\)\s*$/s, '');
  const dot = bare.lastIndexOf('.');
  return dot < 0 ? { className: '', methodName: bare } : { className: bare.slice(0, dot), methodName: bare.slice(dot + 1) };
}

function durationMs(text: string | undefined): number | undefined {
  const m = text ? /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(text) : null;
  if (!m) return undefined;
  return Math.round(((Number(m[1] ?? 0) * 24 + Number(m[2])) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000);
}

/** A discovered test case in the result shape the tree matching uses (outcome is a placeholder). */
export function caseAsResult(c: VsTestCase): TrxResult {
  return { ...splitFullyQualifiedName(c.FullyQualifiedName), testName: c.DisplayName, outcome: 'skipped' };
}

export function toTrxResult(r: VsTestResult): TrxResult {
  const out: TrxResult = { ...splitFullyQualifiedName(r.TestCase.FullyQualifiedName), testName: r.DisplayName || r.TestCase.DisplayName, outcome: OUTCOMES[r.Outcome] ?? 'errored' };
  const d = durationMs(r.Duration);
  if (d !== undefined) out.durationMs = d;
  if (r.ErrorMessage) out.message = r.ErrorMessage;
  if (r.ErrorStackTrace) out.stackTrace = r.ErrorStackTrace;
  const stdout = (r.Messages ?? []).filter((m) => /StdOut/i.test(m.Category ?? '')).map((m) => m.Text ?? '').join('');
  if (stdout) out.stdout = stdout;
  return out;
}

export const EMPTY_RUN_SETTINGS = '<RunSettings><RunConfiguration><DisableAppDomain>true</DisableAppDomain></RunConfiguration></RunSettings>';

/** How vstest.console asks the editor to start the test host itself (TestExecution.CustomTestHostLaunch, debugging). */
export interface VsTestProcessStartInfo {
  FileName: string;
  Arguments?: string | null;
  WorkingDirectory?: string | null;
  EnvironmentVariables?: Record<string, string> | null;
}

/** Splits a Windows-style command line (double quotes group, backslashes escape quotes) into arguments. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      has = true;
    } else if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}
