import type { HealthSummary } from '@refyntra/domain';
import { projectCounts } from '@refyntra/domain';
import { type HealthAction, type HealthPageModel, type StatusIcon } from './healthPageModel';
import { describeReason } from './terminology';

// HTML of the Health webview (pure). Every value is escaped; there is no inline script or style attribute handler:
// buttons carry only data-key (looked up in the extension's own model), and the page script (nonce) posts that key.

/**
 * Status icons of the page as inline SVG (16x16, filled with the theme color of the state). Emoji glyphs depend on an
 * emoji font: on a Linux desktop without one they render as empty boxes. The text export keeps the glyphs.
 */
export const ICON_SVG: Record<StatusIcon, string> = {
  ok: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.1 4.3L7 9.4 4.9 7.3l-.9.9 3 3 5-5z"/></svg>',
  warning: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.5 15.5 14.5h-15zM7.3 6v4.2h1.4V6zm0 5.3v1.4h1.4v-1.4z"/></svg>',
  error: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zM5.5 4.6l-.9.9L7.1 8l-2.5 2.5.9.9L8 8.9l2.5 2.5.9-.9L8.9 8l2.5-2.5-.9-.9L8 7.1z"/></svg>',
  locked: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.5a3.5 3.5 0 0 1 3.5 3.5V7H13v7.5H3V7h1.5V5A3.5 3.5 0 0 1 8 1.5zM8 3a2 2 0 0 0-2 2v2h4V5a2 2 0 0 0-2-2z"/></svg>',
  loading: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 1.5h9V3h-1v2.2L9.2 8l2.3 2.8V13h1v1.5h-9V13h1v-2.2L6.8 8 4.5 5.2V3h-1zM6 3v1.7L8 7.2l2-2.5V3z"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.7 6v5h1.4V7zm0-2.8v1.4h1.4V4.2z"/></svg>',
};

