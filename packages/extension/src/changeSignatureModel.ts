import type { SignatureInfo } from '@refyntra/contracts';
import { type SignatureRow, addRow, identifierProblem, isUnchanged, moveRow, removeRow, removedNames, rowDescription, rowsProblem, signatureText } from './codeRefactorSummary';
import { escapeHtml } from './healthPageHtml';

// The Change Signature dialog (webview): state lives in the extension; the page sends small messages and renders the
// view model it gets back. Pure: unit-tested with vitest (no vscode).

export type SignatureMessage =
  | { type: 'edit'; index: number; field: 'name' | 'type' | 'defaultValue' | 'callSiteValue'; value: string }
  | { type: 'move'; index: number; delta: -1 | 1 }
  | { type: 'moveTo'; from: number; to: number }
  | { type: 'remove'; index: number }
  | { type: 'add' }
  | { type: 'submit' }
  | { type: 'cancel' }
  | { type: 'ready' };

const MAX_FIELD = 500;

/** Validates an untrusted message from the page; anything malformed is undefined (ignored). */
export function parseSignatureMessage(m: unknown, rowCount: number): SignatureMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const x = m as Record<string, unknown>;
  const idx = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < rowCount;
  switch (x.type) {
    case 'edit':
      if (!idx(x.index) || typeof x.value !== 'string' || x.value.length > MAX_FIELD) return undefined;
      if (x.field !== 'name' && x.field !== 'type' && x.field !== 'defaultValue' && x.field !== 'callSiteValue') return undefined;
      return { type: 'edit', index: x.index as number, field: x.field, value: x.value };
    case 'move':
      return idx(x.index) && (x.delta === -1 || x.delta === 1) ? { type: 'move', index: x.index as number, delta: x.delta } : undefined;
    case 'moveTo':
      return idx(x.from) && idx(x.to) ? { type: 'moveTo', from: x.from as number, to: x.to as number } : undefined;
    case 'remove':
      return idx(x.index) ? { type: 'remove', index: x.index as number } : undefined;
    case 'add':
    case 'submit':
    case 'cancel':
    case 'ready':
      return { type: x.type };
    default:
      return undefined;
  }
}

/** A params array must stay last: a move that would put another parameter after it is refused (rows unchanged). */
function paramsLast(rows: readonly SignatureRow[]): boolean {
  const i = rows.findIndex((r) => /\bparams\b/.test(r.modifiers));
  return i < 0 || i === rows.length - 1;
}

/** Applies one editing message. Existing parameters keep their type and default (only name and position change). */
export function reduceSignature(rows: readonly SignatureRow[], msg: SignatureMessage): SignatureRow[] {
  switch (msg.type) {
    case 'edit': {
      const r = rows[msg.index];
      if (!r) return [...rows];
      if (msg.field !== 'name' && r.from !== undefined) return [...rows];
      const value = msg.field === 'name' || msg.field === 'type' ? msg.value.trim() : msg.value;
      return rows.map((x, i) => {
        if (i !== msg.index) return x;
        const next: SignatureRow = { ...x, [msg.field]: value };
        if ((msg.field === 'defaultValue' || msg.field === 'callSiteValue') && !value.trim()) delete next[msg.field];
        return next;
      });
    }
    case 'move': {
      const next = moveRow(rows, msg.index, msg.delta);
      return paramsLast(next) ? next : [...rows];
    }
    case 'moveTo': {
      if (msg.from === msg.to) return [...rows];
      const next = [...rows];
      const [item] = next.splice(msg.from, 1);
      next.splice(msg.to, 0, item!);
      return paramsLast(next) ? next : [...rows];
    }
    case 'remove':
      return removeRow(rows, msg.index);
    case 'add': {
      let n = 1;
      while (rows.some((r) => r.name === `value${n}`)) n++;
      return addRow(rows, { name: `value${n}`, type: 'int', callSiteValue: '0' });
    }
    default:
      return [...rows];
  }
}

