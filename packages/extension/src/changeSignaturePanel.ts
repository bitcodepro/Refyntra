import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { watchWebview } from './webviewWatchdog';
import type { SignatureInfo } from '@refyntra/contracts';
import { type SignatureRow, initialRows } from './codeRefactorSummary';
import { type SignatureView, parseSignatureMessage, reduceSignature, renderSignatureHtml, signatureView } from './changeSignatureModel';

/**
 * The Change Signature dialog: a webview with the parameter table. It only edits rows; "Preview changes…" hands the rows
 * to the normal plan → preview → revalidate → EditApplier pipeline (codeRefactor.ts). No file is touched here.
 */
export class ChangeSignatureDialog implements vscode.Disposable {
  /** The open dialog (tests drive it through `dispatch`, the same path as the page). */
  static current: ChangeSignatureDialog | undefined;

  private rows: SignatureRow[];
  private callSites: { count: number; more?: boolean } | undefined;
  private readonly panel: vscode.WebviewPanel;
  private settle: ((rows: SignatureRow[] | undefined) => void) | undefined;
  readonly result: Promise<SignatureRow[] | undefined>;

  constructor(
    private readonly info: SignatureInfo,
    initial?: SignatureRow[],
  ) {
    this.rows = initial ?? initialRows(info);
    this.result = new Promise((resolve) => (this.settle = resolve));
    const title = `Change Signature: ${info.name ?? 'method'}`;
    this.panel = vscode.window.createWebviewPanel('refyntra.changeSignature', title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const nonce = randomBytes(16).toString('base64');
    this.panel.webview.html = renderSignatureHtml({ nonce, cspSource: this.panel.webview.cspSource, title });
    this.panel.webview.onDidReceiveMessage((m: unknown) => this.dispatch(m));
    const watch = watchWebview(this.panel.webview, 'Change Signature');
    this.panel.onDidDispose(() => {
      watch.dispose();
      this.finish(undefined);
    });
    ChangeSignatureDialog.current = this;
  }

  view(): SignatureView {
    return signatureView(this.info, this.rows, this.callSites);
  }

  setCallSites(c: { count: number; more?: boolean } | undefined): void {
    this.callSites = c;
    this.render();
  }

  /** One message from the page (validated: anything malformed is ignored). */
  dispatch(raw: unknown): void {
    const msg = parseSignatureMessage(raw, this.rows.length);
    if (!msg) return;
    const focusRaw = (raw as { focus?: unknown }).focus;
    const focus = typeof focusRaw === 'string' && /^[a-z]+-\d+(-[A-Za-z]+)?$/.test(focusRaw) ? focusRaw : undefined;
    switch (msg.type) {
      case 'ready':
        return this.render();
      case 'cancel':
        return this.finish(undefined);
      case 'submit':
        if (this.view().problem) return this.render('Fix the problems first.');
        return this.finish(this.rows);
      default: {
        const before = new Set(this.rows.map((r) => r.name));
        this.rows = reduceSignature(this.rows, msg);
        const added = this.rows.findIndex((r) => r.from === undefined && !before.has(r.name));
        const announce = msg.type === 'add' ? 'Parameter added.' : msg.type === 'remove' ? 'Parameter removed.' : msg.type === 'move' || msg.type === 'moveTo' ? `Moved. New signature ${this.view().preview}` : undefined;
        this.render(announce, msg.type === 'add' && added >= 0 ? `f-${added}-name` : focus);
      }
    }
  }

  private render(announce?: string, focus?: string): void {
    void this.panel.webview.postMessage({ type: 'render', view: this.view(), ...(announce ? { announce } : {}), ...(focus ? { focus } : {}) });
  }

  private finish(rows: SignatureRow[] | undefined): void {
    const s = this.settle;
    if (!s) return;
    this.settle = undefined;
    if (ChangeSignatureDialog.current === this) ChangeSignatureDialog.current = undefined;
    s(rows);
    this.panel.dispose();
  }

  dispose(): void {
    this.finish(undefined);
  }
}
