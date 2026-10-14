// The status bar indicator of a Run with Hot Reload (`dotnet watch`) run, and the rude-edit question (watchModel.ts).
import * as vscode from 'vscode';
import { type RudeEditPolicy, WatchOutput, type WatchStatus, watchStatusText } from './watchModel';

export const RESTART_APP = 'Restart App';

export interface WatchHooks {
  /** Tests answer the rude-edit question instead of the notification. */
  answer?: (question: string) => string | undefined;
  /** Questions asked (tests). */
  questions: string[];
}

export const watchHooks: WatchHooks = { questions: [] };

export function rudeEditPolicy(): RudeEditPolicy {
  return vscode.workspace.getConfiguration('refyntra').get<string>('run.hotReload.rudeEdit', 'restart') === 'ask' ? 'ask' : 'restart';
}

export class WatchIndicator implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('refyntra.watch', vscode.StatusBarAlignment.Left, 48);
  private readonly out = new WatchOutput();

  constructor(
    private readonly label: string,
    private readonly show: () => void,
    private readonly restart: () => void,
  ) {
    this.item.name = 'Refyntra Hot Reload';
    this.item.command = 'refyntra.showWatchTerminal';
    this.render();
    this.item.show();
  }

  get status(): WatchStatus {
    return this.out.status;
  }

  text(): string {
    return this.item.text;
  }

  onOutput(text: string): void {
    const prompted = this.out.push(text);
    this.render();
    if (prompted) void this.ask();
  }

  ended(): void {
    this.out.status = { state: 'exited' };
    this.render();
  }

  reveal(): void {
    this.show();
  }

  private render(): void {
    const s = this.out.status;
    this.item.text = watchStatusText(s);
    this.item.tooltip = `${this.label} (dotnet watch)${s.detail ? `\n${s.detail}` : ''}\nClick to show its terminal.`;
    this.item.accessibilityInformation = { label: `${watchStatusText(s).replace(/\$\([^)]*\)\s*/, '')}, ${this.label}` };
    this.item.backgroundColor = s.state === 'rudeEdit' || s.state === 'failed' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  /** policy `ask`: dotnet watch cannot read the answer from Refyntra's terminal, so Refyntra restarts the run itself. */
  private async ask(): Promise<void> {
    const question = `${this.label}: Hot Reload cannot apply this change (a rude edit). Restart the app to apply it?`;
    watchHooks.questions.push(question);
    const pick = watchHooks.answer ? watchHooks.answer(question) : await vscode.window.showWarningMessage(question, RESTART_APP, 'Not Now');
    if (pick === RESTART_APP) this.restart();
  }

  dispose(): void {
    this.item.dispose();
  }
}
