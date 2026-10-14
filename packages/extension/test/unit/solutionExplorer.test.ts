import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectStructure, SolutionStructureResult } from '@refyntra/contracts';
import { normalizeSolutionStructure } from '@refyntra/application';
import { buildSolutionTree, outline, pathToFile, projectIcon } from '../../src/solutionExplorerModel';
import {
  addCentralVersion,
  addPackage,
  addReference,
  commandLine,
  compareVersions,
  consolidate,
  listPackages,
  newList,
  newProject,
  packageSearch,
  parseListPackageJson,
  parseSourcesShort,
  parseTemplateList,
  planRenameProject,
  removePackage,
  removeReference,
  setCentralVersion,
  slnAdd,
  slnRemove,
} from '../../src/projectOpsModel';
import { filterHits, mergeHits, parseLocalFeed, parsePackageSearchJson, parseSearch, parseServiceIndex, parseVersions, searchUrl, versionsUrl } from '../../src/nugetModel';
import { cacheIds, elementNameAt, hoverFor, openElements, packageIdOfElement, projectFileContext, propertyValues } from '../../src/projectFileModel';
import { type NuGetPageState, renderNuGetBody, renderNuGetHtml } from '../../src/nugetHtml';

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'nuget', name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

const root = 'file:///w/Explorer';
function project(name: string, dir: string, extra: Partial<ProjectStructure> = {}): ProjectStructure {
  return {
    name,
    projectUri: `${root}/${dir}/${name}.csproj`,
    folderId: null,
    kind: 'library',
    targetFrameworks: ['net10.0'],
    state: 'loaded',
    sdk: 'Microsoft.NET.Sdk',
    centralPackageManagement: false,
    packagesPropsUri: null,
    projectReferences: [],
    packages: [],
    frameworks: ['Microsoft.NETCore.App'],
    analyzers: [],
    items: [],
    excludedUris: [],
    itemsTruncated: false,
    ...extra,
  };
}

const structure: SolutionStructureResult = {
  state: 'Ready',
  snapshotId: 's1',
  solutionUri: `${root}/Explorer.sln`,
  format: 'sln',
  folders: [
    { id: 'SRC', name: 'src', parentId: null, fileUris: [] },
    { id: 'LIBS', name: 'Libraries', parentId: 'SRC', fileUris: [] },
    { id: 'ITEMS', name: 'Solution Items', parentId: null, fileUris: [`${root}/README.md`] },
  ],
  projects: [
    project('Explorer.App', 'src/Explorer.App', {
      folderId: 'SRC',
      kind: 'console',
      projectReferences: [{ name: 'Explorer.Core', projectUri: `${root}/src/Explorer.Core/Explorer.Core.csproj` }],
      analyzers: [{ name: 'Microsoft.CodeAnalysis.NetAnalyzers', uri: null }],
      items: [
        { uri: `${root}/src/Explorer.App/Program.cs`, itemType: 'Compile', virtualPath: 'Program.cs', linked: false },
        { uri: `${root}/shared/SharedInfo.cs`, itemType: 'Compile', virtualPath: 'Shared/SharedInfo.cs', linked: true },
        { uri: `${root}/src/Explorer.App/appsettings.json`, itemType: 'None', virtualPath: 'appsettings.json', linked: false },
      ],
      excludedUris: [`${root}/src/Explorer.App/Legacy/Old.cs`],
    }),
    project('Explorer.Core', 'src/Explorer.Core', {
      folderId: 'LIBS',
      centralPackageManagement: true,
      packagesPropsUri: `${root}/Directory.Packages.props`,
      packages: [{ id: 'MediatR', version: '12.5.0', resolvedVersion: '12.5.0', central: true, versionOverride: false }],
      items: [{ uri: `${root}/src/Explorer.Core/Services/Clock.cs`, itemType: 'Compile', virtualPath: 'Services/Clock.cs', linked: false }],
    }),
    project('Explorer.Tests', 'tests/Explorer.Tests', { kind: 'test', state: 'notLoaded' }),
  ],
};

