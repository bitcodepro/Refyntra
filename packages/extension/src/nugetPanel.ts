import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectStructure } from '@refyntra/contracts';
import { runCapture, runVisible } from './dotnetCli';
import { type InstalledRow, type NuGetPageState, type NuGetTab, renderNuGetBody, renderNuGetHtml } from './nugetHtml';
import { type SearchHit, filterHits, mergeHits, needsCredentials, parseLocalFeed, parsePackageSearchJson, parseSearch, parseServiceIndex, parseVersions, searchUrl, versionsUrl } from './nugetModel';
import { type NuGetSource, addCentralVersion, addPackage, compareVersions, consolidate, listPackages, nugetSources, packageSearch, parseListPackageJson, parseSourcesShort, removePackage, restore, setCentralVersion } from './projectOpsModel';
import type { SolutionExplorer } from './solutionExplorer';

const fsPath = (uri: string) => vscode.Uri.parse(uri, true).fsPath;
const FETCH_TIMEOUT_MS = 20_000;

export interface NuGetMessage {
  action: string;
  arg?: string;
  version?: string;
  values?: Record<string, string | boolean>;
}

/** Fetches JSON from a NuGet source without credentials (status kept: 401/403 means "use the credential providers"). */
async function getJson(url: string): Promise<{ status: number; json?: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' }, redirect: 'follow' });
    if (!r.ok) return { status: r.status };
    return { status: r.status, json: await r.json() };
  } finally {
    clearTimeout(timer);
  }
}

/** The .nupkg files of a local folder feed (flat or hierarchical, at most 3 levels). */
function listFeed(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) walk(path.join(d, e.name), r, depth + 1);
      else if (e.isFile() && /\.nupkg$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out;
}

