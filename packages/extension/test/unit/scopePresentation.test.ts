import { describe, expect, it } from 'vitest';
import type { ScopeDetails } from '@refyntra/contracts';
import { scopeLines } from '../../src/scopePresentation';

// Completeness notes under the Related results: plain language, shown only when relevant, never hiding incompleteness.

const complete = (over: Partial<ScopeDetails> = {}): ScopeDetails => ({
  projectsTotal: 3, projectsComplete: 3, projectsPartial: 0, projectsFailed: 0,
  causes: { missingAssets: 0, missingPackages: 0, missingProjectReferences: 0, loadFailures: 0, otherErrors: 0 },
  restoreRecommended: false, solutionPath: 'C:/src/App.sln', frameworks: [], ...over,
});
const ASP = { id: 'aspnetcore', name: 'ASP.NET Core', evidence: 'Microsoft.AspNetCore.Routing, Version=6.0.0.0, PublicKeyToken=adb9793829ddae60', versionVerified: true };
const DI = { id: 'di', name: 'Microsoft.Extensions.DependencyInjection', evidence: 'Microsoft.Extensions.DependencyInjection.Abstractions, Version=6.0.0.0, PublicKeyToken=adb9793829ddae60', versionVerified: true };
const view = (scopeDetails: ScopeDetails | undefined, completeness: 'complete' | 'partial' | 'unknown' = 'complete', scopeNotes: string[] = [], additionalNotes: string[] = []) => ({ completeness, scopeNotes, scopeDetails, additionalNotes });

describe('scope lines of the Related view', () => {
  it('shows nothing when everything loaded completely (detected frameworks are evidence, not a note)', () => {
    expect(scopeLines(view(complete({ frameworks: [ASP, DI] }), 'complete', ['aspnetcore: x', 'di: y']), { trusted: true })).toEqual([]);
  });

  it('18 unrestored projects: one warning with the cause, Run dotnet restore and Show Health; no assembly identities in labels', () => {
    const d = complete({
      projectsTotal: 18, projectsComplete: 0, projectsPartial: 18,
      causes: { missingAssets: 18, missingPackages: 0, missingProjectReferences: 0, loadFailures: 0, otherErrors: 0 },
      restoreRecommended: true, frameworks: [ASP, DI],
    });
    const lines = scopeLines(view(d, 'partial', ['0 of 18 projects loaded completely', `aspnetcore: ${ASP.evidence}`, `di: ${DI.evidence}`]), { trusted: true });
    expect(lines.map((l) => l.text)).toEqual(['Results may be incomplete: 18 of 18 projects loaded only partially (NuGet packages not restored)', 'Run dotnet restore', 'Show Health']);
    expect(lines[0]!.icon).toBe('warning');
    expect(lines[1]!.command).toEqual({ command: 'refyntra.runRestore', title: 'Run dotnet restore', args: ['C:/src/App.sln'] });
    expect(lines[2]!.command?.command).toBe('refyntra.showHealth');
    for (const l of lines) expect(l.text).not.toMatch(/Version=|PublicKeyToken|aspnetcore:|di:/);
  });

  it('no restore item in an untrusted workspace or without a solution path; Show Health stays', () => {
    const d = complete({ projectsComplete: 1, projectsPartial: 2, causes: { missingAssets: 2, missingPackages: 0, missingProjectReferences: 0, loadFailures: 0, otherErrors: 0 }, restoreRecommended: true });
    expect(scopeLines(view(d, 'partial'), { trusted: false }).map((l) => l.text)).toEqual(['Results may be incomplete: 2 of 3 projects loaded only partially (NuGet packages not restored)', 'Show Health']);
    expect(scopeLines(view({ ...d, solutionPath: null }, 'partial'), { trusted: true }).map((l) => l.command?.command)).toEqual([undefined, 'refyntra.showHealth']);
  });

  it('summarizes mixed causes and failed projects', () => {
    const d = complete({
      projectsTotal: 5, projectsComplete: 1, projectsPartial: 2, projectsFailed: 2,
      causes: { missingAssets: 0, missingPackages: 1, missingProjectReferences: 1, loadFailures: 2, otherErrors: 0 },
    });
    const [first] = scopeLines(view(d, 'partial'), { trusted: true });
    expect(first!.text).toBe('Results may be incomplete: 4 of 5 projects not loaded completely (NuGet packages missing, referenced project not found, 2 projects failed to load)');
    expect(first!.tooltip).toMatch(/2 loaded partially, 2 not loaded/);
  });

  it('an unverified framework version: one short line, evidence only in the tooltip', () => {
    const med = { id: 'mediatr', name: 'MediatR', evidence: 'MediatR, Version=9.0.0.0', versionVerified: false };
    const lines = scopeLines(view(complete({ frameworks: [med, ASP] })), { trusted: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('MediatR: relations shown as likely (version not verified)');
    expect(lines[0]!.tooltip).toContain('MediatR, Version=9.0.0.0');
  });

  it('notes added by framework adapters are kept', () => {
    expect(scopeLines(view(complete(), 'complete', ['x'], ['Framework X: boom']), { trusted: true }).map((l) => l.text)).toEqual(['Framework X: boom']);
  });

  it('without scopeDetails (delegated route, older host) the notes are shown; incompleteness is never hidden', () => {
    const lines = scopeLines(view(undefined, 'unknown', ['TypeScript: delegated results; completeness unknown.']), { trusted: true });
    expect(lines.map((l) => l.text)).toEqual(['Results may be incomplete (search scope unknown)', 'TypeScript: delegated results; completeness unknown.']);
    // Partial completeness without details still warns.
    expect(scopeLines(view(complete(), 'partial'), { trusted: true })[0]!.icon).toBe('warning');
  });
});