describe('Solution Explorer tree model', () => {
  const opts = { excludedFiles: 'hide' as const, unloaded: new Set<string>() };

  it('nests solution folders and projects as the solution file says, with Dependencies and items', () => {
    expect(outline(buildSolutionTree(structure, opts))).toEqual([
      'Explorer.sln — 3 projects, 2 loaded',
      '  Solution Items',
      '    README.md',
      '  src',
      '    Libraries',
      '      Explorer.Core — net10.0',
      '        Dependencies',
      '          Packages — 1',
      '            MediatR — 12.5.0 (Directory.Packages.props)',
      '          Frameworks — 1',
      '            Microsoft.NETCore.App',
      '        Services',
      '          Clock.cs',
      '    Explorer.App — net10.0',
      '      Dependencies',
      '        Projects — 1',
      '          Explorer.Core',
      '        Frameworks — 1',
      '          Microsoft.NETCore.App',
      '        Analyzers — 1',
      '          Microsoft.CodeAnalysis.NetAnalyzers',
      '      Shared',
      '        SharedInfo.cs — linked',
      '      appsettings.json — None',
      '      Program.cs',
      '  Explorer.Tests — net10.0 (not loaded)',
    ]);
  });

  it('shows excluded C# files greyed only with the "grey" setting; linked files carry the link icon', () => {
    const grey = buildSolutionTree(structure, { ...opts, excludedFiles: 'grey' });
    const lines = outline(grey);
    expect(lines).toContain('      Legacy');
    expect(lines).toContain('        Old.cs — not in the build');
    const chain = pathToFile(grey, `${root}/src/Explorer.App/Legacy/Old.cs`)!;
    expect(chain.at(-1)!.excluded).toBe(true);
    expect(chain.at(-1)!.context).toBe('refyntra.sol.file.excluded');
    const linked = pathToFile(grey, `${root}/shared/SharedInfo.cs`)!.at(-1)!;
    expect(linked.icon).toBe('link');
    expect(linked.linked).toBe(true);
  });

  it('unloaded projects have no children; the startup project is marked; icons follow the kind', () => {
    const uri = structure.projects[0]!.projectUri;
    const tree = buildSolutionTree(structure, { ...opts, unloaded: new Set([uri]), startupProjectUri: uri });
    const app = pathToFile(tree, uri)!.at(-1)!;
    expect(app.children).toEqual([]);
    expect(app.description).toBe('net10.0 (unloaded) (startup)');
    expect(app.context).toBe('refyntra.sol.project.unloaded.runnable');
    expect(['web', 'console', 'test', 'library', 'worker', 'desktop'].map(projectIcon)).toEqual(['globe', 'terminal', 'beaker', 'library', 'server-process', 'window']);
  });

  it('reveal finds the path to a file (the project-folder item before a linked copy)', () => {
    const tree = buildSolutionTree(structure, opts);
    expect(pathToFile(tree, `${root}/src/Explorer.Core/Services/Clock.cs`)!.map((n) => n.label)).toEqual(['Explorer.sln', 'src', 'Libraries', 'Explorer.Core', 'Services', 'Clock.cs']);
    expect(pathToFile(tree, `${root}/nowhere.cs`)).toBeUndefined();
  });

  it('a project file opened alone has no solution root', () => {
    const tree = buildSolutionTree({ ...structure, solutionUri: null, format: 'project', folders: [], projects: [structure.projects[1]!] }, opts);
    expect(tree.map((n) => n.label)).toEqual(['Explorer.Core']);
  });

  it('drops malformed host data (normalizeSolutionStructure)', () => {
    const r = normalizeSolutionStructure({ state: 'Ready', format: 'slnx', folders: [{ id: 'x' }, { id: '/a/', name: 'a', fileUris: [1, 'file:///a'] }], projects: [{ name: 'P' }, { name: 'Q', projectUri: 'file:///q/Q.csproj', items: [{ uri: 'file:///q/a.cs', virtualPath: 'a.cs' }, { uri: 3 }], packages: [{ id: 'X', central: 'yes' }] }] });
    expect(r.folders).toEqual([{ id: '/a/', name: 'a', parentId: null, fileUris: ['file:///a'] }]);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]!.items).toEqual([{ uri: 'file:///q/a.cs', itemType: 'None', virtualPath: 'a.cs', linked: false }]);
    expect(r.projects[0]!.packages[0]!.central).toBe(false);
  });
});

