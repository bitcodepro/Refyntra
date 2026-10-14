// The Structural Search panel page (webview): static markup, theme variables only, a strict CSP (nonce script/style,
// no remote resources) and local inline SVG icons. The page builds every dynamic node with textContent: no HTML from
// the host or from code is ever parsed. It posts only validated messages (structuralSearchModel.parsePanelMessage).

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Local icons (24×24 outline glyphs drawn for Refyntra; currentColor, aria-hidden). */
export const ICONS: Record<string, string> = {
  search: '<path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.8 4.8-1.1 1.1-4.8-4.8A7.5 7.5 0 1 1 10.5 3zm0 1.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>',
  replace: '<path d="M4 5h9v1.5H4zm0 4h6v1.5H4zm9.5 2.5 3-3 3 3-1 1-1.3-1.3V16a3 3 0 0 1-3 3H11v-1.5h3.2A1.5 1.5 0 0 0 15.7 16v-4.8l-1.2 1.3zM4 13h5v1.5H4z"/>',
  save: '<path d="M5 3h11l4 4v12.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3zm.5 1.5v15h13V7.6L15.4 4.5H15V9H7V4.5zm3 0V7.5h5v-3zM8 12h8v6H8zm1.5 1.5v3h5v-3z"/>',
  trash: '<path d="M9 3h6v1.5h5V6H4V4.5h5zm-3 4.5h12l-1 12.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20zm1.6 1.5.9 11h7l.9-11zM10 11h1.5v7H10zm2.5 0H14v7h-1.5z"/>',
  more: '<path d="M5 11h14v2H5zm6-6h2v14h-2z"/>',
  file: '<path d="M6 2.5h8l5 5v13A1.5 1.5 0 0 1 17.5 22h-11A1.5 1.5 0 0 1 5 20.5v-16.5A1.5 1.5 0 0 1 6.5 2.5zm0 1.5v16.5h11.5V8.5H13.5V4zm9 1.1v1.9h1.9z"/>',
};

