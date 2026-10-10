import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { StartupError } from '@refyntra/application';
import type { ProcessLaunch } from '@refyntra/infrastructure';

export const HOST_DLL = 'Refyntra.Host.dll';
export const DEV_HOST_RELATIVE = path.join('src', 'dotnet', 'Refyntra.Host', 'bin', 'Release', 'net10.0', HOST_DLL);

export interface HostCandidate {
  source: 'override' | 'setting' | 'packaged' | 'dev';
  path: string;
}

/**
 * Host location order:
 *   1. test/e2e override (REFYNTRA_HOST_PATH env var or the test API)
 *   2. user/machine setting refyntra.hostPath (machine scope; ignored in Restricted Mode)
 *   3. packaged: <extension>/host/Refyntra.Host.dll
 *   4. dev checkout: <repo>/src/dotnet/Refyntra.Host/bin/Release/net10.0/Refyntra.Host.dll
 */
export class HostLocator {
  private override: string | undefined = process.env.REFYNTRA_HOST_PATH || undefined;
  private lastDescription: string | undefined;

  constructor(private readonly extensionPath: string) {}

  setOverride(p: string | undefined): void {
    this.override = p || undefined;
  }

  candidates(): HostCandidate[] {
    const out: HostCandidate[] = [];
    if (this.override) out.push({ source: 'override', path: this.override });
    // inspect(): only user/machine-level values; a workspace cannot choose the executable.
    const inspected = vscode.workspace.getConfiguration('refyntra').inspect<string>('hostPath');
    const setting = inspected?.globalValue;
    if (setting && setting.trim()) out.push({ source: 'setting', path: setting.trim() });
    out.push({ source: 'packaged', path: path.join(this.extensionPath, 'host', HOST_DLL) });
    out.push({ source: 'dev', path: path.resolve(this.extensionPath, '..', '..', DEV_HOST_RELATIVE) });
    return out;
  }

  description(): string | undefined {
    return this.lastDescription;
  }

  async resolve(): Promise<ProcessLaunch> {
    const candidates = this.candidates();
    for (const c of candidates) {
      if (!path.isAbsolute(c.path)) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(c.path);
      } catch {
        if (c.source === 'override' || c.source === 'setting') {
          throw new StartupError('HostNotFound', `The Refyntra host configured via ${c.source === 'setting' ? 'refyntra.hostPath' : 'REFYNTRA_HOST_PATH'} does not exist: ${c.path}`);
        }
        continue;
      }
      if (!stat.isFile()) continue;
      const launch: ProcessLaunch = c.path.toLowerCase().endsWith('.dll')
        ? { command: 'dotnet', args: [c.path], cwd: path.dirname(c.path), env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } }
        : { command: c.path, args: [], cwd: path.dirname(c.path), env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } };
      this.lastDescription = `${c.source}: ${launch.command === 'dotnet' ? `dotnet ${c.path}` : c.path}`;
      return launch;
    }
    this.lastDescription = undefined;
    throw new StartupError(
      'HostNotFound',
      `The Refyntra C# host was not found. Looked for: ${candidates.map((c) => c.path).join('; ')}. Build it with "pnpm build:host" or set refyntra.hostPath.`,
    );
  }
}
