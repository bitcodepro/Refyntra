// Project operations model (pure: no vscode, no processes, no file system). Builds the dotnet CLI command lines the
// Solution Explorer and the NuGet panel run as visible tasks (argument arrays: no shell, so paths with spaces stay one
// argument), parses what those commands print, and plans the file edits of Rename Project. ADR-013.

export interface CliCommand {
  command: string;
  args: string[];
  cwd: string;
  /** Short title of the task ("dotnet sln add"). */
  title: string;
}

const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p : p.slice(0, i);
};

export function slnAdd(solution: string, project: string, solutionFolder?: string): CliCommand {
  const args = ['sln', solution, 'add', project];
  args.push(...(solutionFolder ? ['--solution-folder', solutionFolder] : ['--in-root']));
  return { command: 'dotnet', args, cwd: dirOf(solution), title: 'dotnet sln add' };
}

export function slnRemove(solution: string, project: string): CliCommand {
  return { command: 'dotnet', args: ['sln', solution, 'remove', project], cwd: dirOf(solution), title: 'dotnet sln remove' };
}

export function newProject(template: string, name: string, outputDir: string, framework?: string): CliCommand {
  const args = ['new', template, '--name', name, '--output', outputDir];
  if (framework) args.push('--framework', framework);
  return { command: 'dotnet', args, cwd: dirOf(outputDir), title: `dotnet new ${template}` };
}

export function newList(cwd: string): CliCommand {
  return { command: 'dotnet', args: ['new', 'list', '--columns', 'type', '--columns', 'language', '--columns', 'tags'], cwd, title: 'dotnet new list' };
}

export function addReference(project: string, reference: string): CliCommand {
  return { command: 'dotnet', args: ['add', project, 'reference', reference], cwd: dirOf(project), title: 'dotnet add reference' };
}

export function removeReference(project: string, reference: string): CliCommand {
  return { command: 'dotnet', args: ['remove', project, 'reference', reference], cwd: dirOf(project), title: 'dotnet remove reference' };
}

export function addPackage(project: string, id: string, opts: { version?: string; source?: string; prerelease?: boolean; noRestore?: boolean } = {}): CliCommand {
  const args = ['add', project, 'package', id];
  if (opts.version) args.push('--version', opts.version);
  else if (opts.prerelease) args.push('--prerelease');
  if (opts.source) args.push('--source', opts.source);
  if (opts.noRestore) args.push('--no-restore');
  return { command: 'dotnet', args, cwd: dirOf(project), title: `dotnet add package ${id}` };
}

export function removePackage(project: string, id: string): CliCommand {
  return { command: 'dotnet', args: ['remove', project, 'package', id], cwd: dirOf(project), title: `dotnet remove package ${id}` };
}

export type ListPackageMode = 'installed' | 'outdated' | 'vulnerable' | 'deprecated';

/** dotnet list package (JSON output, SDK 7.0.200+); "outdated" / "vulnerable" / "deprecated" ask the configured sources. */
export function listPackages(target: string, mode: ListPackageMode, prerelease = false): CliCommand {
  const args = ['list', target, 'package', '--format', 'json'];
  if (mode !== 'installed') args.push(`--${mode}`);
  if (mode === 'outdated' && prerelease) args.push('--include-prerelease');
  return { command: 'dotnet', args, cwd: dirOf(target), title: `dotnet list package${mode === 'installed' ? '' : ` --${mode}`}` };
}

/** dotnet package search (SDK 8.0.2xx+): searches with the user's credential providers (private feeds). */
export function packageSearch(term: string, cwd: string, opts: { source?: string; prerelease?: boolean; take?: number } = {}): CliCommand {
  const args = ['package', 'search', term, '--format', 'json', '--take', String(opts.take ?? 30)];
  if (opts.source) args.push('--source', opts.source);
  if (opts.prerelease) args.push('--prerelease');
  return { command: 'dotnet', args, cwd, title: 'dotnet package search' };
}

export function restore(target: string): CliCommand {
  return { command: 'dotnet', args: ['restore', target], cwd: dirOf(target), title: 'dotnet restore' };
}

