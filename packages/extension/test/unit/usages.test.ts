import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageItem, UsageKind } from '@refyntra/contracts';
import {
  NO_FILTERS,
  type UsageTreeNode,
  applyFilters,
  buildUsageTree,
  describeFilters,
  kindCounts,
  nextLimit,
  previewLabel,
  relativePath,
  stepIndex,
  usageDescription,
  usagesToMarkdown,
} from '../../src/usagesModel';

const ROOT = 'file:///ws';
let n = 0;
function u(file: string, line: number, kind: UsageKind, opts: Partial<UsageItem> = {}): UsageItem {
  n++;
  return {
    uri: `${ROOT}/${file}`,
    range: { start: { line, character: 8 }, end: { line, character: 13 } },
    kind,
    containingMember: 'Run',
    containingType: 'Uses',
    projectName: file.split('/')[0]!,
    isTest: false,
    lineText: `        order.Count = ${n};`,
    ...opts,
  };
}

const ITEMS: UsageItem[] = [
  u('App/Uses.cs', 10, 'write'),
  u('App/Uses.cs', 4, 'read'),
  u('App/Sub/More.cs', 2, 'invocation', { containingType: 'More', containingMember: 'Go' }),
  u('Lib/Order.cs', 20, 'readWrite', { containingType: 'Order', containingMember: 'Touch' }),
  u('Tests/OrderTests.cs', 7, 'write', { isTest: true, containingType: 'OrderTests', containingMember: 'Counts' }),
];

/** The tree as indented "label (count)" / "file:line" lines. */
function render(nodes: UsageTreeNode<UsageItem>[], depth = 0): string[] {
  return nodes.flatMap((x) =>
    x.kind === 'group' ? [`${'  '.repeat(depth)}${x.label} (${x.count})`, ...render(x.children, depth + 1)] : [`${'  '.repeat(depth)}${x.usage.uri.slice(ROOT.length + 1)}:${x.usage.range.start.line + 1} #${x.index}`],
  );
}

describe('usages grouping', () => {
  it('groups by kind (fixed order, tests in their own group) then file, with counts', () => {
    const { nodes } = buildUsageTree(ITEMS, ['kind', 'file'], NO_FILTERS, [ROOT]);
    expect(render(nodes)).toEqual([
      'Invocation (1)',
      '  More.cs (1)',
      '    App/Sub/More.cs:3 #0',
      'Read (1)',
      '  Uses.cs (1)',
      '    App/Uses.cs:5 #1',
      'Write (1)',
      '  Uses.cs (1)',
      '    App/Uses.cs:11 #2',
      'Read-write (1)',
      '  Order.cs (1)',
      '    Lib/Order.cs:21 #3',
      'In tests (1)',
      '  OrderTests.cs (1)',
      '    Tests/OrderTests.cs:8 #4',
    ]);
  });

  it('nests in a fixed order whatever order the groupings were switched on', () => {
    const a = render(buildUsageTree(ITEMS, ['member', 'project'], NO_FILTERS, [ROOT]).nodes);
    const b = render(buildUsageTree(ITEMS, ['project', 'member'], NO_FILTERS, [ROOT]).nodes);
    expect(a).toEqual(b);
    expect(a.slice(0, 4)).toEqual(['App (3)', '  Go (1)', '    App/Sub/More.cs:3 #0', '  Run (2)']);
  });

  it('folder and containing type groupings; no grouping = a flat list in file/position order', () => {
    expect(render(buildUsageTree(ITEMS, ['folder'], NO_FILTERS, [ROOT]).nodes).filter((l) => !l.startsWith(' '))).toEqual(['App (2)', 'App/Sub (1)', 'Lib (1)', 'Tests (1)']);
    expect(render(buildUsageTree(ITEMS, ['type'], NO_FILTERS, [ROOT]).nodes).filter((l) => !l.startsWith(' '))).toEqual(['More (1)', 'Order (1)', 'OrderTests (1)', 'Uses (2)']);
    expect(render(buildUsageTree(ITEMS, [], NO_FILTERS, [ROOT]).nodes)).toEqual(['App/Sub/More.cs:3 #0', 'App/Uses.cs:5 #1', 'App/Uses.cs:11 #2', 'Lib/Order.cs:21 #3', 'Tests/OrderTests.cs:8 #4']);
  });

  it('leaf ids are unique and stable across rebuilds', () => {
    const ids = (g: Parameters<typeof buildUsageTree>[1]) => {
      const out: string[] = [];
      const walk = (ns: UsageTreeNode<UsageItem>[]) => ns.forEach((x) => (out.push(x.id), x.kind === 'group' && walk(x.children)));
      walk(buildUsageTree(ITEMS, g, NO_FILTERS, [ROOT]).nodes);
      return out;
    };
    expect(new Set(ids(['kind', 'file'])).size).toBe(ids(['kind', 'file']).length);
    expect(ids(['kind', 'file'])).toEqual(ids(['kind', 'file']));
  });
});

