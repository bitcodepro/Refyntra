import { describe, expect, it } from 'vitest';
import type { RunnableProjectInfo } from '@refyntra/contracts';
import {
  browserUrl,
  cargoBinaries,
  csharpEntryLine,
  devServerUrl,
  dotnetBuildArgs,
  dotnetDebugConfiguration,
  dotnetProgram,
  dotnetRunCommand,
  dotnetTargets,
  firstUrl,
  isPythonEntry,
  listeningUrl,
  lldbDebugConfiguration,
  lldbEnv,
  netcoredbgLaunchArguments,
  nodeDebugConfigurations,
  nodeTargets,
  packageManagerOf,
  parseLaunchSettings,
  pickFramework,
  pythonDebugConfiguration,
  pythonEntryLine,
  pythonTarget,
  runnableFrameworks,
  rustEntryLine,
  rustTargets,
  splitArgs,
  statusText,
  stripJsonComments,
  targetForFile,
  validateDotnetConfiguration,
  validatePythonConfiguration,
} from '../../src/runModel';
import { buildHealthPage, debugSection, renderHealthPageText } from '../../src/healthPageModel';

const LAUNCH = `{
  // comments are allowed in launchSettings.json
  "profiles": {
    "http": {
      "commandName": "Project",
      "launchBrowser": true,
      "applicationUrl": "http://localhost:5187",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", "PORT": 5187 }
    },
    "staging": {
      "commandName": "Project",
      "applicationUrl": "https://localhost:7001;http://localhost:5001",
      "launchUrl": "swagger",
      "commandLineArgs": "--verbose \\"two words\\"",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Staging" },
    },
    "IIS Express": { "commandName": "IISExpress", "launchBrowser": true }
  }
}`;

const project = (over: Partial<RunnableProjectInfo> = {}): RunnableProjectInfo => ({
  name: 'WebApp',
  projectUri: 'file:///w/WebApp/WebApp.csproj',
  kind: 'web',
  runnable: true,
  windowsOnly: false,
  targetFrameworks: ['net10.0'],
  outputs: [{ targetFramework: 'net10.0', outputUri: 'file:///w/WebApp/bin/Debug/net10.0/WebApp.dll' }],
  assemblyName: 'WebApp',
  launchSettingsUri: 'file:///w/WebApp/Properties/launchSettings.json',
  ...over,
});
const toPath = (u: string) => u.replace('file://', '');