export function nugetSources(cwd: string): CliCommand {
  return { command: 'dotnet', args: ['nuget', 'list', 'source', '--format', 'short'], cwd, title: 'dotnet nuget list source' };
}

/** Display of a command line (task names, logs): arguments with spaces quoted. */
export function commandLine(c: Pick<CliCommand, 'command' | 'args'>): string {
  return [c.command, ...c.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

// ---------------------------------------------------------------- dotnet new list

export interface TemplateInfo {
  name: string;
  shortNames: string[];
  languages: string[];
  type: string;
  tags: string;
}

/**
 * Parses the table `dotnet new list --columns type --columns language --columns tags` prints: a header line, a line of
 * dashes whose groups give the column widths, then one row per template. Only project templates (type "project").
 */
export function parseTemplateList(output: string): TemplateInfo[] {
  const lines = output.replace(/\r/g, '').split('\n');
  const dashIndex = lines.findIndex((l) => /^-{3,}(\s+-{3,})+\s*$/.test(l));
  if (dashIndex < 1) return [];
  const header = lines[dashIndex - 1]!;
  const cols: { start: number; end: number; name: string }[] = [];
  const re = /-+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lines[dashIndex]!))) cols.push({ start: m.index, end: m.index + m[0].length, name: '' });
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]!;
    const next = cols[i + 1];
    c.name = header.slice(c.start, next ? next.start : undefined).trim().toLowerCase();
  }
  const cell = (row: string, i: number) => row.slice(cols[i]!.start, cols[i + 1] ? cols[i + 1]!.start : undefined).trim();
  const idx = (pred: (n: string) => boolean) => cols.findIndex((c) => pred(c.name));
  const iName = idx((n) => n.startsWith('template name') || n === 'name');
  const iShort = idx((n) => n.startsWith('short name'));
  const iLang = idx((n) => n.startsWith('language'));
  const iType = idx((n) => n === 'type');
  const iTags = idx((n) => n === 'tags');
  if (iName < 0 || iShort < 0) return [];
  const out: TemplateInfo[] = [];
  for (const row of lines.slice(dashIndex + 1)) {
    if (!row.trim()) continue;
    const type = iType >= 0 ? cell(row, iType).toLowerCase() : 'project';
    if (type && type !== 'project') continue;
    const shortNames = cell(row, iShort).split(',').map((s) => s.trim()).filter(Boolean);
    if (!shortNames.length) continue;
    const languages = (iLang >= 0 ? cell(row, iLang) : '').replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ name: cell(row, iName), shortNames, languages, type: type || 'project', tags: iTags >= 0 ? cell(row, iTags) : '' });
  }
  return out.filter((t) => t.languages.length === 0 || t.languages.some((l) => l === 'C#'));
}

// ---------------------------------------------------------------- dotnet list package --format json

export interface ListedPackage {
  project: string;
  framework: string;
  id: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  latestVersion?: string;
  transitive: boolean;
  vulnerabilities: { severity: string; advisoryUrl: string }[];
  deprecationReasons: string[];
  alternative?: string;
}

