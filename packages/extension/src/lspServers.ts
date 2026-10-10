import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { StartupError } from '@refyntra/application';
import type { EnvironmentNote } from '@refyntra/adapter-lsp';
import type { ProcessLaunch } from '@refyntra/infrastructure';

// Where the bundled language servers are and how they are launched. Python: Pyright (JavaScript) runs on the Node
// runtime VS Code runs extensions on (process.execPath with ELECTRON_RUN_AS_NODE=1): no system Node. Rust: the
// rust-analyzer binary shipped in the platform VSIX; never one from PATH, never downloaded at run time.

/** The rust-analyzer release pinned in scripts/package/rust-analyzer.json (dev fallback cache folder). */
export const RUST_ANALYZER_VERSION = '2026-09-21';

const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export class LspServerLocator {
  /** `devFallback`: also look in the development checkout (never for an installed extension in production mode). */
  constructor(
    private readonly extensionPath: string,
    private readonly devFallback: boolean,
  ) {}

  /** packaged: <ext>/servers/pyright; dev checkout: <ext>/node_modules/pyright (pinned devDependency). */
  pyrightCandidates(): string[] {
    const packaged = path.join(this.extensionPath, 'servers', 'pyright', 'langserver.index.js');
    return this.devFallback ? [packaged, path.join(this.extensionPath, 'node_modules', 'pyright', 'langserver.index.js')] : [packaged];
  }

  async pyright(): Promise<ProcessLaunch> {
    const entry = this.pyrightCandidates().find(exists);
    if (!entry) throw new StartupError('ServerNotFound', 'The bundled Pyright language server is missing from this installation of Refyntra. Reinstall the extension.');
    return { command: process.execPath, args: [entry, '--stdio'], cwd: path.dirname(entry), env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  /** packaged: <ext>/servers/rust-analyzer/; dev checkout: <repo>/.cache/rust-analyzer/<version>/<platform-arch>/. */
  rustAnalyzerCandidates(): string[] {
    const exe = process.platform === 'win32' ? 'rust-analyzer.exe' : 'rust-analyzer';
    const packaged = path.join(this.extensionPath, 'servers', 'rust-analyzer', exe);
    return this.devFallback ? [packaged, path.resolve(this.extensionPath, '..', '..', '.cache', 'rust-analyzer', RUST_ANALYZER_VERSION, `${process.platform}-${process.arch}`, exe)] : [packaged];
  }

  async rustAnalyzer(): Promise<ProcessLaunch> {
    const bin = this.rustAnalyzerCandidates().find(exists);
    if (!bin) {
      throw new StartupError(
        'ServerNotFound',
        `rust-analyzer is not bundled for this platform (${process.platform}-${process.arch}). Refyntra ships rust-analyzer in platform-specific packages for Windows, Linux and macOS (x64 and arm64); install the package for your platform from the Marketplace. Rust features are unavailable with this package.`,
      );
    }
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
      } catch {
        // A copy that lost its executable bit (for example extracted by a tool that drops modes): restore it.
        fs.chmodSync(bin, 0o755);
      }
    }
    return { command: bin, args: [], cwd: path.dirname(bin), env: { RA_LOG: 'error' } };
  }
}

/** Python environment for imports: python.defaultInterpreterPath (if the file exists) or a .venv/venv with pyvenv.cfg. Never run here. */
export function pythonInterpreter(folders: readonly vscode.WorkspaceFolder[]): string | undefined {
  const configured = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
  const bin = (venv: string) => (process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));
  for (const f of folders) {
    if (configured && configured.trim() && configured.trim() !== 'python') {
      const p = path.isAbsolute(configured.trim()) ? configured.trim() : path.join(f.uri.fsPath, configured.trim().replace(/^\$\{workspaceFolder\}[\\/]?/, ''));
      if (exists(p)) return p;
    }
    for (const name of ['.venv', 'venv']) {
      const venv = path.join(f.uri.fsPath, name);
      if (exists(path.join(venv, 'pyvenv.cfg')) && exists(bin(venv))) return bin(venv);
    }
  }
  return undefined;
}

/** Pyright's settings (workspace/configuration). Diagnostics off: Refyntra uses Pyright for navigation and rename only. */
export function pyrightConfiguration(section: string | undefined, folders: readonly vscode.WorkspaceFolder[]): unknown {
  const interpreter = pythonInterpreter(folders);
  const analysis = { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly', typeCheckingMode: 'off', autoImportCompletions: false };
  if (section === 'python') return { ...(interpreter ? { pythonPath: interpreter } : {}), analysis };
  if (section === 'python.analysis') return analysis;
  if (section === 'pyright') return { disableLanguageServices: false, disableOrganizeImports: true };
  return null;
}

/** rust-analyzer settings: no cargo check on save (a build); build scripts and proc-macros as rust-analyzer defaults (trusted workspaces only). */
export const RUST_ANALYZER_SETTINGS = {
  checkOnSave: false,
  check: { command: 'check' },
  cargo: { buildScripts: { enable: true } },
  procMacro: { enable: true },
  diagnostics: { enable: false },
  files: { watcher: 'client' },
  lens: { enable: false },
  inlayHints: { enable: false },
};

/** Looks for cargo without running anything: PATH entries, CARGO_HOME/bin and ~/.cargo/bin. */
export function findCargo(): string | undefined {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.env.CARGO_HOME) dirs.push(path.join(process.env.CARGO_HOME, 'bin'));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) dirs.push(path.join(home, '.cargo', 'bin'));
  for (const d of dirs) if (exists(path.join(d, exe))) return path.join(d, exe);
  return undefined;
}

export const CARGO_NOT_FOUND: EnvironmentNote = {
  reasonCode: 'CargoNotFound',
  message:
    'cargo (the Rust toolchain) was not found. rust-analyzer still lists the symbols of open files and finds definitions and references inside them, but it cannot load the Cargo project: results across files and crates, the standard library and dependencies are missing or incomplete. Install Rust from https://rustup.rs and restart the backend. Refyntra never installs anything itself.',
};
