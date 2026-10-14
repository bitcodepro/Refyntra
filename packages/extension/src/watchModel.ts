// What a `dotnet watch` run (Run with Hot Reload) is doing, read from its console output: the status bar indicator and
// the rude-edit prompt. No vscode import: unit-tested directly.

export type WatchState = 'starting' | 'building' | 'running' | 'applied' | 'failed' | 'rudeEdit' | 'waiting' | 'exited';

export interface WatchStatus {
  state: WatchState;
  /** The last hot reload / restart outcome line, for the tooltip. */
  detail?: string;
  /** dotnet watch asks whether to restart the app (a rude edit). */
  prompt?: boolean;
}

const RULES: { re: RegExp; state: WatchState; prompt?: boolean }[] = [
  { re: /Do you want to restart your app\?/i, state: 'rudeEdit', prompt: true },
  { re: /(Restart is needed to apply the changes|rude edit|requires restarting the application|Unable to apply hot reload)/i, state: 'rudeEdit' },
  { re: /Hot reload (of changes )?succeeded/i, state: 'applied' },
  { re: /(Build FAILED|Build failed|error [A-Z]+\d+:|Hot reload failed|Failed to apply)/i, state: 'failed' },
  { re: /Waiting for a file to change before restarting/i, state: 'waiting' },
  { re: /\bExited\b/i, state: 'waiting' },
  { re: /(File (changed|updated)|Determining projects to restore|Loading projects|Building\.\.\.|Restarting|Shutdown requested)/i, state: 'building' },
  { re: /(Waiting for changes|\bStarted\b|Now listening on:|Hot reload enabled)/i, state: 'running' },
];

/** The status after more output; lines are read in order, the last matching line wins. */
export function watchStatusAfter(prev: WatchStatus, output: string): WatchStatus {
  let s = prev;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line) continue;
    const rule = RULES.find((r) => r.re.test(line));
    if (!rule) continue;
    if (rule.state === 'rudeEdit' && s.state === 'rudeEdit' && !rule.prompt) continue;
    s = { state: rule.state, detail: line.replace(/^dotnet watch\s*/i, '').replace(/^[^\p{L}\p{N}[]+/u, ''), ...(rule.prompt ? { prompt: true } : {}) };
  }
  return s;
}

const TEXT: Record<WatchState, string> = {
  starting: '$(sync~spin) Hot Reload: starting',
  building: '$(sync~spin) Hot Reload: building',
  running: '$(flame) Hot Reload: watching',
  applied: '$(flame) Hot Reload: applied',
  failed: '$(error) Hot Reload: failed',
  rudeEdit: '$(warning) Hot Reload: restart needed',
  waiting: '$(watch) Hot Reload: waiting for changes',
  exited: '$(circle-slash) Hot Reload: stopped',
};

export function watchStatusText(s: WatchStatus): string {
  return TEXT[s.state];
}

/**
 * What happens on a rude edit (a change Hot Reload cannot apply). Refyntra's terminal is a pipe, not a console, so
 * dotnet watch cannot read the y/n key of its own prompt (measured: the key is never read, the old code keeps running):
 * - `restart`: `dotnet watch --non-interactive`, which restarts the app by itself;
 * - `ask`: Refyntra asks in a notification and restarts the watch run itself.
 */
export type RudeEditPolicy = 'restart' | 'ask';

/** The `dotnet watch` arguments for the policy (`--non-interactive` right after `watch`). */
export function watchArgs(args: readonly string[], policy: RudeEditPolicy): string[] {
  const i = args.indexOf('watch');
  if (policy !== 'restart' || i < 0 || args.includes('--non-interactive')) return [...args];
  return [...args.slice(0, i + 1), '--non-interactive', ...args.slice(i + 1)];
}

/** Splits streamed output into complete lines; the unfinished last line is kept, but a prompt in it counts at once. */
export class WatchOutput {
  private tail = '';
  private promptSeen = false;
  status: WatchStatus = { state: 'starting' };

  /** Feeds output; true when a new rude-edit prompt appeared. */
  push(text: string): boolean {
    const lines = (this.tail + text).split(/\r?\n/);
    this.tail = lines.pop() ?? '';
    const before = this.status;
    if (lines.length) {
      this.status = watchStatusAfter(this.status, lines.join('\n'));
      if (this.status.state !== 'rudeEdit') this.promptSeen = false;
    }
    let prompted = this.status.prompt === true && before !== this.status && !this.promptSeen;
    if (/Do you want to restart your app\?/i.test(this.tail) && !this.promptSeen) {
      this.status = watchStatusAfter(this.status, this.tail);
      prompted = true;
    }
    if (prompted) this.promptSeen = true;
    return prompted;
  }
}
