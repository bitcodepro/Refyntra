import { type HealthSummary, formatAdapterHealth, projectCounts } from '@refyntra/domain';
import { dotnetDebugFeaturesText } from './debugExtrasModel';
import { type DebugHealth, buildHealthPage, renderHealthPageText } from './healthPageModel';
import { reasonPhrase } from './terminology';

// Markdown version of the Health page (pure): "Refyntra: Show Health (text)", "Copy as text" and the fallback. The
// plain summary comes first, then every technical detail.

function esc(s: string): string {
  return s.replace(/[|\\`*_[\]<>]/g, (c) => `\\${c}`);
}

export function renderHealth(h: HealthSummary, extra: { solution?: string | undefined; debug?: DebugHealth | undefined }): string {
  const summary = renderHealthPageText(buildHealthPage({ health: h, debug: extra.debug })).split(/\r?\n/).slice(2, -2);
  const out: string[] = ['# Refyntra health', '', '```text', ...summary, '```', '', '## Technical details (for troubleshooting)', ''];
  if (!h.workspaceTrusted) {
    out.push(
      '> **Restricted Mode.** Refyntra only lists solution files and shows this page. It does not start the C# host and does not run MSBuild evaluation, restore, build, source generators or analyzers. Trust the workspace (command *Workspaces: Manage Workspace Trust*) to enable Find, Related, Actions and Rename.',
      '',
    );
  }
  out.push(`- Workspace trusted: ${h.workspaceTrusted ? 'yes' : 'no'}`, `- Selected solution: ${extra.solution ? esc(extra.solution) : '(automatic)'}`, '- Telemetry: none (Refyntra never sends data)', '');
  for (const a of h.adapters) {
    out.push(`### ${esc(formatAdapterHealth(a))}`, '');
    if (a.reasonCode) {
      const phrase = reasonPhrase(a.reasonCode);
      out.push(`- Reason: ${phrase ? `${phrase} ` : ''}(\`${a.reasonCode}\`)`);
    }
    if (a.message) out.push(`- ${esc(a.message)}`);
    if (a.recoveryHint) out.push(`- ${esc(a.recoveryHint)}`);
    for (const r of a.recoveryActions) out.push(`- Recovery: ${esc(r.title)} (\`${r.command}\`)`);
    out.push(`- Route: \`${a.providerRouteId}\``);
    if (a.hostDescription) out.push(`- Host: ${esc(a.hostDescription)}`);
    if (a.sessionEpoch) out.push(`- Session epoch: \`${a.sessionEpoch}\``);
    out.push(`- Restarts: ${a.restartCount}`);
    if (a.sdk) out.push(`- .NET SDK: ${a.sdk.version ? esc(a.sdk.version) : 'unknown'}${a.sdk.path ? ` (${esc(a.sdk.path)})` : ''}`);
    if (a.solutionPath) out.push(`- Loaded: ${esc(a.solutionPath)}`);
    const { loaded, total } = projectCounts(a);
    if (total > 0) {
      out.push('', `### Projects (${loaded}/${total} loaded)`, '', '| Project | TFM | State | Documents | Diagnostics |', '|---|---|---|---|---|');
      for (const p of a.projects) out.push(`| ${esc(p.name)} | ${esc(p.targetFramework ?? '?')} | ${p.state} | ${p.documentCount} | ${p.diagnostics.length} |`);
    }
    const diags = [...a.diagnostics, ...a.projects.flatMap((p) => p.diagnostics)];
    if (diags.length) {
      out.push('', '#### Load diagnostics', '');
      for (const d of diags.slice(0, 50)) {
        const rec = (d.recoveryActions ?? []).map((r) => ` — Recovery: ${esc(r.title)} (\`${r.command}\`)`).join('');
        out.push(`- ${d.severity}: ${esc(d.message)}${d.projectPath ? ` (${esc(d.projectPath)})` : ''}${rec}`);
      }
      if (diags.length > 50) out.push(`- … ${diags.length - 50} more`);
    }
    out.push('');
  }
  if (extra.debug) {
    const d = extra.debug;
    out.push(
      '### Run and debug',
      '',
      `- netcoredbg: ${d.netcoredbg.path ? `${esc(d.netcoredbg.version ?? 'bundled')} (${esc(d.netcoredbg.path)})` : `not available (${esc(d.netcoredbg.reason ?? '')})`}`,
      `- debugpy: ${d.debugpy.path ? esc(d.debugpy.version ?? 'bundled') : 'missing'}`,
      `- Python interpreter: ${d.python ? esc(d.python) : 'not found'}`,
      `- dotnet: ${d.dotnet ? esc(d.dotnet) : 'not found on PATH'}`,
      `- cargo: ${d.cargo ? esc(d.cargo) : 'not found'}`,
      `- lldb-dap (Rust debugging): ${d.lldbDap ? esc(d.lldbDap) : 'not found'}`,
      ...(d.tests ? [`- Tests: ${esc(d.tests)}`] : []),
      ...(d.decompiler ? [`- Decompiled sources: ${esc(d.decompiler)}`] : []),
      ...(d.efTools ? [`- EF Core: ${esc(d.efTools)}`] : []),
      ...(d.netcoredbg.path ? [`- ${esc(dotnetDebugFeaturesText())}`] : []),
      '',
    );
  }
  return out.join('\n');
}

