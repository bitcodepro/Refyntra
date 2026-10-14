import { describe, expect, it } from 'vitest';
import type { StructuralMatch, StructuralSearchResult } from '@refyntra/contracts';
import {
  BUILTIN_PATTERNS,
  EMPTY_EDITOR,
  type SavedPattern,
  cleanPlaceholder,
  editorFromPattern,
  groupMatches,
  inspectionPatterns,
  mergePatterns,
  nextResultLimit,
  panelView,
  parsePanelMessage,
  parsePatternsFile,
  patternFromEditor,
  patternProblems,
  placeholderNames,
  removePattern,
  resultsHeadline,
  ruleIdOf,
  serializePatterns,
  syncPlaceholders,
  toProtocol,
  upsertPattern,
} from '../../src/structuralSearchModel';
import { renderStructuralHtml } from '../../src/structuralSearchHtml';
import { ruleLevel, structuralSeverity } from '../../src/diagnosticsModel';

const match = (uri: string, line: number, text: string, values: Record<string, string> = {}): StructuralMatch => ({
  uri,
  range: { start: { line, character: 4 }, end: { line, character: 10 } },
  lineText: text,
  values,
});

const result = (matches: StructuralMatch[], extra: Partial<StructuralSearchResult> = {}): StructuralSearchResult => ({
  patternKind: 'expression',
  matches,
  truncated: false,
  filesSearched: 10,
  filesWithMatches: new Set(matches.map((m) => m.uri)).size,
  notes: [],
  elapsedMs: 5,
  snapshotId: 's1',
  ...extra,
});

describe('placeholder table', () => {
  it('lists the names of the pattern in order of first use', () => {
    expect(placeholderNames('$s$ == null || $s$ == "" && $t$')).toEqual(['s', 't']);
    expect(placeholderNames('no placeholders, $ 1 $')).toEqual([]);
  });

  it('is filled from the pattern and keeps the settings of names that remain', () => {
    const rows = syncPlaceholders('$x$.Result', [{ name: 'x', kind: 'expression', type: 'System.Threading.Tasks.Task' }, { name: 'gone', kind: 'type' }]);
    expect(rows).toEqual([{ name: 'x', kind: 'expression', type: 'System.Threading.Tasks.Task' }]);
    expect(syncPlaceholders('$a$ + $b$', rows)).toEqual([
      { name: 'a', kind: 'any' },
      { name: 'b', kind: 'any' },
    ]);
  });

  it('cleans untrusted rows: names, kinds, counts, lengths', () => {
    expect(cleanPlaceholder({ name: 'args', kind: 'argument', minCount: '1', maxCount: 3, regex: 'Get.*', exactType: true, type: ' int ' })).toEqual({ name: 'args', kind: 'argument', minCount: 1, maxCount: 3, regex: 'Get.*', exactType: true, type: 'int' });
    expect(cleanPlaceholder({ name: '1bad' })).toBeUndefined();
    expect(cleanPlaceholder({ name: 'x', kind: 'banana', minCount: -1 })).toEqual({ name: 'x' });
    expect(cleanPlaceholder(null)).toBeUndefined();
  });
});