export function icon(name: keyof typeof ICONS): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 20px 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
h1 { font-size: 1.4em; font-weight: 600; margin: 4px 0 8px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 16px 0 6px; }
h3 { font-size: 1em; font-weight: 600; margin: 10px 0 4px; display: flex; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.muted { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
.layout { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 24px; align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
label { display: block; margin: 8px 0 4px; font-weight: 600; }
textarea, input[type=text], select { width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 4px 6px; font: inherit; }
textarea { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); resize: vertical; min-height: 4.5em; white-space: pre; overflow-wrap: normal; }
input[type=number] { width: 4.5em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 3px 4px; font: inherit; }
textarea:focus, input:focus, select:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 4px 0; }
caption { text-align: left; font-weight: 600; padding: 4px 0; }
th, td { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
td code { font-family: var(--vscode-editor-font-family); }
fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 2px; margin: 10px 0; padding: 4px 10px 8px; }
legend { font-weight: 600; padding: 0 4px; }
fieldset label { display: inline-flex; gap: 4px; align-items: center; font-weight: normal; margin: 4px 14px 0 0; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
button { display: inline-flex; gap: 6px; align-items: center; min-height: 26px; padding: 3px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
[hidden] { display: none !important; }
button.link { padding: 2px 4px; min-height: 24px; border: none; background: transparent; color: var(--vscode-textLink-foreground); text-align: left; }
button.link:hover { text-decoration: underline; background: transparent; }
.icon { fill: currentColor; flex: none; }
.problem { color: var(--vscode-errorForeground); margin: 4px 0; }
ul.plain { list-style: none; padding: 0; margin: 0; }
#patterns li { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
#patterns li.selected { background: var(--vscode-list-inactiveSelectionBackground); }
.tag { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
.save-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.save-row label { display: inline-flex; gap: 4px; align-items: center; font-weight: normal; margin: 0; }
.save-row select { width: auto; }
#results ol { list-style: none; margin: 0 0 6px; padding: 0 0 0 22px; }
#results li { display: flex; gap: 8px; align-items: baseline; }
.row-main { flex: 1; min-width: 0; }
.row-main code { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.values { display: block; color: var(--vscode-descriptionForeground); font-size: 0.92em; overflow-wrap: anywhere; }
.count { color: var(--vscode-descriptionForeground); font-weight: normal; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (forced-colors: active) { button { border: 1px solid ButtonText; } .icon { fill: ButtonText; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

// The page script: renders the view the extension posts and posts edits / commands back. No HTML parsing.
const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const ICON = ${JSON.stringify(ICONS)};
  const svg = (name) => { const ns = 'http://www.w3.org/2000/svg'; const s = document.createElementNS(ns, 'svg'); s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false'); const p = document.createElementNS(ns, 'path'); p.setAttribute('d', /d="([^"]+)"/.exec(ICON[name])[1]); s.appendChild(p); return s; };
  let view = null;
  let rowsKey = '';
  let timer = 0;
  function editorState() {
    const rows = Array.from(document.querySelectorAll('#placeholders tr[data-name]')).map((tr) => {
      const q = (k) => tr.querySelector('[data-k="' + k + '"]');
      const r = { name: tr.dataset.name, kind: q('kind').value };
      if (q('type').value.trim()) r.type = q('type').value.trim();
      if (q('exact').checked) r.exactType = true;
      if (q('min').value !== '') r.minCount = Number(q('min').value);
      if (q('max').value !== '') r.maxCount = Number(q('max').value);
      if (q('regex').value) r.regex = q('regex').value;
      return r;
    });
    const scope = (document.querySelector('input[name=scope]:checked') || {}).value || 'solution';
    return { text: $('pattern').value, replacement: $('replacement').value, placeholders: rows, scope: scope };
  }
  function changed(now) {
    clearTimeout(timer);
    const send = () => vscode.postMessage({ type: 'change', editor: editorState() });
    if (now) send(); else timer = setTimeout(send, 150);
  }
  function setValue(node, value) { if (document.activeElement !== node && node.value !== value) node.value = value; }
  function renderPlaceholders(rows, kinds) {
    const key = rows.map((r) => r.name).join(',');
    const body = $('placeholders');
    if (key !== rowsKey) {
      rowsKey = key;
      body.textContent = '';
      for (const r of rows) {
        const tr = el('tr'); tr.dataset.name = r.name;
        const th = el('th'); th.scope = 'row'; th.appendChild(el('code', '', '$' + r.name + '$')); tr.appendChild(th);
        const cell = (node, label) => { node.setAttribute('aria-label', label + ' of $' + r.name + '$'); const td = el('td'); td.appendChild(node); tr.appendChild(td); return node; };
        const kind = el('select'); kind.dataset.k = 'kind'; for (const k of kinds) { const o = el('option', '', k); o.value = k; kind.appendChild(o); } cell(kind, 'Kind');
        const type = el('input'); type.type = 'text'; type.dataset.k = 'type'; type.placeholder = 'e.g. System.Threading.Tasks.Task'; cell(type, 'Type');
        const exact = el('input'); exact.type = 'checkbox'; exact.dataset.k = 'exact'; cell(exact, 'Exact type');
        const min = el('input'); min.type = 'number'; min.min = '0'; min.dataset.k = 'min'; cell(min, 'Minimum count');
        const max = el('input'); max.type = 'number'; max.min = '0'; max.dataset.k = 'max'; cell(max, 'Maximum count');
        const rx = el('input'); rx.type = 'text'; rx.dataset.k = 'regex'; rx.placeholder = 'regex'; cell(rx, 'Text regex');
        body.appendChild(tr);
      }
      if (!rows.length) { const tr = el('tr'); const td = el('td', 'muted', 'No placeholders: write $name$ in the pattern.'); td.colSpan = 7; tr.appendChild(td); body.appendChild(tr); }
    }
    for (const r of rows) {
      const tr = body.querySelector('tr[data-name="' + r.name + '"]'); if (!tr) continue;
      const q = (k) => tr.querySelector('[data-k="' + k + '"]');
      setValue(q('kind'), r.kind || 'any'); setValue(q('type'), r.type || '');
      if (document.activeElement !== q('exact')) q('exact').checked = !!r.exactType;
      setValue(q('min'), r.minCount === undefined ? '' : String(r.minCount)); setValue(q('max'), r.maxCount === undefined ? '' : String(r.maxCount));
      setValue(q('regex'), r.regex || '');
    }
  }
  function renderPatterns(v) {
    const list = $('patterns'); list.textContent = '';
    for (const p of v.patterns) {
      const li = el('li'); if (p.id === v.selectedId) li.className = 'selected';
      const load = el('button', 'link', p.name); load.type = 'button'; load.dataset.load = p.id; load.setAttribute('aria-describedby', 'pd-' + p.id.replace(/[^A-Za-z0-9_-]/g, '_'));
      li.appendChild(load);
      const d = el('span', 'tag', p.origin + (p.inspection ? ' · ' + p.inspection : '')); d.id = 'pd-' + p.id.replace(/[^A-Za-z0-9_-]/g, '_'); li.appendChild(d);
      if (p.origin !== 'builtin') { const del = el('button', 'link'); del.type = 'button'; del.dataset.del = p.id; del.appendChild(svg('trash')); del.appendChild(el('span', '', 'Delete')); del.setAttribute('aria-label', 'Delete pattern ' + p.name); li.appendChild(del); }
      list.appendChild(li);
    }
  }
  function renderResults(v) {
    $('headline').textContent = v.headline;
    const notes = $('notes'); notes.textContent = ''; for (const n of v.notes) notes.appendChild(el('li', 'muted', n));
    const box = $('results'); box.textContent = '';
    for (const g of v.groups) {
      const h = el('h3'); h.appendChild(svg('file')); h.appendChild(el('span', '', g.label)); h.appendChild(el('span', 'count', '(' + g.count + ')')); box.appendChild(h);
      const ol = el('ol');
      for (const r of g.rows) {
        const li = el('li');
        const main = el('span', 'row-main');
        const open = el('button', 'link'); open.type = 'button'; open.dataset.open = String(r.index);
        open.appendChild(el('span', '', r.line + ': ')); open.appendChild(el('code', '', r.preview));
        open.setAttribute('aria-label', 'Open match at line ' + r.line + ': ' + r.preview);
        main.appendChild(open);
        if (r.values) main.appendChild(el('span', 'values', r.values));
        li.appendChild(main);
        const rep = el('button'); rep.type = 'button'; rep.dataset.replace = String(r.index); rep.appendChild(svg('replace')); rep.appendChild(el('span', '', 'Replace…'));
        rep.setAttribute('aria-label', 'Replace the match at line ' + r.line + ' of ' + g.label);
        rep.disabled = v.busy || v.replaceProblems.length > 0;
        li.appendChild(rep);
        ol.appendChild(li);
      }
      box.appendChild(ol);
    }
    $('more').hidden = !v.canShowMore;
  }
  function render(v) {
    view = v;
    setValue($('pattern'), v.editor.text);
    setValue($('replacement'), v.editor.replacement);
    for (const r of document.querySelectorAll('input[name=scope]')) r.checked = r.value === v.editor.scope;
    renderPlaceholders(v.editor.placeholders, v.kinds);
    $('problems').textContent = v.problems.join(' ');
    $('search').disabled = v.busy || v.problems.length > 0;
    $('replaceAll').disabled = v.busy || v.replaceProblems.length > 0;
    $('replaceAll').title = v.replaceProblems.join(' ');
    renderPatterns(v);
    renderResults(v);
    document.body.setAttribute('aria-busy', v.busy ? 'true' : 'false');
  }
  window.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'render') { render(m.view); if (m.announce) $('live').textContent = m.announce; } });
  $('pattern').addEventListener('input', () => changed(false));
  $('replacement').addEventListener('input', () => changed(false));
  $('placeholders').addEventListener('input', () => changed(false));
  $('placeholders').addEventListener('change', () => changed(true));
  for (const r of document.querySelectorAll('input[name=scope]')) r.addEventListener('change', () => changed(true));
  $('pattern').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); changed(true); vscode.postMessage({ type: 'search' }); } });
  $('search').addEventListener('click', () => { changed(true); vscode.postMessage({ type: 'search' }); });
  $('replaceAll').addEventListener('click', () => { changed(true); vscode.postMessage({ type: 'replaceAll' }); });
  $('more').addEventListener('click', () => vscode.postMessage({ type: 'showMore' }));
  $('save-ws').addEventListener('click', () => { changed(true); vscode.postMessage({ type: 'save', target: 'workspace', name: $('save-name').value, inspection: $('save-insp').checked, severity: $('save-sev').value }); });
  $('save-user').addEventListener('click', () => { changed(true); vscode.postMessage({ type: 'save', target: 'user', name: $('save-name').value, inspection: $('save-insp').checked, severity: $('save-sev').value }); });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.load) vscode.postMessage({ type: 'load', id: t.dataset.load });
    else if (t.dataset.del) vscode.postMessage({ type: 'delete', id: t.dataset.del });
    else if (t.dataset.open) vscode.postMessage({ type: 'openMatch', index: Number(t.dataset.open) });
    else if (t.dataset.replace) vscode.postMessage({ type: 'replaceMatch', index: Number(t.dataset.replace) });
  });
  vscode.postMessage({ type: 'ready' });
})();
`;

export function renderStructuralHtml(opts: { nonce: string; cspSource: string; title: string; severities: readonly string[] }): string {
  const e = escapeHtml;
  const csp = `default-src 'none'; style-src 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}'; img-src ${opts.cspSource};`;
  const severities = opts.severities.map((s) => `<option value="${e(s)}"${s === 'warning' ? ' selected' : ''}>${e(s)}</option>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(opts.title)}</title><style nonce="${opts.nonce}">${CSS}</style></head><body>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<main aria-labelledby="title">
<h1 id="title">${e(opts.title)}</h1>
<p class="muted">C# code with placeholders <code>$name$</code>. Names match their symbol in any spelling; a placeholder used twice must match the same code. Replacements are previewed and compile-checked before anything changes.</p>
<div class="layout">
<section aria-labelledby="pattern-h">
<h2 id="pattern-h">Pattern</h2>
<label for="pattern">Search pattern</label>
<textarea id="pattern" rows="4" spellcheck="false" autocomplete="off" aria-describedby="problems"></textarea>
<label for="replacement">Replacement (optional)</label>
<textarea id="replacement" rows="3" spellcheck="false" autocomplete="off"></textarea>
<div class="table-wrap" role="region" aria-label="Placeholders" tabindex="0">
<table>
<caption>Placeholders</caption>
<thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Type</th><th scope="col">Exact</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Regex</th></tr></thead>
<tbody id="placeholders"></tbody>
</table>
</div>
<fieldset><legend>Scope</legend>
<label><input type="radio" name="scope" value="document"> Current file</label>
<label><input type="radio" name="scope" value="project"> Current project</label>
<label><input type="radio" name="scope" value="solution" checked> Solution</label>
</fieldset>
<p id="problems" class="problem" role="alert"></p>
<div class="bar"><button type="button" id="search" class="primary">${icon('search')}<span>Search</span></button><button type="button" id="replaceAll">${icon('replace')}<span>Replace all…</span></button></div>
</section>
<section aria-labelledby="saved-h">
<h2 id="saved-h">Saved patterns</h2>
<ul id="patterns" class="plain" aria-labelledby="saved-h"></ul>
<h2 id="save-h">Save this pattern</h2>
<label for="save-name">Name</label>
<input type="text" id="save-name" autocomplete="off">
<div class="save-row">
<label><input type="checkbox" id="save-insp"> Show as inspection</label>
<label for="save-sev">Severity</label><select id="save-sev">${severities}</select>
</div>
<div class="bar"><button type="button" id="save-ws">${icon('save')}<span>Save to workspace</span></button><button type="button" id="save-user">${icon('save')}<span>Save for me</span></button></div>
</section>
</div>
<section aria-labelledby="results-h">
<h2 id="results-h">Results</h2>
<p id="headline" class="muted"></p>
<ul id="notes" class="plain"></ul>
<div id="results"></div>
<div class="bar"><button type="button" id="more" hidden>${icon('more')}<span>Show more</span></button></div>
</section>
</main>
<script nonce="${opts.nonce}">${SCRIPT}</script></body></html>`;
}