export interface SignatureRowView {
  index: number;
  isNew: boolean;
  name: string;
  type: string;
  modifiers: string;
  defaultValue: string;
  callSiteValue: string;
  /** What happens to it ("renamed from x", "new · call sites get 0"). */
  status: string;
  /** Problem of this row's name, or of a new row's missing value. */
  problem?: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export interface SignatureView {
  methodName: string;
  /** The new signature, e.g. "Greet(int times, string name)". */
  preview: string;
  rows: SignatureRowView[];
  removed: string[];
  /** Blocks "Preview changes"; undefined = ready. */
  problem?: string;
  /** "Affects 3 call sites" (from Related; undefined while unknown). */
  callSites?: string;
}

export function signatureView(info: SignatureInfo, rows: readonly SignatureRow[], callSites?: { count: number; more?: boolean }): SignatureView {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
  const view = rows.map((r, index): SignatureRowView => {
    const isNew = r.from === undefined;
    const problem = identifierProblem(r.name) ?? ((seen.get(r.name) ?? 0) > 1 ? `Two parameters are named ${r.name}.` : undefined) ?? (isNew && !r.type.trim() ? 'Enter a type.' : undefined) ?? (isNew && !r.callSiteValue && !r.defaultValue ? 'Needs a value at call sites or a default value.' : undefined);
    const moved = moveRow(rows, index, -1);
    const movedDown = moveRow(rows, index, 1);
    return {
      index,
      isNew,
      name: r.name,
      type: r.type,
      modifiers: r.modifiers,
      defaultValue: r.defaultValue ?? '',
      callSiteValue: r.callSiteValue ?? '',
      status: rowDescription(r, info),
      ...(problem ? { problem } : {}),
      canMoveUp: index > 0 && paramsLast(moved),
      canMoveDown: index < rows.length - 1 && paramsLast(movedDown),
    };
  });
  const problem = rowsProblem(rows) ?? (view.some((v) => v.problem) ? view.find((v) => v.problem)!.problem : undefined) ?? (isUnchanged(rows, info) ? 'The signature is unchanged.' : undefined);
  return {
    methodName: info.name ?? 'method',
    preview: `${info.name ?? ''}${signatureText(rows)}`,
    rows: view,
    removed: removedNames(rows, info),
    ...(problem ? { problem } : {}),
    ...(callSites ? { callSites: `Affects ${callSites.count}${callSites.more ? '+' : ''} call site${callSites.count === 1 ? '' : 's'} (references)` } : {}),
  };
}

const CSS = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 24px; }
h1 { font-size: 1.3em; font-weight: 600; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
caption { text-align: left; color: var(--vscode-descriptionForeground); padding-bottom: 4px; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); vertical-align: middle; }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
tr.dragging { opacity: .5; }
tr.drop-target td { border-top: 2px solid var(--vscode-focusBorder); }
input { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; width: 100%; box-sizing: border-box; }
input[readonly] { opacity: .75; }
input[aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder); }
input:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); padding: 2px 8px; cursor: pointer; }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:disabled { opacity: .4; cursor: default; }
.handle { cursor: grab; user-select: none; color: var(--vscode-descriptionForeground); }
.status { color: var(--vscode-descriptionForeground); font-size: .9em; }
.problem { color: var(--vscode-errorForeground); font-size: .9em; }
.preview { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 6px 8px; display: block; white-space: pre-wrap; }
.bar { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.muted { color: var(--vscode-descriptionForeground); }
`;

/** The page script: renders the view model with DOM APIs (textContent, never innerHTML) and posts small messages. */
const SCRIPT = `
const vscode = acquireVsCodeApi();
const tbody = document.getElementById('rows');
const live = document.getElementById('live');
let view;
let dragFrom = -1;
const post = (m) => vscode.postMessage(m);
function el(tag, attrs, text) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v === undefined) continue; e.setAttribute(k, v === true ? '' : String(v)); } if (text !== undefined) e.textContent = text; return e; }
function field(row, name, label, readonly) {
  const id = 'f-' + row.index + '-' + name;
  const input = el('input', { id, type: 'text', 'aria-label': label, value: row[name], readonly: readonly, 'aria-invalid': name === 'name' && row.problem ? 'true' : undefined, 'aria-describedby': row.problem ? 'p-' + row.index : undefined, 'data-index': row.index, 'data-field': name });
  input.value = row[name];
  input.addEventListener('change', () => post({ type: 'edit', index: row.index, field: name, value: input.value }));
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); post({ type: 'edit', index: row.index, field: name, value: input.value }); } });
  return input;
}
function render(v, focusId) {
  view = v;
  document.getElementById('preview').textContent = v.preview;
  document.getElementById('callsites').textContent = v.callSites || '';
  document.getElementById('removed').textContent = v.removed.length ? 'Removed: ' + v.removed.join(', ') + ' (only when unused; call-site arguments must be free of side effects)' : '';
  const problem = document.getElementById('problem');
  problem.textContent = v.problem || '';
  document.getElementById('submit').disabled = !!v.problem;
  tbody.textContent = '';
  for (const row of v.rows) {
    const label = row.name || ('parameter ' + (row.index + 1));
    const tr = el('tr', { draggable: 'true', 'data-index': row.index });
    const handle = el('td', { class: 'handle', 'aria-hidden': 'true', title: 'Drag to reorder' }, '\\u2630');
    tr.append(handle);
    tr.append(el('td', {}, String(row.index + 1)));
    const nameCell = el('td');
    nameCell.append(field(row, 'name', 'Name of parameter ' + (row.index + 1), false));
    if (row.problem) nameCell.append(el('div', { id: 'p-' + row.index, class: 'problem' }, row.problem));
    tr.append(nameCell);
    const typeCell = el('td'); typeCell.append(field(row, 'type', 'Type of ' + label + (row.isNew ? '' : ' (read only)'), !row.isNew)); tr.append(typeCell);
    const valueCell = el('td'); valueCell.append(field(row, 'callSiteValue', 'Value at call sites for ' + label + (row.isNew ? '' : ' (only for new parameters)'), !row.isNew)); tr.append(valueCell);
    const defCell = el('td'); defCell.append(field(row, 'defaultValue', 'Default value of ' + label + (row.isNew ? '' : ' (read only)'), !row.isNew)); tr.append(defCell);
    tr.append(el('td', { class: 'status' }, row.modifiers ? row.modifiers + (row.status ? ' · ' + row.status : '') : row.status));
    const actions = el('td');
    const up = el('button', { type: 'button', id: 'up-' + row.index, 'aria-label': 'Move ' + label + ' up', title: 'Move up (Alt+Up)', disabled: !row.canMoveUp }, '\\u2191');
    up.addEventListener('click', () => post({ type: 'move', index: row.index, delta: -1, focus: 'up-' + (row.index - 1) }));
    const down = el('button', { type: 'button', id: 'down-' + row.index, 'aria-label': 'Move ' + label + ' down', title: 'Move down (Alt+Down)', disabled: !row.canMoveDown }, '\\u2193');
    down.addEventListener('click', () => post({ type: 'move', index: row.index, delta: 1, focus: 'down-' + (row.index + 1) }));
    const remove = el('button', { type: 'button', id: 'rm-' + row.index, 'aria-label': 'Remove ' + label, title: 'Remove' }, '\\u2715');
    remove.addEventListener('click', () => post({ type: 'remove', index: row.index }));
    actions.append(up, down, remove);
    tr.append(actions);
    tr.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      ev.preventDefault();
      const delta = ev.key === 'ArrowUp' ? -1 : 1;
      if ((delta < 0 && !row.canMoveUp) || (delta > 0 && !row.canMoveDown)) return;
      const f = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : undefined;
      post({ type: 'move', index: row.index, delta, focus: f ? 'f-' + (row.index + delta) + '-' + f : undefined });
    });
    tr.addEventListener('dragstart', (ev) => { dragFrom = row.index; tr.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(row.index)); });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); dragFrom = -1; });
    tr.addEventListener('dragover', (ev) => { if (dragFrom < 0) return; ev.preventDefault(); tr.classList.add('drop-target'); });
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-target'));
    tr.addEventListener('drop', (ev) => { ev.preventDefault(); tr.classList.remove('drop-target'); if (dragFrom >= 0 && dragFrom !== row.index) post({ type: 'moveTo', from: dragFrom, to: row.index }); });
    tbody.append(tr);
  }
  if (focusId) { const f = document.getElementById(focusId); if (f) f.focus(); }
}
let lastAnnounce = '';
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.type !== 'render') return;
  const active = document.activeElement && document.activeElement.id;
  render(m.view, m.focus || active);
  const say = m.announce || '';
  if (say && say !== lastAnnounce) { live.textContent = say; lastAnnounce = say; }
});
document.getElementById('add').addEventListener('click', () => post({ type: 'add' }));
document.getElementById('submit').addEventListener('click', () => post({ type: 'submit' }));
document.getElementById('cancel').addEventListener('click', () => post({ type: 'cancel' }));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') post({ type: 'cancel' }); });
post({ type: 'ready' });
`;

/** The page: strict CSP (nothing but its own nonce'd style and script), VS Code theme variables, no external files. */
export function renderSignatureHtml(opts: { nonce: string; cspSource: string; title: string }): string {
  const e = escapeHtml;
  const csp = `default-src 'none'; style-src 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}'; img-src ${opts.cspSource};`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(opts.title)}</title><style nonce="${opts.nonce}">${CSS}</style></head><body>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<main aria-labelledby="title">
<h1 id="title">${e(opts.title)}</h1>
<p class="muted">Reorder (drag, the arrow buttons or Alt+Up/Down), rename, add or remove parameters. Nothing changes until you review the preview and apply it.</p>
<h2 class="sr-only" id="sig-h">New signature</h2>
<code id="preview" class="preview" aria-labelledby="sig-h"></code>
<p id="callsites" class="muted"></p>
<table aria-describedby="callsites">
<caption>Parameters</caption>
<thead><tr><th scope="col"><span class="sr-only">Drag handle</span></th><th scope="col">#</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Value at call sites</th><th scope="col">Default</th><th scope="col">Notes</th><th scope="col">Actions</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p id="removed" class="muted"></p>
<p id="problem" class="problem" role="alert"></p>
<div class="bar"><button type="button" id="add">Add parameter</button><button type="button" id="submit" class="primary">Preview changes…</button><button type="button" id="cancel">Cancel</button></div>
</main>
<script nonce="${opts.nonce}">${SCRIPT}</script></body></html>`;
}
