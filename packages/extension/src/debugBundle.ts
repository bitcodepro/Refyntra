import * as os from 'node:os';
import * as vscode from 'vscode';
import type { HealthSummary } from '@refyntra/domain';
import { type LogRing, buildDebugBundle, renderDebugBundle } from './debugBundleModel';

export const BUNDLE_SCHEME = 'refyntra-debug-bundle';
const PREVIEW_URI = vscode.Uri.parse(`${BUNDLE_SCHEME}:/Refyntra%20Debug%20Bundle%20(preview).json`);

/** Test-mode hooks: replace the opt-in pick, the confirmation and the save dialog (honoured only in Test mode). */
export interface DebugBundleTestHooks {
  includeProjectNames?: boolean;
  /** Called with the previewed text while nothing has been written; return true to save. */
  confirm?: (previewText: string) => Promise<boolean> | boolean;
  saveTarget?: vscode.Uri;
}

export type ExportResult = { status: 'saved'; uri: vscode.Uri; text: string } | { status: 'cancelled'; previewText?: string };

/** Read-only preview document: shows exactly the bytes that will be saved. */
export class BundlePreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private text = '';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  set(text: string): void {
    this.text = text;
    this.emitter.fire(PREVIEW_URI);
  }
  provideTextDocumentContent(): string {
    return this.text;
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export class DebugBundleExporter {
  testHooks: DebugBundleTestHooks | undefined;

  constructor(
    private readonly deps: {
      extensionVersion: string;
      health: () => HealthSummary;
      log: LogRing;
      preview: BundlePreviewProvider;
      testMode: boolean;
    },
  ) {}

  /** Opt-in, previewed, local only: nothing is written before the user confirms and picks a file. */
  async run(): Promise<ExportResult> {
    const hooks = this.deps.testMode ? this.testHooks : undefined;
    let includeProjectNames: boolean;
    if (hooks?.includeProjectNames !== undefined) {
      includeProjectNames = hooks.includeProjectNames;
    } else {
      const item: vscode.QuickPickItem = {
        label: 'Include project and solution names',
        description: 'off: names are replaced by project-1, project-2, …',
        detail: 'Paths under your home folder and the workspace are always replaced by placeholders. No source text, no environment values.',
        picked: false,
      };
      const picked = await vscode.window.showQuickPick([item], {
        canPickMany: true,
        title: 'Refyntra: Export Debug Bundle — options (a preview is shown before anything is saved)',
        ignoreFocusOut: true,
      });
      if (!picked) return { status: 'cancelled' };
      includeProjectNames = picked.includes(item);
    }

    const bundle = buildDebugBundle(
      {
        generatedAt: new Date().toISOString(),
        extensionVersion: this.deps.extensionVersion,
        vscodeVersion: vscode.version,
        os: { platform: process.platform, release: os.release(), arch: process.arch },
        health: this.deps.health(),
        logLines: this.deps.log.snapshot(),
        homeDir: os.homedir(),
        workspaceRoots: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
      },
      { includeProjectNames },
    );
    const text = renderDebugBundle(bundle);
    this.deps.preview.set(text);
    const doc = await vscode.workspace.openTextDocument(PREVIEW_URI);
    await vscode.languages.setTextDocumentLanguage(doc, 'json');
    await vscode.window.showTextDocument(doc, { preview: true });

    const ok = hooks?.confirm
      ? await hooks.confirm(text)
      : (await vscode.window.showInformationMessage(
          'Save this Refyntra debug bundle? The preview shows exactly what will be written to a local file. Nothing is sent anywhere.',
          { modal: true },
          'Save…',
        )) === 'Save…';
    if (!ok) return { status: 'cancelled', previewText: text };

    const stamp = bundle.generatedAt.replace(/[:.]/g, '-');
    const target =
      hooks?.saveTarget ??
      (await vscode.window.showSaveDialog({
        title: 'Save Refyntra debug bundle',
        defaultUri: vscode.Uri.file(`${os.homedir()}/refyntra-debug-bundle-${stamp}.json`),
        filters: { JSON: ['json'] },
      }));
    if (!target) return { status: 'cancelled', previewText: text };
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(`Refyntra debug bundle saved: ${target.fsPath}`);
    return { status: 'saved', uri: target, text };
  }
}
