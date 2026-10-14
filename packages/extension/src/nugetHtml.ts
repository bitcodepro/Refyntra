// Manage NuGet Packages page (pure: no vscode). The extension keeps the state and renders the body here; the page
// script only posts the user's clicks and inputs (action + values) and swaps in the body it gets back. Strict CSP: its
// own nonce'd style and script, no images, no remote content (package icons are not loaded); VS Code theme variables.
import { formatDownloads, type SearchHit } from './nugetModel';
import type { ConsolidateRow } from './projectOpsModel';

export type NuGetTab = 'installed' | 'browse' | 'updates' | 'consolidate';

export interface InstalledRow {
  id: string;
  version: string;
  projects: string[];
  central: boolean;
  latest?: string;
  vulnerable?: string;
  deprecated?: string;
}

export interface NuGetPageState {
  title: string;
  /** Projects in scope (one for a project, all for the solution). */
  projects: string[];
  centralPackageManagement: boolean;
  tab: NuGetTab;
  installed: InstalledRow[];
  browse: { term: string; prerelease: boolean; hits: SearchHit[]; searched: boolean };
  updates: { checked: boolean; rows: InstalledRow[] };
  consolidate: ConsolidateRow[];
  /** Selected package (details pane): id, versions known, chosen version. */
  selected?: { id: string; versions: string[]; version?: string; installedVersion?: string; source?: string; description?: string };
  sources: string[];
  busy?: string;
  message?: { kind: 'info' | 'warning' | 'error'; text: string };
  /** Vulnerable / deprecated checks were run (on demand). */
  audit?: { vulnerable: boolean; deprecated: boolean };
}

const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function tabButton(id: NuGetTab, label: string, s: NuGetPageState, count?: number): string {
  const sel = s.tab === id;
  return `<button role="tab" id="tab-${id}" aria-selected="${sel}" aria-controls="panel" tabindex="${sel ? 0 : -1}" class="tab${sel ? ' sel' : ''}" data-action="tab" data-arg="${id}">${e(label)}${count !== undefined ? ` <span class="count">${count}</span>` : ''}</button>`;
}