describe('launchSettings.json', () => {
  it('keeps Project profiles with URL, environment, arguments and browser flag; skips IIS Express', () => {
    const p = parseLaunchSettings(LAUNCH);
    expect(p.map((x) => x.name)).toEqual(['http', 'staging']);
    expect(p[0]).toMatchObject({ applicationUrl: 'http://localhost:5187', launchBrowser: true, environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development', PORT: '5187' } });
    expect(p[1]).toMatchObject({ launchUrl: 'swagger', commandLineArgs: '--verbose "two words"', launchBrowser: false });
  });
  it('returns nothing for broken JSON and strips comments without touching strings', () => {
    expect(parseLaunchSettings('{ not json')).toEqual([]);
    expect(JSON.parse(stripJsonComments('{"a": "http://x//y", /* c */ "b": 1, // d\n}'))).toEqual({ a: 'http://x//y', b: 1 });
  });
  it('splits command lines and picks URLs', () => {
    expect(splitArgs('--verbose "two words" x\\"y')).toEqual(['--verbose', 'two words', 'x"y']);
    expect(splitArgs(undefined)).toEqual([]);
    expect(firstUrl('https://localhost:7001;http://localhost:5001')).toBe('https://localhost:7001');
    expect(listeningUrl('info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5187\n')).toBe('http://localhost:5187');
    expect(browserUrl(parseLaunchSettings(LAUNCH)[1])).toBe('https://localhost:7001/swagger');
    expect(browserUrl(undefined, 'http://[::]:5000')).toBe('http://localhost:5000');
  });
});

describe('.NET targets and configurations', () => {
  const profiles = parseLaunchSettings(LAUNCH);
  const targets = dotnetTargets(
    [
      project(),
      project({ name: 'Desk', projectUri: 'file:///w/Desk/Desk.csproj', kind: 'wpf', windowsOnly: true, targetFrameworks: ['net10.0-windows'], launchSettingsUri: null }),
      project({ name: 'Tests', projectUri: 'file:///w/Tests/Tests.csproj', kind: 'test', runnable: false, reason: 'Test project: run its tests from the Test Explorer.', launchSettingsUri: null }),
      project({ name: 'Lib', kind: 'library', runnable: false }),
      project({ name: 'Multi', projectUri: 'file:///w/Multi/Multi.csproj', kind: 'console', targetFrameworks: ['net8.0', 'net10.0'], launchSettingsUri: null, outputs: [{ targetFramework: 'net8.0', outputUri: 'file:///w/Multi/bin/Debug/net8.0/Multi.dll' }, { targetFramework: 'net10.0', outputUri: 'file:///w/Multi/bin/Debug/net10.0/Multi.dll' }] }),
    ],
    toPath,
    () => profiles,
    'linux',
  );

  it('lists runnable projects first, explains the others, leaves libraries out', () => {
    expect(targets.map((t) => [t.label, t.runnable])).toEqual([
      ['Multi', true],
      ['WebApp', true],
      ['Desk', false],
      ['Tests', false],
    ]);
    expect(targets.find((t) => t.label === 'Desk')!.note).toContain('Windows only');
    expect(targets.find((t) => t.label === 'Tests')!.note).toContain('Test project');
    expect(dotnetTargets([project({ kind: 'wpf', windowsOnly: true, targetFrameworks: ['net10.0-windows'] })], toPath, () => [], 'win32')[0]!.runnable).toBe(true);
  });

  it('chooses frameworks: the requested one, else the newest runnable', () => {
    const multi = targets.find((t) => t.label === 'Multi')!.dotnet!.project;
    expect(pickFramework(multi, 'linux')).toBe('net10.0');
    expect(pickFramework(multi, 'linux', 'net8.0')).toBe('net8.0');
    expect(runnableFrameworks(project({ targetFrameworks: ['netstandard2.0', 'net10.0-windows', 'net9.0'] }), 'linux')).toEqual(['net9.0']);
  });

  it('runs with dotnet run and the launch profile; dotnet watch for hot reload', () => {
    const web = targets.find((t) => t.label === 'WebApp')!;
    expect(dotnetRunCommand(web, { configuration: 'Debug', profile: 'staging' }, 'linux').args).toEqual(['run', '--project', '/w/WebApp/WebApp.csproj', '-c', 'Debug', '--launch-profile', 'staging']);
    expect(dotnetRunCommand(web, { configuration: 'Release' }, 'linux', true).args).toEqual(['watch', 'run', '--project', '/w/WebApp/WebApp.csproj', '-c', 'Release', '--no-launch-profile']);
    const multi = targets.find((t) => t.label === 'Multi')!;
    expect(dotnetRunCommand(multi, { configuration: 'Debug', framework: 'net8.0' }, 'linux').args).toContain('net8.0');
    expect(dotnetBuildArgs('/w/A.csproj', 'net10.0', 'Debug').slice(0, 6)).toEqual(['build', '/w/A.csproj', '-c', 'Debug', '-f', 'net10.0']);
  });

  it('builds a netcoredbg launch configuration from the profile', () => {
    const web = targets.find((t) => t.label === 'WebApp')!;
    const c = dotnetDebugConfiguration(web, { configuration: 'Release', profile: 'staging' }, 'linux');
    expect(c).toMatchObject({ type: 'refyntra-dotnet', request: 'launch', program: '/w/WebApp/bin/Release/net10.0/WebApp.dll', cwd: '/w/WebApp', args: ['--verbose', 'two words'], justMyCode: true, stopAtEntry: false, console: 'internalConsole', launchProfile: 'staging', launchBrowser: { enabled: false, url: 'swagger' } });
    expect(c.env).toEqual({ ASPNETCORE_ENVIRONMENT: 'Staging', ASPNETCORE_URLS: 'https://localhost:7001;http://localhost:5001' });
    const inWs = dotnetDebugConfiguration(web, { configuration: 'Debug', profile: 'http' }, 'linux', '/w');
    expect(inWs.program).toBe('${workspaceFolder}/WebApp/bin/Debug/net10.0/WebApp.dll');
    expect(inWs.launchBrowser).toEqual({ enabled: true });
    expect(netcoredbgLaunchArguments(c)).toEqual({ program: c.program, args: c.args, cwd: c.cwd, env: c.env, stopAtEntry: false, justMyCode: true, enableStepFiltering: true });
  });

  it('derives the program for other configurations and without an evaluated output', () => {
    expect(dotnetProgram('/w/A/A.csproj', project({ assemblyName: 'Alpha' }), 'net10.0', 'Release')).toBe('/w/A/bin/Release/net10.0/Alpha.dll');
    expect(dotnetProgram('C:\\w\\A\\A.csproj', project({ assemblyName: null }), 'net8.0', 'Debug')).toBe('C:\\w\\A\\bin\\Debug\\net8.0\\A.dll');
    expect(dotnetProgram('/w/A/A.csproj', project(), 'net10.0', 'Release', '/w/A/bin/Debug/net10.0/A.exe')).toBe('/w/A/bin/Release/net10.0/A.dll');
  });

  it('validates configurations with readable problems', () => {
    expect(validateDotnetConfiguration({ request: 'launch' })).toContain('"program"');
    expect(validateDotnetConfiguration({ request: 'launch', program: '/a.dll', console: 'popup' as never })).toContain('console');
    expect(validateDotnetConfiguration({ request: 'launch', program: '/a.dll', env: { A: 1 as never } })).toContain('env');
    expect(validateDotnetConfiguration({ request: 'attach' })).toContain('processId');
    expect(validateDotnetConfiguration({ request: 'attach', processId: 'abc' })).toContain('process number');
    expect(validateDotnetConfiguration({ request: 'attach', processId: '1234' })).toBeUndefined();
    expect(validateDotnetConfiguration({ request: 'launch', project: '/w/A.csproj' })).toBeUndefined();
  });

  it('puts profile and framework in the status bar text', () => {
    const web = targets.find((t) => t.label === 'WebApp')!;
    expect(statusText(web, { configuration: 'Debug', profile: 'http' })).toBe('$(play) WebApp · http');
    expect(statusText(targets.find((t) => t.label === 'Multi'), { configuration: 'Release', framework: 'net8.0' })).toBe('$(play) Multi · net8.0 · Release');
    expect(statusText(undefined, undefined)).toBe('$(play) Run…');
  });
});

describe('Node, Python and Rust', () => {
  it('turns package.json scripts into targets for the right package manager', () => {
    const t = nodeTargets('/w/web/package.json', { name: 'web', scripts: { lint: 'eslint .', build: 'vite build', dev: 'vite --port 5174', start: 'node server.js', predev: 'x' } }, ['pnpm-lock.yaml']);
    expect(t.map((x) => x.node!.script)).toEqual(['dev', 'start', 'build']);
    expect(t[0]!.node).toMatchObject({ packageManager: 'pnpm', devServerUrl: 'http://localhost:5174' });
    expect(packageManagerOf([], 'yarn@4.1.0')).toBe('yarn');
    expect(packageManagerOf(['package-lock.json'])).toBe('npm');
    expect(devServerUrl('next dev')).toBe('http://localhost:3000');
    expect(devServerUrl('ng serve')).toBe('http://localhost:4200');
    expect(devServerUrl('node server.js')).toBeUndefined();
  });

  it('generates js-debug configurations instead of reimplementing them', () => {
    const [dev] = nodeTargets('/w/web/package.json', { scripts: { dev: 'vite' } }, []);
    const c = nodeDebugConfigurations(dev!, 'chrome');
    expect(c[0]).toMatchObject({ type: 'node', request: 'launch', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], cwd: '/w/web' });
    expect(c[1]).toMatchObject({ type: 'chrome', request: 'launch', url: 'http://localhost:5173', webRoot: '/w/web' });
  });

  it('recognises Python entry files and builds debugpy configurations', () => {
    expect(isPythonEntry('def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n')).toBe(true);
    expect(pythonEntryLine("x = 1\nif __name__ == '__main__':\n  pass")).toBe(1);
    const t = pythonTarget('/w/app/main.py', '/w');
    expect(pythonDebugConfiguration(t, '/w/.venv/bin/python')).toMatchObject({ type: 'refyntra-python', request: 'launch', program: '/w/app/main.py', cwd: '/w', python: '/w/.venv/bin/python', justMyCode: true });
    expect(validatePythonConfiguration({ request: 'launch' })).toContain('program');
    expect(validatePythonConfiguration({ request: 'attach' })).toContain('connect');
    expect(validatePythonConfiguration({ request: 'attach', connect: { port: 5678 } })).toBeUndefined();
  });

  it('reads Cargo binaries and builds cargo / lldb-dap steps', () => {
    expect(cargoBinaries('[package]\nname = "orders" # app\nversion="0.1.0"\n[dependencies]\nname = "x"\n', true)).toEqual({ packageName: 'orders', bins: ['orders'] });
    expect(cargoBinaries('[package]\nname = "tools"\n[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n', false).bins).toEqual(['a', 'b']);
    expect(rustTargets('/w/Cargo.toml', '[package]\nname = "lib-only"\n', false)).toEqual([]);
    const [t] = rustTargets('/w/Cargo.toml', '[package]\nname = "orders"\n', true);
    expect(lldbDebugConfiguration(t!, 'win32')).toMatchObject({ type: 'refyntra-lldb', program: '/w/target/debug/orders.exe', cargo: { manifest: '/w/Cargo.toml', bin: 'orders' } });
    expect(lldbEnv({ A: '1' })).toEqual(['A=1']);
    expect(rustEntryLine('use x;\n\nfn main() {\n}')).toBe(2);
  });
});

describe('CodeLens placement and file ownership', () => {
  it('finds Main or the first top-level statement of Program.cs', () => {
    expect(csharpEntryLine('namespace A;\nclass P\n{\n    static async Task<int> Main(string[] args) => 0;\n}', 'Program.cs')).toBe(3);
    expect(csharpEntryLine('// header\nusing System;\n\nvar builder = WebApplication.CreateBuilder(args);\n', 'Program.cs')).toBe(3);
    expect(csharpEntryLine('/* a\n b */\nConsole.WriteLine(1);', 'Program.cs')).toBe(2);
    expect(csharpEntryLine('Console.WriteLine(1);', 'Other.cs')).toBeUndefined();
    expect(csharpEntryLine('namespace A;\npublic class Program {}', 'Program.cs')).toBeUndefined();
  });

  it('maps a file to the deepest project folder', () => {
    const ts = [
      { id: 'a', cwd: '/w', language: 'dotnet' as const },
      { id: 'b', cwd: '/w/Web', language: 'dotnet' as const },
    ];
    expect(targetForFile(ts, '/w/Web/Program.cs', 'dotnet')!.id).toBe('b');
    expect(targetForFile(ts, 'C:\\other\\x.cs', 'dotnet')).toBeUndefined();
  });
});

describe('Health: Run and debug section', () => {
  it('says what runs and debugs here and why not', () => {
    const ok = debugSection({ netcoredbg: { path: '/x/netcoredbg', version: 'netcoredbg 3.2.0-1092 (linux-x64)' }, debugpy: { path: '/x/debugpy', version: 'debugpy 1.8.22 (pure-Python parts)' }, python: '/usr/bin/python3', dotnet: '/usr/bin/dotnet' }, true);
    expect(ok.icon).toBe('ok');
    expect(ok.meaning).toContain('netcoredbg 3.2.0-1092');
    expect(ok.meaning).toContain('lldb-dap');
    const none = debugSection({ netcoredbg: { reason: 'netcoredbg has no official build for win32-arm64.' }, debugpy: { path: '/x' } }, true);
    expect(none.icon).toBe('warning');
    expect(none.headline).toContain('.NET debugging is unavailable');
    expect(debugSection({ netcoredbg: {}, debugpy: {} }, false).icon).toBe('locked');
    const text = renderHealthPageText(buildHealthPage({ health: { adapters: [], workspaceTrusted: true }, debug: { netcoredbg: {}, debugpy: {} } }));
    expect(text).toContain('Run and debug');
  });
});