function iconSpan(icon: StatusIcon): string {
  return `<span class="icon ${icon}" aria-hidden="true">${ICON_SVG[icon]}</span>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}
const e = escapeHtml;

/**
 * A real <button> whose name is its visible label. The hint is a tooltip for the mouse (title) and, for screen readers,
 * the accessible description (a visually hidden element referenced by aria-describedby), so keyboard users get it too.
 */
function button(a: HealthAction, primary: boolean): string {
  const hint = a.hint ? `<span id="hint-${e(a.key)}" class="sr-only">${e(a.hint)}</span>` : '';
  return `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-key="${e(a.key)}"${a.hint ? ` title="${e(a.hint)}" aria-describedby="hint-${e(a.key)}"` : ''}>${e(a.label)}</button>${hint}`;
}

/**
 * What the polite live region says after an update: the status headline of every language and the restore banner.
 * Only these words, and only when they changed (the page script compares), so a project count ticking up while a
 * solution loads does not speak for every health event.
 */
export function healthAnnouncement(m: HealthPageModel): string {
  return [...(m.restoreBanner ? [m.restoreBanner.text] : []), ...m.sections.map((s) => s.headline)].join('. ');
}

/** Stable id for a <details> so its open state survives a live update. */
const did = (...parts: string[]) => e(parts.join('/'));

export function renderHealthBody(m: HealthPageModel, h: HealthSummary, extra: { solution?: string | undefined }): string {
  const out: string[] = ['<h1 id="page-title" tabindex="-1">Refyntra Health</h1>'];
  if (m.restoreBanner) {
    const b = m.restoreBanner;
    out.push(`<div class="banner ${b.icon}">${iconSpan(b.icon)} <span>${e(b.text)}</span>${b.action ? ` ${button(b.action, false)}` : ''}</div>`);
  }
  for (const s of m.sections) {
    out.push(`<section class="lang ${s.icon}" aria-labelledby="h-${e(s.adapterId)}">`);
    out.push(`<h2 id="h-${e(s.adapterId)}" class="${s.icon}">${iconSpan(s.icon)} ${e(s.headline)}</h2>`);
    if (s.meaning) out.push(`<p class="meaning">${e(s.meaning)}</p>`);
    if (s.primary || s.more.length) out.push(`<div class="actions">${s.primary ? button(s.primary, true) : ''}${s.more.map((a) => button(a, false)).join('')}</div>`);
    if (s.groups.length) {
      out.push('<h3>Projects</h3>', '<ul class="groups">');
      for (const g of s.groups) {
        out.push(`<li class="group ${e(g.kind)}"><details data-id="${did(s.adapterId, g.kind)}"><summary><strong>${e(g.title)}:</strong> ${e(g.summary)}</summary><ul class="projects">`);
        for (const p of g.projects) {
          if (!p.problems.length) {
            out.push(`<li><span class="pname">${e(p.name)}</span> <span class="muted">— loaded</span></li>`);
            continue;
          }
          out.push(`<li><details data-id="${did(s.adapterId, g.kind, p.path)}"><summary><span class="pname">${e(p.name)}</span> — ${e(p.problems.map((x) => x.text).join('; '))}</summary>`);
          out.push(`<p class="muted path">${e(p.path)}</p>`);
          for (const pr of p.problems) {
            if (!pr.raw.length) continue;
            out.push(`<details class="raw" data-id="${did(s.adapterId, g.kind, p.path, pr.cause)}"><summary>Show MSBuild message${pr.raw.length > 1 ? `s (${pr.raw.length})` : ''}</summary><ul>${pr.raw.map((r) => `<li><code>${e(r)}</code></li>`).join('')}</ul></details>`);
          }
          out.push('</details></li>');
        }
        out.push('</ul></details></li>');
      }
      out.push('</ul>');
    }
    out.push('</section>');
  }
  out.push(`<div class="actions secondary-row" role="group" aria-label="More actions">${m.secondary.map((a) => button(a, false)).join('')}</div>`);
  // The heading is outside the <summary> so it stays a heading for screen-reader navigation and the disclosure stays a plain button.
  out.push(`<h2 id="technical-title" class="technical-title">Technical details (for troubleshooting)</h2><details class="technical" data-id="technical"><summary>Show technical details</summary>${technical(h, extra)}</details>`);
  return out.join('\n');
}

function technical(h: HealthSummary, extra: { solution?: string | undefined }): string {
  const row = (k: string, v: string) => `<tr><th scope="row">${e(k)}</th><td>${e(v)}</td></tr>`;
  const out: string[] = ['<table class="kv"><caption class="sr-only">Workspace</caption><tbody>', row('Workspace trusted', h.workspaceTrusted ? 'yes' : 'no'), row('Selected solution', extra.solution ?? '(automatic)'), row('Telemetry', 'none (Refyntra never sends data)'), '</tbody></table>'];
  for (const a of h.adapters) {
    const { loaded, total } = projectCounts(a);
    out.push(`<h3>${e(a.displayName)} (${e(a.adapterId)})</h3><table class="kv"><caption class="sr-only">${e(a.displayName)} backend details</caption><tbody>`);
    out.push(row('State', a.state));
    if (a.reasonCode) out.push(row('Reason', describeReason(a.reasonCode)));
    if (a.message) out.push(row('Message', a.message));
    if (a.recoveryHint) out.push(row('Recovery', a.recoveryHint));
    for (const r of a.recoveryActions) out.push(row('Recovery action', `${r.title} (${r.command}${r.args?.length ? ` ${r.args.map(String).join(' ')}` : ''})`));
    out.push(row('Route', a.providerRouteId));
    if (a.hostDescription) out.push(row('Host', a.hostDescription));
    if (a.backend) out.push(row('Backend', `${a.backend.engineVersion ?? '?'} (protocol ${a.backend.protocol})`));
    if (a.sessionEpoch) out.push(row('Session epoch', a.sessionEpoch));
    out.push(row('Restarts', String(a.restartCount)));
    if (a.lastLoadDurationMs !== undefined) out.push(row('Last load', `${a.lastLoadDurationMs} ms`));
    if (a.sdk) out.push(row('.NET SDK', `${a.sdk.version ?? 'unknown'}${a.sdk.path ? ` (${a.sdk.path})` : ''}`));
    if (a.solutionPath) out.push(row('Loaded', a.solutionPath));
    out.push('</tbody></table>');
    if (total > 0) {
      out.push(`<h4>Projects (${loaded}/${total} loaded)</h4><div class="table-wrap" role="region" tabindex="0" aria-label="${e(a.displayName)} projects table"><table class="grid"><caption class="sr-only">${e(a.displayName)} projects</caption><thead><tr><th scope="col">Project</th><th scope="col">TFM</th><th scope="col">State</th><th scope="col">Documents</th><th scope="col">Diagnostics</th></tr></thead><tbody>`);
      for (const p of a.projects) out.push(`<tr><td>${e(p.name)}</td><td>${e(p.targetFramework ?? '?')}</td><td>${e(p.state)}</td><td>${p.documentCount}</td><td>${p.diagnostics.length}</td></tr>`);
      out.push('</tbody></table></div>');
    }
    const diags = [...a.diagnostics, ...a.projects.flatMap((p) => p.diagnostics)];
    if (diags.length) {
      out.push('<h4>Load diagnostics</h4><ul class="diags">');
      for (const d of diags) out.push(`<li><code>${e(`${d.severity}${d.cause ? ` [${d.cause}]` : ''}: ${d.message}${d.projectPath ? ` (${d.projectPath})` : ''}`)}</code></li>`);
      out.push('</ul>');
    }
  }
  return out.join('');
}

export const HEALTH_CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 20px 24px;max-width:960px;line-height:1.45;overflow-wrap:anywhere}
h1{font-size:1.5em;font-weight:600;margin:16px 0 8px}
h2{font-size:1.25em;font-weight:600;margin:20px 0 4px}
h2.technical-title{font-size:1.05em;margin:24px 0 4px}
h3{font-size:1.05em;margin:14px 0 4px}
h4{margin:12px 0 4px}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.icon{display:inline-block;min-width:1.4em}
.icon svg{fill:currentColor;vertical-align:-2px}
.icon.ok{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}
.icon.warning{color:var(--vscode-editorWarning-foreground,var(--vscode-foreground))}
.icon.error{color:var(--vscode-errorForeground)}
.icon.info,.icon.locked,.icon.loading{color:var(--vscode-descriptionForeground)}
.meaning{margin:4px 0 10px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
button{font-family:inherit;font-size:inherit;min-height:24px;padding:5px 12px;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
h1:focus{outline:none}
.banner{padding:8px 12px;margin:8px 0;border-left:3px solid var(--vscode-textLink-foreground);background:var(--vscode-textBlockQuote-background);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.banner.error{border-left-color:var(--vscode-errorForeground)}
.banner.ok{border-left-color:var(--vscode-testing-iconPassed,var(--vscode-textLink-foreground))}
ul.groups,ul.projects{list-style:none;padding-left:0;margin:4px 0}
ul.projects{padding-left:18px}
li.group{margin:4px 0}
summary{cursor:pointer;padding:2px 0;min-height:24px}
.pname{font-weight:600}
.muted{color:var(--vscode-descriptionForeground)}
.path{margin:2px 0 4px 18px;word-break:break-all}
details.raw{margin-left:18px}
code{font-family:var(--vscode-editor-font-family);font-size:0.95em;white-space:pre-wrap;word-break:break-word}
details.technical{margin-top:4px;border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding-top:8px}
table{border-collapse:collapse;margin:4px 0}
th,td{text-align:left;padding:2px 10px 2px 0;vertical-align:top}
.table-wrap{overflow-x:auto;max-width:100%}
table.grid th,table.grid td{border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding:2px 10px}
table.kv th{font-weight:normal;color:var(--vscode-descriptionForeground);white-space:nowrap}
td{word-break:break-all}
body.vscode-high-contrast .banner,body.vscode-high-contrast-light .banner{border:1px solid var(--vscode-contrastBorder);border-left-width:6px;background:transparent}
body.vscode-high-contrast button,body.vscode-high-contrast-light button{border:1px solid var(--vscode-contrastBorder,var(--vscode-button-border,currentColor))}
body.vscode-high-contrast :focus-visible,body.vscode-high-contrast-light :focus-visible{outline:2px solid var(--vscode-contrastActiveBorder,var(--vscode-focusBorder));outline-offset:2px}
body.vscode-high-contrast details.technical,body.vscode-high-contrast-light details.technical,body.vscode-high-contrast table.grid th,body.vscode-high-contrast-light table.grid th,body.vscode-high-contrast table.grid td,body.vscode-high-contrast-light table.grid td{border-color:var(--vscode-contrastBorder)}
@media (forced-colors:active){button{border:1px solid ButtonText}.banner{border:1px solid CanvasText}:focus-visible{outline:2px solid Highlight}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

/**
 * Page script: posts the data-key of a clicked button; keeps <details> open state and keyboard focus across updates;
 * speaks status changes through the polite live region (only when the announcement text changed). No eval, no HTML
 * from anywhere but the extension.
 */
export const HEALTH_SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const live = document.getElementById('live');
let lastAnnounce = root.getAttribute('data-announce') || '';
const title = document.getElementById('page-title');
if (title) title.focus();
root.addEventListener('click', (ev) => {
  const b = ev.target instanceof Element ? ev.target.closest('button[data-key]') : null;
  if (b) vscode.postMessage({ type: 'action', key: b.getAttribute('data-key') });
});
function focusToken(el) {
  if (!el || !root.contains(el)) return null;
  if (el.hasAttribute('data-key')) return { kind: 'button', id: el.getAttribute('data-key') };
  const d = el.tagName === 'SUMMARY' ? el.parentElement : null;
  if (d && d.getAttribute('data-id')) return { kind: 'summary', id: d.getAttribute('data-id') };
  if (el.classList.contains('table-wrap')) return { kind: 'table', id: el.getAttribute('aria-label') };
  return { kind: 'other' };
}
function restoreFocus(t) {
  if (!t) return;
  let f = null;
  if (t.kind === 'button') f = root.querySelector('button[data-key="' + CSS.escape(t.id) + '"]');
  else if (t.kind === 'summary') { const d = root.querySelector('details[data-id="' + CSS.escape(t.id) + '"]'); f = d && d.querySelector(':scope > summary'); }
  else if (t.kind === 'table') f = root.querySelector('.table-wrap[aria-label="' + CSS.escape(t.id) + '"]');
  // The focused control is gone (for example the Restore button while it runs): focus the page title, never lose focus to <body>.
  (f || document.getElementById('page-title') || root).focus();
}
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.type !== 'update' || typeof m.html !== 'string') return;
  const open = new Set([...root.querySelectorAll('details[open]')].map((d) => d.getAttribute('data-id')));
  const token = focusToken(document.activeElement);
  root.innerHTML = m.html;
  for (const d of root.querySelectorAll('details[data-id]')) if (open.has(d.getAttribute('data-id'))) d.open = true;
  restoreFocus(token);
  if (typeof m.announce === 'string' && m.announce !== lastAnnounce) {
    lastAnnounce = m.announce;
    live.textContent = '';
    setTimeout(() => { live.textContent = m.announce; }, 50);
  }
});
`;

export function renderHealthHtml(body: string, opts: { nonce: string; cspSource: string; announce?: string }): string {
  const csp = `default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}';`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Refyntra Health</title><style nonce="${opts.nonce}">${HEALTH_CSS}</style></head><body><div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div><main id="root" data-announce="${e(opts.announce ?? '')}">${body}</main><script nonce="${opts.nonce}">${HEALTH_SCRIPT}</script></body></html>`;
}
