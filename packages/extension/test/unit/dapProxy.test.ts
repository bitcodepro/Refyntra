import { describe, expect, it } from 'vitest';
import { DapProxyCore, type DapMessage, EMULATED_CAPABILITIES, formatLogMessage, hitConditionHolds, parseHitCondition, parseLogMessage } from '../../src/dapProxyModel';

describe('hit conditions', () => {
  it('parses the forms VS Code accepts', () => {
    expect(parseHitCondition('3')).toEqual({ op: '==', n: 3 });
    expect(parseHitCondition(' == 3 ')).toEqual({ op: '==', n: 3 });
    expect(parseHitCondition('=3')).toEqual({ op: '==', n: 3 });
    expect(parseHitCondition('===3')).toEqual({ op: '==', n: 3 });
    expect(parseHitCondition('>= 2')).toEqual({ op: '>=', n: 2 });
    expect(parseHitCondition('>2')).toEqual({ op: '>', n: 2 });
    expect(parseHitCondition('<= 2')).toEqual({ op: '<=', n: 2 });
    expect(parseHitCondition('< 2')).toEqual({ op: '<', n: 2 });
    expect(parseHitCondition('% 2')).toEqual({ op: '%', n: 2 });
    expect(parseHitCondition('')).toBeUndefined();
    expect(parseHitCondition(undefined)).toBeUndefined();
    for (const bad of ['% 0', 'abc', '3x', '!= 3', '-1', '>= ']) expect(parseHitCondition(bad)).toBe('invalid');
  });

  it('decides per hit', () => {
    const at = (c: string) => [1, 2, 3, 4, 5, 6].filter((h) => hitConditionHolds(parseHitCondition(c) as never, h));
    expect(at('3')).toEqual([3]);
    expect(at('== 3')).toEqual([3]);
    expect(at('>= 3')).toEqual([3, 4, 5, 6]);
    expect(at('> 3')).toEqual([4, 5, 6]);
    expect(at('< 3')).toEqual([1, 2]);
    expect(at('<= 3')).toEqual([1, 2, 3]);
    expect(at('% 2')).toEqual([2, 4, 6]);
    expect(hitConditionHolds(undefined, 1)).toBe(true);
  });
});

describe('log messages', () => {
  it('splits text and expressions', () => {
    expect(parseLogMessage('i={i}')).toEqual([{ text: 'i=' }, { expr: 'i' }]);
    expect(parseLogMessage('{a} + {b} = {a + b}!')).toEqual([{ expr: 'a' }, { text: ' + ' }, { expr: 'b' }, { text: ' = ' }, { expr: 'a + b' }, { text: '!' }]);
    expect(parseLogMessage('plain')).toEqual([{ text: 'plain' }]);
  });

  it('keeps nested braces and braces in literals inside an expression', () => {
    expect(parseLogMessage('n={new[] { 1, 2 }.Length}')).toEqual([{ text: 'n=' }, { expr: 'new[] { 1, 2 }.Length' }]);
    expect(parseLogMessage('s={"}" + s + \'{\'}.')).toEqual([{ text: 's=' }, { expr: '"}" + s + \'{\'' }, { text: '.' }]);
    expect(parseLogMessage('q={"a\\"}b"}')).toEqual([{ text: 'q=' }, { expr: '"a\\"}b"' }]);
  });

  it('escapes, empty and unterminated braces stay literal', () => {
    expect(parseLogMessage('\\{i\\} = {i}')).toEqual([{ text: '{i} = ' }, { expr: 'i' }]);
    expect(parseLogMessage('back\\\\slash \\n')).toEqual([{ text: 'back\\slash \\n' }]);
    expect(parseLogMessage('empty {} {  }')).toEqual([{ text: 'empty {} {  }' }]);
    expect(parseLogMessage('open {i')).toEqual([{ text: 'open {i' }]);
    expect(parseLogMessage('open {"}')).toEqual([{ text: 'open {"}' }]);
    expect(parseLogMessage('close } only')).toEqual([{ text: 'close } only' }]);
  });

  it('formats with the values in order', () => {
    expect(formatLogMessage(parseLogMessage('i={i}, j={j}.'), ['1', '2'])).toBe('i=1, j=2.');
  });
});

