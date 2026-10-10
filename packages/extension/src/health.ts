import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { formatAdapterHealth, formatStatusBar, worstState } from '@refyntra/domain';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { renderHealth } from './healthText';
import { type HealthAction, type HealthPageModel, type RestoreRun, buildHealthPage, resolveMessage } from './healthPageModel';
import { healthAnnouncement, renderHealthBody, renderHealthHtml } from './healthPageHtml';
import { statusBarLabel } from './terminology';
import { RESTORE_TASK_TYPE, runRestore } from './restore';

export { renderHealth };
import { runRecovery } from './actions';

export const HEALTH_SCHEME = 'refyntra-health';
export const HEALTH_TEXT_COMMAND = 'refyntra.showHealthText';
export const HEALTH_URI = vscode.Uri.from({ scheme: HEALTH_SCHEME, path: '/Refyntra Health.md' });

export class HealthDocument implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly engine: EngineClient,
    private readonly solution: () => string | undefined,
  ) {
    this.sub = engine.onDidChangeHealth(() => this.changed.fire(HEALTH_URI));
  }

  provideTextDocumentContent(): string {
    return renderHealth(this.engine.health(), { solution: this.solution() });
  }

  async show(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(HEALTH_URI);
    if (doc.languageId !== 'markdown') await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: true });
    const actions = this.engine.health().adapters.flatMap((a) => [
      ...a.recoveryActions,
      ...[...a.diagnostics, ...a.projects.flatMap((p) => p.diagnostics)].flatMap((d) => d.recoveryActions ?? []),
    ]).filter((r) => r.command !== 'refyntra.showHealth');
    const unique = [...new Map(actions.map((a) => [a.command, a])).values()];
    if (unique.length) {
      // Not awaited: the command finishes when the page is shown.
      void vscode.window.showInformationMessage('Refyntra: some features are unavailable. See the health page.', ...unique.map((a) => a.title)).then((pick) => runRecovery(unique.find((a) => a.title === pick)));
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

/**
 * The Health page (webview). Plain words first, technical details collapsed at the bottom. The page script can only
 * post {type:'action', key}; the key is looked up in the model this class built, so the webview never chooses a
 * command or an argument. Updates live on every health change and restore progress.
 */
export class HealthPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private restore: RestoreRun | undefined;
  private current: HealthPageModel;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly solution: () => string | undefined,
    private readonly isTrusted: () => boolean,
  ) {
    this.current = this.build();
    this.subs.push(
      engine.onDidChangeHealth(() => this.update()),
      vscode.tasks.onDidEndTaskProcess((e) => void this.onTaskEnd(e)),
    );
  }

  model(): HealthPageModel {
    return this.current;
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** The page as the webview receives it (tests check landmarks, live region and styles of the real HTML). */
  renderedHtml(): string {
    return renderHealthHtml(this.body(), { nonce: 'test', cspSource: 'vscode-webview:', announce: healthAnnouncement(this.current) });
  }

  private build(): HealthPageModel {
    return buildHealthPage({ health: this.engine.health(), restore: this.restore });
  }

  private updateMessage(): { type: 'update'; html: string; announce: string } {
    return { type: 'update', html: this.body(), announce: healthAnnouncement(this.current) };
  }

  private body(): string {
    return renderHealthBody(this.current, this.engine.health(), { solution: this.solution() });
  }

  show(): void {
    this.current = this.build();
    if (this.panel) {
      this.panel.reveal();
      void this.panel.webview.postMessage(this.updateMessage());
      return;
    }
    const panel = vscode.window.createWebviewPanel('refyntra.health', 'Refyntra Health', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    this.panel = panel;
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = renderHealthHtml(this.body(), { nonce, cspSource: panel.webview.cspSource, announce: healthAnnouncement(this.current) });
    panel.webview.onDidReceiveMessage((m: unknown) => this.dispatch(m));
    panel.onDidChangeViewState(() => panel.visible && this.update());
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private update(): void {
    this.current = this.build();
    if (this.panel) void this.panel.webview.postMessage(this.updateMessage());
  }

  /** A message from the webview (or the e2e test, through the same path). Only actions of the current model run. */
  async dispatch(msg: unknown): Promise<void> {
    const a = resolveMessage(this.current, msg);
    if (a) await this.run(a);
  }

  private async run(a: HealthAction): Promise<void> {
    switch (a.id) {
      case 'restore':
        return this.startRestore(a.arg);
      case 'showRestoreOutput': {
        const name = this.restore ? `dotnet restore ${path.basename(this.restore.target)}` : 'dotnet restore';
        const t = vscode.window.terminals.find((x) => x.name.includes(name));
        if (t) t.show();
        else await vscode.commands.executeCommand('workbench.action.terminal.focus');
        return;
      }
      case 'installSdk':
        if (a.arg && /^https:\/\//.test(a.arg)) await vscode.env.openExternal(vscode.Uri.parse(a.arg));
        return;
      case 'openGlobalJson':
        if (a.arg && path.isAbsolute(a.arg) && path.basename(a.arg).toLowerCase() === 'global.json') await vscode.window.showTextDocument(vscode.Uri.file(a.arg));
        return;
      case 'trustWorkspace':
        await vscode.commands.executeCommand('workbench.trust.manage');
        return;
      case 'selectSolution':
        await vscode.commands.executeCommand('refyntra.selectSolution');
        return;
      case 'restartBackend':
        await vscode.commands.executeCommand('refyntra.restartBackend');
        return;
      case 'exportDebugBundle':
        await vscode.commands.executeCommand('refyntra.exportDebugBundle');
        return;
      case 'getStarted':
        await vscode.commands.executeCommand('refyntra.getStarted');
        return;
      case 'copyText':
        await vscode.env.clipboard.writeText(renderHealth(this.engine.health(), { solution: this.solution() }));
        void vscode.window.showInformationMessage('Refyntra: the health report was copied to the clipboard.');
        return;
      case 'showText':
        await vscode.commands.executeCommand(HEALTH_TEXT_COMMAND);
        return;
    }
  }

  private async startRestore(target: string | undefined): Promise<void> {
    if (this.restore?.state === 'running' || !target) return;
    // runRestore re-checks trust, the file type and that the target is inside an open workspace folder.
    const exec = await runRestore(this.isTrusted, target, { quiet: true });
    if (!exec) return;
    this.restore = { state: 'running', target };
    this.update();
  }

  private async onTaskEnd(e: vscode.TaskProcessEndEvent): Promise<void> {
    const def = e.execution.task.definition;
    const run = this.restore;
    if (def.type !== RESTORE_TASK_TYPE || run?.state !== 'running' || def.target !== run.target) return;
    if (e.exitCode !== 0) {
      this.restore = { state: 'failed', target: run.target, exitCode: e.exitCode };
      this.update();
      return;
    }
    this.restore = { state: 'succeeded', target: run.target };
    this.update();
    try {
      await this.engine.restart();
    } finally {
      if (this.restore?.state === 'succeeded') this.restore = undefined;
      this.update();
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.panel?.dispose();
  }
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('refyntra.status', vscode.StatusBarAlignment.Left, 50);
  private readonly sub: vscode.Disposable;
  private visible = false;

  constructor(private readonly engine: EngineClient) {
    this.item.name = 'Refyntra';
    this.item.command = 'refyntra.showMenu';
    this.sub = engine.onDidChangeHealth(() => this.update());
    this.update();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.update();
  }

  text(): string {
    return this.item.text;
  }

  /** What a screen reader says for the item. */
  accessibleLabel(): string {
    return this.item.accessibilityInformation?.label ?? '';
  }

  update(): void {
    const h = this.engine.health();
    const worst = worstState(h);
    const icon = worst === 'Loading' || worst === 'Restarting' ? '$(sync~spin) ' : worst === 'Ready' ? '' : '$(warning) ';
    this.item.text = `${icon}${formatStatusBar(h)}`;
    this.item.tooltip = [...h.adapters.map(formatAdapterHealth), h.workspaceTrusted ? '' : 'Restricted Mode: the C# host is not started.', 'Click for the Refyntra menu (Find, Related, Actions, Rename, Health, …)'].filter(Boolean).join('\n');
    this.item.accessibilityInformation = { label: statusBarLabel(h), role: 'button' };
    this.item.backgroundColor = worst === 'Failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') : worst === 'TrustRequired' || worst === 'Partial' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (this.visible) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
