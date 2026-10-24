import * as vscode from 'vscode';

/** How long a webview may take to send its first message before Refyntra treats it as not loaded. */
export const WEBVIEW_LOAD_TIMEOUT_MS = 10000;

let noticeShown = false;

/** Test hook: the notices that would have been shown (none are shown in tests). */
export const webviewNotices: string[] = [];

let live = 0;

/** Test hook: watchdogs still waiting for their page (a disposed or answered one no longer counts). */
export function liveWatchdogs(): number {
  return live;
}

/**
 * Watches one webview until its page sends its first message ("ready"). A page that never does was not loaded by VS Code
 * itself (for example "Could not register service worker: InvalidStateError" after VS Code updated in the background
 * while windows stayed open): VS Code fails before any Refyntra code runs, so Refyntra cannot fix it in the page. It can
 * recover: `retry` (when given) runs once, e.g. a panel is created again; if the page still does not answer, a notice
 * explains it and offers Reload Window, which loads the updated VS Code and fixes the webviews of every extension.
 */
export function watchWebview(webview: vscode.Webview, name: string, retry?: () => void, timeoutMs = WEBVIEW_LOAD_TIMEOUT_MS): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retried = false;
  let ended = false;
  live++;
  const end = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    sub.dispose();
    if (!ended) live--;
    ended = true;
  };
  const arm = () => {
    timer = setTimeout(() => {
      timer = undefined;
      if (retry && !retried) {
        retried = true;
        retry();
        arm();
        return;
      }
      end();
      notLoaded(name);
    }, timeoutMs);
  };
  const sub = webview.onDidReceiveMessage(() => end());
  arm();
  return new vscode.Disposable(() => end());
}

function notLoaded(name: string): void {
  const message = `Refyntra: the ${name} view did not load. VS Code could not start its web view, which usually happens after VS Code updated in the background while this window stayed open. Reload the window to fix it.`;
  webviewNotices.push(message);
  if (noticeShown) return;
  noticeShown = true;
  void vscode.window.showWarningMessage(message, 'Reload Window').then((pick) => {
    noticeShown = false;
    if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}
