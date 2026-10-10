import { describe, expect, it } from 'vitest';
import type { HealthSummary } from '@refyntra/domain';
import { LogRing, buildDebugBundle, pathVariants, redactNames, redactPaths, renderDebugBundle, type DebugBundleInput } from '../../src/debugBundleModel';

const HOME = 'C:\\Users\\Jürgen Doe';
const WS = 'D:\\Code\\My Shop ü';

function health(): HealthSummary {
  return {
    workspaceTrusted: true,
    adapters: [
      {
        adapterId: 'csharp',
        providerRouteId: 'csharp.roslyn',
        displayName: 'C#',
        state: 'Partial',
        reasonCode: 'ProjectsFailed',
        message: `1 project failed to load: ${WS}\\AcmeBilling.Api\\AcmeBilling.Api.csproj`,
        recoveryActions: [{ command: 'refyntra.runRestore', title: 'Run dotnet restore', args: [`${WS}\\AcmeShop.sln`] }],
        sdk: { version: '10.0.100', path: 'C:\\Program Files\\dotnet\\sdk\\10.0.100' },
        solutionPath: `${WS}\\AcmeShop.sln`,
        projects: [
          { projectContextId: 'p1', name: 'AcmeBilling.Api', projectPath: `${WS}\\AcmeBilling.Api\\AcmeBilling.Api.csproj`, targetFramework: 'net10.0', state: 'failed', documentCount: 0, diagnostics: [{ severity: 'error', message: `Assets file '${WS}\\AcmeBilling.Api\\obj\\project.assets.json' not found` }] },
          { projectContextId: 'p2', name: 'AcmeBilling', projectPath: `${WS}\\AcmeBilling\\AcmeBilling.csproj`, targetFramework: 'net10.0', state: 'loaded', documentCount: 12, diagnostics: [] },
        ],
        diagnostics: [],
        restartCount: 2,
        hostDescription: `packaged: dotnet ${HOME}\\.vscode\\extensions\\refyntra.refyntra-0.1.0\\host\\Refyntra.Host.dll`,
        backend: { engineVersion: '0.1.0', protocol: '1.1' },
        lastLoadDurationMs: 4200,
      },
    ],
  } as HealthSummary;
}

function input(over: Partial<DebugBundleInput> = {}): DebugBundleInput {
  return {
    generatedAt: '2026-10-09T12:00:00.000Z',
    extensionVersion: '0.1.0',
    vscodeVersion: '1.90.2',
    os: { platform: 'win32', release: '10.0.26300', arch: 'x64' },
    health: health(),
    logLines: [
      '2026-10-09T11:00:00.000Z [info] [extension] activating version=0.1.0 trusted=true',
      `2026-10-09T11:00:01.000Z [info] [host:stderr] warning CS1234 at ${WS}\\AcmeBilling\\Secret.cs: var password = "hunter2";`,
      `2026-10-09T11:00:02.000Z [debug] [adapter:csharp.roslyn] related traceId=t1 epoch=e snapshot=s durationMs=40 status=ok`,
      `2026-10-09T11:00:03.000Z [debug] [adapter:csharp.roslyn] related traceId=t2 epoch=e snapshot=s durationMs=60 status=ok`,
      `2026-10-09T11:00:04.000Z [warn] [adapter:csharp.roslyn] open failed uri=file:///d%3A/Code/My%20Shop%20%C3%BC/AcmeBilling/Orders.cs error="${WS.replace(/\\/g, '\\\\')}\\\\AcmeBilling\\\\Orders.cs locked"`,
      `2026-10-09T11:00:05.000Z [info] [extension] didChange text=[redacted] path=${HOME}/AppData/Local/Temp/x`,
    ],
    homeDir: HOME,
    workspaceRoots: [WS],
    ...over,
  };
}

const SENSITIVE = [/Jürgen/i, /My Shop/i, /My%20Shop/i, /hunter2/, /Secret\.cs/];

