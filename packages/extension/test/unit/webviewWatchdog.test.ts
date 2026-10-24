import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shown: string[] = [];
const commands: string[] = [];
let pick: string | undefined;

vi.mock('vscode', () => ({
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
  window: {
    showWarningMessage: (message: string) => {
      shown.push(message);
      return Promise.resolve(pick);
    },
  },
  commands: { executeCommand: (c: string) => (commands.push(c), Promise.resolve()) },
}));

import { watchWebview, webviewNotices } from '../../src/webviewWatchdog';

/** A webview whose page may or may not send messages. */
function fakeWebview() {
  const listeners = new Set<(m: unknown) => void>();
  return {
    onDidReceiveMessage: (fn: (m: unknown) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    send: (m: unknown) => [...listeners].forEach((fn) => fn(m)),
    listeners,
  };
}

describe('webview watchdog (a page VS Code did not load, e.g. the service worker error after an update)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shown.length = 0;
    commands.length = 0;
    webviewNotices.length = 0;
    pick = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('stays silent when the page answers in time', () => {
    const w = fakeWebview();
    watchWebview(w as never, 'Git', undefined, 1000);
    vi.advanceTimersByTime(500);
    w.send({ type: 'ready' });
    vi.advanceTimersByTime(5000);
    expect(webviewNotices).toEqual([]);
    expect(w.listeners.size).toBe(0); // the watchdog no longer listens
  });

  it('retries once, then explains and offers Reload Window', async () => {
    const w = fakeWebview();
    const retry = vi.fn();
    pick = 'Reload Window';
    watchWebview(w as never, 'Git', retry, 1000);
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/Git view did not load.*updated in the background.*Reload the window/);
    await vi.runAllTimersAsync();
    expect(commands).toEqual(['workbench.action.reloadWindow']);
  });

  it('shows one notice for several views that fail together, and nothing for a disposed one', () => {
    const a = fakeWebview();
    const b = fakeWebview();
    const c = fakeWebview();
    watchWebview(a as never, 'Git', undefined, 1000);
    watchWebview(b as never, 'Immediate', undefined, 1000);
    watchWebview(c as never, 'commit', undefined, 1000).dispose();
    vi.advanceTimersByTime(1000);
    expect(webviewNotices).toHaveLength(2);
    expect(shown).toHaveLength(1);
  });
});
