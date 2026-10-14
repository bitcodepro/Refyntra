import * as vscode from 'vscode';
import { metadataService } from './metadata';
import { OPEN_DECOMPILED } from './metadataModel';
import type { EngineClient } from '@refyntra/application';
import type { StepIntoTargetsResult } from '@refyntra/contracts';
import {
  COMMON_EXCEPTION_TYPES,
  NETCOREDBG_CAPABILITIES,
  type ExceptionBreakpointsArgs,
  type SmartStepStop,
  type SourceLine,
  type StepIntoItem,
  classifyStop,
  exceptionBreakpointsWithTypes,
  isExceptionTypeName,
  isRefyntraExceptionRequest,
  samePath,
  stepIntoItems,
  unsupportedBreakpointNote,
} from './debugExtrasModel';

const DOTNET_DEBUG_TYPE = 'refyntra-dotnet';
const TYPES_SETTING = 'debug.dotnet.breakOnExceptionTypes';

export type SmartStepOutcome =
  | { kind: SmartStepStop; at?: SourceLine; target: string }
  | { kind: 'refused' | 'cancelled' | 'unavailable' | 'ended'; message?: string; /** refused library call: what "Open Decompiled Source" opens. */ documentationId?: string };

export interface DebugExtrasHooks {
  /** Tests choose the Smart Step Into item instead of the QuickPick (the label without the icon). */
  pick?: (items: StepIntoItem[]) => StepIntoItem | undefined;
  /** The last Smart Step Into list (tests). */
  lastTargets?: StepIntoTargetsResult;
  /** The DAP initialize response body of the last refyntra-dotnet session (the e2e compares it with ADR-008). */
  capabilities?: Record<string, unknown>;
  /** Messages shown (tests). */
  messages: string[];
  /** The Smart Step Into picker is on screen (the visual test waits for it). */
  pickerOpen?: boolean;
}

interface SessionState {
  /** VS Code's last setExceptionBreakpoints arguments (the ticked filters). */
  vsExceptions?: ExceptionBreakpointsArgs;
  /** Thread of the last stopped event. */
  stoppedThread?: number;
  /** Waiters for the next stop / end of this session. */
  onStop: ((e: { threadId?: number; ended?: boolean }) => void)[];
  /** Waiters for a setBreakpoints response covering a file and line (seq → waiter). */
  bpRequests: Map<number, { path: string; lines: number[] }>;
  onBreakpointsSet: ((r: { path: string; lines: number[] }) => void)[];
}

/**
 * Rider-style debugger extras for refyntra-dotnet sessions (netcoredbg, ADR-008 "Debugger capabilities"):
 * - Smart Step Into: netcoredbg has no stepInTargets, so the C# host lists the calls of the stopped statement
 *   (code/stepIntoTargets), the user picks one, and Refyntra sets temporary breakpoints at the start of the callee's body
 *   and at the next statement (if the call is not made), continues, and removes them at the next stop.
 * - Break on Exception Types: netcoredbg's `all` filter with a condition of full type names (exceptionFilterOptions),
 *   sent after VS Code's own setExceptionBreakpoints.
 * - A note when a C# breakpoint has a hit count or log message (netcoredbg ignores both and stops).
 */
export class DebugExtras implements vscode.Disposable {
  readonly hooks: DebugExtrasHooks = { messages: [] };
  /** The capability table of ADR-008 (the e2e compares it with the live initialize response). */
  readonly expectedCapabilities: Readonly<Record<string, boolean>> = NETCOREDBG_CAPABILITIES;
  private readonly sessions = new Map<string, SessionState>();
  private readonly subs: vscode.Disposable[] = [];
  private readonly noted = new Set<string>();

