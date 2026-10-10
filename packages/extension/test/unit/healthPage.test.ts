import { describe, expect, it } from 'vitest';
import type { LoadDiagnostic, ProjectContextInfo } from '@refyntra/contracts';
import type { AdapterHealth, HealthSummary } from '@refyntra/domain';
import { buildHealthPage, diagnosticCause, modelActions, nameList, renderHealthPageText, resolveMessage } from '../../src/healthPageModel';
import { escapeHtml, renderHealthBody, renderHealthHtml } from '../../src/healthPageHtml';
import { renderHealth } from '../../src/healthText';

const SLN = 'C:\\src\\Sample\\Sample.sln';
const restoreAction = { command: 'refyntra.runRestore', title: 'Run dotnet restore', args: [SLN] };
const cs = (over: Partial<AdapterHealth>): AdapterHealth => ({ adapterId: 'csharp', providerRouteId: 'csharp.roslyn', displayName: 'C#', state: 'Ready', recoveryActions: [], projects: [], diagnostics: [], restartCount: 0, solutionPath: SLN, ...over });
const ts: AdapterHealth = { adapterId: 'typescript', providerRouteId: 'tsjs.vscode', displayName: 'TS/JS', state: 'Ready', recoveryActions: [], projects: [], diagnostics: [], restartCount: 0 };
const h = (a: AdapterHealth[], trusted = true): HealthSummary => ({ adapters: a, workspaceTrusted: trusted });
const proj = (name: string, state: ProjectContextInfo['state'], diagnostics: LoadDiagnostic[] = []): ProjectContextInfo => ({ projectContextId: name, name, projectPath: `C:\\src\\Sample\\${name}\\${name}.csproj`, targetFramework: 'net10.0', state, documentCount: 3, diagnostics });
const msbuild = (name: string): LoadDiagnostic => ({ severity: 'error', message: `Msbuild failed when processing the file 'C:\\src\\Sample\\${name}\\${name}.csproj' with message: Assets file 'obj\\project.assets.json' not found. Run a NuGet package restore to generate this file.`, projectPath: `C:\\src\\Sample\\${name}\\${name}.csproj` });
const assets = (name: string): LoadDiagnostic => ({ severity: 'error', message: 'project.assets.json is missing (packages are not restored). Recovery: Run dotnet restore.', cause: 'missingAssets', recoveryActions: [restoreAction], projectPath: `C:\\src\\Sample\\${name}\\${name}.csproj` });
const pkgs = (name: string): LoadDiagnostic => ({ severity: 'error', message: '37 package(s) listed in project.assets.json are missing from the package folders (e.g. Avalonia/12.1.1, Avalonia.Desktop/12.1.1, Serilog/4.0.0). Recovery: Run dotnet restore.', cause: 'missingPackages', recoveryActions: [restoreAction], projectPath: `C:\\src\\Sample\\${name}\\${name}.csproj` });

const NAMES = ['App', 'Infrastructure', 'Web', 'Worker', 'Shared', 'Tests', 'Cli', 'Benchmarks'];
/** The user's case: 9 projects, 8 without restored packages, two near-duplicate messages each. */
const unrestored = () => cs({ state: 'Partial', reasonCode: 'PartialLoad', recoveryActions: [{ command: 'refyntra.showHealth', title: 'Show Health' }, restoreAction], projects: [proj('Sample.Core', 'loaded'), ...NAMES.map((n) => proj(n, 'partial', [msbuild(n), assets(n)]))] });