describe('project operation command lines (no shell: paths with spaces stay one argument)', () => {
  const sln = 'C:/My Work/Shop App/Shop.sln';
  const proj = 'C:/My Work/Shop App/src/Shop Api/Shop.Api.csproj';
  const ref = 'C:/My Work/Shop App/src/Shop Core/Shop.Core.csproj';

  it('sln add / remove with a solution folder', () => {
    expect(slnAdd(sln, proj, 'src/Web Apps')).toEqual({ command: 'dotnet', args: ['sln', sln, 'add', proj, '--solution-folder', 'src/Web Apps'], cwd: 'C:/My Work/Shop App', title: 'dotnet sln add' });
    expect(slnAdd(sln, proj).args).toEqual(['sln', sln, 'add', proj, '--in-root']);
    expect(slnRemove(sln, proj).args).toEqual(['sln', sln, 'remove', proj]);
  });

  it('references, packages, new and list', () => {
    expect(addReference(proj, ref).args).toEqual(['add', proj, 'reference', ref]);
    expect(removeReference(proj, ref).args).toEqual(['remove', proj, 'reference', ref]);
    expect(addPackage(proj, 'MediatR', { version: '12.5.0', source: 'C:/feeds/local feed' }).args).toEqual(['add', proj, 'package', 'MediatR', '--version', '12.5.0', '--source', 'C:/feeds/local feed']);
    expect(addPackage(proj, 'X', { prerelease: true, noRestore: true }).args).toEqual(['add', proj, 'package', 'X', '--prerelease', '--no-restore']);
    expect(removePackage(proj, 'MediatR').args).toEqual(['remove', proj, 'package', 'MediatR']);
    expect(newProject('classlib', 'Shop.Core', 'C:/My Work/Shop App/src/Shop Core').args).toEqual(['new', 'classlib', '--name', 'Shop.Core', '--output', 'C:/My Work/Shop App/src/Shop Core']);
    expect(newList('C:/x').args).toEqual(['new', 'list', '--columns', 'type', '--columns', 'language', '--columns', 'tags']);
    expect(listPackages(sln, 'outdated', true).args).toEqual(['list', sln, 'package', '--format', 'json', '--outdated', '--include-prerelease']);
    expect(listPackages(proj, 'installed').args).toEqual(['list', proj, 'package', '--format', 'json']);
    expect(packageSearch('serilog', 'C:/x', { source: 'https://f.example.test/v3/index.json', prerelease: true }).args).toEqual(['package', 'search', 'serilog', '--format', 'json', '--take', '30', '--source', 'https://f.example.test/v3/index.json', '--prerelease']);
  });

  it('a display command line quotes arguments with spaces and quotes', () => {
    expect(commandLine(addReference(proj, ref))).toBe('dotnet add "C:/My Work/Shop App/src/Shop Api/Shop.Api.csproj" reference "C:/My Work/Shop App/src/Shop Core/Shop.Core.csproj"');
    expect(commandLine({ command: 'dotnet', args: ['a"b'] })).toBe('dotnet "a\\"b"');
  });
});

