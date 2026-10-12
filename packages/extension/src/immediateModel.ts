// The Immediate Window (Visual Studio-like). Pure: unit-tested with vitest (no vscode). The view (immediate.ts) sends
// DAP requests (evaluate with context 'repl', variables, completions) to the active debug session and posts results.

export const IMMEDIATE_DEBUG_TYPES = ['refyntra-dotnet', 'refyntra-python'] as const;

/** Input history with Visual Studio behaviour: Up/Down walk through earlier inputs, the draft is kept. */
export class ImmediateHistory {
  private items: string[] = [];
  private index = 0;
  private draft = '';

  constructor(private readonly max = 100) {}

  push(input: string): void {
    const t = input.trim();
    if (!t) return;
    if (this.items[this.items.length - 1] !== input) this.items.push(input);
    if (this.items.length > this.max) this.items.shift();
    this.index = this.items.length;
    this.draft = '';
  }

  /** Earlier input (Up). `current` is the text in the box, kept as the draft when leaving the end. */
  previous(current: string): string | undefined {
    if (this.items.length === 0 || this.index === 0) return undefined;
    if (this.index === this.items.length) this.draft = current;
    return this.items[--this.index];
  }

  /** Later input (Down); past the end returns the draft. */
  next(): string | undefined {
    if (this.index >= this.items.length) return undefined;
    this.index++;
    return this.index === this.items.length ? this.draft : this.items[this.index];
  }

  get all(): readonly string[] {
    return this.items;
  }
}

/** Keys in the input box: Enter evaluates, Shift+Enter is a newline, Up/Down walk the history on the first/last line. */
export function inputKeyAction(key: string, shift: boolean, text: string, caret: number): 'evaluate' | 'newline' | 'previous' | 'next' | 'none' {
  if (key === 'Enter') return shift ? 'newline' : 'evaluate';
  if (key === 'ArrowUp' && !text.slice(0, caret).includes('\n')) return 'previous';
  if (key === 'ArrowDown' && !text.slice(caret).includes('\n')) return 'next';
  return 'none';
}

/** One line of output: the input echoed, a result (expandable when variablesReference > 0) or an error. */
export interface ImmediateNode {
  id: number;
  label: string;
  value: string;
  type?: string;
  /** DAP variablesReference: > 0 means it has children (fetched on expand). */
  ref: number;
  /** The expression that evaluates to it (for Add to Watch), when known. */
  evaluateName?: string;
}

export interface ImmediateEntry {
  id: number;
  input: string;
  result?: ImmediateNode;
  error?: string;
}

/** DAP evaluate response / variable → a node. Values are kept whole (the view shortens with CSS and has Copy Value). */
export function toNode(id: number, label: string, v: { result?: string; value?: string; type?: string; variablesReference?: number; evaluateName?: string }, evaluateName?: string): ImmediateNode {
  return {
    id,
    label,
    value: v.result ?? v.value ?? '',
    ...(v.type ? { type: v.type } : {}),
    ref: v.variablesReference ?? 0,
    ...((v.evaluateName ?? evaluateName) ? { evaluateName: (v.evaluateName ?? evaluateName)! } : {}),
  };
}

/**
 * A simple assignment `target = value` (target: a name or member chain; not ==, =>, <=, >=, !=, +=). Debuggers that do
 * not evaluate assignments (netcoredbg) get it as DAP setExpression / setVariable instead.
 */