describe('Health page model', () => {
  it('ready: one plain headline, no fix needed, every project under Works', () => {
    const m = buildHealthPage({ health: h([cs({ projects: Array.from({ length: 9 }, (_, i) => proj(`P${i}`, 'loaded')) }), ts]) });
    const c = m.sections[0]!;
    expect(c.icon).toBe('ok');
    expect(c.headline).toBe('C# is ready — 9 projects loaded');
    expect(c.primary).toBeUndefined();
    expect(c.groups.map((g) => g.kind)).toEqual(['works']);
    expect(c.groups[0]!.summary).toBe('P0, P1, P2, P3, P4, … (+4 more)');
    expect(m.secondary.map((a) => a.label)).toEqual(['Export debug bundle', 'Get started', 'Copy as text', 'Open as text']);
  });

  it('partial, missing packages: meaning in plain words, Restore packages for the solution, one line per project', () => {
    const m = buildHealthPage({ health: h([unrestored(), ts]) });
    const c = m.sections[0]!;
    expect(c.icon).toBe('warning');
    expect(c.headline).toBe('C# works partially');
    expect(c.meaning).toBe("8 of 9 projects are missing their NuGet packages, so Refyntra can't fully understand them. Find, Related and Rename may miss results in these projects.");
    expect(c.primary).toMatchObject({ id: 'restore', label: 'Restore packages', arg: SLN });
    expect(c.groups.map((g) => `${g.title}: ${g.summary}`)).toEqual(['Needs packages: App, Infrastructure, Web, Worker, Shared, … (+3 more)', 'Works: Sample.Core']);
    const app = c.groups[0]!.projects[0]!;
    expect(app.problems).toHaveLength(1);
    expect(app.problems[0]!.text).toBe('NuGet packages not restored');
    expect(app.problems[0]!.raw).toHaveLength(2);
  });

  it('missing packages from project.assets.json: count and an example package', () => {
    const m = buildHealthPage({ health: h([cs({ state: 'Partial', projects: [proj('App', 'partial', [pkgs('App')])] })]) });
    expect(m.sections[0]!.groups[0]!.projects[0]!.problems[0]!.text).toBe('NuGet packages not restored (37 missing, e.g. Avalonia 12.1.1)');
  });

  it('partial, mixed causes: every cause counted, still Restore packages first, groups in plain words', () => {
    const missingRef: LoadDiagnostic = { severity: 'error', message: 'Referenced project not found: C:\\src\\Sample\\Gone\\Gone.csproj. References to it are unresolved.', cause: 'missingProjectReference' };
    const m = buildHealthPage({
      health: h([cs({ state: 'Partial', projects: [proj('Core', 'loaded'), proj('App', 'partial', [assets('App')]), proj('Web', 'partial', [missingRef]), proj('Legacy', 'failed', [{ severity: 'error', message: 'The project could not be loaded.' }])] })]),
    });
    const c = m.sections[0]!;
    expect(c.meaning).toBe('3 of 4 projects did not load completely (1 need NuGet packages, 1 miss a referenced project, 1 failed to load). Find, Related and Rename may miss results in these projects.');
    expect(c.primary?.id).toBe('restore');
    expect(c.more.map((a) => a.id)).toEqual(['restartBackend']);
    expect(c.groups.map((g) => `${g.title}: ${g.summary}`)).toEqual(['Needs packages: App', 'Missing project reference: Web', 'Failed to load: Legacy', 'Works: Core']);
    expect(c.groups[1]!.projects[0]!.problems[0]!.text).toBe('A project it references is missing: Gone.csproj');
  });

  it('cause heuristics when the host sends no structured cause', () => {
    expect(diagnosticCause(msbuild('A'))).toBe('missingAssets');
    expect(diagnosticCause({ severity: 'error', message: 'error NU1101: Unable to find package Foo.' })).toBe('missingPackages');
    expect(diagnosticCause({ severity: 'error', message: 'Referenced project not found: X.csproj. References to it are unresolved.' })).toBe('missingProjectReference');
    expect(diagnosticCause({ severity: 'error', message: 'Something else' })).toBe('other');
  });

  it('missing SDK with global.json: Install .NET SDK opens the host download URL, Open global.json', () => {
    const m = buildHealthPage({
      health: h([cs({ state: 'Failed', reasonCode: 'SdkNotFound', message: 'C:\\src\\Sample\\global.json asks for .NET SDK 9.0.100 (rollForward: disable, accepts exactly 9.0.100). Installed SDKs: 10.0.100.', recoveryHint: 'Install a .NET SDK that matches (exactly 9.0.100) from https://dotnet.microsoft.com/download/dotnet, or change the SDK version or rollForward in that global.json; then run Refyntra: Restart Backend.' })]),
    });
    const c = m.sections[0]!;
    expect(c.icon).toBe('error');
    expect(c.headline).toBe('C# is not running');
    expect(c.meaning).toMatch(/^The \.NET SDK version this solution asks for \(in global\.json\) is not installed\./);
    expect(c.primary).toMatchObject({ id: 'installSdk', label: 'Install .NET SDK', arg: 'https://dotnet.microsoft.com/download/dotnet' });
    expect(c.more).toEqual([expect.objectContaining({ id: 'openGlobalJson', arg: 'C:\\src\\Sample\\global.json' }), expect.objectContaining({ id: 'restartBackend' })]);
  });

  it('no solution: Select solution', () => {
    const c = buildHealthPage({ health: h([cs({ state: 'NotStarted', reasonCode: 'NoSolutionFound', solutionPath: null }), ts]) }).sections[0]!;
    expect(c.headline).toBe('C#: no solution or project found');
    expect(c.primary).toMatchObject({ id: 'selectSolution', label: 'Select solution' });
  });

  it('restricted: Trust workspace, nothing else is started', () => {
    const c = buildHealthPage({ health: h([cs({ state: 'TrustRequired', reasonCode: 'TrustRequired' }), ts], false) }).sections[0]!;
    expect(c.icon).toBe('locked');
    expect(c.headline).toBe('Restricted Mode');
    expect(c.primary).toMatchObject({ id: 'trustWorkspace', label: 'Trust workspace' });
  });

  it('host failed: not running, Restart backend', () => {
    const c = buildHealthPage({ health: h([cs({ state: 'Failed', reasonCode: 'HostNotFound', message: 'Refyntra.Host.dll was not found.' })]) }).sections[0]!;
    expect(c.headline).toBe('C# is not running');
    expect(c.meaning).toContain('(Refyntra.Host.dll was not found.)');
    expect(c.primary).toMatchObject({ id: 'restartBackend', label: 'Restart backend' });
  });

  it('TS/JS only: ready, built-in language features', () => {
    const m = buildHealthPage({ health: h([ts]) });
    expect(m.sections).toHaveLength(1);
    expect(m.sections[0]).toMatchObject({ icon: 'ok', headline: "TypeScript / JavaScript: ready (uses VS Code's built-in language features)" });
  });

  it('restore progress: no second Restore button while it runs; a failure is shown with Show restore output', () => {
    const running = buildHealthPage({ health: h([unrestored()]), restore: { state: 'running', target: SLN } });
    expect(running.sections[0]!.primary).toBeUndefined();
    expect(running.restoreBanner?.text).toMatch(/^Restoring NuGet packages for Sample\.sln/);
    const failed = buildHealthPage({ health: h([unrestored()]), restore: { state: 'failed', target: SLN, exitCode: 1 } });
    expect(failed.restoreBanner).toMatchObject({ icon: 'error', action: { id: 'showRestoreOutput', label: 'Show restore output' } });
    expect(failed.sections[0]!.primary?.id).toBe('restore');
  });
});