/** A fake netcoredbg: answers requests, numbers its breakpoints, reports frames and evaluates from a table. */
class FakeAdapter {
  readonly requests: DapMessage[] = [];
  readonly client: DapMessage[] = [];
  readonly core: DapProxyCore;
  depth = 1;
  line = 10;
  path = '/w/Program.cs';
  values: Record<string, string> = {};
  totalFrames = true;
  hitIds = true;
  private nextId = 1;
  private seq = 1;

  constructor() {
    this.core = new DapProxyCore(
      (m) => this.client.push(m),
      (m) => this.receive(m),
    );
  }

  private respond(req: DapMessage, body: unknown, success = true, message?: string): void {
    queueMicrotask(() => this.core.fromAdapter({ seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success, ...(message ? { message } : {}), body }));
  }

  private receive(m: DapMessage): void {
    this.requests.push(m);
    if (m.type !== 'request') return;
    switch (m.command) {
      case 'initialize':
        return this.respond(m, { supportsConditionalBreakpoints: true, supportsLogPoints: false });
      case 'setBreakpoints':
        return this.respond(m, { breakpoints: m.arguments.breakpoints.map((b: { line: number }) => ({ id: this.nextId++, verified: true, line: b.line })) });
      case 'stackTrace': {
        const frames = Array.from({ length: m.arguments.levels === 1 ? 1 : this.depth }, (_, i) => ({ id: 1000 + i, line: i === 0 ? this.line : 1, source: { path: this.path } }));
        return this.respond(m, { stackFrames: frames, ...(this.totalFrames ? { totalFrames: this.depth } : {}) });
      }
      case 'evaluate': {
        const v = this.values[m.arguments.expression];
        return v === undefined ? this.respond(m, undefined, false, `error CS0103: The name '${m.arguments.expression}' does not exist`) : this.respond(m, { result: v });
      }
      default:
        return this.respond(m, {});
    }
  }

  event(event: string, body: unknown): void {
    this.core.fromAdapter({ seq: this.seq++, type: 'event', event, body });
  }

  stop(reason: string, ids?: number[]): void {
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...(ids && this.hitIds ? { hitBreakpointIds: ids } : {}) });
  }

  private clientSeq = 100;
  request(command: string, args?: unknown): number {
    const seq = this.clientSeq++;
    this.core.fromClient({ seq, type: 'request', command, ...(args !== undefined ? { arguments: args } : {}) });
    return seq;
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.core.idle();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  sent(command: string): DapMessage[] {
    return this.requests.filter((r) => r.command === command);
  }
  stops(): DapMessage[] {
    return this.client.filter((m) => m.event === 'stopped');
  }
  outputs(): string[] {
    return this.client.filter((m) => m.event === 'output').map((m) => m.body.output);
  }
}

async function withBreakpoints(bps: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[]): Promise<FakeAdapter> {
  const f = new FakeAdapter();
  f.request('initialize', { adapterID: 'refyntra-dotnet' });
  f.request('setBreakpoints', { source: { path: f.path }, breakpoints: bps });
  await f.settle();
  return f;
}