/** Parses `dotnet list package --format json` (format version 1); problems (sources not reachable …) come back too. */
export function parseListPackageJson(text: string): { packages: ListedPackage[]; problems: string[] } {
  let doc: unknown;
  try {
    const start = text.indexOf('{');
    doc = JSON.parse(start > 0 ? text.slice(start) : text);
  } catch {
    return { packages: [], problems: ['The output of dotnet list package was not JSON.'] };
  }
  const o = (doc ?? {}) as Record<string, unknown>;
  const problems = (Array.isArray(o.problems) ? o.problems : []).map((p) => String((p as { text?: unknown })?.text ?? '')).filter(Boolean);
  const packages: ListedPackage[] = [];
  for (const p of Array.isArray(o.projects) ? o.projects : []) {
    const project = String((p as { path?: unknown })?.path ?? '');
    for (const f of Array.isArray((p as { frameworks?: unknown }).frameworks) ? ((p as { frameworks: unknown[] }).frameworks as Record<string, unknown>[]) : []) {
      const framework = String(f?.framework ?? '');
      const take = (list: unknown, transitive: boolean) => {
        for (const x of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
          if (!x || typeof x.id !== 'string') continue;
          const alt = x.alternativePackage as { id?: string; versionRange?: string } | undefined;
          packages.push({
            project,
            framework,
            id: x.id,
            ...(typeof x.requestedVersion === 'string' ? { requestedVersion: x.requestedVersion } : {}),
            ...(typeof x.resolvedVersion === 'string' ? { resolvedVersion: x.resolvedVersion } : {}),
            ...(typeof x.latestVersion === 'string' ? { latestVersion: x.latestVersion } : {}),
            transitive,
            vulnerabilities: (Array.isArray(x.vulnerabilities) ? (x.vulnerabilities as Record<string, unknown>[]) : []).map((v) => ({ severity: String(v?.severity ?? ''), advisoryUrl: String(v?.advisoryurl ?? v?.advisoryUrl ?? '') })),
            deprecationReasons: (Array.isArray(x.deprecationReasons) ? x.deprecationReasons : []).map(String),
            ...(alt?.id ? { alternative: `${alt.id}${alt.versionRange ? ` ${alt.versionRange}` : ''}` } : {}),
          });
        }
      };
      take(f?.topLevelPackages, false);
      take(f?.transitivePackages, true);
    }
  }
  return { packages, problems };
}

// ---------------------------------------------------------------- dotnet nuget list source --format short

export interface NuGetSource {
  name: string;
  /** URL or local folder. */
  url: string;
  enabled: boolean;
  /** "http" (V3 or V2 feed) or "local" (a folder of .nupkg files). */
  kind: 'http' | 'local';
}

/**
 * Parses `dotnet nuget list source --format short`: lines "E https://api.nuget.org/v3/index.json" (E enabled, D disabled;
 * a following letter marks machine-wide / official sources). The short format has no names, so the URL is the name.
 */
