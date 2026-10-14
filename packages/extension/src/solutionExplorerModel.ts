// Solution Explorer model (pure: no vscode, no file system). Turns the host's solution/structure result (protocol 1.20)
// into the tree the "Refyntra Solution" view shows: solution → solution folders → projects → Dependencies (Projects,
// Packages, Frameworks, Analyzers) and the project's items as MSBuild sees them (folders from the virtual paths, linked
// files with a link badge, excluded C# files greyed or hidden). ADR-013. solutionExplorer.ts talks to VS Code.
import type { ProjectStructure, SolutionStructureResult } from '@refyntra/contracts';

export type SolutionNodeKind =
  | 'solution'
  | 'folder'
  | 'solutionItem'
  | 'project'
  | 'dependencies'
  | 'depGroup'
  | 'projectRef'
  | 'package'
  | 'framework'
  | 'analyzer'
  | 'dir'
  | 'file'
  | 'message';

export interface SolutionNode {
  /** Stable id (tree state survives refreshes). */
  id: string;
  kind: SolutionNodeKind;
  label: string;
  description?: string;
  tooltip?: string;
  /** File or project the node stands for (open / reveal / copy path). */
  uri?: string;
  /** The project this node belongs to (project operations from any node inside it). */
  projectUri?: string;
  /** Codicon id. */
  icon: string;
  /** contextValue for menus. */
  context: string;
  linked?: boolean;
  excluded?: boolean;
  children: SolutionNode[];
}

export interface SolutionTreeOptions {
  /** "hide" (default) or "grey": C# files in the project folder that the build does not compile. */
  excludedFiles: 'hide' | 'grey';
  /** Project files the user unloaded in Refyntra (shown greyed, no children). */
  unloaded: ReadonlySet<string>;
  /** The run target the user chose (the startup project), as a project URI. */
  startupProjectUri?: string;
}

/** Codicon per project kind (web / console / test / library / worker / desktop …). */
export function projectIcon(kind: string): string {
  switch (kind) {
    case 'web':
      return 'globe';
    case 'console':
      return 'terminal';
    case 'test':
      return 'beaker';
    case 'library':
      return 'library';
    case 'worker':
      return 'server-process';
    case 'desktop':
      return 'window';
    case 'maui':
      return 'device-mobile';
    case 'blazor-wasm':
      return 'browser';
    default:
      return 'project';
  }
}

export function baseName(uri: string): string {
  const clean = uri.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1));
}