describe('debug bundle redaction', () => {
  it('path variants cover native, forward-slash, JSON-escaped and file-URI spellings', () => {
    const v = pathVariants(WS);
    expect(v).toContain('D:\\Code\\My Shop ü');
    expect(v).toContain('D:/Code/My Shop ü');
    expect(v).toContain('D:\\\\Code\\\\My Shop ü');
    expect(v).toContain('file:///D%3A/Code/My%20Shop%20%C3%BC');
  });

  it('replaces home and workspace roots in every spelling, case-insensitively, workspace before home', () => {
    const ph = [{ root: HOME, placeholder: '<home>' }, { root: `${HOME}\\src\\ws`, placeholder: '<workspace>' }];
    expect(redactPaths(`a ${HOME}\\src\\ws\\x.cs b ${HOME.toLowerCase()}\\.nuget c file:///c%3A/Users/J%C3%BCrgen%20Doe/x`, ph)).toBe('a <workspace>\\x.cs b <home>\\.nuget c <home>/x');
    // A sibling folder that merely starts with the same characters is not a match.
    expect(redactPaths(`${HOME}2\\x`, ph)).toBe(`${HOME}2\\x`);
  });

  it('replaces whole project names only', () => {
    const names = new Map([['AcmeBilling', 'project-2'], ['AcmeBilling.Api', 'project-1']]);
    expect(redactNames('AcmeBilling.Api and AcmeBilling but not AcmeBillingX', names)).toBe('project-1 and project-2 but not AcmeBillingX');
  });

  it('by default the bundle has no home/workspace path, no project or solution name, no source text', () => {
    const text = renderDebugBundle(buildDebugBundle(input(), { includeProjectNames: false }));
    for (const re of SENSITIVE) expect(text, String(re)).not.toMatch(re);
    expect(text).not.toMatch(/Acme/);
    expect(text).toContain('<workspace>');
    expect(text).toContain('<home>');
    expect(text).toContain('project-1');
    expect(text).toContain('solution-1');
    expect(text).toContain('C:\\\\Program Files\\\\dotnet\\\\sdk\\\\10.0.100'); // SDK location is not user data
  });

  it('keeps project names only when the user opts in; paths stay redacted', () => {
    const text = renderDebugBundle(buildDebugBundle(input(), { includeProjectNames: true }));
    expect(text).toContain('AcmeBilling.Api');
    for (const re of SENSITIVE) expect(text, String(re)).not.toMatch(re);
  });

  it('versions, protocol, OS, SDK, restart count and timings are present', () => {
    const b = buildDebugBundle(input(), { includeProjectNames: false });
    expect(b.versions).toEqual({ extension: '0.1.0', vscode: '1.90.2', backends: [{ adapter: 'csharp', engineVersion: '0.1.0', protocol: '1.1' }] });
    expect(b.os.platform).toBe('win32');
    expect(b.adapters[0]).toMatchObject({ state: 'Partial', restartCount: 2, lastLoadDurationMs: 4200, sdk: { version: '10.0.100' } });
    expect(b.timings).toEqual([{ component: 'adapter:csharp.roslyn', operation: 'related', count: 2, maxMs: 60, avgMs: 50 }]);
  });

  it('drops unstructured host output and keeps only the last N log lines', () => {
    const b = buildDebugBundle(input(), { includeProjectNames: false, maxLogLines: 2 });
    expect(b.log.omittedUnstructured).toBe(1);
    expect(b.log.lines).toHaveLength(2);
    expect(b.log.lines.join('\n')).not.toMatch(/host:stderr|hunter2/);
    expect(b.log.lines[1]).toContain('text=[redacted]');
  });

  it('contains no environment values', () => {
    process.env.REFYNTRA_BUNDLE_PROBE = 'probe-value-1f2e3d';
    try {
      const text = renderDebugBundle(buildDebugBundle(input(), { includeProjectNames: true }));
      expect(text).not.toContain('probe-value-1f2e3d');
      expect(text).not.toMatch(/"env"|"environment"/i);
    } finally {
      delete process.env.REFYNTRA_BUNDLE_PROBE;
    }
  });

  it('LogRing keeps the newest lines', () => {
    const r = new LogRing(3);
    for (let i = 0; i < 5; i++) r.push(String(i));
    expect(r.snapshot()).toEqual(['2', '3', '4']);
  });
});