export function parseAssignment(input: string): { target: string; value: string } | undefined {
  const m = /^\s*((?:this\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=(?![=>])\s*(.+?)\s*;?\s*$/s.exec(input);
  return m ? { target: m[1]!, value: m[2]! } : undefined;
}

/** Multi-line input is sent as one expression/statement: lines are joined (netcoredbg evaluates one expression). */
export function normaliseInput(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').replace(/;\s*$/, '');
}

/** The word before the caret and its start, for DAP completions (`order.Cu|` → text "order.Cu", column of caret). */
export function completionPrefix(text: string, caret: number): { prefix: string; start: number } {
  let s = caret;
  while (s > 0 && /[\w]/.test(text[s - 1]!)) s--;
  return { prefix: text.slice(s, caret), start: s };
}

/** Messages page → extension. */
export type PageMessage =
  | { type: 'evaluate'; text: string }
  | { type: 'expand'; nodeId: number }
  | { type: 'copy'; nodeId: number }
  | { type: 'watch'; nodeId: number }
  | { type: 'clear' }
  | { type: 'complete'; text: string; caret: number }
  | { type: 'ready' };

export function parsePageMessage(m: unknown): PageMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'evaluate':
      return typeof o.text === 'string' ? { type: 'evaluate', text: o.text } : undefined;
    case 'expand':
    case 'copy':
    case 'watch':
      return typeof o.nodeId === 'number' ? { type: o.type, nodeId: o.nodeId } : undefined;
    case 'complete':
      return typeof o.text === 'string' && typeof o.caret === 'number' ? { type: 'complete', text: o.text, caret: o.caret } : undefined;
    case 'clear':
    case 'ready':
      return { type: o.type };
    default:
      return undefined;
  }
}

const CSS = `
:root{color-scheme:light dark}
body{margin:0;padding:0 6px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);color:var(--vscode-foreground);background:var(--vscode-panel-background,var(--vscode-editor-background))}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#status{padding:4px 0;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family)}
#out{margin:0;padding:0;list-style:none}
#out li.entry{padding:2px 0;border-bottom:1px solid var(--vscode-panel-border,transparent)}
.input{color:var(--vscode-textPreformat-foreground,var(--vscode-foreground))}
.input::before{content:'> ';color:var(--vscode-descriptionForeground)}
.error{color:var(--vscode-errorForeground)}
[role=tree],[role=group]{list-style:none;margin:0;padding-left:14px}
[role=treeitem]{outline:none;white-space:nowrap}
[role=treeitem]>.row{display:flex;gap:6px;align-items:baseline;padding:1px 2px}
[role=treeitem]:focus>.row{outline:1px solid var(--vscode-focusBorder)}
.twisty{display:inline-block;width:10px}
.name{color:var(--vscode-debugTokenExpression-name,var(--vscode-symbolIcon-variableForeground))}
.value{color:var(--vscode-debugTokenExpression-value,var(--vscode-foreground));overflow:hidden;text-overflow:ellipsis;max-width:70vw}
.type{color:var(--vscode-descriptionForeground)}
.row button{font:inherit;font-size:11px;background:none;border:1px solid transparent;color:var(--vscode-textLink-foreground);cursor:pointer;padding:0 3px}
.row button:focus,.row button:hover{border-color:var(--vscode-focusBorder)}
#bar{position:sticky;bottom:0;background:inherit;padding:4px 0;display:flex;gap:6px;align-items:flex-start}
#inwrap{flex:1;display:flex;flex-direction:column}
#bar textarea{flex:1;resize:vertical;min-height:1.6em;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:3px}
#bar textarea:focus{outline:1px solid var(--vscode-focusBorder)}
#bar button{font-family:var(--vscode-font-family);color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:none;padding:3px 8px;cursor:pointer}
#bar button:focus{outline:1px solid var(--vscode-focusBorder)}
#completions{list-style:none;margin:0;padding:0;border:1px solid var(--vscode-editorSuggestWidget-border,var(--vscode-focusBorder));background:var(--vscode-editorSuggestWidget-background);max-height:8em;overflow:auto}
#completions li[aria-selected=true]{background:var(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground));color:var(--vscode-editorSuggestWidget-selectedForeground,var(--vscode-list-activeSelectionForeground))}
`;