describe('pattern problems', () => {
  const base = { text: '$x$.Result', placeholders: [{ name: 'x' }] };
  it('needs a pattern, well-formed placeholders and a replacement that uses only pattern placeholders', () => {
    expect(patternProblems({ ...base }, 'search')).toEqual([]);
    expect(patternProblems({ text: ' ', placeholders: [] }, 'search')).toContain('Enter a pattern.');
    expect(patternProblems({ text: '$x.Result', placeholders: [] }, 'search').join()).toContain('does not start a placeholder');
    expect(patternProblems({ text: '$"interpolated {a}"', placeholders: [] }, 'search')).toEqual([]);
    expect(patternProblems({ ...base, replacement: 'await $y$' }, 'replace').join()).toContain('$y$');
    expect(patternProblems({ ...base, replacement: '' }, 'replace')).toContain('Enter a replacement.');
    // Statements may be replaced by nothing (deleted).
    expect(patternProblems({ text: 'Debug.WriteLine($a$);', placeholders: [], replacement: '' }, 'replace')).toEqual([]);
  });

  it('checks counts, regular expressions and the inspection name', () => {
    expect(patternProblems({ text: 'f($a$)', placeholders: [{ name: 'a', minCount: 3, maxCount: 1 }] }, 'search').join()).toContain('minimum count');
    expect(patternProblems({ text: '$a$', placeholders: [{ name: 'a', regex: '(' }] }, 'search').join()).toContain('regular expression');
    expect(patternProblems({ ...base, name: '' }, 'save')).toContain('Enter a name.');
    expect(patternProblems({ ...base, name: 'Ok name', inspection: { enabled: true, severity: 'warning' } }, 'save')).toEqual([]);
  });
});

describe('protocol form and inspections', () => {
  it('rule ids are ORS-<name> with safe characters', () => {
    expect(ruleIdOf('Task.Result to await')).toBe('ORS-Task.Result-to-await');
    expect(ruleIdOf('  ')).toBe('ORS-pattern');
  });

  it('only enabled, valid inspections are sent, once per rule id, with severity, message and fix title', () => {
    const p = (name: string, enabled: boolean, text = '$x$.Result'): SavedPattern => ({ id: `workspace.${name}`, name, text, replacement: 'await $x$', placeholders: [{ name: 'x' }], origin: 'workspace', inspection: { enabled, severity: 'error' } });
    const list = inspectionPatterns([p('a', true), p('b', false), p('a', true), p('c', true, '')]);
    expect(list).toEqual([{ text: '$x$.Result', placeholders: [{ name: 'x' }], replacement: 'await $x$', ruleId: 'ORS-a', severity: 'error', message: 'a (structural pattern ORS-a)', fixTitle: 'Replace: a' }]);
    expect(toProtocol(BUILTIN_PATTERNS[0]!)).toEqual({ text: '$x$.Result', replacement: 'await $x$', placeholders: [{ name: 'x', kind: 'expression', type: 'System.Threading.Tasks.Task' }] });
  });

  it('pattern inspection severity: the setting wins, else the saved severity; ORS rules are on by default', () => {
    expect(structuralSeverity('error', undefined)).toBe('error');
    expect(structuralSeverity('hint', 'warning')).toBe('warning');
    expect(structuralSeverity('nonsense', undefined)).toBe('warning');
    expect(structuralSeverity('error', 'off')).toBeUndefined();
    expect(ruleLevel('ORS-x', undefined)).toBe('warning');
    expect(ruleLevel('ORS-x', 'off')).toBe('off');
  });
});