function installedTable(rows: InstalledRow[], s: NuGetPageState, mode: 'installed' | 'updates'): string {
  if (!rows.length) return `<p class="empty">${mode === 'updates' ? (s.updates.checked ? 'Every package is up to date.' : 'Updates are not checked yet. Check for updates asks your NuGet sources (network).') : 'No packages are installed.'}</p>`;
  const multi = s.projects.length > 1;
  return `<table class="rows"><thead><tr><th scope="col">Package</th><th scope="col">Version</th>${mode === 'updates' ? '<th scope="col">Latest</th>' : ''}${multi ? '<th scope="col">Projects</th>' : ''}<th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows
    .map((r) => {
      const badges = [r.central ? '<span class="badge" title="Version in Directory.Packages.props">central</span>' : '', r.latest && mode === 'installed' ? `<span class="badge update" title="Update available">${e(r.latest)} available</span>` : '', r.vulnerable ? `<span class="badge warn" title="Known vulnerability">${e(r.vulnerable)}</span>` : '', r.deprecated ? `<span class="badge warn" title="Deprecated">deprecated${r.deprecated === 'deprecated' ? '' : `: ${e(r.deprecated)}`}</span>` : '']
        .filter(Boolean)
        .join(' ');
      const actions = [mode === 'updates' && r.latest ? `<button data-action="update" data-arg="${e(r.id)}" data-version="${e(r.latest)}">Update</button>` : '', `<button class="secondary" data-action="select" data-arg="${e(r.id)}">Details</button>`, mode === 'installed' ? `<button class="secondary" data-action="remove" data-arg="${e(r.id)}">Uninstall</button>` : ''].filter(Boolean).join(' ');
      return `<tr${s.selected?.id === r.id ? ' class="current"' : ''}><td><span class="id">${e(r.id)}</span> ${badges}</td><td>${e(r.version)}</td>${mode === 'updates' ? `<td>${e(r.latest ?? '')}</td>` : ''}${multi ? `<td>${e(r.projects.join(', '))}</td>` : ''}<td class="actions">${actions}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function browse(s: NuGetPageState): string {
  const b = s.browse;
  const form = `<form class="search" data-action="search"><label for="term">Search packages</label><input id="term" name="term" type="search" value="${e(b.term)}" placeholder="Package id or keyword" autocomplete="off"><label class="check"><input id="prerelease" name="prerelease" type="checkbox"${b.prerelease ? ' checked' : ''}> Include prerelease</label><button type="submit">Search</button></form>`;
  const note = `<p class="note">Searches ${s.sources.length ? e(s.sources.join(', ')) : 'your configured NuGet sources'} when you press Search.</p>`;
  if (!b.searched) return form + note;
  if (!b.hits.length) return `${form}${note}<p class="empty">No packages found.</p>`;
  return `${form}${note}<table class="rows"><thead><tr><th scope="col">Package</th><th scope="col">Latest</th><th scope="col">Downloads</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${b.hits
    .map((h) => {
      const installed = s.installed.find((r) => r.id.toLowerCase() === h.id.toLowerCase());
      return `<tr${s.selected?.id === h.id ? ' class="current"' : ''}><td><span class="id">${e(h.id)}</span>${h.verified ? ' <span class="badge" title="Verified owner">verified</span>' : ''}${installed ? ` <span class="badge">installed ${e(installed.version)}</span>` : ''}<div class="desc">${e(h.description.slice(0, 200))}</div></td><td>${e(h.version)}</td><td>${e(formatDownloads(h.totalDownloads))}</td><td class="actions"><button data-action="select" data-arg="${e(h.id)}">Details</button></td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function consolidateTable(s: NuGetPageState): string {
  if (s.projects.length < 2) return '<p class="empty">Consolidate compares versions across the projects of a solution; open Manage NuGet Packages on the solution.</p>';
  if (!s.consolidate.length) return '<p class="empty">Every package has one version across the projects.</p>';
  return `<table class="rows"><thead><tr><th scope="col">Package</th><th scope="col">Versions</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${s.consolidate
    .map((c) => `<tr><td><span class="id">${e(c.id)}</span></td><td>${c.versions.map((v) => `${e(v.version)} <span class="muted">(${e(v.projects.join(', '))})</span>`).join('<br>')}</td><td class="actions"><button data-action="consolidate" data-arg="${e(c.id)}" data-version="${e(c.versions[0]!.version)}">Use ${e(c.versions[0]!.version)} everywhere</button></td></tr>`)
    .join('')}</tbody></table>`;
}

function details(s: NuGetPageState): string {
  const d = s.selected;
  if (!d) return '';
  const versions = d.versions.length ? d.versions : d.version ? [d.version] : [];
  const options = versions.map((v) => `<option value="${e(v)}"${v === (d.version ?? versions[0]) ? ' selected' : ''}>${e(v)}${v === d.installedVersion ? ' (installed)' : ''}</option>`).join('');
  const install = d.installedVersion ? 'Update' : 'Install';
  return `<aside class="details" aria-label="Package details"><h2>${e(d.id)}</h2>${d.description ? `<p class="desc">${e(d.description)}</p>` : ''}${d.installedVersion ? `<p>Installed: ${e(d.installedVersion)}</p>` : ''}<div class="row"><label for="version">Version</label><select id="version" name="version">${options}</select><button class="secondary" data-action="versions" data-arg="${e(d.id)}" title="Ask the NuGet sources for every version (network)">Load versions</button></div><div class="row"><button data-action="install" data-arg="${e(d.id)}">${install}</button>${d.installedVersion ? `<button class="secondary" data-action="remove" data-arg="${e(d.id)}">Uninstall</button>` : ''}</div>${d.source ? `<p class="muted">Source: ${e(d.source)}</p>` : ''}</aside>`;
}

export function renderNuGetBody(s: NuGetPageState): string {
  const msg = s.message ? `<div class="msg ${s.message.kind}" role="${s.message.kind === 'error' ? 'alert' : 'status'}">${e(s.message.text)}</div>` : '';
  const busy = s.busy ? `<div class="busy" role="status" aria-live="polite">${e(s.busy)}</div>` : '';
  const updatesCount = s.updates.checked ? s.updates.rows.length : undefined;
  const tools =
    s.tab === 'installed' || s.tab === 'updates'
      ? `<div class="tools"><button class="secondary" data-action="checkUpdates">Check for updates</button><button class="secondary" data-action="checkVulnerable">Check vulnerable</button><button class="secondary" data-action="checkDeprecated">Check deprecated</button></div>`
      : '';
  const panel = s.tab === 'installed' ? installedTable(s.installed, s, 'installed') : s.tab === 'updates' ? installedTable(s.updates.rows, s, 'updates') : s.tab === 'browse' ? browse(s) : consolidateTable(s);
  return `<header><h1>${e(s.title)}</h1><p class="muted">${e(s.projects.length === 1 ? s.projects[0]! : `${s.projects.length} projects`)}${s.centralPackageManagement ? ' · Central Package Management (Directory.Packages.props)' : ''}</p></header>${msg}${busy}<div role="tablist" aria-label="NuGet">${tabButton('browse', 'Browse', s)}${tabButton('installed', 'Installed', s, s.installed.length)}${tabButton('updates', 'Updates', s, updatesCount)}${tabButton('consolidate', 'Consolidate', s, s.projects.length > 1 ? s.consolidate.length : undefined)}</div><div class="layout"><section id="panel" role="tabpanel" aria-labelledby="tab-${s.tab}">${tools}${panel}</section>${details(s)}</div>`;
}

const CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:12px 20px}
h1{font-size:1.3em;font-weight:600;margin:4px 0}h2{font-size:1.1em;margin:0 0 6px}
.muted,.note{color:var(--vscode-descriptionForeground)}.note{margin:4px 0 8px}
[role=tablist]{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border,transparent));margin:10px 0}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--vscode-foreground);padding:6px 10px;cursor:pointer;font:inherit}
.tab.sel{border-bottom-color:var(--vscode-focusBorder);font-weight:600}
.count{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px;padding:0 6px;font-size:.85em}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border,transparent);padding:3px 10px;cursor:pointer;font:inherit;border-radius:2px}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit}
.layout{display:flex;gap:16px;align-items:flex-start}#panel{flex:1;min-width:0}
.details{width:300px;border-left:1px solid var(--vscode-panel-border,var(--vscode-widget-border,transparent));padding-left:14px}
.details .row{display:flex;gap:6px;align-items:center;margin:8px 0}
table.rows{border-collapse:collapse;width:100%}table.rows th{text-align:left;font-weight:600;color:var(--vscode-descriptionForeground);padding:4px 6px}
table.rows td{padding:5px 6px;border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border,transparent));vertical-align:top}
tr.current td{background:var(--vscode-list-inactiveSelectionBackground)}
.id{font-weight:600}.desc{color:var(--vscode-descriptionForeground);margin-top:2px}.actions{white-space:nowrap;text-align:right}
.badge{display:inline-block;border:1px solid var(--vscode-contrastBorder,var(--vscode-badge-background));background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:3px;padding:0 4px;font-size:.85em}
.badge.update{background:var(--vscode-statusBarItem-prominentBackground,var(--vscode-badge-background))}
.badge.warn{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-foreground);border-color:var(--vscode-inputValidation-warningBorder)}
.search{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.search input[type=search]{min-width:260px}
.check{display:flex;gap:4px;align-items:center}.tools{display:flex;gap:6px;margin:0 0 8px}
.msg{padding:6px 10px;margin:8px 0;border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-textBlockQuote-background)}
.msg.warning{border-color:var(--vscode-editorWarning-foreground)}.msg.error{border-color:var(--vscode-errorForeground)}
.busy{color:var(--vscode-descriptionForeground);margin:6px 0}.empty{color:var(--vscode-descriptionForeground)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function values() {
  const v = {};
  for (const el of root.querySelectorAll('input,select')) v[el.name || el.id] = el.type === 'checkbox' ? el.checked : el.value;
  return v;
}
root.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-action]');
  if (!b || b.type === 'submit') return;
  ev.preventDefault();
  vscode.postMessage({ action: b.dataset.action, arg: b.dataset.arg || '', version: b.dataset.version || '', values: values() });
});
root.addEventListener('submit', (ev) => {
  ev.preventDefault();
  vscode.postMessage({ action: ev.target.dataset.action || 'search', arg: '', version: '', values: values() });
});
root.addEventListener('keydown', (ev) => {
  const t = ev.target.closest('[role=tab]');
  if (!t || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return;
  const tabs = [...root.querySelectorAll('[role=tab]')];
  const i = (tabs.indexOf(t) + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  tabs[i].focus();
  vscode.postMessage({ action: 'tab', arg: tabs[i].dataset.arg, version: '', values: values() });
});
window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.type !== 'body') return;
  const focused = document.activeElement && document.activeElement.id;
  root.innerHTML = ev.data.html;
  const again = focused && document.getElementById(focused);
  if (again) again.focus();
});
`;

export function renderNuGetHtml(body: string, opts: { nonce: string; title: string }): string {
  const csp = `default-src 'none'; style-src 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}';`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(opts.title)}</title><style nonce="${opts.nonce}">${CSS}</style></head><body><main id="root">${body}</main><script nonce="${opts.nonce}">${SCRIPT}</script></body></html>`;
}