// Page script: renders entries posted by the extension; every action posts a message (no eval, no remote content).
const SCRIPT = `
const vscode = acquireVsCodeApi();
const out = document.getElementById('out'), input = document.getElementById('input'), live = document.getElementById('live');
const status = document.getElementById('status'), comp = document.getElementById('completions');
let history = [], hIndex = 0, draft = '', items = [], sel = -1;
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function nodeItem(n){
  const li = el('li'); li.setAttribute('role','treeitem'); li.tabIndex = -1; li.dataset.id = n.id; li.dataset.ref = n.ref;
  if (n.ref > 0) li.setAttribute('aria-expanded','false');
  li.setAttribute('aria-label', n.label + ' = ' + n.value + (n.type ? ', ' + n.type : ''));
  const row = el('div','row'); row.append(el('span','twisty', n.ref > 0 ? '\\u25B8' : ''), el('span','name', n.label), el('span','value', n.value));
  if (n.type) row.append(el('span','type', n.type));
  const c = el('button', '', 'Copy'); c.title = 'Copy Value'; c.setAttribute('aria-label','Copy value of ' + n.label); c.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({type:'copy', nodeId:n.id}); };
  row.append(c);
  if (n.evaluateName) { const w = el('button','', 'Watch'); w.title = 'Add to Watch'; w.setAttribute('aria-label','Add ' + n.evaluateName + ' to Watch'); w.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({type:'watch', nodeId:n.id}); }; row.append(w); }
  row.onclick = () => toggle(li);
  li.append(row); return li;
}
function toggle(li){
  if (li.dataset.ref === '0') return;
  const open = li.getAttribute('aria-expanded') === 'true';
  li.setAttribute('aria-expanded', String(!open)); li.querySelector('.twisty').textContent = open ? '\\u25B8' : '\\u25BE';
  const g = li.querySelector(':scope > [role=group]');
  if (open) { if (g) g.hidden = true; return; }
  if (g) { g.hidden = false; return; }
  vscode.postMessage({type:'expand', nodeId: Number(li.dataset.id)});
}
function focusItem(li){ document.querySelectorAll('[role=treeitem]').forEach(x => x.tabIndex = -1); li.tabIndex = 0; li.focus(); }
out.addEventListener('keydown', (e) => {
  const li = e.target.closest && e.target.closest('[role=treeitem]'); if (!li) return;
  const all = [...out.querySelectorAll('[role=treeitem]')].filter(x => !x.closest('[hidden]'));
  const i = all.indexOf(li);
  if (e.key === 'ArrowDown' && all[i+1]) { focusItem(all[i+1]); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && all[i-1]) { focusItem(all[i-1]); e.preventDefault(); }
  else if (e.key === 'ArrowRight' && li.getAttribute('aria-expanded') === 'false') { toggle(li); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { if (li.getAttribute('aria-expanded') === 'true') toggle(li); else { const p = li.parentElement.closest('[role=treeitem]'); if (p) focusItem(p); } e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { toggle(li); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'c') { vscode.postMessage({type:'copy', nodeId:Number(li.dataset.id)}); e.preventDefault(); }
  else if (e.key === 'Escape') { input.focus(); }
});
function showCompletions(list){
  items = list; sel = list.length ? 0 : -1; comp.textContent = '';
  comp.hidden = list.length === 0; input.setAttribute('aria-expanded', String(list.length > 0));
  list.forEach((t, i) => { const li = el('li','',t); li.id = 'c' + i; li.setAttribute('role','option'); li.setAttribute('aria-selected', String(i === sel)); li.onmousedown = (e) => { e.preventDefault(); accept(i); }; comp.append(li); });
  if (sel >= 0) input.setAttribute('aria-activedescendant', 'c0'); else input.removeAttribute('aria-activedescendant');
}
function accept(i){
  const t = items[i]; if (t === undefined) return;
  const caret = input.selectionStart; let s = caret; while (s > 0 && /\\w/.test(input.value[s-1])) s--;
  input.value = input.value.slice(0, s) + t + input.value.slice(caret); input.selectionStart = input.selectionEnd = s + t.length; showCompletions([]);
}
input.addEventListener('keydown', (e) => {
  if (!comp.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; [...comp.children].forEach((c,i) => c.setAttribute('aria-selected', String(i === sel))); input.setAttribute('aria-activedescendant','c'+sel); e.preventDefault(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { accept(sel); e.preventDefault(); return; }
    if (e.key === 'Escape') { showCompletions([]); e.preventDefault(); return; }
  }
  if (e.key === ' ' && e.ctrlKey) { vscode.postMessage({type:'complete', text: input.value, caret: input.selectionStart}); e.preventDefault(); return; }
  const before = input.value.slice(0, input.selectionStart), after = input.value.slice(input.selectionEnd);
  if (e.key === 'Enter' && !e.shiftKey) { const t = input.value; if (t.trim()) { vscode.postMessage({type:'evaluate', text: t}); if (history[history.length-1] !== t) history.push(t); hIndex = history.length; input.value = ''; } e.preventDefault(); }
  else if (e.key === 'ArrowUp' && !before.includes('\\n') && hIndex > 0) { if (hIndex === history.length) draft = input.value; input.value = history[--hIndex]; e.preventDefault(); }
  else if (e.key === 'ArrowDown' && !after.includes('\\n') && hIndex < history.length) { hIndex++; input.value = hIndex === history.length ? draft : history[hIndex]; e.preventDefault(); }
});
input.addEventListener('input', () => { const c = input.selectionStart; if (input.value[c-1] === '.') vscode.postMessage({type:'complete', text: input.value, caret: c}); else if (!comp.hidden) showCompletions([]); });
document.getElementById('clear').onclick = () => vscode.postMessage({type:'clear'});
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'status') { status.textContent = m.text; input.disabled = !m.active; input.setAttribute('aria-disabled', String(!m.active)); }
  else if (m.type === 'clear') { out.textContent = ''; live.textContent = 'Immediate Window cleared'; }
  else if (m.type === 'entry') {
    const li = el('li','entry'); li.append(el('div','input', m.entry.input));
    if (m.entry.error) li.append(el('div','error', m.entry.error));
    if (m.entry.result) { const t = el('ul'); t.setAttribute('role','tree'); t.setAttribute('aria-label','Result of ' + m.entry.input); const it = nodeItem(m.entry.result); it.tabIndex = 0; t.append(it); li.append(t); }
    out.append(li); li.scrollIntoView({block:'end'});
    live.textContent = m.entry.error ? 'Error: ' + m.entry.error : (m.entry.result ? m.entry.result.value : '');
  }
  else if (m.type === 'children') {
    const li = out.querySelector('[role=treeitem][data-id="' + m.nodeId + '"]'); if (!li) return;
    const g = el('ul'); g.setAttribute('role','group'); m.children.forEach(n => g.append(nodeItem(n))); li.append(g);
    live.textContent = m.children.length + ' members';
  }
  else if (m.type === 'completions') showCompletions(m.items);
  else if (m.type === 'focus') input.focus();
});
vscode.postMessage({type:'ready'});
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page: strict CSP (only its own nonce'd style and script), VS Code theme variables, no external files. */
export function renderImmediateHtml(opts: { nonce: string; cspSource: string }): string {
  const csp = `default-src 'none'; style-src 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}'; img-src ${opts.cspSource};`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${esc(csp)}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Refyntra Immediate</title><style nonce="${opts.nonce}">${CSS}</style></head><body>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="status" role="note">Start debugging and stop at a breakpoint to evaluate expressions.</div>
<ul id="out" aria-label="Immediate Window output"></ul>
<div id="bar"><label for="input" class="sr-only">Expression (Enter evaluates, Shift+Enter adds a line, Up and Down recall history, Ctrl+Space completes)</label>
<div id="inwrap"><textarea id="input" rows="1" role="combobox" aria-autocomplete="list" aria-controls="completions" aria-expanded="false" spellcheck="false" disabled aria-disabled="true"></textarea><ul id="completions" role="listbox" aria-label="Completions" hidden></ul></div>
<button id="clear" title="Clear the Immediate Window">Clear</button></div>
<script nonce="${opts.nonce}">${SCRIPT}</script></body></html>`;
}
