// Installation smoke, Windows and Linux. Run: pnpm test:install
//
// 1. Takes the packaged dist/refyntra-<version>.vsix (run `pnpm package:vsix` first).
// 2. Installs it with the VS Code CLI into a fresh extensions dir whose path has spaces and non-ASCII characters,
//    with its own user-data dir (a clean profile).
// 3. Starts that VS Code on temp copies of tests/fixtures/Shop and DiRules (restored). The only extension under test
//    is the INSTALLED copy: the extension development path is an empty stub runner outside the repository, and
//    REFYNTRA_HOST_PATH is removed from the environment. The suite asserts extensionPath is inside the temp
//    extensions dir and that the host was started from <installed>/host/Refyntra.Host.dll.
// 4. Journeys: Ready, Find, Related (GetOrderQuery → handler / Send / endpoint), rename preview; OR1001 on DiRules.
// 5. After VS Code exits (extension deactivate), no process whose command line points into <installed>/host (the
//    host or a BuildHost from the installed payload) may remain (process-tree shutdown).
//
// VS Code version: REFYNTRA_TEST_VSCODE_VERSION (default 1.90.2, the minimum supported engine).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const extPkgDir = path.join(repo, 'packages', 'extension');
const require = createRequire(path.join(extPkgDir, 'package.json'));
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = require('@vscode/test-electron');

const pkg = JSON.parse(fs.readFileSync(path.join(extPkgDir, 'package.json'), 'utf8'));
const extensionId = `${pkg.publisher}.${pkg.name}`;
const vsix = path.join(repo, 'dist', `${pkg.name}-${pkg.version}.vsix`);
const version = process.env.REFYNTRA_TEST_VSCODE_VERSION || '1.90.2';
const cachePath = path.join(repo, '.vscode-test');

function fail(msg) {
  console.error(`\ntest:install FAILED: ${msg}`);
  process.exitCode = 1;
}

if (!fs.existsSync(vsix)) {
  console.error(`test:install: ${path.relative(repo, vsix)} not found. Run "pnpm package:vsix" first.`);
  process.exit(2);
}
// The installed host must be the only candidate: no override from the environment.
delete process.env.REFYNTRA_HOST_PATH;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Refyntra smoke ü-'));
const extDir = path.join(root, 'ext dir');
const userData = path.join(root, 'user data');
const runner = path.join(root, 'runner');
console.log(`Install smoke root: ${root}`);
console.log(`VSIX: ${vsix} (${(fs.statSync(vsix).size / 1024).toFixed(1)} KiB)`);

/** Lists processes whose command line or executable mentions `needle` (Windows: CIM; POSIX: ps). */
function processesMentioning(needle) {
  if (process.platform === 'win32') {
    const script = `$n = $env:REFYNTRA_SMOKE_NEEDLE; Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -and $_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, REFYNTRA_SMOKE_NEEDLE: needle },
      windowsHide: true,
    });
    return out.split(/\r?\n/).filter(Boolean);
  }
  // Our own line is skipped by pid; a substring filter on the script name would also hide every child whose arguments
  // mention it.
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(needle) && Number.parseInt(l, 10) !== process.pid);
}

/**
 * The process matcher must see a known running process, or the shutdown check would prove nothing. A sleeper child
 * with a unique marker in its arguments works on every OS (POSIX `ps` shows argv as typed, e.g. "node", not
 * process.execPath, and the old self-match was filtered out with the script name).
 */
async function assertProcessListingWorks() {
  const marker = `refyntra-smoke-probe-${process.pid}-${Date.now()}`;
  const probe = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      probe.once('spawn', resolve);
      probe.once('error', reject);
    });
    if (processesMentioning(marker).length === 0) throw new Error('process listing does not work: a running probe process was not found');
  } finally {
    probe.kill();
  }
}

function copyFixture(fixture, sln) {
  const fixtures = path.join(repo, 'tests', 'fixtures');
  const dest = path.join(root, `ws ${fixture}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(fixtures)) if (f.startsWith('Directory.')) fs.copyFileSync(path.join(fixtures, f), path.join(dest, f));
  fs.cpSync(path.join(fixtures, fixture), path.join(dest, fixture), { recursive: true, filter: (src) => !/[\\/](bin|obj)$/.test(src) });
  const r = spawnSync('dotnet', ['restore', path.join(dest, fixture, sln), '--nologo'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`dotnet restore of the ${fixture} copy failed`);
  return path.join(dest, fixture);
}

/**
 * Same arguments as @vscode/test-electron's runTests, but spawned WITHOUT a shell: runTests uses `shell: true` on
 * Windows, which splits paths with spaces (the point of this smoke) into several arguments.
 */
function runVsCodeTests(exe, { extensionDevelopmentPath, extensionTestsPath, launchArgs, env }) {
  const args = [
    ...launchArgs,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
  ];
  const fullEnv = { ...process.env, ...env };
  delete fullEnv.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: fullEnv, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`VS Code exited with ${code ?? signal}`))));
  });
}

