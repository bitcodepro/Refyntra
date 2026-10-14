import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { compareVersions } from './projectOpsModel';
import { MSBUILD_ITEMS, MSBUILD_PROPERTIES, cacheIds, elementNameAt, groupNames, hoverFor, packageIdOfElement, projectFileContext, propertyValues } from './projectFileModel';
import type { SolutionExplorer } from './solutionExplorer';

/** .csproj / .props / .targets in any language mode (VS Code opens them as XML, or plain text without an XML extension). */
export const PROJECT_FILE_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', pattern: '**/*.csproj' },
  { scheme: 'file', pattern: '**/*.props' },
  { scheme: 'file', pattern: '**/*.targets' },
];

const LOAD_VERSIONS = 'refyntra.projectFile.loadVersions';

/** The global packages folder (NUGET_PACKAGES or ~/.nuget/packages): its folder names are lower-case package ids. */
export function globalPackagesFolder(): string {
  return process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
}

function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export class ProjectFileCompletion implements vscode.CompletionItemProvider, vscode.HoverProvider {
  /** Versions loaded from the NuGet sources on request (package id lower case → versions, newest first). */
  private readonly remoteVersions = new Map<string, string[]>();

  constructor(private readonly explorer: SolutionExplorer) {}

  /** Installed package ids (the loaded solution) and the local NuGet cache. */
  packageIds(prefix: string): { id: string; detail: string }[] {
    const installed = new Map<string, string>();
    for (const p of this.explorer.structure()?.projects ?? []) for (const x of p.packages) installed.set(x.id.toLowerCase(), x.id);
    const out = new Map<string, { id: string; detail: string }>();
    for (const [key, id] of installed) if (key.startsWith(prefix.toLowerCase())) out.set(key, { id, detail: 'installed in the solution' });
    for (const id of cacheIds(readDirNames(globalPackagesFolder()), prefix).slice(0, 500)) if (!out.has(id)) out.set(id, { id, detail: 'local NuGet cache' });
    return [...out.values()];
  }

  versions(id: string): { version: string; detail: string }[] {
    const local = readDirNames(path.join(globalPackagesFolder(), id.toLowerCase())).filter((v) => /^\d/.test(v));
    const remote = this.remoteVersions.get(id.toLowerCase()) ?? [];
    const all = [...new Set([...remote, ...local])].sort((a, b) => compareVersions(b, a));
    return all.map((v) => ({ version: v, detail: local.includes(v) ? 'local NuGet cache' : 'NuGet source' }));
  }

  setRemoteVersions(id: string, versions: string[]): void {
    this.remoteVersions.set(id.toLowerCase(), versions);
  }

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - 400), 0), pos));
    const ctx = projectFileContext(before);
    const items: vscode.CompletionItem[] = [];
    const lineBefore = doc.lineAt(pos.line).text.slice(0, pos.character);
    switch (ctx.kind) {
      case 'propertyName':
      case 'itemName':
      case 'groupName': {
        const list = ctx.kind === 'propertyName' ? MSBUILD_PROPERTIES : ctx.kind === 'itemName' ? MSBUILD_ITEMS : groupNames().map((name) => ({ name, doc: '' }));
        const typed = /<([A-Za-z_][\w.-]*)?$/.exec(lineBefore)?.[1] ?? '';
        const range = new vscode.Range(pos.translate(0, -typed.length), pos);
        for (const e of list) {
          const it = new vscode.CompletionItem(e.name, ctx.kind === 'propertyName' ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Class);
          it.range = range;
          if (e.doc) it.documentation = new vscode.MarkdownString(e.doc);
          if (ctx.kind === 'propertyName') it.insertText = new vscode.SnippetString(`${e.name}>$1</${e.name}>`);
          else if (ctx.kind === 'itemName') it.insertText = new vscode.SnippetString(e.name === 'PackageReference' ? 'PackageReference Include="$1" Version="$2" />' : `${e.name} Include="$1" />`);
          items.push(it);
        }
        break;
      }
      case 'propertyValue':
        for (const v of propertyValues(ctx.property)) {
          const it = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
          it.detail = ctx.property;
          items.push(it);
        }
        break;
      case 'attributeValue': {
        const pkgElement = ctx.element === 'PackageReference' || ctx.element === 'PackageVersion';
        const range = new vscode.Range(pos.translate(0, -ctx.prefix.length), pos);
        if (pkgElement && (ctx.attribute === 'Include' || ctx.attribute === 'Update')) {
          for (const p of this.packageIds(ctx.prefix)) {
            const it = new vscode.CompletionItem(p.id, vscode.CompletionItemKind.Module);
            it.detail = p.detail;
            it.range = range;
            items.push(it);
          }
        } else if (pkgElement && (ctx.attribute === 'Version' || ctx.attribute === 'VersionOverride')) {
          const id = packageIdOfElement(before);
          if (id) {
            this.versions(id).forEach((v, i) => {
              const it = new vscode.CompletionItem(v.version, vscode.CompletionItemKind.Constant);
              it.detail = v.detail;
              it.range = range;
              it.sortText = String(i).padStart(4, '0');
              items.push(it);
            });
            const more = new vscode.CompletionItem('Load versions from NuGet sources…', vscode.CompletionItemKind.Event);
            more.detail = 'Asks your configured NuGet sources (network)';
            more.insertText = '';
            more.range = range;
            more.sortText = '9999';
            more.filterText = ctx.prefix;
            more.command = { command: LOAD_VERSIONS, title: 'Load versions', arguments: [id] };
            items.push(more);
          }
        } else if (ctx.element === 'FrameworkReference' && ctx.attribute === 'Include') {
          for (const f of ['Microsoft.AspNetCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.WindowsDesktop.App.WPF', 'Microsoft.WindowsDesktop.App.WindowsForms']) {
            const it = new vscode.CompletionItem(f, vscode.CompletionItemKind.Module);
            it.range = range;
            items.push(it);
          }
        }
        break;
      }
      default:
        break;
    }
    return items;
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const line = doc.lineAt(pos.line).text;
    const name = elementNameAt(line, pos.character);
    const text = name ? hoverFor(name) : undefined;
    return text ? new vscode.Hover(new vscode.MarkdownString(text)) : undefined;
  }
}

export function registerProjectFileEditing(explorer: SolutionExplorer, loadVersions: (id: string) => Promise<string[]>): { provider: ProjectFileCompletion; disposable: vscode.Disposable } {
  const provider = new ProjectFileCompletion(explorer);
  const disposable = vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(PROJECT_FILE_SELECTOR, provider, '<', '"'),
    vscode.languages.registerHoverProvider(PROJECT_FILE_SELECTOR, provider),
    vscode.commands.registerCommand(LOAD_VERSIONS, async (id: string) => {
      if (typeof id !== 'string' || !id) return;
      const versions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Refyntra: versions of ${id}` }, () => loadVersions(id));
      provider.setRemoteVersions(id, versions);
      if (versions.length) await vscode.commands.executeCommand('editor.action.triggerSuggest');
      else void vscode.window.showInformationMessage(`Refyntra: no versions of ${id} were found in your NuGet sources.`);
    }),
  );
  return { provider, disposable };
}