describe('usages filters', () => {
  it('kinds multi-select and tests only / excluded', () => {
    expect(applyFilters(ITEMS, { kinds: ['write'], tests: 'all' })).toHaveLength(2);
    expect(applyFilters(ITEMS, { kinds: ['write'], tests: 'exclude' })).toHaveLength(1);
    expect(applyFilters(ITEMS, { kinds: [], tests: 'only' }).map((x) => x.containingMember)).toEqual(['Counts']);
    expect(applyFilters(ITEMS, { kinds: ['read', 'invocation'], tests: 'all' })).toHaveLength(2);
    expect(describeFilters({ kinds: ['read', 'readWrite'], tests: 'exclude' })).toBe('kinds: Read, Read-write · tests excluded');
    expect(describeFilters(NO_FILTERS)).toBeUndefined();
  });

  it('a filtered tree numbers only the visible usages (Next/Previous skip hidden ones)', () => {
    const { ordered } = buildUsageTree(ITEMS, ['kind'], { kinds: [], tests: 'exclude' }, [ROOT]);
    expect(ordered).toHaveLength(4);
    expect(ordered.every((x) => !x.isTest)).toBe(true);
  });

  it('kind counts follow the kind order', () => {
    expect(kindCounts(ITEMS)).toEqual([
      { kind: 'invocation', count: 1 },
      { kind: 'read', count: 1 },
      { kind: 'write', count: 2 },
      { kind: 'readWrite', count: 1 },
    ]);
  });
});

describe('usages navigation and presentation', () => {
  it('Next / Previous wrap around', () => {
    expect(stepIndex(undefined, 3, 1)).toBe(0);
    expect(stepIndex(undefined, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(5, 3, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });

  it('preview label: trimmed line with the name highlighted', () => {
    expect(previewLabel('        order.Count = 1;', 14, 19)).toEqual({ label: 'order.Count = 1;', highlights: [[6, 11]] });
    expect(previewLabel('x', 5, 9)).toEqual({ label: 'x', highlights: [] });
  });

  it('preview label of a long line keeps the name visible and marks the cuts', () => {
    const line = `${'a'.repeat(200)} Target ${'b'.repeat(100)}`;
    const p = previewLabel(line, 201, 207, 60);
    expect(p.label.length).toBe(60);
    expect(p.label.startsWith('…') && p.label.endsWith('…')).toBe(true);
    const [s, e] = p.highlights[0]!;
    expect(p.label.slice(s, e)).toBe('Target');
    const short = previewLabel(`Target ${'c'.repeat(100)}`, 0, 6, 40);
    expect(short.label.slice(0, 6)).toBe('Target');
    expect(short.label.endsWith('…')).toBe(true);
    expect(short.highlights).toEqual([[0, 6]]);
  });

  it('description and relative paths', () => {
    expect(usageDescription(ITEMS[4]!, 'OrderTests.cs')).toBe('Write · in tests · OrderTests.Counts · OrderTests.cs:8');
    expect(relativePath(`${ROOT}/App/My%20File.cs`, [ROOT])).toBe('App/My File.cs');
    expect(relativePath('file:///elsewhere/X.cs', [ROOT])).toBe('elsewhere/X.cs');
    expect(nextLimit(1000)).toBe(4000);
    expect(nextLimit(40000)).toBe(50000);
  });

  it('exports the shown tree to Markdown', () => {
    const md = usagesToMarkdown({ subject: 'Order.Count', total: 9, truncated: true, items: ITEMS, groupings: ['kind'], filters: { kinds: [], tests: 'exclude' }, roots: [ROOT] });
    expect(md).toBe(
      [
        '# Usages of Order.Count',
        '',
        '4 shown of 9 (list capped by the search limit); filters: tests excluded.',
        '',
        '## Invocation (1)',
        '',
        '- App/Sub/More.cs:3 — Invocation: `order.Count = 3;`',
        '',
        '## Read (1)',
        '',
        '- App/Uses.cs:5 — Read: `order.Count = 2;`',
        '',
        '## Write (1)',
        '',
        '- App/Uses.cs:11 — Write: `order.Count = 1;`',
        '',
        '## Read-write (1)',
        '',
        '- Lib/Order.cs:21 — Read-write: `order.Count = 4;`',
        '',
      ].join('\n'),
    );
  });
});

describe('usages contributions', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; when: string }[]; views: Record<string, { id: string; when?: string }[]>; menus: Record<string, { command: string; when?: string }[]> };
  };

  it('F4 / Shift+F4 only with results, in a C# editor, outside the reference peek', () => {
    const keys = pkg.contributes.keybindings.filter((k) => k.command.startsWith('refyntra.usages.'));
    expect(keys.map((k) => [k.command, k.key, /preset == '(\w+)'/.exec(k.when)?.[1]])).toEqual([
      ['refyntra.usages.next', 'f4', 'visualStudio'],
      ['refyntra.usages.previous', 'shift+f4', 'visualStudio'],
      ['refyntra.usages.next', 'f4', 'resharper'],
      ['refyntra.usages.previous', 'shift+f4', 'resharper'],
    ]);
    for (const k of keys) for (const part of ['refyntra.usagesHasResults', 'editorTextFocus', 'editorLangId == csharp', '!referenceSearchVisible']) expect(k.when).toContain(part);
  });

  it('the view is in the Refyntra container and every grouping has a toggle in the view menu', () => {
    expect(pkg.contributes.views.refyntra!.some((v) => v.id === 'refyntra.usagesView')).toBe(true);
    const title = pkg.contributes.menus['view/title']!.filter((m) => m.when?.includes('refyntra.usagesView')).map((m) => m.command);
    for (const g of ['kind', 'project', 'folder', 'file', 'type', 'member']) {
      expect(title).toContain(`refyntra.usages.group.${g}`);
      expect(title).toContain(`refyntra.usages.ungroup.${g}`);
    }
    for (const c of ['refyntra.usages.filterKinds', 'refyntra.usages.filterTests', 'refyntra.usages.export', 'refyntra.usages.pin', 'refyntra.usages.unpin', 'refyntra.usages.next', 'refyntra.usages.previous']) expect(title).toContain(c);
  });
});