describe('DAP proxy', () => {
  it('adds the emulated capabilities to the initialize response and keeps netcoredbg\'s', async () => {
    const f = new FakeAdapter();
    const seq = f.request('initialize', {});
    await f.settle();
    const r = f.client.find((m) => m.type === 'response')!;
    expect(r.request_seq).toBe(seq);
    expect(r.body).toMatchObject({ supportsConditionalBreakpoints: true, ...EMULATED_CAPABILITIES });
    expect(f.core.stats.adapterCapabilities).toEqual({ supportsConditionalBreakpoints: true, supportsLogPoints: false });
  });

  it('sends netcoredbg plain breakpoints that keep the condition; responses get the client\'s sequence number', async () => {
    const f = new FakeAdapter();
    const seq = f.request('setBreakpoints', { source: { path: f.path }, breakpoints: [{ line: 10, condition: 'i > 1', hitCondition: '2', logMessage: 'i={i}' }, { line: 12 }, { line: 14, hitCondition: 'oops' }] });
    await f.settle();
    expect(f.sent('setBreakpoints')[0]!.arguments.breakpoints).toEqual([{ line: 10, condition: 'i > 1' }, { line: 12 }, { line: 14 }]);
    const r = f.client.find((m) => m.command === 'setBreakpoints')!;
    expect(r.request_seq).toBe(seq);
    expect(r.body.breakpoints[0]).toEqual({ id: 1, verified: true, line: 10 });
    expect(r.body.breakpoints[2].message).toMatch(/Hit condition "oops" is not understood/);
    expect(f.core.emulated().map((b) => b.line)).toEqual([10]);
    // The proxy numbers what it sends; the adapter never sees the client's numbers twice.
    const seqs = f.requests.map((x) => x.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('hit count == 3: swallows the first two stops (continue), shows the third, then none', async () => {
    const f = await withBreakpoints([{ line: 10, hitCondition: '== 3' }]);
    for (let i = 0; i < 4; i++) {
      f.stop('breakpoint', [1]);
      await f.settle();
    }
    expect(f.stops()).toHaveLength(1);
    expect(f.sent('continue')).toHaveLength(3);
    expect(f.core.stats.swallowedStops).toBe(3);
    expect(f.core.emulated()[0]!.hits).toBe(4);
  });

  it('hit count % 2 stops every second hit; matching by file and line when netcoredbg reports no ids', async () => {
    const f = await withBreakpoints([{ line: 10, hitCondition: '% 2' }]);
    f.hitIds = false;
    for (let i = 0; i < 4; i++) {
      f.stop('breakpoint', [1]);
      await f.settle();
    }
    expect(f.stops()).toHaveLength(2);
    expect(f.sent('continue')).toHaveLength(2);
  });

  it('logpoint: evaluates each expression in the top frame (watch context), writes a console line, never stops', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'i={i} sum={a + b} {missing}' }]);
    f.values = { i: '2', 'a + b': '5' };
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.stops()).toHaveLength(0);
    expect(f.outputs()).toEqual(["i=2 sum=5 <error: error CS0103: The name 'missing' does not exist>\n"]);
    const out = f.client.find((m) => m.event === 'output')!;
    expect(out.body).toMatchObject({ category: 'console', line: 10, source: { path: f.path, name: 'Program.cs' } });
    expect(f.sent('evaluate').map((e) => e.arguments)).toEqual([
      { expression: 'i', frameId: 1000, context: 'watch' },
      { expression: 'a + b', frameId: 1000, context: 'watch' },
      { expression: 'missing', frameId: 1000, context: 'watch' },
    ]);
    expect(f.sent('continue')).toHaveLength(1);
    // The internal requests' responses never reach the client.
    expect(f.client.filter((m) => m.type === 'response' && ['evaluate', 'stackTrace', 'continue'].includes(m.command!))).toHaveLength(0);
  });

  it('logpoint with a hit count logs only when it holds', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'hit', hitCondition: '>= 2' }]);
    for (let i = 0; i < 3; i++) {
      f.stop('breakpoint', [1]);
      await f.settle();
    }
    expect(f.outputs()).toEqual(['hit\n', 'hit\n']);
    expect(f.stops()).toHaveLength(0);
  });

  it('passes through other stops: plain breakpoints, steps, pauses, exceptions, and a plain breakpoint reported with an emulated one', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'x' }, { line: 12 }]);
    f.stop('breakpoint', [2]);
    f.stop('step');
    f.stop('pause');
    f.stop('exception');
    f.stop('breakpoint', [1, 2]);
    await f.settle();
    expect(f.stops().map((s) => s.body.reason)).toEqual(['breakpoint', 'step', 'pause', 'exception', 'breakpoint']);
    expect(f.outputs()).toEqual(['x\n']);
    expect(f.sent('continue')).toHaveLength(0);
  });

  it('without emulated breakpoints every message passes untouched and no extra request is made', async () => {
    const f = await withBreakpoints([{ line: 12 }]);
    f.request('next', { threadId: 1 });
    f.stop('breakpoint', [1]);
    f.event('output', { category: 'stdout', output: 'hello\n' });
    await f.settle();
    expect(f.sent('stackTrace')).toHaveLength(0);
    expect(f.stops()).toHaveLength(1);
    expect(f.outputs()).toEqual(['hello\n']);
  });

  it('events keep their order while a stop is handled (concurrent hits are handled one at a time)', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'one' }]);
    f.stop('breakpoint', [1]);
    f.event('output', { category: 'stdout', output: 'after\n' });
    f.stop('breakpoint', [1]);
    f.event('exited', { exitCode: 0 });
    f.event('terminated', {});
    await f.settle();
    expect(f.outputs()).toEqual(['one\n', 'after\n', 'one\n']);
    expect(f.client.filter((m) => m.type === 'event').map((m) => m.event)).toEqual(['output', 'output', 'output', 'exited', 'terminated']);
  });

  it('a pause asked for while a hidden stop is handled shows that stop as a pause', async () => {
    const f = await withBreakpoints([{ line: 10, hitCondition: '5' }]);
    f.request('pause', { threadId: 1 });
    await f.settle();
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.stops().map((s) => s.body.reason)).toEqual(['pause']);
    expect(f.stops()[0]!.body.hitBreakpointIds).toBeUndefined();
    expect(f.sent('continue')).toHaveLength(0);
  });

  it('a hidden hit inside a call being stepped over: steps out, then finishes the line; the client sees one step stop', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'in callee' }]);
    f.depth = 1;
    f.request('next', { threadId: 1 });
    await f.settle();
    f.depth = 2; // stopped in the callee
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.sent('stepOut')).toHaveLength(1);
    f.depth = 1; // back in the caller, mid-line
    f.line = 5;
    f.stop('step');
    await f.settle();
    expect(f.sent('next')).toHaveLength(2); // the user's and the proxy's
    expect(f.stops()).toHaveLength(0);
    f.line = 6;
    f.stop('step');
    await f.settle();
    expect(f.stops().map((s) => s.body.reason)).toEqual(['step']);
    expect(f.outputs()).toEqual(['in callee\n']);
    expect(f.sent('continue')).toHaveLength(0);
  });

  it('a hidden hit in the same frame during Step Over is where the step ends (shown as a step)', async () => {
    const f = await withBreakpoints([{ line: 10, hitCondition: '3' }]);
    f.totalFrames = false;
    f.depth = 2;
    f.request('next', { threadId: 1 });
    await f.settle();
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.stops().map((s) => s.body.reason)).toEqual(['step']);
    expect(f.sent('stepOut')).toHaveLength(0);
  });

  it('Step Out interrupted by a hidden hit deeper down steps out until it is above the starting frame', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'x' }]);
    f.depth = 3;
    f.request('stepOut', { threadId: 1 });
    await f.settle();
    f.depth = 4;
    f.stop('breakpoint', [1]);
    await f.settle();
    f.depth = 3;
    f.stop('step');
    await f.settle();
    f.depth = 2;
    f.stop('step');
    await f.settle();
    expect(f.sent('stepOut')).toHaveLength(3); // the user's and two of the proxy's
    expect(f.stops().map((s) => s.body.reason)).toEqual(['step']);
  });

  it('Step Into stopped by a hidden hit shows a step stop there', async () => {
    const f = await withBreakpoints([{ line: 10, logMessage: 'x' }]);
    f.request('stepIn', { threadId: 1 });
    await f.settle();
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.stops().map((s) => s.body.reason)).toEqual(['step']);
  });

  it('hit counts survive a new setBreakpoints when netcoredbg keeps the id; removed breakpoints are forgotten', async () => {
    const f = await withBreakpoints([{ line: 10, hitCondition: '3' }]);
    f.stop('breakpoint', [1]);
    await f.settle();
    f.request('setBreakpoints', { source: { path: f.path }, breakpoints: [] });
    await f.settle();
    expect(f.core.emulated()).toHaveLength(0);
    f.stop('breakpoint', [1]);
    await f.settle();
    expect(f.stops()).toHaveLength(1);
  });

  it('forwards other requests, reverse requests and their responses', async () => {
    const f = new FakeAdapter();
    const seq = f.request('threads');
    await f.settle();
    expect(f.client.find((m) => m.command === 'threads')!.request_seq).toBe(seq);
    f.core.fromAdapter({ seq: 77, type: 'request', command: 'runInTerminal', arguments: {} });
    expect(f.client.some((m) => m.command === 'runInTerminal' && m.type === 'request')).toBe(true);
    f.core.fromClient({ seq: 5, type: 'response', command: 'runInTerminal', request_seq: 77, success: true });
    expect(f.requests.some((m) => m.type === 'response' && m.request_seq === 77)).toBe(true);
  });
});
