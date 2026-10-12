import type { PlannedChange, PlannedTextChange } from '@refyntra/contracts';
import type { CaptureOptions, CapturedEdit, Clock, CommitResult, Disposable, EditApplier, LogLevel, Logger } from '@refyntra/application';
import type { AnyRelation } from '@refyntra/domain';
import type { FrameworkAdapter, FrameworkRelatedInput } from '@refyntra/application';
import { applyTextEdits, sha256 } from './fixtureEngine';

/** Deterministic clock: timers run only when the test advances time. */
export class FakeClock implements Clock {
  private time = 0;
  private timers: { at: number; cb: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(cb: () => void, ms: number): Disposable {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, cb, id });
    return { dispose: () => (this.timers = this.timers.filter((t) => t.id !== id)) };
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Advances time, running due timers in order and letting promise continuations settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.time = next.at;
      next.cb();
      await flushAsync();
    }
    this.time = target;
    await flushAsync();
  }
}

/** Lets queued microtasks and immediate macrotasks (stream pipes) run. */
export async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export class MemoryLogger implements Logger {
  readonly lines: { level: LogLevel; component: string; message: string; fields?: Record<string, unknown> }[] = [];
  log(level: LogLevel, component: string, message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level, component, message, ...(fields ? { fields } : {}) });
  }
}

/** EditApplier over the fixture world's files (stands in for VS Code's workspace.applyEdit). */
export class WorldEditApplier implements EditApplier {
  readonly applied: string[] = [];
  /** Called inside commit before the synchronous check (tests use it to simulate a late edit). */
  beforeCommit: (() => void) | undefined;
  /** Called after capture resolved (simulates an external write right after the disk read). */
  afterCapture: (() => void) | undefined;
  /** Fault injection: the editor apply returns false and changes nothing. */
  rejectApply = false;
  /** Fault injection: the editor reports success but one target ends with other text. */
  corruptUri: string | undefined;
  /** The options of every capture (tests check that the Refactor Preview confirmation is passed through). */
  readonly captureOptions: (CaptureOptions | undefined)[] = [];

  constructor(
    private readonly world: { readonly files: Map<string, string> },
    private readonly currentText: (uri: string) => string | undefined,
    private readonly onApplied: (uri: string, text: string) => void,
  ) {}

  private text(uri: string): string | undefined {
    return this.currentText(uri) ?? this.world.files.get(uri);
  }

  async capture(writeSet: readonly PlannedChange[], options?: CaptureOptions): Promise<CapturedEdit | { ok: false; reason: string; uri?: string }> {
    this.captureOptions.push(options);
    for (const change of writeSet) {
      if (change.kind !== 'text') return { ok: false, reason: 'resource operations are not supported' };
      if (this.text(change.uri) === undefined) return { ok: false, reason: `${change.uri} is missing`, uri: change.uri };
    }
    this.afterCapture?.();
    const texts = writeSet as readonly PlannedTextChange[]; // checked above: text only
    return {
      ok: true,
      commit: (): CommitResult => {
        this.beforeCommit?.();
        for (const change of texts) {
          const text = this.text(change.uri);
          if (text === undefined || sha256(text) !== change.expectedHash) return { started: false, reason: `${change.uri} changed`, uri: change.uri };
          if (sha256(applyTextEdits(text, change.edits)) !== change.resultHash) return { started: false, reason: 'the edits do not produce the previewed result', uri: change.uri };
        }
        if (!this.rejectApply) {
          for (const change of texts) {
            let next = applyTextEdits(this.text(change.uri)!, change.edits);
            if (change.uri === this.corruptUri) next += '// someone else\n';
            this.onApplied(change.uri, next);
            this.applied.push(change.uri);
          }
        }
        const files = texts.map((c) => {
          const h = sha256(this.text(c.uri) ?? '');
          return { uri: c.uri, status: h === c.resultHash ? ('confirmed' as const) : h === c.expectedHash ? ('unchanged' as const) : ('unknown' as const) };
        });
        return { started: true, result: Promise.resolve({ editorAccepted: !this.rejectApply, files }) };
      },
    };
  }
}

/**
 * Fake framework module on top of fake language facts: for subject `X`, a declared symbol `XWiring` is a
 * "wiring registration" (namespaced relation kind, group registrations). Registered without UI changes.
 */
export class FixtureWiringFramework implements FrameworkAdapter {
  readonly descriptor;

  constructor(providerRouteId: string) {
    this.descriptor = { frameworkId: 'fixture.wiring', displayName: 'Fixture Wiring', providerRouteIds: [providerRouteId] };
  }

  async related(input: FrameworkRelatedInput): Promise<AnyRelation[]> {
    const subject = input.subject;
    if (!subject) return [];
    const wanted = `${subject.name}Wiring`;
    const found = await input.language.search({ query: wanted, filters: { type: true }, limit: 5 }, input.token);
    return found.value.items
      .filter((i) => i.symbol?.name === wanted)
      .map((i) => ({
        relationKind: 'fixture.wiredBy' as const,
        group: 'registrations' as const,
        target: { symbol: i.symbol!, label: i.symbol!.displayName },
        evidence: [{ description: `naming convention ${wanted}`, ...(i.symbol!.location ? { location: i.symbol!.location } : {}) }],
        confidence: 'heuristic' as const,
        provenance: i.symbol!.provenance,
        limitations: ['Convention-based fake framework rule'],
      }));
  }
}