let exitCode = 0;
let hostNeedle;
try {
  await assertProcessListingWorks();
  // ---------------------------------------------------------------- install with the VS Code CLI
  const vscodeExe = await downloadAndUnzipVSCode({ version, cachePath });
  fs.mkdirSync(extDir, { recursive: true });
  const cliArgs = ['--install-extension', vsix, '--force', '--extensions-dir', extDir, '--user-data-dir', userData];
  let install;
  if (process.platform === 'win32' || process.platform === 'linux') {
    // What bin\code.cmd and bin/code do, without a shell: the executable as Node running the CLI entry point. On Linux
    // bin/code would also stop at an interactive "VS Code in WSL?" prompt when the kernel is a WSL2 one (Docker Desktop).
    const cliJs = path.join(path.dirname(vscodeExe), 'resources', 'app', 'out', 'cli.js');
    install = spawnSync(vscodeExe, [cliJs, ...cliArgs], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, windowsHide: true });
  } else {
    install = spawnSync(resolveCliPathFromVSCodeExecutablePath(vscodeExe), cliArgs, { encoding: 'utf8' });
  }
  process.stdout.write(install.stdout ?? '');
  process.stderr.write(install.stderr ?? '');
  if (install.status !== 0) throw new Error(`code --install-extension failed (${install.status})`);
  const installed = fs.readdirSync(extDir).filter((d) => d.toLowerCase().startsWith(`${extensionId}-`));
  if (installed.length !== 1) throw new Error(`expected one installed ${extensionId} in ${extDir}, found: ${fs.readdirSync(extDir).join(', ')}`);
  const installedPath = path.join(extDir, installed[0]);
  const installedHost = path.join(installedPath, 'host', 'Refyntra.Host.dll');
  if (!fs.existsSync(installedHost)) throw new Error(`installed payload has no host: ${installedHost}`);
  hostNeedle = path.join(installedPath, 'host');
  console.log(`Installed: ${installedPath}`);

  // ---------------------------------------------------------------- stub runner (no extension code of ours)
  fs.mkdirSync(runner, { recursive: true });
  fs.writeFileSync(
    path.join(runner, 'package.json'),
    JSON.stringify({ name: 'refyntra-install-smoke-runner', publisher: 'refyntra-test', version: '0.0.0', engines: { vscode: '^1.90.0' } }, null, 2),
  );
  const extensionTestsPath = path.join(here, 'install-smoke', 'suite.cjs');

  const settings = {
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
  };
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));

  const scenarios = [
    { name: 'shop', workspace: copyFixture('Shop', 'Shop.sln') },
    { name: 'di-rules', workspace: copyFixture('DiRules', 'DiRules.sln') },
  ];
  for (const s of scenarios) {
    console.log(`\n=== Installed-VSIX scenario: ${s.name} (VS Code ${version}) ===`);
    const report = path.join(root, `report-${s.name}.json`);
    try {
      await runVsCodeTests(vscodeExe, {
        extensionDevelopmentPath: runner,
        extensionTestsPath,
        launchArgs: [s.workspace, `--extensions-dir=${extDir}`, `--user-data-dir=${userData}`],
        env: {
          REFYNTRA_SMOKE_SCENARIO: s.name,
          REFYNTRA_SMOKE_EXTENSIONS_DIR: extDir,
          REFYNTRA_SMOKE_EXTENSION_ID: extensionId,
          REFYNTRA_SMOKE_REPO: repo,
          REFYNTRA_SMOKE_REPORT: report,
        },
      });
    } catch (e) {
      fail(`scenario ${s.name}: ${e instanceof Error ? e.message : e}`);
      exitCode = 1;
      continue;
    }
    const r = JSON.parse(fs.readFileSync(report, 'utf8'));
    console.log(`  extensionPath: ${r.extensionPath}`);
    console.log(`  host launch:   ${r.hostLaunch}`);
    console.log(`  host pids:     ${r.hostPids.join(', ')}`);
    // ------------------------------------------------------------ process-tree shutdown after VS Code exited
    let left = [];
    const deadline = Date.now() + 20000;
    do {
      left = processesMentioning(hostNeedle);
      if (left.length === 0) break;
      await new Promise((res) => setTimeout(res, 500));
    } while (Date.now() < deadline);
    if (left.length) {
      fail(`processes from the installed payload outlived VS Code:\n  ${left.join('\n  ')}`);
      exitCode = 1;
    } else {
      console.log('  shutdown:      no Refyntra.Host / BuildHost process from the install remains');
    }
    for (const pid of r.hostPids) {
      try {
        process.kill(pid, 0);
        fail(`host pid ${pid} is still alive`);
        exitCode = 1;
      } catch {
        // gone
      }
    }
  }
} catch (e) {
  fail(e instanceof Error ? e.stack ?? e.message : String(e));
  exitCode = 1;
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : e}`);
  }
}
if (exitCode) process.exit(1);
console.log('\nInstall smoke passed');