describe('pattern storage (.refyntra/patterns.json and the user file)', () => {
  const saved: SavedPattern = {
    id: 'workspace.empty',
    name: 'Empty string',
    text: '$s$ == null || $s$ == ""',
    replacement: 'string.IsNullOrEmpty($s$)',
    placeholders: [{ name: 's', kind: 'expression', type: 'string' }],
    inspection: { enabled: true, severity: 'information' },
    origin: 'workspace',
  };

  it('round-trips through the file format (stable, diff-friendly JSON)', () => {
    const text = serializePatterns([saved]);
    expect(text).toMatch(/^\{\n {2}"version": 1,\n {2}"patterns": \[/);
    expect(text.endsWith('\n')).toBe(true);
    const back = parsePatternsFile(text, 'workspace');
    expect(back.errors).toEqual([]);
    expect(back.patterns).toEqual([saved]);
    expect(serializePatterns(back.patterns)).toBe(text);
  });

  it('reports malformed files and entries, keeps the good ones', () => {
    expect(parsePatternsFile('{ nope', 'user').errors[0]).toMatch(/Not valid JSON/);
    expect(parsePatternsFile('{"x":1}', 'user').errors).toEqual(['Expected { "patterns": [ ... ] }.']);
    const r = parsePatternsFile(JSON.stringify({ patterns: [{ name: 'ok', text: '$a$', inspection: { severity: 'loud' } }, { text: 'x' }, 7, { name: 'ok', text: '$b$' }] }), 'user');
    expect(r.patterns.map((p) => p.name)).toEqual(['ok']);
    expect(r.patterns[0]!.inspection).toEqual({ enabled: true, severity: 'warning' });
    expect(r.errors).toEqual(['Pattern 2: "name" is missing.', 'Pattern 3: not an object.', 'Pattern ok: the id is used twice.']);
  });

  it('merges workspace, user and built-in patterns; upsert by name, remove by id', () => {
    const user: SavedPattern = { ...saved, id: 'user.mine', name: 'Mine', origin: 'user' };
    const all = mergePatterns([saved], [user]);
    expect(all.map((p) => p.origin)).toEqual(['workspace', 'user', 'builtin', 'builtin', 'builtin', 'builtin']);
    const changed = upsertPattern([saved], { ...saved, id: 'workspace.other-id', name: 'EMPTY STRING', text: '$s$ == ""' });
    expect(changed).toHaveLength(1);
    expect(changed[0]!.id).toBe('workspace.empty');
    expect(changed[0]!.text).toBe('$s$ == ""');
    expect(upsertPattern([saved], user)).toHaveLength(2);
    expect(removePattern([saved, user], 'user.mine')).toEqual([saved]);
  });

  it('a pattern saved from the editor keeps the placeholder rows of its text and the inspection', () => {
    const editor = { text: '$a$ + $a$', replacement: '2 * $a$', placeholders: [{ name: 'a', kind: 'expression' as const }, { name: 'old' }], scope: 'project' as const };
    const p = patternFromEditor(editor, 'Double', 'user', { enabled: true, severity: 'hint' });
    expect(p).toEqual({ id: 'user.Double', name: 'Double', text: '$a$ + $a$', replacement: '2 * $a$', placeholders: [{ name: 'a', kind: 'expression' }], origin: 'user', inspection: { enabled: true, severity: 'hint' } });
    expect(editorFromPattern(p, 'document')).toEqual({ text: '$a$ + $a$', replacement: '2 * $a$', placeholders: [{ name: 'a', kind: 'expression' }], scope: 'document' });
  });

  it('the four built-in examples are valid and replaceable', () => {
    expect(BUILTIN_PATTERNS.map((p) => p.text)).toEqual(['$x$.Result', '$s$ == null || $s$ == ""', 'if ($c$) return true; else return false;', '$list$.Count() > 0']);
    for (const p of BUILTIN_PATTERNS) expect(patternProblems(p, 'replace'), p.name).toEqual([]);
  });
});

describe('results', () => {
  const a = 'file:///w/Shop/A.cs';
  const b = 'file:///w/Shop/B.cs';
  const label = (u: string) => u.replace('file:///w/', '');

  it('groups matches by file with line previews and placeholder values', () => {
    const groups = groupMatches([match(a, 4, '    var n = t.Result;', { x: 't' }), match(b, 0, 'x'), match(a, 9, '  return    u.Result  ;')], label);
    expect(groups).toEqual([
      { uri: a, label: 'Shop/A.cs', count: 2, rows: [{ index: 0, line: 5, character: 5, preview: 'var n = t.Result;', values: '$x$ = t' }, { index: 2, line: 10, character: 5, preview: 'return u.Result ;', values: '' }] },
      { uri: b, label: 'Shop/B.cs', count: 1, rows: [{ index: 1, line: 1, character: 5, preview: 'x', values: '' }] },
    ]);
  });

  it('headline: counts, "+" and show more when truncated, the reason when invalid', () => {
    expect(resultsHeadline(result([match(a, 1, 'x'), match(b, 2, 'y')]))).toBe('2 matches in 2 files.');
    expect(resultsHeadline(result([match(a, 1, 'x')]))).toBe('1 match in 1 file.');
    expect(resultsHeadline(result([match(a, 1, 'x')], { truncated: true }))).toBe('1+ matches in 1 file (more available).');
    expect(resultsHeadline(result([], { filesSearched: 1 }))).toBe('No matches in 1 file.');
    expect(resultsHeadline(result([], { reasonCode: 'InvalidPattern', message: 'The pattern is not C#.' }))).toBe('The pattern is not C#.');
    expect(nextResultLimit(200)).toBe(400);
    expect(nextResultLimit(4000)).toBe(5000);
  });
});

describe('search panel', () => {
  it('validates every page message', () => {
    expect(parsePanelMessage({ type: 'search' })).toEqual({ type: 'search' });
    expect(parsePanelMessage({ type: 'openMatch', index: 2 })).toEqual({ type: 'openMatch', index: 2 });
    expect(parsePanelMessage({ type: 'openMatch', index: -1 })).toBeUndefined();
    expect(parsePanelMessage({ type: 'save', target: 'disk', name: 'x' })).toBeUndefined();
    expect(parsePanelMessage({ type: 'save', target: 'user', name: 'x', inspection: true, severity: 'loud' })).toEqual({ type: 'save', target: 'user', name: 'x', inspection: true, severity: 'warning' });
    expect(parsePanelMessage({ type: 'change', editor: { text: '$a$', replacement: '', scope: 'galaxy', placeholders: [{ name: 'a', kind: 'type' }, { name: 'zz' }] } })).toEqual({
      type: 'change',
      editor: { text: '$a$', replacement: '', scope: 'solution', placeholders: [{ name: 'a', kind: 'type' }] },
    });
    expect(parsePanelMessage({ type: 'eval', code: 'x' })).toBeUndefined();
    expect(parsePanelMessage('search')).toBeUndefined();
  });

  it('view: problems, pattern list with inspection tags, results and show more', () => {
    const editor = { ...EMPTY_EDITOR, text: '$x$.Result', placeholders: [{ name: 'x' }] };
    const v = panelView({ editor, patterns: [...BUILTIN_PATTERNS, { ...BUILTIN_PATTERNS[1]!, id: 'workspace.e', origin: 'workspace', inspection: { enabled: true, severity: 'hint' } }], busy: false, result: result([match('file:///A.cs', 0, 'a')], { truncated: true }), label: (u) => u });
    expect(v.problems).toEqual([]);
    expect(v.replaceProblems).toEqual(['Enter a replacement.']);
    expect(v.patterns.at(-1)).toEqual({ id: 'workspace.e', name: 'Null or empty check', origin: 'workspace', inspection: 'inspection ORS-Null-or-empty-check (hint)', description: BUILTIN_PATTERNS[1]!.description });
    expect(v.headline).toBe('1+ matches in 1 file (more available).');
    expect(v.canShowMore).toBe(true);
    expect(v.groups).toHaveLength(1);
    expect(panelView({ editor: EMPTY_EDITOR, patterns: [], busy: false, label: (u) => u }).headline).toBe('Enter a pattern and choose Search.');
  });

  it('page: strict CSP with nonces, no remote resources, labelled controls, no inline handlers', () => {
    const html = renderStructuralHtml({ nonce: 'N0NCE', cspSource: 'vscode-resource:', title: 'Structural Search', severities: ['error', 'warning'] });
    expect(html).toContain(`content="default-src 'none'; style-src 'nonce-N0NCE'; script-src 'nonce-N0NCE'; img-src vscode-resource:;"`);
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval|https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toMatch(/<script(?![^>]*nonce=)/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toContain('innerHTML');
    for (const id of ['pattern', 'replacement', 'save-name', 'save-sev']) expect(html, id).toContain(`for="${id}"`);
    expect(html).toContain('<option value="warning" selected>warning</option>');
    expect(html.match(/<button type="button"/g)?.length).toBe(html.match(/<button/g)?.length);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Structural Search</title>');
    expect(html).toMatch(/<svg class="icon"[^>]*aria-hidden="true"/);
  });
});