/** Comparison of folder/file names as Solution Explorers sort them (folders first, then case-insensitive names). */
function byName(a: SolutionNode, b: SolutionNode): number {
  const fa = a.kind === 'dir' || a.kind === 'folder' ? 0 : 1;
  const fb = b.kind === 'dir' || b.kind === 'folder' ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const la = a.label.toLowerCase();
  const lb = b.label.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function sortDeep(nodes: SolutionNode[]): void {
  nodes.sort(byName);
  for (const n of nodes) if (n.kind === 'dir' || n.kind === 'folder' || n.kind === 'solution') sortDeep(n.children);
}

function dependencies(p: ProjectStructure): SolutionNode {
  const pid = p.projectUri;
  const group = (key: string, label: string, icon: string, children: SolutionNode[]): SolutionNode => ({
    id: `deps:${key}:${pid}`,
    kind: 'depGroup',
    label,
    description: String(children.length),
    projectUri: pid,
    icon,
    context: `refyntra.sol.depGroup.${key}`,
    children,
  });
  const groups: SolutionNode[] = [];
  if (p.projectReferences.length)
    groups.push(
      group(
        'projects',
        'Projects',
        'references',
        p.projectReferences.map((r) => ({ id: `ref:${pid}|${r.projectUri}`, kind: 'projectRef', label: r.name, uri: r.projectUri, projectUri: pid, icon: 'project', context: 'refyntra.sol.projectRef', tooltip: r.projectUri, children: [] })),
      ),
    );
  if (p.packages.length)
    groups.push(
      group(
        'packages',
        'Packages',
        'package',
        p.packages.map((x) => {
          const shown = x.resolvedVersion ?? x.version ?? '';
          const notes = [x.central ? 'Directory.Packages.props' : '', x.versionOverride ? 'VersionOverride' : '', x.resolvedVersion && x.version && x.resolvedVersion !== x.version ? `requested ${x.version}` : ''].filter(Boolean);
          return {
            id: `pkg:${pid}|${x.id}`,
            kind: 'package' as const,
            label: x.id,
            description: [shown, ...notes.map((n) => `(${n})`)].filter(Boolean).join(' '),
            projectUri: pid,
            icon: 'package',
            context: x.central ? 'refyntra.sol.package.central' : 'refyntra.sol.package',
            tooltip: `${x.id} ${shown}${x.central ? '\nVersion from Directory.Packages.props (Central Package Management)' : ''}`,
            children: [],
          };
        }),
      ),
    );
  if (p.frameworks.length)
    groups.push(group('frameworks', 'Frameworks', 'library', p.frameworks.map((f) => ({ id: `fw:${pid}|${f}`, kind: 'framework', label: f, projectUri: pid, icon: 'symbol-namespace', context: 'refyntra.sol.framework', children: [] }))));
  if (p.analyzers.length)
    groups.push(
      group(
        'analyzers',
        'Analyzers',
        'search',
        p.analyzers.map((a) => ({ id: `an:${pid}|${a.name}`, kind: 'analyzer', label: a.name, projectUri: pid, icon: 'checklist', context: 'refyntra.sol.analyzer', ...(a.uri ? { tooltip: a.uri, uri: a.uri } : {}), children: [] })),
      ),
    );
  return { id: `deps:${pid}`, kind: 'dependencies', label: 'Dependencies', projectUri: pid, icon: 'references', context: 'refyntra.sol.dependencies', children: groups };
}

/** The items of a project as folders and files (virtual paths: Link metadata for linked files). */
export function projectItems(p: ProjectStructure, opts: Pick<SolutionTreeOptions, 'excludedFiles'>): SolutionNode[] {
  const pid = p.projectUri;
  const root: SolutionNode[] = [];
  const dirs = new Map<string, SolutionNode>();
  const projectDir = p.projectUri.slice(0, p.projectUri.lastIndexOf('/'));
  const dirOf = (segments: string[]): SolutionNode[] => {
    let list = root;
    let key = '';
    for (const s of segments) {
      key = key ? `${key}/${s}` : s;
      let d = dirs.get(key);
      if (!d) {
        d = { id: `dir:${pid}|${key}`, kind: 'dir', label: s, uri: `${projectDir}/${key.split('/').map(encodeURIComponent).join('/')}`, projectUri: pid, icon: 'folder', context: 'refyntra.sol.dir', children: [] };
        dirs.set(key, d);
        list.push(d);
      }
      list = d.children;
    }
    return list;
  };
  const add = (virtualPath: string, uri: string, itemType: string, linked: boolean, excluded: boolean) => {
    const parts = virtualPath.split('/').filter(Boolean);
    const name = parts.pop() ?? baseName(uri);
    const notes = [linked ? 'linked' : '', itemType !== 'Compile' ? itemType : '', excluded ? 'not in the build' : ''].filter(Boolean);
    dirOf(parts).push({
      id: `file:${pid}|${virtualPath}`,
      kind: 'file',
      label: name,
      ...(notes.length ? { description: notes.join(', ') } : {}),
      tooltip: `${uri}\n${excluded ? 'Excluded from the project (not compiled)' : `${itemType}${linked ? ' (linked file)' : ''}`}`,
      uri,
      projectUri: pid,
      icon: linked ? 'link' : excluded ? 'circle-slash' : 'file',
      context: excluded ? 'refyntra.sol.file.excluded' : linked ? 'refyntra.sol.file.linked' : 'refyntra.sol.file',
      ...(linked ? { linked: true } : {}),
      ...(excluded ? { excluded: true } : {}),
      children: [],
    });
  };
  for (const i of p.items) add(i.virtualPath, i.uri, i.itemType, i.linked, false);
  if (opts.excludedFiles === 'grey') {
    for (const u of p.excludedUris) {
      if (!u.startsWith(`${projectDir}/`)) continue;
      add(u.slice(projectDir.length + 1).split('/').map(decodeURIComponent).join('/'), u, 'Compile', false, true);
    }
  }
  sortDeep(root);
  return root;
}

export function projectNode(p: ProjectStructure, opts: SolutionTreeOptions): SolutionNode {
  const unloaded = opts.unloaded.has(p.projectUri);
  const startup = opts.startupProjectUri === p.projectUri;
  const notLoaded = p.state === 'notLoaded' || p.state === 'failed';
  const desc = [p.targetFrameworks.join('; '), unloaded ? '(unloaded)' : notLoaded ? `(${p.state === 'failed' ? 'load failed' : 'not loaded'})` : p.state === 'partial' ? '(partially loaded)' : '', startup ? '(startup)' : ''].filter(Boolean).join(' ');
  const runnable = p.kind === 'web' || p.kind === 'console' || p.kind === 'worker' || p.kind === 'desktop';
  return {
    id: `proj:${p.projectUri}`,
    kind: 'project',
    label: p.name,
    ...(desc ? { description: desc } : {}),
    tooltip: `${p.name} (${p.kind})\n${p.projectUri}${p.sdk ? `\nSDK ${p.sdk}` : ''}${p.centralPackageManagement ? '\nCentral Package Management' : ''}`,
    uri: p.projectUri,
    projectUri: p.projectUri,
    icon: unloaded ? 'circle-slash' : projectIcon(p.kind),
    context: `refyntra.sol.project${unloaded ? '.unloaded' : ''}${runnable ? '.runnable' : ''}${p.kind === 'test' ? '.test' : ''}`,
    children: unloaded || notLoaded ? [] : [dependencies(p), ...projectItems(p, opts)],
  };
}

/** The whole tree: one root (the solution, or the projects when a project file was opened). */
export function buildSolutionTree(r: SolutionStructureResult, opts: SolutionTreeOptions): SolutionNode[] {
  const folders = new Map<string, SolutionNode>();
  for (const f of r.folders)
    folders.set(f.id, {
      id: `folder:${f.id}`,
      kind: 'folder',
      label: f.name,
      icon: 'folder-library',
      context: 'refyntra.sol.folder',
      children: f.fileUris.map((u) => ({ id: `item:${f.id}|${u}`, kind: 'solutionItem', label: baseName(u), uri: u, icon: 'file', context: 'refyntra.sol.solutionItem', tooltip: u, children: [] })),
    });
  const top: SolutionNode[] = [];
  for (const f of r.folders) {
    const node = folders.get(f.id)!;
    const parent = f.parentId ? folders.get(f.parentId) : undefined;
    (parent ? parent.children : top).push(node);
  }
  for (const p of r.projects) {
    const node = projectNode(p, opts);
    const parent = p.folderId ? folders.get(p.folderId) : undefined;
    (parent ? parent.children : top).push(node);
  }
  sortDeep(top);
  if (!r.solutionUri) return top;
  const loaded = r.projects.filter((p) => p.state !== 'notLoaded' && p.state !== 'failed' && !opts.unloaded.has(p.projectUri)).length;
  const count = r.projects.length;
  return [
    {
      id: `sln:${r.solutionUri}`,
      kind: 'solution',
      label: baseName(r.solutionUri),
      description: `${count} project${count === 1 ? '' : 's'}${loaded !== count ? `, ${loaded} loaded` : ''}`,
      uri: r.solutionUri,
      icon: 'root-folder',
      context: 'refyntra.sol.solution',
      tooltip: r.solutionUri,
      children: top,
    },
  ];
}

/** The chain of nodes from a root to the node of a file (Reveal Active File). Prefers a non-linked item. */
export function pathToFile(roots: readonly SolutionNode[], fileUri: string): SolutionNode[] | undefined {
  const norm = (u: string) => decodeURIComponent(u).toLowerCase();
  const target = norm(fileUri);
  let best: SolutionNode[] | undefined;
  const walk = (nodes: readonly SolutionNode[], chain: SolutionNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'dependencies') continue;
      const next = [...chain, n];
      if ((n.kind === 'file' || n.kind === 'solutionItem' || n.kind === 'project') && n.uri && norm(n.uri) === target) {
        if (!best || (best[best.length - 1]!.linked && !n.linked)) best = next;
      }
      if (n.children.length) walk(n.children, next);
    }
  };
  walk(roots, []);
  return best;
}

/** Text outline of a tree (tests and the visual baselines' expectations). */
export function outline(nodes: readonly SolutionNode[], depth = 0, maxDepth = 8): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(`${'  '.repeat(depth)}${n.label}${n.description ? ` — ${n.description}` : ''}`);
    if (depth < maxDepth) out.push(...outline(n.children, depth + 1, maxDepth));
  }
  return out;
}

/** Every node by id (getParent for TreeView.reveal). */
export function indexTree(roots: readonly SolutionNode[]): { byId: Map<string, SolutionNode>; parent: Map<string, SolutionNode> } {
  const byId = new Map<string, SolutionNode>();
  const parent = new Map<string, SolutionNode>();
  const walk = (nodes: readonly SolutionNode[], p?: SolutionNode) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      if (p) parent.set(n.id, p);
      walk(n.children, n);
    }
  };
  walk(roots);
  return { byId, parent };
}