describe('parsing what the dotnet CLI prints (recorded output)', () => {
  it('dotnet new list: C# project templates only, columns from the dash line', () => {
    const t = parseTemplateList(fixture('new-list.txt'));
    expect(t.map((x) => x.shortNames[0])).toEqual(['web', 'webapi', 'classlib', 'console', 'worker', 'xunit']);
    expect(t[2]).toEqual({ name: 'Class Library', shortNames: ['classlib'], languages: ['C#', 'F#', 'VB'], type: 'project', tags: 'Common/Library' });
    expect(parseTemplateList('no table here')).toEqual([]);
  });

  it('dotnet list package --outdated / --vulnerable / --deprecated (JSON)', () => {
    const o = parseListPackageJson(fixture('list-outdated.json'));
    expect(o.problems).toEqual(['The source https://unreachable.example.test/v3/index.json could not be reached.']);
    expect(o.packages.map((p) => [p.id, p.resolvedVersion, p.latestVersion, p.transitive])).toEqual([
      ['MediatR', '12.4.0', '12.5.0', false],
      ['MediatR.Contracts', '2.0.1', '2.0.1', true],
    ]);
    const v = parseListPackageJson(fixture('list-vulnerable.json'));
    expect(v.packages[0]!.vulnerabilities).toEqual([{ severity: 'High', advisoryUrl: 'https://github.com/advisories/GHSA-hh2w-p6rv-4g7w' }]);
    expect(v.packages[0]!.project).toBe('C:\\work\\App\\App.csproj');
    const d = parseListPackageJson(fixture('list-deprecated.json'));
    expect(d.packages[0]).toMatchObject({ id: 'Old.Lib', deprecationReasons: ['Legacy'], alternative: 'New.Lib >= 2.0.0' });
    expect(parseListPackageJson('error: not json').problems).toHaveLength(1);
  });

  it('dotnet nuget list source --format short', () => {
    expect(parseSourcesShort(fixture('sources-short.txt'))).toEqual([
      { name: 'https://api.nuget.org/v3/index.json', url: 'https://api.nuget.org/v3/index.json', enabled: true, kind: 'http' },
      { name: 'https://disabled.example.test/v3/index.json', url: 'https://disabled.example.test/v3/index.json', enabled: false, kind: 'http' },
      { name: 'C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\', url: 'C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\', enabled: true, kind: 'local' },
      { name: '/tmp/local feed', url: '/tmp/local feed', enabled: true, kind: 'local' },
    ]);
  });
});

describe('NuGet V3 responses (recorded, no network)', () => {
  it('service index: search and flat container resources', () => {
    expect(parseServiceIndex(json('service-index.json'))).toEqual({ search: 'https://azuresearch-usnc.nuget.org/query', packageBaseAddress: 'https://api.nuget.org/v3-flatcontainer/' });
    expect(parseServiceIndex({})).toEqual({});
  });

  it('search results: versions newest first, malformed entries dropped, deprecation flagged', () => {
    const hits = parseSearch(json('search-mediatr.json'), 'https://api.nuget.org/v3/index.json');
    expect(hits.map((h) => h.id)).toEqual(['MediatR', 'MediatR.Contracts']);
    expect(hits[0]).toMatchObject({ version: '12.5.0', authors: 'Jimmy Bogard', verified: true, totalDownloads: 412345678, versions: ['12.5.0', '12.0.0-beta1', '11.1.0'] });
    expect(hits[1]).toMatchObject({ authors: 'Jimmy Bogard', deprecated: true });
    expect(filterHits(hits, 'contracts').map((h) => h.id)).toEqual(['MediatR.Contracts']);
  });

  it('URLs: search query and flat container versions', () => {
    expect(searchUrl('https://s.example.test/query', 'media tr', { prerelease: true, take: 5 })).toBe('https://s.example.test/query?q=media+tr&skip=0&take=5&prerelease=true&semVerLevel=2.0.0');
    expect(versionsUrl('https://api.nuget.org/v3-flatcontainer/', 'MediatR')).toBe('https://api.nuget.org/v3-flatcontainer/mediatr/index.json');
    expect(parseVersions(json('flat-versions.json'))).toEqual(['12.5.0', '12.0.0', '12.0.0-beta1', '11.1.0', '9.0.0']);
  });

  it('dotnet package search JSON (private feeds through the credential providers)', () => {
    const r = parsePackageSearchJson(fixture('package-search.json'));
    expect(r.hits.map((h) => `${h.id} ${h.version}`)).toEqual(['Contoso.Logging 3.2.1', 'Contoso.Http 1.0.0-preview.2']);
    expect(r.problems).toEqual(['private: Response status code does not indicate success: 401 (Unauthorized).']);
  });

  it('local folder feeds: flat and hierarchical layouts; merging sources keeps the highest version', () => {
    const local = parseLocalFeed(['Refyntra.Sample.1.0.0.nupkg', 'Refyntra.Sample.1.1.0-beta.1.nupkg', 'other/2.0.0/other.2.0.0.nupkg', 'x.symbols.nupkg', 'readme.txt'], '/feed');
    expect(local.map((h) => [h.id, h.version, h.versions])).toEqual([
      ['other', '2.0.0', ['2.0.0']],
      ['Refyntra.Sample', '1.1.0-beta.1', ['1.1.0-beta.1', '1.0.0']],
    ]);
    const merged = mergeHits([local, [{ id: 'refyntra.sample', version: '1.2.0', description: 'd', authors: '', verified: false, versions: ['1.2.0'], source: 'https://x' }]]);
    expect(merged.find((h) => h.id.toLowerCase() === 'refyntra.sample')).toMatchObject({ version: '1.2.0', versions: ['1.2.0', '1.1.0-beta.1', '1.0.0'], description: 'd' });
  });
});

describe('Central Package Management and versions', () => {
  const props = '<Project>\r\n  <ItemGroup>\r\n    <PackageVersion Include="MediatR" Version="12.4.0" />\r\n    <PackageVersion Version="1.0.0" Include="Other" />\r\n    <PackageVersion Include="Child">\r\n      <Version>2.0.0</Version>\r\n    </PackageVersion>\r\n  </ItemGroup>\r\n</Project>\r\n';

  it('sets a version in Directory.Packages.props (attribute in either order, or a child element)', () => {
    expect(setCentralVersion(props, 'mediatr', '12.5.0')).toContain('<PackageVersion Include="MediatR" Version="12.5.0" />');
    expect(setCentralVersion(props, 'Other', '1.1.0')).toContain('<PackageVersion Version="1.1.0" Include="Other" />');
    expect(setCentralVersion(props, 'Child', '3.0.0')).toContain('<Version>3.0.0</Version>');
    expect(setCentralVersion(props, 'Missing', '1.0.0')).toBeUndefined();
  });

  it('adds a PackageVersion next to the others (line endings kept), or a new ItemGroup', () => {
    expect(addCentralVersion(props, 'New', '1.0.0')).toContain('    <PackageVersion Include="New" Version="1.0.0" />\r\n    <PackageVersion Include="MediatR"');
    expect(addCentralVersion('<Project>\n</Project>\n', 'New', '1.0.0')).toBe('<Project>\n  <ItemGroup>\n    <PackageVersion Include="New" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n');
  });

  it('consolidate: packages in several versions across projects, newest first', () => {
    const rows = consolidate([
      { name: 'A', packages: [{ id: 'MediatR', version: '12.4.0' }, { id: 'Same', version: '1.0.0' }] },
      { name: 'B', packages: [{ id: 'mediatr', resolvedVersion: '12.5.0' }, { id: 'Same', version: '1.0.0' }] },
    ]);
    expect(rows).toEqual([{ id: 'MediatR', versions: [{ version: '12.5.0', projects: ['B'] }, { version: '12.4.0', projects: ['A'] }] }]);
  });

  it('SemVer ordering', () => {
    expect(['1.0.0', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha', '0.9.9', '1.0.1'].sort((a, b) => compareVersions(b, a))).toEqual(['1.0.1', '1.0.0', '1.0.0-beta.10', '1.0.0-beta.2', '1.0.0-alpha', '0.9.9']);
    expect(compareVersions('1.0.0+build', '1.0.0')).toBe(0);
  });
});

describe('Rename Project plan', () => {
  const base = {
    projectPath: '/w/My Shop/src/Shop.Core/Shop.Core.csproj',
    newName: 'Shop.Domain',
    projectText: '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <RootNamespace>Shop.Core</RootNamespace>\n  </PropertyGroup>\n</Project>\n',
    solution: { path: '/w/My Shop/Shop.sln', text: 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Core", "src\\Shop.Core\\Shop.Core.csproj", "{1}"\nEndProject\n' },
    others: [
      { path: '/w/My Shop/src/Shop.Api/Shop.Api.csproj', text: '<ItemGroup><ProjectReference Include="..\\Shop.Core\\Shop.Core.csproj" /></ItemGroup>' },
      { path: '/w/My Shop/src/Other/Other.csproj', text: '<ItemGroup></ItemGroup>' },
    ],
    siblingsInFolder: [],
    exists: () => false,
  };

  it('renames folder and file, the solution entry, references and RootNamespace', () => {
    const plan = planRenameProject(base);
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.folderRename).toEqual({ from: '/w/My Shop/src/Shop.Core', to: '/w/My Shop/src/Shop.Domain' });
    expect(plan.fileRename).toEqual({ from: '/w/My Shop/src/Shop.Domain/Shop.Core.csproj', to: '/w/My Shop/src/Shop.Domain/Shop.Domain.csproj' });
    expect(plan.edits.map((e) => [e.path, e.newText])).toEqual([
      ['/w/My Shop/src/Shop.Domain/Shop.Domain.csproj', base.projectText.replace('<RootNamespace>Shop.Core<', '<RootNamespace>Shop.Domain<')],
      ['/w/My Shop/Shop.sln', 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Domain", "src\\Shop.Domain\\Shop.Domain.csproj", "{1}"\nEndProject\n'],
      ['/w/My Shop/src/Shop.Api/Shop.Api.csproj', '<ItemGroup><ProjectReference Include="..\\Shop.Domain\\Shop.Domain.csproj" /></ItemGroup>'],
    ]);
    expect(plan.notes).toContain('RootNamespace Shop.Core → Shop.Domain');
  });

  it('slnx entries keep their separator style', () => {
    const plan = planRenameProject({ ...base, solution: { path: '/w/My Shop/Shop.slnx', text: '<Solution><Project Path="src/Shop.Core/Shop.Core.csproj" /></Solution>' } });
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.edits.find((e) => e.path.endsWith('.slnx'))!.newText).toBe('<Solution><Project Path="src/Shop.Domain/Shop.Domain.csproj" /></Solution>');
  });

  it('refuses ambiguous renames', () => {
    const refused = (x: Partial<typeof base>) => {
      const r = planRenameProject({ ...base, ...x });
      return 'refused' in r ? r.refused : '';
    };
    expect(refused({ siblingsInFolder: ['/w/My Shop/src/Shop.Core/Other.csproj'] })).toMatch(/other project files/);
    expect(refused({ projectPath: '/w/My Shop/src/core/Shop.Core.csproj', siblingsInFolder: ['/w/My Shop/src/core/X.csproj'] })).toMatch(/not named after the project/);
    expect(refused({ exists: (p) => p === '/w/My Shop/src/Shop.Domain' })).toMatch(/already exists/);
    expect(refused({ newName: '9bad' })).toMatch(/not a valid project name/);
    expect(refused({ others: [{ path: '/w/My Shop/src/X/X.csproj', text: '<ProjectReference Include="$(Root)Shop.Core.csproj" />' }] })).toMatch(/cannot update safely/);
    expect(refused({ solution: { path: '/w/My Shop/Shop.sln', text: 'no entry' } })).toMatch(/no entry/);
  });

  it('a folder named differently stays; only the file is renamed', () => {
    const plan = planRenameProject({ ...base, projectPath: '/w/My Shop/src/core/Shop.Core.csproj', solution: { path: '/w/My Shop/Shop.sln', text: 'Project("{X}") = "Shop.Core", "src\\core\\Shop.Core.csproj", "{1}"' }, others: [] });
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.folderRename).toBeUndefined();
    expect(plan.fileRename).toEqual({ from: '/w/My Shop/src/core/Shop.Core.csproj', to: '/w/My Shop/src/core/Shop.Domain.csproj' });
  });
});

describe('project file completion contexts', () => {
  const doc = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n';

  it('element names inside PropertyGroup / ItemGroup / Project', () => {
    expect(projectFileContext(`${doc}    <Nul`)).toEqual({ kind: 'propertyName' });
    expect(projectFileContext(`${doc}  </PropertyGroup>\n  <ItemGroup>\n    <`)).toEqual({ kind: 'itemName' });
    expect(projectFileContext(`${doc}  </PropertyGroup>\n  <`)).toEqual({ kind: 'groupName' });
  });

  it('property values and attribute values', () => {
    expect(projectFileContext(`${doc}    <Nullable>en`)).toEqual({ kind: 'propertyValue', property: 'Nullable' });
    expect(propertyValues('nullable')).toEqual(['enable', 'disable', 'warnings', 'annotations']);
    expect(propertyValues('TargetFramework')).toContain('net10.0');
    expect(propertyValues('LangVersion')).toContain('latest');
    expect(propertyValues('ImplicitUsings')).toEqual(['enable', 'disable']);
    const before = `${doc}  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="MediatR" Version="12.`;
    expect(projectFileContext(before)).toEqual({ kind: 'attributeValue', element: 'PackageReference', attribute: 'Version', prefix: '12.' });
    expect(packageIdOfElement(before)).toBe('MediatR');
    expect(projectFileContext(`${doc}  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Med`)).toMatchObject({ kind: 'attributeValue', attribute: 'Include', prefix: 'Med' });
  });

  it('comments do not open elements; hover text; element under the caret; cache ids', () => {
    expect(openElements('<Project><!-- <PropertyGroup> --><ItemGroup>')).toEqual(['Project', 'ItemGroup']);
    expect(hoverFor('Nullable')).toContain('nullable reference types');
    expect(hoverFor('PackageReference')).toContain('MSBuild item');
    expect(hoverFor('Unknown')).toBeUndefined();
    expect(elementNameAt('    <TargetFramework>net10.0</TargetFramework>', 8)).toBe('TargetFramework');
    expect(cacheIds(['mediatr', 'mediatr.contracts', '.tools', 'serilog'], 'MED')).toEqual(['mediatr', 'mediatr.contracts']);
  });
});

describe('Manage NuGet Packages page', () => {
  const state: NuGetPageState = {
    title: 'NuGet: Explorer.Core',
    projects: ['Explorer.Core'],
    centralPackageManagement: true,
    tab: 'installed',
    installed: [{ id: 'MediatR', version: '12.5.0', projects: ['Explorer.Core'], central: true, latest: '13.0.0', vulnerable: 'High' }],
    browse: { term: '', prerelease: false, hits: [], searched: false },
    updates: { checked: false, rows: [] },
    consolidate: [],
    sources: ['/feed'],
  };

  it('strict CSP: only its own nonce for style and script, nothing remote', () => {
    const html = renderNuGetHtml(renderNuGetBody(state), { nonce: 'abc', title: 'NuGet <x>' });
    expect(html).toContain(`content="default-src 'none'; style-src 'nonce-abc'; script-src 'nonce-abc';"`);
    expect(html).not.toMatch(/<img|https?:\/\/(?!github)/);
    expect(html).toContain('<title>NuGet &lt;x&gt;</title>');
  });

  it('installed rows with central / update / vulnerability badges; tabs are an ARIA tablist', () => {
    const body = renderNuGetBody(state);
    expect(body).toContain('<span class="id">MediatR</span>');
    expect(body).toContain('central');
    expect(body).toContain('13.0.0 available');
    expect(body).toContain('role="tablist"');
    expect(body).toContain('aria-selected="true" aria-controls="panel" tabindex="0" class="tab sel" data-action="tab" data-arg="installed"');
  });

  it('escapes package data', () => {
    const body = renderNuGetBody({ ...state, tab: 'browse', browse: { term: '"><script>', prerelease: true, searched: true, hits: [{ id: 'A<b>', version: '1.0.0', description: '<img src=x>', authors: '', verified: false, versions: ['1.0.0'], source: '/feed' }] } });
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<img');
    expect(body).toContain('A&lt;b&gt;');
  });
});