describe('webview messages', () => {
  it('only keys of the current model resolve; arguments always come from the model', () => {
    const m = buildHealthPage({ health: h([unrestored()]) });
    const keys = modelActions(m).map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(resolveMessage(m, { type: 'action', key: 'restore' })).toMatchObject({ id: 'restore', arg: SLN });
    expect(resolveMessage(m, { type: 'action', key: 'restore', arg: 'C:\\evil.sln' })?.arg).toBe(SLN);
    for (const bad of [null, 'restore', { type: 'command', key: 'restore' }, { type: 'action', key: 'workbench.action.terminal.new' }, { type: 'action', key: 'installSdk' }, { type: 'action', key: 7 }]) expect(resolveMessage(m, bad)).toBeUndefined();
  });
});

describe('HTML and text', () => {
  it('escapes everything that comes from the workspace or the backend', () => {
    const evil = '<img src=x onerror=alert(1)>"\'`&';
    const a = cs({ state: 'Partial', message: evil, projects: [proj(evil, 'partial', [{ severity: 'error', message: evil }])] });
    const body = renderHealthBody(buildHealthPage({ health: h([a]) }), h([a]), { solution: evil });
    expect(body).not.toContain('<img');
    expect(body).not.toMatch(/"'`/);
    expect(body).toContain(escapeHtml(evil));
    const html = renderHealthHtml(body, { nonce: 'abc', cspSource: 'vscode-resource:' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-abc'");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect(html.replaceAll('&#60;img src=x onerror=', '')).not.toMatch(/<[^>]* on[a-z]+=/); // no event handler attribute of our own
  });

  it('buttons are real buttons with keys; technical details are collapsed at the bottom and complete', () => {
    const a = unrestored();
    const body = renderHealthBody(buildHealthPage({ health: h([a]) }), h([a]), { solution: SLN });
    expect(body).toContain('<button type="button" class="primary" data-key="restore"');
    const tech = body.indexOf('Technical details (for troubleshooting)');
    expect(tech).toBeGreaterThan(body.indexOf('Needs packages'));
    expect(body.slice(tech)).toContain('csharp.roslyn');
    expect(body.slice(tech)).toContain('PartialLoad');
    expect(body).toContain('<summary>Show MSBuild messages (2)</summary>');
  });

  it('the Markdown version starts with the plain summary and keeps the technical details', () => {
    const md = renderHealth(h([unrestored()]), { solution: undefined });
    expect(md.indexOf('⚠ C# works partially')).toBeLessThan(md.indexOf('## Technical details'));
    expect(md).toContain('Route: `csharp.roslyn`');
    expect(md).toContain('Reason: some projects loaded only partially (`PartialLoad`)');
  });

  it('text rendering of the partial case', () => {
    expect(renderHealthPageText(buildHealthPage({ health: h([unrestored(), ts]) }))).toMatchInlineSnapshot(`
      "Refyntra Health

      ⚠ C# works partially
         8 of 9 projects are missing their NuGet packages, so Refyntra can't fully understand them. Find, Related and Rename may miss results in these projects.
         [Restore packages] (Restart backend)

         Projects
         ▸ Needs packages: App, Infrastructure, Web, Worker, Shared, … (+3 more)
             App: NuGet packages not restored ▸ Show MSBuild message
             Infrastructure: NuGet packages not restored ▸ Show MSBuild message
             Web: NuGet packages not restored ▸ Show MSBuild message
             Worker: NuGet packages not restored ▸ Show MSBuild message
             Shared: NuGet packages not restored ▸ Show MSBuild message
             Tests: NuGet packages not restored ▸ Show MSBuild message
             Cli: NuGet packages not restored ▸ Show MSBuild message
             Benchmarks: NuGet packages not restored ▸ Show MSBuild message
         ▸ Works: Sample.Core

      ✅ TypeScript / JavaScript: ready (uses VS Code's built-in language features)
         Related, Find and Rename for TypeScript and JavaScript files use the language support built into VS Code; nothing to set up.

      (Export debug bundle) (Get started) (Copy as text) (Open as text)

      ▸ Technical details (for troubleshooting)"
    `);
  });

  it('nameList', () => {
    expect(nameList(['a', 'b'])).toBe('a, b');
    expect(nameList(['a', 'b', 'c'], 2)).toBe('a, b, … (+1 more)');
  });
});