export function parseSourcesShort(output: string): NuGetSource[] {
  const out: NuGetSource[] = [];
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const m = /^\s*([ED])[A-Z]*\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const url = m[2]!;
    out.push({ name: url, url, enabled: m[1] === 'E', kind: /^https?:\/\//i.test(url) ? 'http' : 'local' });
  }
  return out;
}

// ---------------------------------------------------------------- Central Package Management

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sets the version of a package in Directory.Packages.props (`<PackageVersion Include="Id" Version="x" />`): the
 * attribute or the child element; undefined when the package has no PackageVersion item (the caller then adds one).
 */
export function setCentralVersion(propsText: string, id: string, version: string): string | undefined {
  const attr = new RegExp(`(<PackageVersion\\b[^>]*\\bInclude\\s*=\\s*"${escapeRe(id)}"[^>]*\\bVersion\\s*=\\s*")[^"]*(")`, 'i');
  if (attr.test(propsText)) return propsText.replace(attr, `$1${version}$2`);
  const attrFirst = new RegExp(`(<PackageVersion\\b[^>]*\\bVersion\\s*=\\s*")[^"]*("[^>]*\\bInclude\\s*=\\s*"${escapeRe(id)}")`, 'i');
  if (attrFirst.test(propsText)) return propsText.replace(attrFirst, `$1${version}$2`);
  const child = new RegExp(`(<PackageVersion\\b[^>]*\\bInclude\\s*=\\s*"${escapeRe(id)}"[^>]*>\\s*<Version>)[^<]*(</Version>)`, 'i');
  if (child.test(propsText)) return propsText.replace(child, `$1${version}$2`);
  return undefined;
}

/** Adds a PackageVersion item to the first ItemGroup holding PackageVersion items (or a new ItemGroup). */
export function addCentralVersion(propsText: string, id: string, version: string): string {
  const eol = propsText.includes('\r\n') ? '\r\n' : '\n';
  const existing = /^([ \t]*)<PackageVersion\b[^\n]*$/m.exec(propsText);
  if (existing) {
    const at = existing.index;
    return `${propsText.slice(0, at)}${existing[1]}<PackageVersion Include="${id}" Version="${version}" />${eol}${propsText.slice(at)}`;
  }
  const close = propsText.lastIndexOf('</Project>');
  if (close < 0) return propsText;
  return `${propsText.slice(0, close)}  <ItemGroup>${eol}    <PackageVersion Include="${id}" Version="${version}" />${eol}  </ItemGroup>${eol}${propsText.slice(close)}`;
}

// ---------------------------------------------------------------- Consolidate

export interface ConsolidateRow {
  id: string;
  versions: { version: string; projects: string[] }[];
}

/** Packages installed in different versions across projects (the Consolidate tab). */
export function consolidate(projects: { name: string; packages: { id: string; version?: string | null; resolvedVersion?: string | null }[] }[]): ConsolidateRow[] {
  const byId = new Map<string, { id: string; map: Map<string, string[]> }>();
  for (const p of projects)
    for (const x of p.packages) {
      const v = x.resolvedVersion ?? x.version;
      if (!v) continue;
      const key = x.id.toLowerCase();
      const e = byId.get(key) ?? { id: x.id, map: new Map<string, string[]>() };
      byId.set(key, e);
      e.map.set(v, [...(e.map.get(v) ?? []), p.name]);
    }
  return [...byId.values()]
    .filter((e) => e.map.size > 1)
    .map((e) => ({ id: e.id, versions: [...e.map.entries()].sort((a, b) => compareVersions(b[0], a[0])).map(([version, projects]) => ({ version, projects: projects.sort() })) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** SemVer 2 ordering (numeric parts, then prerelease lower than release, prerelease identifiers compared). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', pre] = v.split('+')[0]!.split(/-(.*)/s);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return d < 0 ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- Rename Project

export interface RenameProjectInput {
  /** Absolute paths with '/' separators. */
  projectPath: string;
  newName: string;
  projectText: string;
  /** The solution file and its text (undefined when a project file was opened). */
  solution?: { path: string; text: string };
  /** Other projects of the solution and their text (references to the renamed project are updated). */
  others: { path: string; text: string }[];
  /** Other project files in the project's folder (a shared folder makes the rename ambiguous). */
  siblingsInFolder: string[];
  /** Whether a file or folder already exists at a path. */
  exists: (path: string) => boolean;
}

export interface TextReplace {
  path: string;
  /** Exact old text and its replacement (whole-file replacement keeps the plan reviewable in the preview). */
  oldText: string;
  newText: string;
  description: string;
}

export interface RenameProjectPlan {
  folderRename?: { from: string; to: string };
  fileRename: { from: string; to: string };
  edits: TextReplace[];
  notes: string[];
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function relative(fromDir: string, to: string): string {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  while (i < a.length && i < b.length && same(a[i]!, b[i]!)) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/**
 * Plans Rename Project: the project file (and its folder when the folder has the project's name), the solution entry,
 * ProjectReference paths in other projects, and RootNamespace / AssemblyName when they equal the old name. Refuses
 * when the rename is ambiguous (the folder is named differently and holds other project files, the target exists, a
 * reference cannot be matched exactly). Namespaces in code are not changed (a note says so).
 */
export function planRenameProject(i: RenameProjectInput): RenameProjectPlan | { refused: string } {
  const oldName = i.projectPath.slice(i.projectPath.lastIndexOf('/') + 1).replace(/\.[^.]+proj$/i, '');
  const ext = i.projectPath.slice(i.projectPath.lastIndexOf('.'));
  if (!VALID_NAME.test(i.newName)) return { refused: `"${i.newName}" is not a valid project name (letters, digits, '_', '.', '-'; not starting with a digit).` };
  if (i.newName === oldName) return { refused: 'The new name is the current name.' };
  const dir = i.projectPath.slice(0, i.projectPath.lastIndexOf('/'));
  const folderName = dir.slice(dir.lastIndexOf('/') + 1);
  const parent = dir.slice(0, dir.lastIndexOf('/'));
  const renameFolder = folderName === oldName;
  if (!renameFolder && i.siblingsInFolder.length) return { refused: `The folder "${folderName}" is not named after the project and holds other project files; rename it by hand.` };
  if (renameFolder && i.siblingsInFolder.length) return { refused: `The folder "${folderName}" holds other project files too (${i.siblingsInFolder.map((s) => s.slice(s.lastIndexOf('/') + 1)).join(', ')}); renaming it would move them.` };
  if (i.solution && renameFolder && i.solution.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return { refused: 'The solution file is inside the project folder; renaming the folder would move it.' };
  const newDir = renameFolder ? `${parent}/${i.newName}` : dir;
  const newPath = `${newDir}/${i.newName}${ext}`;
  if (renameFolder && i.exists(newDir)) return { refused: `${newDir} already exists.` };
  if (i.exists(`${dir}/${i.newName}${ext}`)) return { refused: `${i.newName}${ext} already exists in the project folder.` };
  const edits: TextReplace[] = [];
  const notes: string[] = [];

  // RootNamespace / AssemblyName equal to the old name follow the new name.
  let projectText = i.projectText;
  for (const prop of ['RootNamespace', 'AssemblyName']) {
    const re = new RegExp(`(<${prop}>)\\s*${escapeRe(oldName)}\\s*(</${prop}>)`, 'g');
    if (re.test(projectText)) {
      projectText = projectText.replace(re, `$1${i.newName}$2`);
      notes.push(`${prop} ${oldName} → ${i.newName}`);
    }
  }
  if (projectText !== i.projectText) edits.push({ path: newPath, oldText: i.projectText, newText: projectText, description: 'RootNamespace / AssemblyName' });

  if (i.solution) {
    const solDir = i.solution.path.slice(0, i.solution.path.lastIndexOf('/'));
    const oldRel = relative(solDir, i.projectPath);
    const newRel = relative(solDir, newPath);
    let text = i.solution.text;
    if (i.solution.path.toLowerCase().endsWith('.slnx')) {
      const re = new RegExp(`(Path\\s*=\\s*")(${escapeRe(oldRel)}|${escapeRe(oldRel.replace(/\//g, '\\'))})(")`, 'gi');
      if (!re.test(text)) return { refused: `The solution file has no entry for ${oldRel}.` };
      text = text.replace(re, (_m, a: string, old: string, c: string) => `${a}${old.includes('\\') ? newRel.replace(/\//g, '\\') : newRel}${c}`);
    } else {
      const winOld = oldRel.replace(/\//g, '\\');
      const re = new RegExp(`(Project\\("\\{[^}]*\\}"\\)\\s*=\\s*")${escapeRe(oldName)}("\\s*,\\s*")(${escapeRe(winOld)}|${escapeRe(oldRel)})(")`, 'i');
      if (!re.test(text)) return { refused: `The solution file has no entry for ${winOld} named ${oldName}.` };
      text = text.replace(re, (_m, a: string, b: string, old: string, d: string) => `${a}${i.newName}${b}${old.includes('\\') ? newRel.replace(/\//g, '\\') : newRel}${d}`);
    }
    edits.push({ path: i.solution.path, oldText: i.solution.text, newText: text, description: 'solution entry' });
  }

  for (const o of i.others) {
    const oDir = o.path.slice(0, o.path.lastIndexOf('/'));
    const oldRel = relative(oDir, i.projectPath);
    const newRel = relative(oDir, newPath);
    const re = new RegExp(`(<ProjectReference\\b[^>]*\\bInclude\\s*=\\s*")(${escapeRe(oldRel)}|${escapeRe(oldRel.replace(/\//g, '\\'))})(")`, 'gi');
    const mentions = new RegExp(`${escapeRe(oldName)}${escapeRe(ext)}`, 'i').test(o.text);
    if (!re.test(o.text)) {
      if (mentions) return { refused: `${o.path.slice(o.path.lastIndexOf('/') + 1)} mentions ${oldName}${ext} in a form Refyntra cannot update safely (a property or a different path).` };
      continue;
    }
    const text = o.text.replace(re, (_m, a: string, old: string, c: string) => `${a}${old.includes('\\') ? newRel.replace(/\//g, '\\') : newRel}${c}`);
    edits.push({ path: o.path, oldText: o.text, newText: text, description: 'ProjectReference' });
  }
  notes.push('Namespaces in code are not renamed (use Rename on a namespace for that).');
  return { ...(renameFolder ? { folderRename: { from: dir, to: newDir } } : {}), fileRename: { from: renameFolder ? `${newDir}/${oldName}${ext}` : i.projectPath, to: newPath }, edits, notes };
}