export class NuGetPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private s: NuGetPageState;
  private sources: NuGetSource[] | undefined;
  private readonly indexes = new Map<string, ReturnType<typeof parseServiceIndex>>();
  private outdated = new Map<string, string>();
  private vulnerable = new Map<string, string>();
  private deprecated = new Map<string, string>();
  /** Every request the panel made to a source (tests check the network policy). */
  readonly requests: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly key: string,
    private readonly explorer: SolutionExplorer,
    /** Project URIs in scope (one project, or every project of the solution). */
    private readonly scope: () => ProjectStructure[],
    private readonly title: string,
    private readonly onDispose: () => void,
  ) {
    this.s = { title, projects: [], centralPackageManagement: false, tab: 'installed', installed: [], browse: { term: '', prerelease: false, hits: [], searched: false }, updates: { checked: false, rows: [] }, consolidate: [], sources: [] };
    this.rebuild();
  }

  dispose(): void {
    const p = this.panel;
    this.panel = undefined;
    p?.dispose();
    this.onDispose();
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('refyntra.nuget', this.title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const nonce = randomBytes(16).toString('base64');
    this.panel.webview.html = renderNuGetHtml(renderNuGetBody(this.s), { nonce, title: this.title });
    this.panel.webview.onDidReceiveMessage((m: NuGetMessage) => void this.dispatch(m));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.onDispose();
    });
  }

  isOpen(): boolean {
    return !!this.panel;
  }

  state(): NuGetPageState {
    return JSON.parse(JSON.stringify(this.s)) as NuGetPageState;
  }

  html(): string {
    return renderNuGetBody(this.s);
  }

  private render(): void {
    void this.panel?.webview.postMessage({ type: 'body', html: renderNuGetBody(this.s) });
  }

  private set(patch: Partial<NuGetPageState>): void {
    this.s = { ...this.s, ...patch };
    this.render();
  }

  /** Installed rows from the host's model (versions from project files / Directory.Packages.props / assets). */
  rebuild(): void {
    const projects = this.scope();
    const rows = new Map<string, InstalledRow>();
    for (const p of projects)
      for (const x of p.packages) {
        const key = x.id.toLowerCase();
        const v = x.resolvedVersion ?? x.version ?? '';
        const cur = rows.get(key);
        if (cur) {
          cur.projects.push(p.name);
          if (compareVersions(v, cur.version) > 0) cur.version = v;
        } else rows.set(key, { id: x.id, version: v, projects: [p.name], central: x.central });
      }
    const installed = [...rows.values()]
      .map((r) => {
        const latest = this.outdated.get(r.id.toLowerCase());
        const vuln = this.vulnerable.get(r.id.toLowerCase());
        const dep = this.deprecated.get(r.id.toLowerCase());
        return { ...r, projects: r.projects.sort(), ...(latest && compareVersions(latest, r.version) > 0 ? { latest } : {}), ...(vuln ? { vulnerable: vuln } : {}), ...(dep ? { deprecated: dep } : {}) };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const updates = installed.filter((r) => r.latest);
    this.s = {
      ...this.s,
      projects: projects.map((p) => p.name),
      centralPackageManagement: projects.some((p) => p.centralPackageManagement),
      installed,
      updates: { checked: this.s.updates.checked, rows: updates },
      consolidate: consolidate(projects.map((p) => ({ name: p.name, packages: p.packages }))),
    };
    if (this.s.selected) {
      const inst = installed.find((r) => r.id.toLowerCase() === this.s.selected!.id.toLowerCase());
      const { installedVersion: _old, ...rest } = this.s.selected;
      this.s.selected = { ...rest, ...(inst ? { installedVersion: inst.version } : {}) };
    }
    this.render();
  }

  private cwd(): string {
    const sln = this.explorer.structure()?.solutionUri;
    const first = this.scope()[0];
    return sln ? path.dirname(fsPath(sln)) : first ? path.dirname(fsPath(first.projectUri)) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
  }

  /** The user's NuGet sources (`dotnet nuget list source`: the effective NuGet.config chain), read once per panel. */
  async nugetSources(): Promise<NuGetSource[]> {
    if (this.sources) return this.sources;
    const r = await runCapture(nugetSources(this.cwd()), 60_000);
    const list = parseSourcesShort(r.stdout).filter((x) => x.enabled);
    const sources: NuGetSource[] = list.length ? list : [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: true, kind: 'http' }];
    this.sources = sources;
    this.s.sources = sources.map((x) => x.url);
    return sources;
  }

  /** Messages from the page (and e2e tests): one at a time. */
  dispatch(m: NuGetMessage): Promise<void> {
    this.queue = this.queue.then(() => this.handle(m)).catch((e) => this.set({ busy: undefined, message: { kind: 'error', text: e instanceof Error ? e.message : String(e) } }));
    return this.queue;
  }

  private async handle(m: NuGetMessage): Promise<void> {
    const v = m.values ?? {};
    switch (m.action) {
      case 'tab':
        this.set({ tab: (['installed', 'browse', 'updates', 'consolidate'].includes(m.arg ?? '') ? m.arg : 'installed') as NuGetTab, message: undefined });
        if (m.arg === 'browse' && !this.sources) {
          await this.nugetSources();
          this.render();
        }
        return;
      case 'search':
        return this.search(String(v.term ?? m.arg ?? ''), v.prerelease === true);
      case 'select':
        return this.select(m.arg ?? '');
      case 'versions':
        await this.loadVersions(m.arg ?? '');
        return;
      case 'install':
      case 'update':
        await this.install(m.arg ?? '', String(m.version || v.version || this.s.selected?.version || ''));
        return;
      case 'remove':
        await this.remove(m.arg ?? '');
        return;
      case 'consolidate':
        return this.consolidateTo(m.arg ?? '', m.version ?? '');
      case 'checkUpdates':
        return this.check('outdated');
      case 'checkVulnerable':
        return this.check('vulnerable');
      case 'checkDeprecated':
        return this.check('deprecated');
      default:
        return;
    }
  }

  private async search(term: string, prerelease: boolean): Promise<void> {
    this.set({ tab: 'browse', busy: 'Searching your NuGet sources…', message: undefined, browse: { ...this.s.browse, term, prerelease } });
    const sources = await this.nugetSources();
    const lists: SearchHit[][] = [];
    const problems: string[] = [];
    for (const src of sources) {
      try {
        if (src.kind === 'local') {
          lists.push(filterHits(parseLocalFeed(listFeed(src.url), src.url), term).filter((h) => prerelease || !h.version.includes('-')));
          continue;
        }
        const index = await this.serviceIndex(src);
        if (index === 'auth' || !index?.search) {
          // Private feed (credentials) or not a V3 feed: dotnet package search uses the user's credential providers.
          const r = await runCapture(packageSearch(term, this.cwd(), { source: src.url, prerelease }), 120_000);
          const parsed = parsePackageSearchJson(r.stdout);
          lists.push(parsed.hits);
          if (r.code !== 0 && !parsed.hits.length) problems.push(`${src.url}: ${index === 'auth' ? 'needs credentials; dotnet package search could not use them' : 'not a NuGet V3 feed'} (${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''})`);
          continue;
        }
        const url = searchUrl(index.search, term, { prerelease, take: 30 });
        this.requests.push(url);
        const r = await getJson(url);
        if (needsCredentials(r.status)) problems.push(`${src.url}: the search service needs credentials.`);
        else if (!r.json) problems.push(`${src.url}: HTTP ${r.status}`);
        else lists.push(parseSearch(r.json, src.url));
      } catch (e) {
        problems.push(`${src.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const hits = mergeHits(lists);
    this.set({ busy: undefined, browse: { term, prerelease, hits, searched: true }, ...(problems.length ? { message: { kind: 'warning' as const, text: problems.join(' · ') } } : {}) });
  }

  private async serviceIndex(src: NuGetSource): Promise<ReturnType<typeof parseServiceIndex> | 'auth' | undefined> {
    const cached = this.indexes.get(src.url);
    if (cached) return cached;
    if (!/\/index\.json$/i.test(src.url)) return undefined;
    this.requests.push(src.url);
    const r = await getJson(src.url);
    if (needsCredentials(r.status)) return 'auth';
    if (!r.json) return undefined;
    const idx = parseServiceIndex(r.json);
    this.indexes.set(src.url, idx);
    return idx;
  }

  private async select(id: string): Promise<void> {
    const hit = this.s.browse.hits.find((h) => h.id.toLowerCase() === id.toLowerCase());
    const inst = this.s.installed.find((r) => r.id.toLowerCase() === id.toLowerCase());
    const versions = hit?.versions.length ? hit.versions : inst ? [...new Set([inst.latest, inst.version].filter((x): x is string => !!x))] : [];
    this.set({
      selected: {
        id: hit?.id ?? inst?.id ?? id,
        versions,
        ...(versions[0] ? { version: versions[0] } : {}),
        ...(inst ? { installedVersion: inst.version } : {}),
        ...(hit?.source ? { source: hit.source } : {}),
        ...(hit?.description ? { description: hit.description } : {}),
      },
    });
  }

  /** Every version of a package from the sources (flat container; local feeds by file names). User-initiated. */
  async loadVersions(id: string): Promise<string[]> {
    this.set({ busy: `Loading the versions of ${id}…` });
    const all: string[][] = [];
    for (const src of await this.nugetSources()) {
      try {
        if (src.kind === 'local') {
          all.push(parseLocalFeed(listFeed(src.url), src.url).find((h) => h.id.toLowerCase() === id.toLowerCase())?.versions ?? []);
          continue;
        }
        const index = await this.serviceIndex(src);
        if (!index || index === 'auth' || !index.packageBaseAddress) continue;
        const url = versionsUrl(index.packageBaseAddress, id);
        this.requests.push(url);
        const r = await getJson(url);
        if (r.json) all.push(parseVersions(r.json));
      } catch {
        // A source that cannot answer contributes nothing.
      }
    }
    const versions = [...new Set(all.flat())].sort((a, b) => compareVersions(b, a));
    const sel = this.s.selected && this.s.selected.id.toLowerCase() === id.toLowerCase() ? this.s.selected : { id, versions: [] };
    this.set({ busy: undefined, selected: { ...sel, versions, ...(versions[0] ? { version: sel.version && versions.includes(sel.version) ? sel.version : versions[0] } : {}) } });
    return versions;
  }

  private async targetProjects(title: string): Promise<ProjectStructure[]> {
    const projects = this.scope();
    if (projects.length <= 1) return projects;
    const pick = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, picked: false, project: p })),
      { title, canPickMany: true },
    );
    return (pick ?? []).map((p) => p.project);
  }

  /** Install or update: `dotnet add package` per project; with Central Package Management an update edits Directory.Packages.props. */
  async install(id: string, version: string, projects?: ProjectStructure[]): Promise<boolean> {
    if (!id) return false;
    const inScope = this.scope();
    const owners = inScope.filter((p) => p.packages.some((x) => x.id.toLowerCase() === id.toLowerCase()));
    const central = inScope.find((p) => p.centralPackageManagement && p.packagesPropsUri && p.packages.some((x) => x.id.toLowerCase() === id.toLowerCase() && x.central));
    if (central && version) {
      const props = fsPath(central.packagesPropsUri!);
      const text = fs.readFileSync(props, 'utf8');
      const next = setCentralVersion(text, id, version) ?? addCentralVersion(text, id, version);
      this.set({ busy: `Setting ${id} ${version} in Directory.Packages.props…` });
      // Restore first (visible task), so the reloaded project resolves the new version.
      fs.writeFileSync(props, next, 'utf8');
      const sln = this.explorer.structure()?.solutionUri;
      await runVisible(restore(sln ? fsPath(sln) : fsPath(central.projectUri)));
      await this.explorer.editFiles(`${id} ${version} in Directory.Packages.props`, [{ path: props, text: next }], text);
      this.afterChange();
      return true;
    }
    const targets = projects ?? (owners.length && inScope.length > 1 ? owners : await this.targetProjects(`Install ${id} into`));
    if (!targets.length) return false;
    const local = this.s.browse.hits.find((h) => h.id.toLowerCase() === id.toLowerCase() && !/^https?:/i.test(h.source))?.source;
    for (const p of targets) {
      this.set({ busy: `dotnet add package ${id} (${p.name})…` });
      const proj = fsPath(p.projectUri);
      const files = [proj, ...(p.packagesPropsUri ? [fsPath(p.packagesPropsUri)] : [])];
      const ok = await this.explorer.mutate(`${p.name}: ${id} ${version || 'latest'}`, files, addPackage(proj, id, { ...(version ? { version } : {}), ...(local ? { source: local } : {}) }));
      if (!ok) break;
    }
    this.afterChange();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const targets = this.scope().filter((p) => p.packages.some((x) => x.id.toLowerCase() === id.toLowerCase()));
    if (!targets.length) return false;
    for (const p of targets) {
      this.set({ busy: `dotnet remove package ${id} (${p.name})…` });
      const proj = fsPath(p.projectUri);
      const ok = await this.explorer.mutate(`${p.name}: removed ${id}`, [proj], removePackage(proj, id));
      if (!ok) break;
    }
    this.afterChange();
    return true;
  }

  private async consolidateTo(id: string, version: string): Promise<void> {
    if (!id || !version) return;
    const behind = this.scope().filter((p) => p.packages.some((x) => x.id.toLowerCase() === id.toLowerCase() && (x.resolvedVersion ?? x.version) !== version));
    await this.install(id, version, behind);
  }

  private afterChange(): void {
    this.rebuild();
    this.set({ busy: undefined });
  }

  /** `dotnet list package --outdated / --vulnerable / --deprecated` (asks the configured sources; on demand only). */
  async check(mode: 'outdated' | 'vulnerable' | 'deprecated'): Promise<void> {
    const sln = this.explorer.structure()?.solutionUri;
    const projects = this.scope();
    const targets = projects.length > 1 && sln ? [fsPath(sln)] : projects.map((p) => fsPath(p.projectUri));
    this.set({ busy: `dotnet list package --${mode}…`, message: undefined });
    const problems: string[] = [];
    const map = mode === 'outdated' ? (this.outdated = new Map()) : mode === 'vulnerable' ? (this.vulnerable = new Map()) : (this.deprecated = new Map());
    for (const t of targets) {
      const r = await runCapture(listPackages(t, mode), 300_000);
      const parsed = parseListPackageJson(r.stdout);
      problems.push(...parsed.problems);
      if (r.code !== 0 && !parsed.packages.length) problems.push((r.stderr || r.stdout).trim().split('\n').slice(0, 2).join(' '));
      for (const x of parsed.packages) {
        if (x.transitive) continue;
        const key = x.id.toLowerCase();
        if (mode === 'outdated' && x.latestVersion) map.set(key, x.latestVersion);
        if (mode === 'vulnerable' && x.vulnerabilities.length) map.set(key, x.vulnerabilities.map((v) => v.severity).join(', ') || 'vulnerable');
        if (mode === 'deprecated') map.set(key, x.deprecationReasons.join(', ') || 'deprecated');
      }
    }
    if (mode === 'outdated') this.s.updates.checked = true;
    this.s.audit = { vulnerable: mode === 'vulnerable' || !!this.s.audit?.vulnerable, deprecated: mode === 'deprecated' || !!this.s.audit?.deprecated };
    this.rebuild();
    const found = map.size;
    const what = mode === 'outdated' ? 'update' : mode === 'vulnerable' ? 'vulnerable package' : 'deprecated package';
    this.set({ busy: undefined, ...(mode === 'outdated' ? { tab: 'updates' as const } : {}), message: problems.length ? { kind: 'warning', text: problems.join(' · ') } : { kind: 'info', text: `${found} ${what}${found === 1 ? '' : 's'} found.` } });
  }
}

export class NuGetPanels {
  private readonly open = new Map<string, NuGetPanel>();
  constructor(private readonly explorer: SolutionExplorer) {}

  current(): NuGetPanel | undefined {
    return [...this.open.values()].pop();
  }

  all(): NuGetPanel[] {
    return [...this.open.values()];
  }

  refreshAll(): void {
    for (const p of this.open.values()) p.rebuild();
  }

  show(project: ProjectStructure | undefined): NuGetPanel {
    const key = project?.projectUri ?? 'solution';
    let panel = this.open.get(key);
    if (!panel) {
      const scope = project ? () => [this.explorer.project(project.projectUri) ?? project] : () => this.explorer.structure()?.projects.filter((p) => p.state !== 'notLoaded') ?? [];
      const title = project ? `NuGet: ${project.name}` : 'NuGet: Solution';
      panel = new NuGetPanel(key, this.explorer, scope, title, () => this.open.delete(key));
      this.open.set(key, panel);
    }
    panel.show();
    return panel;
  }
}

export function registerNuGet(_context: vscode.ExtensionContext, explorer: SolutionExplorer, isTrusted: () => boolean): { panels: NuGetPanels; disposable: vscode.Disposable } {
  const panels = new NuGetPanels(explorer);
  const disposable = vscode.Disposable.from(
    vscode.commands.registerCommand('refyntra.manageNuGet', async (arg?: unknown) => {
      if (!isTrusted()) {
        void vscode.window.showWarningMessage('Refyntra does not run NuGet commands in Restricted Mode. Trust the workspace first.');
        return undefined;
      }
      if (!explorer.structure()) await explorer.refresh();
      const n = arg as { kind?: string; projectUri?: string } | undefined;
      if (n && typeof n === 'object' && n.kind === 'solution') return panels.show(undefined);
      const project = n && typeof n === 'object' && n.projectUri ? explorer.project(n.projectUri) : typeof arg === 'string' ? explorer.structure()?.projects.find((p) => p.projectUri === arg || p.name === arg) : undefined;
      if (project) return panels.show(project);
      const list = explorer.structure()?.projects ?? [];
      const pick = await vscode.window.showQuickPick([{ label: '$(root-folder) Solution', project: undefined as ProjectStructure | undefined }, ...list.map((p) => ({ label: p.name, project: p as ProjectStructure | undefined }))], { title: 'Manage NuGet Packages for' });
      return pick ? panels.show(pick.project) : undefined;
    }),
    explorer.onDidChangeTreeData(() => panels.refreshAll()),
  );
  return { panels, disposable };
}
