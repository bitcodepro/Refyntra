// Solution Explorer, project operations, NuGet and project file editing (protocol 1.20, ADR-013) on a temp copy of
// tests/fixtures/Explorer opened through Explorer.sln (runTest.mjs scenario "solution"): solution folders, linked and
// excluded files, Central Package Management; add/remove project reference with Undo, a new project from a template,
// Rename Project, a package from a LOCAL folder feed made in the test (no internet), csproj completion and hover, and a
// host reload after a project file is saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PACKAGE_ID, createLocalFeed, nugetConfig } = require('./localFeed.cjs');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (rel) => path.join(root(), ...rel.split('/'));
  const read = (rel) => fs.readFileSync(file(rel), 'utf8');
  let feed;

  async function ready() {
    const a = await api();
    await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
    assert.equal(csharp(a.health()).state, 'Ready', JSON.stringify(csharp(a.health()).diagnostics));
    const ex = a.solution.explorer;
    await waitFor(async () => {
      await ex.refresh();
      return ex.structure()?.projects.length === 3;
    }, 'the solution model', 60000);
    return { a, ex };
  }

  const project = (ex, name) => {
    const p = ex.structure().projects.find((x) => x.name === name);
    assert.ok(p, `project ${name}`);
    return p;
  };
  const pickLabel = (label) => async (items) => items.find((i) => i.label === label);

  return [
    [
      'solution: the tree shows solution folders, projects with TFMs, Dependencies, linked and excluded files',
      async () => {
        const { ex } = await ready();
        await vscode.commands.executeCommand('refyntra.solution.show');
        const lines = ex.outline();
        const at = (line) => {
          const i = lines.findIndex((l) => l === line || l.startsWith(`${line} `));
          assert.ok(i >= 0, `${line}\n${lines.join('\n')}`);
          return i;
        };
        at('Explorer.sln — 3 projects');
        assert.ok(at('  src') < at('    Libraries'));
        at('      Explorer.Core — net10.0');
        at('            MediatR — 12.5.0 (Directory.Packages.props)');
        at('    Explorer.App — net10.0');
        at('          Explorer.Core');
        at('        SharedInfo.cs — linked');
        at('      appsettings.json — None');
        at('  Solution Items');
        at('    Explorer.Tests — net10.0');
        assert.ok(!lines.some((l) => l.includes('Old.cs')), 'Compile Remove="Legacy/**" hides Old.cs by default');
        await vscode.workspace.getConfiguration('refyntra.solutionExplorer').update('excludedFiles', 'grey', vscode.ConfigurationTarget.Global);
        try {
          await waitFor(() => ex.outline().includes('        Old.cs — not in the build'), 'Old.cs greyed', 20000);
        } finally {
          await vscode.workspace.getConfiguration('refyntra.solutionExplorer').update('excludedFiles', undefined, vscode.ConfigurationTarget.Global);
        }
        const app = project(ex, 'Explorer.App');
        assert.equal(app.kind, 'console');
        assert.equal(project(ex, 'Explorer.Tests').kind, 'test');
        assert.ok(app.items.some((i) => i.linked && i.virtualPath === 'Shared/SharedInfo.cs'));
      },
    ],
    [
      'solution: Reveal Active File selects the file node; Copy Path; Set as Startup Project',
      async () => {
        const { a, ex } = await ready();
        await vscode.commands.executeCommand('refyntra.solution.show');
        const doc = await vscode.workspace.openTextDocument(file('src/Explorer.Core/Services/Clock.cs'));
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('refyntra.solution.revealActive');
        const node = await ex.revealFile(doc.uri);
        assert.ok(node, 'a node for Clock.cs');
        assert.equal(node.label, 'Clock.cs');
        assert.equal(await ex.copyPath(node), file('src/Explorer.Core/Services/Clock.cs'));
        assert.equal(await ex.setStartup(project(ex, 'Explorer.App').projectUri), true);
        assert.equal(a.run.selection().target.label, 'Explorer.App');
        assert.ok(ex.outline().some((l) => l.includes('Explorer.App — net10.0 (startup)')));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'solution: add and remove a project reference (dotnet add/remove reference as a task) and Undo both',
      async () => {
        const { ex } = await ready();
        const before = read('tests/Explorer.Tests/Explorer.Tests.csproj');
        ex.hooks = { pick: pickLabel('Explorer.App') };
        try {
          assert.equal(await ex.addProjectReference(project(ex, 'Explorer.Tests').projectUri), true);
          assert.match(read('tests/Explorer.Tests/Explorer.Tests.csproj'), /Include="\.\.[\\/]\.\.[\\/]src[\\/]Explorer\.App[\\/]Explorer\.App\.csproj"/);
          assert.deepEqual(project(ex, 'Explorer.Tests').projectReferences.map((r) => r.name).sort(), ['Explorer.App', 'Explorer.Core']);
          const undone = await ex.undo();
          assert.deepEqual(undone, [file('tests/Explorer.Tests/Explorer.Tests.csproj')]);
          assert.equal(read('tests/Explorer.Tests/Explorer.Tests.csproj'), before, 'Undo restores the project file byte for byte');
          assert.deepEqual(project(ex, 'Explorer.Tests').projectReferences.map((r) => r.name), ['Explorer.Core']);

          const appBefore = read('src/Explorer.App/Explorer.App.csproj');
          const refNode = ex.node(`ref:${project(ex, 'Explorer.App').projectUri}|${project(ex, 'Explorer.Core').projectUri}`);
          assert.ok(refNode, 'the Explorer.Core node under Dependencies › Projects');
          assert.equal(await ex.removeProjectReference(refNode), true);
          assert.doesNotMatch(read('src/Explorer.App/Explorer.App.csproj'), /Explorer\.Core\.csproj/);
          assert.deepEqual(project(ex, 'Explorer.App').projectReferences, []);
          await ex.undo();
          assert.equal(read('src/Explorer.App/Explorer.App.csproj'), appBefore);
          assert.deepEqual(project(ex, 'Explorer.App').projectReferences.map((r) => r.name), ['Explorer.Core']);
        } finally {
          ex.hooks = {};
        }
      },
    ],
    [
      'solution: New Project from a template (dotnet new list / new / sln add), Rename Project, Remove from Solution',
      async () => {
        const { ex } = await ready();
        const templates = await ex.templates(root());
        assert.ok(templates.some((t) => t.shortNames.includes('classlib')), templates.map((t) => t.shortNames.join(',')).join(' '));
        const out = file('src/Explorer Extra');
        ex.hooks = {
          pick: async (items) => items.find((i) => i.template === 'classlib'),
          input: async (prompt, value) => (prompt === 'Project name' ? 'Explorer.Extra' : prompt.startsWith('Folder') ? out : prompt.startsWith('New name') ? 'Explorer.Renamed' : value),
          confirm: async () => true,
          applyWithoutPreview: true,
        };
        try {
          const created = await ex.newProject();
          assert.equal(created, path.join(out, 'Explorer.Extra.csproj'));
          assert.match(read('Explorer.sln'), /"Explorer\.Extra", "src\\Explorer Extra\\Explorer\.Extra\.csproj"/);
          await waitFor(() => ex.structure().projects.some((p) => p.name === 'Explorer.Extra'), 'Explorer.Extra in the tree', 60000);
          // The folder is not named after the project: Rename renames the project file and the solution entry only.
          assert.equal(await ex.renameProject(project(ex, 'Explorer.Extra').projectUri), true);
          assert.ok(fs.existsSync(path.join(out, 'Explorer.Renamed.csproj')));
          assert.match(read('Explorer.sln'), /"Explorer\.Renamed", "src\\Explorer Extra\\Explorer\.Renamed\.csproj"/);
          await waitFor(() => ex.structure().projects.some((p) => p.name === 'Explorer.Renamed'), 'the renamed project', 60000);
          assert.equal(await ex.removeFromSolution(project(ex, 'Explorer.Renamed').projectUri), true);
          assert.doesNotMatch(read('Explorer.sln'), /Explorer\.Renamed/);
          assert.ok(!ex.structure().projects.some((p) => p.name === 'Explorer.Renamed'));
        } finally {
          ex.hooks = {};
          fs.rmSync(out, { recursive: true, force: true });
        }
      },
    ],
    [
      'solution: Manage NuGet Packages installs from a LOCAL folder feed (Central Package Management), checks updates, uninstalls',
      async () => {
        const { a, ex } = await ready();
        feed = await createLocalFeed();
        fs.writeFileSync(file('nuget.config'), nugetConfig(feed.feed));
        const propsBefore = read('Directory.Packages.props');
        const csprojBefore = read('src/Explorer.Core/Explorer.Core.csproj');
        await vscode.commands.executeCommand('refyntra.manageNuGet', project(ex, 'Explorer.Core').projectUri);
        const panel = a.solution.nuget.current();
        assert.ok(panel && panel.isOpen(), 'the NuGet panel');
        assert.deepEqual(panel.state().installed.map((r) => `${r.id} ${r.version} ${r.central}`), ['MediatR 12.5.0 true']);
        await panel.dispatch({ action: 'search', values: { term: 'Refyntra', prerelease: false } });
        const s = panel.state();
        assert.deepEqual(s.sources, [feed.feed]);
        assert.deepEqual(s.browse.hits.map((h) => `${h.id} ${h.version}`), [`${PACKAGE_ID} 1.1.0`], JSON.stringify(s.message));
        await panel.dispatch({ action: 'select', arg: PACKAGE_ID });
        await panel.dispatch({ action: 'install', arg: PACKAGE_ID, version: '1.0.0' });
        assert.match(read('Directory.Packages.props'), new RegExp(`<PackageVersion Include="${PACKAGE_ID}" Version="1\\.0\\.0" />`));
        assert.match(read('src/Explorer.Core/Explorer.Core.csproj'), new RegExp(`<PackageReference Include="${PACKAGE_ID}" />`));
        await waitFor(() => panel.state().installed.some((r) => r.id === PACKAGE_ID && r.version === '1.0.0'), 'installed row', 60000);
        assert.ok(ex.outline().some((l) => l.includes(`${PACKAGE_ID} — 1.0.0 (Directory.Packages.props)`)));
        // Check for updates (dotnet list package --outdated): the local feed has 1.1.0.
        await panel.dispatch({ action: 'checkUpdates' });
        const upd = panel.state().updates;
        assert.equal(upd.checked, true);
        assert.deepEqual(upd.rows.filter((r) => r.id === PACKAGE_ID).map((r) => r.latest), ['1.1.0']);
        // Update with Central Package Management: the version changes in Directory.Packages.props.
        await panel.dispatch({ action: 'update', arg: PACKAGE_ID, version: '1.1.0' });
        assert.match(read('Directory.Packages.props'), new RegExp(`<PackageVersion Include="${PACKAGE_ID}" Version="1\\.1\\.0" />`));
        assert.doesNotMatch(read('src/Explorer.Core/Explorer.Core.csproj'), /Version=/);
        // No request left the machine: the only source is the local folder.
        assert.deepEqual(panel.requests, []);
        await panel.dispatch({ action: 'remove', arg: PACKAGE_ID });
        assert.doesNotMatch(read('src/Explorer.Core/Explorer.Core.csproj'), /Refyntra\.Sample/);
        assert.match(read('src/Explorer.Core/Explorer.Core.csproj'), /<PackageReference Include="MediatR" \/>/);
        assert.ok(csprojBefore.length > 0);
        assert.match(read('Directory.Packages.props'), /MediatR/);
        assert.ok(propsBefore.length > 0);
        panel.dispose();
      },
    ],
    [
      'solution: csproj completion (properties, values, package ids from the local cache, versions) and hover',
      async () => {
        await ready();
        const uri = vscode.Uri.file(file('src/Explorer.Core/Explorer.Core.csproj'));
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        const labels = async (pos) => {
          const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos);
          return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
        };
        const text = doc.getText();
        // Inside the PropertyGroup, after "<": MSBuild properties.
        const line = doc.positionAt(text.indexOf('<Nullable>')).line;
        await ed.edit((e) => e.insert(new vscode.Position(line, 0), '    <\n'));
        const props = await labels(new vscode.Position(line, 5));
        for (const p of ['TargetFramework', 'Nullable', 'LangVersion', 'ImplicitUsings']) assert.ok(props.includes(p), `${p} in ${props.slice(0, 20).join(',')}`);
        await vscode.commands.executeCommand('undo');
        // A property value.
        const nullableAt = doc.positionAt(doc.getText().indexOf('<Nullable>') + '<Nullable>'.length);
        assert.ok((await labels(nullableAt)).includes('enable'));
        // PackageReference Include="…": ids from the solution and the local NuGet cache; Version="…": versions.
        const inc = doc.positionAt(doc.getText().indexOf('Include="MediatR"') + 'Include="'.length);
        const ids = await labels(inc);
        assert.ok(ids.includes('MediatR'), ids.slice(0, 10).join(','));
        await ed.edit((e) => e.insert(doc.positionAt(doc.getText().indexOf('<PackageReference Include="MediatR" />') + '<PackageReference Include="MediatR"'.length), ' Version=""'));
        const ver = doc.positionAt(doc.getText().indexOf('Version=""') + 'Version="'.length);
        const versions = await labels(ver);
        assert.ok(versions.includes('12.5.0'), versions.join(','));
        assert.ok(versions.includes('Load versions from NuGet sources…'));
        await vscode.commands.executeCommand('workbench.action.files.revert');
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, doc.positionAt(doc.getText().indexOf('TargetFramework') + 3));
        assert.match(hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n'), /target framework moniker/);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'solution: saving a project file reloads the project in the host (a linked item appears)',
      async () => {
        const { ex } = await ready();
        const uri = vscode.Uri.file(file('src/Explorer.Core/Explorer.Core.csproj'));
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        const original = doc.getText();
        const at = doc.positionAt(doc.getText().indexOf('</Project>'));
        await ed.edit((e) => e.insert(at, '  <ItemGroup>\n    <None Include="..\\..\\README.md" Link="Docs\\README.md" />\n  </ItemGroup>\n'));
        const refreshes = ex.refreshes();
        await doc.save();
        await waitFor(() => ex.refreshes() > refreshes && project(ex, 'Explorer.Core').items.some((i) => i.virtualPath === 'Docs/README.md' && i.linked), 'Docs/README.md linked after the reload', 120000);
        assert.ok(ex.outline().some((l) => l.includes('README.md — linked, None')));
        await ed.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original));
        await doc.save();
        assert.equal(read('src/Explorer.Core/Explorer.Core.csproj'), original);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        feed?.cleanup();
      },
    ],
  ];
};

/** The Shop scenario: the tree shows Shop (both projects, the project reference, MediatR). */
exports.shop = ({ api, csharp, waitFor }) => [
  [
    'solution: the Refyntra Solution view shows Shop',
    async () => {
      const vscode = require('vscode');
      const a = await api();
      await waitFor(() => csharp(a.health())?.state === 'Ready', 'host ready', 240000);
      await vscode.commands.executeCommand('refyntra.solution.show');
      const ex = a.solution.explorer;
      await waitFor(async () => {
        await ex.refresh();
        return ex.structure()?.projects.length === 2;
      }, 'the Shop model', 60000);
      const lines = ex.outline();
      for (const l of ['Shop.sln — 2 projects', '  Shop.Api — net10.0', '  Shop.Contracts — net10.0', '        MediatR — 12.5.0']) assert.ok(lines.some((x) => x === l || x.startsWith(`${l} `)), `${l}\n${lines.join('\n')}`);
      assert.equal(ex.structure().projects.find((p) => p.name === 'Shop.Api').kind, 'web');
      assert.deepEqual(ex.structure().projects.find((p) => p.name === 'Shop.Api').projectReferences.map((r) => r.name), ['Shop.Contracts']);
    },
  ],
];
