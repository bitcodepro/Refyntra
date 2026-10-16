import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { ChangeImpactResult } from '@refyntra/contracts';
import { fromLocation } from './convert';
import { type ImpactEntry, type ImpactGroup, changedCSharpFiles, impactGroups, impactSummary } from './impactModel';

export const IMPACT_VIEW = 'refyntra.impactView';

type Node =
  | { kind: 'group'; group: ImpactGroup }
  | { kind: 'entry'; entry: ImpactEntry }
  | { kind: 'tests'; tests: ChangeImpactResult['tests'] }
  | { kind: 'test'; name: string; reason: string };

/**
 * Change Impact: what a change reaches — the handlers, endpoints, DI registrations, implementations and uses outside the
 * changed code, and the tests that reference it (static references, not coverage). Of the symbol at the cursor, the
 * current file or the uncommitted C# changes (git status). The Impact view lists them; its tests run with one click.
 */
export class ImpactView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: ChangeImpactResult | undefined;
  private title = '';
  view?: vscode.TreeView<Node>;

  constructor(
    private readonly engine: EngineClient,
    private readonly runTests: (fullyQualifiedNames: string[]) => Promise<unknown>,
  ) {}

  /** Tests: the last result. */
  current(): ChangeImpactResult | undefined {
    return this.result;
  }

  async show(arg?: 'symbol' | 'file' | 'git'): Promise<ChangeImpactResult | undefined> {
    if (!this.engine.changeImpact) return undefined;
    const editor = vscode.window.activeTextEditor;
    let source = arg;
    if (!source) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(symbol-method) Symbol at the cursor', id: 'symbol' as const, enabled: !!editor },
          { label: '$(file-code) Current file', id: 'file' as const, enabled: !!editor },
          { label: '$(git-commit) Uncommitted changes', description: 'git status of the workspace', id: 'git' as const, enabled: true },
        ].filter((x) => x.enabled),
        { title: 'Refyntra: Change Impact', placeHolder: 'What changes?' },
      );
      if (!pick) return undefined;
      source = pick.id;
    }
    let request: { uris?: string[]; uri?: string; position?: { line: number; character: number } };
    if (source === 'symbol' && editor) {
      request = { uri: editor.document.uri.toString(), position: { line: editor.selection.active.line, character: editor.selection.active.character } };
      this.title = `${path.basename(editor.document.uri.fsPath)}:${editor.selection.active.line + 1}`;
    } else if (source === 'file' && editor) {
      request = { uris: [editor.document.uri.toString()] };
      this.title = path.basename(editor.document.uri.fsPath);
    } else {
      const uris = await gitChanges();
      if (!uris.length) {
        void vscode.window.showInformationMessage('Refyntra: no uncommitted C# changes.');
        return undefined;
      }
      request = { uris };
      this.title = `${uris.length} changed file${uris.length === 1 ? '' : 's'}`;
    }
    const r = await vscode.window.withProgress({ location: { viewId: IMPACT_VIEW }, title: 'Refyntra: Change Impact' }, () => this.engine.changeImpact!(request));
    if (!r) {
      void vscode.window.showWarningMessage('Refyntra: Change Impact is not available here (C# files of the loaded solution).');
      return undefined;
    }
    this.result = r;
    await vscode.commands.executeCommand('setContext', 'refyntra.impact.visible', true);
    if (this.view) {
      this.view.description = this.title;
      this.view.message = impactSummary(r);
    }
    this.changed.fire();
    await vscode.commands.executeCommand(`${IMPACT_VIEW}.focus`);
    return r;
  }

  async runAffectedTests(): Promise<void> {
    const tests = this.result?.tests ?? [];
    if (!tests.length) {
      void vscode.window.showInformationMessage('Refyntra: no test references the change.');
      return;
    }
    await this.runTests(tests.map((t) => t.fullyQualifiedName));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'group': {
        const item = new vscode.TreeItem(n.group.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(n.group.entries.length);
        item.iconPath = new vscode.ThemeIcon(n.group.icon);
        return item;
      }
      case 'entry': {
        const item = new vscode.TreeItem(n.entry.label, vscode.TreeItemCollapsibleState.None);
        item.description = `via ${n.entry.via}${n.entry.confidence === 'proven' ? '' : ` · ${n.entry.confidence}`}`;
        if (n.entry.location) {
          const l = fromLocation(n.entry.location);
          item.command = { command: 'vscode.open', title: 'Open', arguments: [l.uri, { selection: l.range }] };
          item.tooltip = `${n.entry.label}\nfound from ${n.entry.via}`;
        }
        return item;
      }
      case 'tests': {
        const item = new vscode.TreeItem('Tests', vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${n.tests.length} · static references, not coverage`;
        item.iconPath = new vscode.ThemeIcon('beaker');
        item.contextValue = 'refyntra.impactTests';
        return item;
      }
      case 'test': {
        const item = new vscode.TreeItem(n.name.slice(n.name.lastIndexOf('.', n.name.lastIndexOf('.') - 1) + 1), vscode.TreeItemCollapsibleState.None);
        item.description = n.reason;
        item.tooltip = `${n.name}\n${n.reason}`;
        item.iconPath = new vscode.ThemeIcon('beaker');
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (!this.result) return [];
    if (!n) {
      const groups: Node[] = impactGroups(this.result).map((group) => ({ kind: 'group', group }));
      if (this.result.tests.length) groups.push({ kind: 'tests', tests: this.result.tests });
      return groups;
    }
    if (n.kind === 'group') return n.group.entries.map((entry) => ({ kind: 'entry', entry }));
    if (n.kind === 'tests') return n.tests.map((t) => ({ kind: 'test', name: t.fullyQualifiedName, reason: t.reason }));
    return [];
  }
}

/** The uncommitted C# files of every workspace folder (git status; untracked files included). */
async function gitChanges(): Promise<string[]> {
  const out: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const text = await new Promise<string>((resolve) =>
      execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: folder.uri.fsPath, windowsHide: true, timeout: 30000 }, (_e, stdout) => resolve(String(stdout ?? ''))),
    );
    const root = await new Promise<string>((resolve) =>
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd: folder.uri.fsPath, windowsHide: true, timeout: 30000 }, (_e, stdout) => resolve(String(stdout ?? '').trim())),
    );
    if (!root) continue;
    for (const f of changedCSharpFiles(text)) out.push(vscode.Uri.file(path.join(root, f)).toString());
  }
  return [...new Set(out)];
}

export function registerImpact(engine: EngineClient, runTests: (fullyQualifiedNames: string[]) => Promise<unknown>): { view: ImpactView; disposable: vscode.Disposable } {
  const view = new ImpactView(engine, runTests);
  const tree = vscode.window.createTreeView(IMPACT_VIEW, { treeDataProvider: view, showCollapseAll: true });
  view.view = tree;
  return {
    view,
    disposable: vscode.Disposable.from(
      tree,
      vscode.commands.registerCommand('refyntra.changeImpact', (source?: unknown) => view.show(source === 'symbol' || source === 'file' || source === 'git' ? source : undefined)),
      vscode.commands.registerCommand('refyntra.impact.runTests', () => view.runAffectedTests()),
    ),
  };
}