  constructor(private readonly engine: EngineClient) {
    this.subs.push(
      vscode.debug.registerDebugAdapterTrackerFactory(DOTNET_DEBUG_TYPE, { createDebugAdapterTracker: (s) => this.tracker(s) }),
      vscode.debug.onDidTerminateDebugSession((s) => this.ended(s)),
      vscode.debug.onDidChangeBreakpoints((e) => this.noteUnsupported([...e.added, ...e.changed])),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`refyntra.${TYPES_SETTING}`)) void this.resendExceptionTypes();
      }),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private state(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { onStop: [], bpRequests: new Map(), onBreakpointsSet: [] }));
    return s;
  }

  private tracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    const st = this.state(session.id);
    return {
      onWillReceiveMessage: (m: { type?: string; seq?: number; command?: string; arguments?: Record<string, unknown> }) => {
        if (m.type !== 'request') return;
        if (m.command === 'setExceptionBreakpoints') {
          const args = m.arguments as ExceptionBreakpointsArgs | undefined;
          if (isRefyntraExceptionRequest(args)) return;
          st.vsExceptions = args;
          const ours = exceptionBreakpointsWithTypes(args, this.types());
          // Queued right behind VS Code's request (before configurationDone, which waits for its response).
          if (ours) void session.customRequest('setExceptionBreakpoints', ours).then(undefined, () => undefined);
        } else if (m.command === 'setBreakpoints' && typeof m.seq === 'number') {
          const a = m.arguments as { source?: { path?: string }; breakpoints?: { line: number }[] } | undefined;
          if (a?.source?.path) st.bpRequests.set(m.seq, { path: a.source.path, lines: (a.breakpoints ?? []).map((b) => b.line) });
        }
      },
      onDidSendMessage: (m: { type?: string; event?: string; command?: string; request_seq?: number; success?: boolean; body?: Record<string, unknown> }) => {
        if (m.type === 'response' && m.command === 'initialize') this.hooks.capabilities = { ...(m.body ?? {}) };
        if (m.type === 'response' && m.command === 'setBreakpoints' && typeof m.request_seq === 'number') {
          const r = st.bpRequests.get(m.request_seq);
          st.bpRequests.delete(m.request_seq);
          if (r) for (const w of st.onBreakpointsSet.splice(0)) w(r);
        }
        if (m.type !== 'event') return;
        if (m.event === 'stopped') {
          const threadId = typeof m.body?.threadId === 'number' ? (m.body.threadId as number) : undefined;
          st.stoppedThread = threadId;
          for (const w of st.onStop.splice(0)) w({ threadId });
        } else if (m.event === 'terminated' || m.event === 'exited') {
          for (const w of st.onStop.splice(0)) w({ ended: true });
        }
      },
    };
  }

  private ended(s: vscode.DebugSession): void {
    const st = this.sessions.get(s.id);
    if (!st) return;
    for (const w of st.onStop.splice(0)) w({ ended: true });
    this.sessions.delete(s.id);
  }

  private types(): string[] {
    const v = vscode.workspace.getConfiguration('refyntra').get<unknown>(TYPES_SETTING, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  /** The types changed: every running refyntra-dotnet session gets VS Code's filters plus the new types. */
  private async resendExceptionTypes(): Promise<void> {
    const types = this.types();
    for (const [id, st] of this.sessions) {
      const session = vscode.debug.activeDebugSession?.id === id ? vscode.debug.activeDebugSession : undefined;
      if (!session) continue;
      const args = exceptionBreakpointsWithTypes(st.vsExceptions, types) ?? { filters: [...(st.vsExceptions?.filters ?? [])], ...(st.vsExceptions?.filterOptions ? { filterOptions: st.vsExceptions.filterOptions } : {}) };
      try {
        await session.customRequest('setExceptionBreakpoints', args);
      } catch {
        /* the session ended */
      }
    }
  }

  private message(kind: 'info' | 'warning', text: string): void {
    this.hooks.messages.push(text);
    if (kind === 'info') void vscode.window.showInformationMessage(text);
    else void vscode.window.showWarningMessage(text);
  }

  private noteUnsupported(bps: readonly vscode.Breakpoint[]): void {
    for (const bp of bps) {
      if (!(bp instanceof vscode.SourceBreakpoint) || !bp.location.uri.path.toLowerCase().endsWith('.cs')) continue;
      const note = unsupportedBreakpointNote(bp);
      if (!note) continue;
      const key = `${bp.id}:${note}`;
      if (this.noted.has(key)) continue;
      this.noted.add(key);
      this.message('warning', note);
    }
  }

  /** Refyntra: Break on Exception Types… — the types are stored in `refyntra.debug.dotnet.breakOnExceptionTypes`. */
  async chooseExceptionTypes(preset?: string[]): Promise<string[] | undefined> {
    let chosen: string[] | undefined = preset;
    if (!chosen) {
      const current = this.types();
      const OTHER = '$(edit) Other type…';
      const items: vscode.QuickPickItem[] = [...new Set([...current, ...COMMON_EXCEPTION_TYPES])].map((t) => ({ label: t, picked: current.includes(t) }));
      items.push({ label: OTHER, alwaysShow: true });
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Break when these .NET exceptions are thrown (exact type names; none = only the ticked exception filters)',
      });
      if (!picked) return undefined;
      chosen = picked.filter((p) => p.label !== OTHER).map((p) => p.label);
      if (picked.some((p) => p.label === OTHER)) {
        const typed = await vscode.window.showInputBox({
          title: 'Full exception type names, separated by commas',
          placeHolder: 'MyApp.Orders.OrderRejectedException',
          validateInput: (v) => (v.split(',').every((x) => !x.trim() || isExceptionTypeName(x)) ? undefined : 'Use full type names: Namespace.TypeName (nested types: Outer+Inner).'),
        });
        if (typed) chosen.push(...typed.split(',').map((x) => x.trim()).filter(Boolean));
      }
    }
    const valid = [...new Set(chosen.filter(isExceptionTypeName).map((x) => x.trim()))];
    await vscode.workspace.getConfiguration('refyntra').update(TYPES_SETTING, valid, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    return valid;
  }

  /** Refyntra: Smart Step Into — choose which call of the stopped C# statement to step into. */
  async smartStepInto(): Promise<SmartStepOutcome> {
    const item = vscode.debug.activeStackItem;
    const session = item?.session ?? vscode.debug.activeDebugSession;
    if (!session || session.type !== DOTNET_DEBUG_TYPE) {
      const message = 'Smart Step Into works while a Refyntra .NET debug session (refyntra-dotnet) is stopped.';
      this.message('info', message);
      return { kind: 'unavailable', message };
    }
    const st = this.state(session.id);
    const threadId = item && 'threadId' in item ? item.threadId : st.stoppedThread;
    if (threadId === undefined) {
      const message = 'Smart Step Into: the program is not stopped.';
      this.message('info', message);
      return { kind: 'unavailable', message };
    }
    const frameId = item instanceof vscode.DebugStackFrame ? item.frameId : undefined;
    type Frame = { id: number; line: number; column: number; source?: { path?: string } };
    let frame: Frame | undefined;
    try {
      const trace = (await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 50 })) as { stackFrames: Frame[] };
      frame = trace.stackFrames.find((f) => f.id === frameId) ?? trace.stackFrames[0];
    } catch {
      frame = undefined;
    }
    if (!frame?.source?.path) {
      const message = 'Smart Step Into: the stopped frame has no source file.';
      this.message('info', message);
      return { kind: 'unavailable', message };
    }
    const r = await this.engine.stepIntoTargets!(vscode.Uri.file(frame.source.path).toString(), { line: frame.line - 1, character: Math.max(0, frame.column - 1) });
    if (r.kind !== 'targets') {
      this.message('info', `Smart Step Into: ${r.message}`);
      return { kind: 'unavailable', message: r.message };
    }
    this.hooks.lastTargets = r.result;
    const items = stepIntoItems(r.result);
    if (items.length === 0) {
      const message = 'Smart Step Into: there is no call on this statement.';
      this.message('info', message);
      return { kind: 'unavailable', message };
    }
    const chosen = this.hooks.pick ? this.hooks.pick(items) : await this.pick(items);
    if (!chosen) return { kind: 'cancelled' };
    const t = chosen.target;
    if (!t.breakAt) {
      const message = `Cannot step into ${t.label}: ${chosen.detail ?? 'no source'}.`;
      if (t.reason === 'metadata' && t.documentationId && metadataService()) {
        // The library method can still be read: offer its decompiled source (go to metadata, protocol 1.16).
        this.hooks.messages.push(message);
        const docId = t.documentationId;
        const assemblyName = t.assemblyName;
        void vscode.window.showWarningMessage(message, OPEN_DECOMPILED).then((pick) => {
          if (pick === OPEN_DECOMPILED) void metadataService()?.open({ documentationId: docId, ...(assemblyName ? { assemblyName } : {}) }, t.label);
        });
        return { kind: 'refused', message, documentationId: docId };
      }
      this.message('warning', message);
      return { kind: 'refused', message };
    }

    const targetUri = vscode.Uri.parse(t.breakAt.uri);
    const target: SourceLine = { path: targetUri.fsPath, line: t.breakAt.range.start.line + 1 };
    const guard: SourceLine | undefined = r.result.nextStatement ? { path: frame.source.path, line: r.result.nextStatement.line + 1 } : undefined;
    const temps: vscode.SourceBreakpoint[] = [];
    const want = [
      { uri: targetUri, line: target.line - 1, character: t.breakAt.range.start.character },
      ...(guard && !(samePath(guard.path, target.path) && guard.line === target.line) ? [{ uri: vscode.Uri.file(guard.path), line: guard.line - 1, character: r.result.nextStatement!.character }] : []),
    ];
    for (const w of want) {
      const existing = vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.enabled && samePath(b.location.uri.fsPath, w.uri.fsPath) && b.location.range.start.line === w.line);
      if (!existing) temps.push(new vscode.SourceBreakpoint(new vscode.Location(w.uri, new vscode.Position(w.line, w.character))));
    }
    const remove = () => {
      if (temps.length) vscode.debug.removeBreakpoints(temps);
    };
    try {
      if (temps.length) {
        // Continue only once netcoredbg has the temporary breakpoints (VS Code sends them asynchronously).
        const set = Promise.all(temps.map((b) => this.breakpointsSent(st, b.location.uri.fsPath, b.location.range.start.line + 1)));
        vscode.debug.addBreakpoints(temps);
        await set;
      }
      const stop = new Promise<{ threadId?: number; ended?: boolean }>((resolve) => st.onStop.push(resolve));
      // VS Code's own Continue (the focused thread of the focused session) keeps the debug UI in step; a direct DAP
      // request when this session is not the focused one.
      if (vscode.debug.activeDebugSession?.id === session.id) await vscode.commands.executeCommand('workbench.action.debug.continue');
      else await session.customRequest('continue', { threadId });
      const e = await stop;
      if (e.ended) return { kind: 'ended' };
      const at = await this.topLine(session, e.threadId ?? threadId);
      const kind = classifyStop(at, target, guard);
      if (kind === 'returned') this.message('info', `${t.label} was not called; stopped at the next statement.`);
      return { kind, ...(at ? { at } : {}), target: t.label };
    } finally {
      remove();
    }
  }

  private breakpointsSent(st: SessionState, path: string, line: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, 5000);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      const wait = (r: { path: string; lines: number[] }) => {
        if (samePath(r.path, path) && r.lines.includes(line)) done();
        else st.onBreakpointsSet.push(wait);
      };
      st.onBreakpointsSet.push(wait);
    });
  }

  private async topLine(session: vscode.DebugSession, threadId: number): Promise<SourceLine | undefined> {
    try {
      const trace = (await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })) as { stackFrames: { line: number; source?: { path?: string } }[] };
      const f = trace.stackFrames[0];
      return f?.source?.path ? { path: f.source.path, line: f.line } : undefined;
    } catch {
      return undefined;
    }
  }

  private async pick(items: StepIntoItem[]): Promise<StepIntoItem | undefined> {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { item: StepIntoItem }>();
    qp.title = 'Smart Step Into: choose the call to step into';
    qp.placeholder = 'Calls of the stopped statement, in the order they run';
    qp.matchOnDescription = true;
    qp.items = items.map((i) => ({ label: i.label, description: i.description, detail: i.detail, item: i }));
    return new Promise((resolve) => {
      let chosen: StepIntoItem | undefined;
      qp.onDidAccept(() => {
        chosen = qp.selectedItems[0]?.item;
        qp.hide();
      });
      qp.onDidHide(() => {
        this.hooks.pickerOpen = false;
        qp.dispose();
        resolve(chosen);
      });
      qp.show();
      this.hooks.pickerOpen = true;
    });
  }
}

export function registerDebugExtras(engine: EngineClient): { extras: DebugExtras; disposable: vscode.Disposable } {
  const extras = new DebugExtras(engine);
  const disposable = vscode.Disposable.from(
    extras,
    vscode.commands.registerCommand('refyntra.smartStepInto', () => extras.smartStepInto()),
    vscode.commands.registerCommand('refyntra.breakOnExceptionTypes', (types?: unknown) => extras.chooseExceptionTypes(Array.isArray(types) ? types.filter((x): x is string => typeof x === 'string') : undefined)),
  );
  return { extras, disposable };
}
