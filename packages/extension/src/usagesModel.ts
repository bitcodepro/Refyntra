import type { UsageItem, UsageKind } from '@refyntra/contracts';

// Find Usages grouped: grouping, filters, ordering, Next/Previous and the Markdown export of the Refyntra Usages view.
// Pure: unit-tested with vitest (no vscode).

export type Grouping = 'kind' | 'project' | 'folder' | 'file' | 'type' | 'member';

/** Grouping levels in the order they nest (outermost first) when several are on. */
export const GROUPING_ORDER: readonly Grouping[] = ['kind', 'project', 'folder', 'file', 'type', 'member'];

export const GROUPING_TITLES: Readonly<Record<Grouping, string>> = {
  kind: 'Usage Kind',
  project: 'Project',
  folder: 'Folder',
  file: 'File',
  type: 'Containing Type',
  member: 'Containing Member',
};

export const DEFAULT_GROUPINGS: readonly Grouping[] = ['kind', 'file'];

/** A usage-kind group: the kinds the host reports, plus "tests" (every usage in test code goes there). */
export type KindGroup = UsageKind | 'tests';

export const KIND_ORDER: readonly KindGroup[] = ['invocation', 'objectCreation', 'read', 'write', 'readWrite', 'inheritance', 'typeArgument', 'attribute', 'nameof', 'other', 'tests'];

export const KIND_TITLES: Readonly<Record<KindGroup, string>> = {
  read: 'Read',
  write: 'Write',
  readWrite: 'Read-write',
  invocation: 'Invocation',
  nameof: 'nameof',
  attribute: 'Attribute',
  inheritance: 'Inheritance / implementation',
  typeArgument: 'Type argument',
  objectCreation: 'Object creation',
  other: 'Other reference',
  tests: 'In tests',
};

export const KIND_ICONS: Readonly<Record<KindGroup, string>> = {
  read: 'eye',
  write: 'edit',
  readWrite: 'arrow-swap',
  invocation: 'symbol-method',
  nameof: 'symbol-string',
  attribute: 'symbol-property',
  inheritance: 'type-hierarchy-sub',
  typeArgument: 'symbol-type-parameter',
  objectCreation: 'add',
  other: 'references',
  tests: 'beaker',
};

export type TestsFilter = 'all' | 'only' | 'exclude';

export interface UsageFilters {
  /** Kinds to show; empty = all kinds. */
  kinds: readonly UsageKind[];
  tests: TestsFilter;
}

export const NO_FILTERS: UsageFilters = { kinds: [], tests: 'all' };

export const kindGroupOf = (u: Pick<UsageItem, 'kind' | 'isTest'>): KindGroup => (u.isTest ? 'tests' : u.kind);

export function applyFilters<T extends Pick<UsageItem, 'kind' | 'isTest'>>(items: readonly T[], f: UsageFilters): T[] {
  return items.filter((u) => (f.kinds.length === 0 || f.kinds.includes(u.kind)) && (f.tests === 'all' || (f.tests === 'only') === u.isTest));
}

export function filtersActive(f: UsageFilters): boolean {
  return f.kinds.length > 0 || f.tests !== 'all';
}

/** "kinds: Read, Write · only tests" (view description and export). */
export function describeFilters(f: UsageFilters): string | undefined {
  const parts: string[] = [];
  if (f.kinds.length) parts.push(`kinds: ${f.kinds.map((k) => KIND_TITLES[k]).join(', ')}`);
  if (f.tests === 'only') parts.push('only tests');
  if (f.tests === 'exclude') parts.push('tests excluded');
  return parts.length ? parts.join(' · ') : undefined;
}

/** Path of a file URI relative to the workspace root when it is under it (else the path). */
export function relativePath(uri: string, roots: readonly string[]): string {
  const clean = uri.replace(/[?#].*$/, '');
  for (const r of roots) {
    const root = r.endsWith('/') ? r : `${r}/`;
    if (clean.startsWith(root)) return decodeURIComponent(clean.slice(root.length));
  }
  return decodeURIComponent(clean.replace(/^file:\/\/\/?/, ''));
}

export const fileName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
export const folderOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.');

export interface UsageGroupNode<T> {
  kind: 'group';
  grouping: Grouping;
  /** Stable id: the parent's id plus this key. */
  id: string;
  key: string;
  label: string;
  /** Codicon id. */
  icon: string;
  count: number;
  children: UsageTreeNode<T>[];
}

export interface UsageLeafNode<T> {
  kind: 'usage';
  id: string;
  usage: T;
  /** Position in the ordered, filtered list (Next/Previous). */
  index: number;
}

export type UsageTreeNode<T> = UsageGroupNode<T> | UsageLeafNode<T>;

const GROUP_ICONS: Readonly<Record<Exclude<Grouping, 'kind'>, string>> = { project: 'project', folder: 'folder', file: 'file-code', type: 'symbol-class', member: 'symbol-method' };

function groupKey<T extends UsageItem>(u: T, g: Grouping, roots: readonly string[]): { key: string; label: string; icon: string } {
  const rel = relativePath(u.uri, roots);
  switch (g) {
    case 'kind': {
      const k = kindGroupOf(u);
      return { key: k, label: KIND_TITLES[k], icon: KIND_ICONS[k] };
    }
    case 'project':
      return { key: u.projectName ?? '', label: u.projectName ?? '(no project)', icon: GROUP_ICONS.project };
    case 'folder': {
      const f = folderOf(rel);
      return { key: f, label: f, icon: GROUP_ICONS.folder };
    }
    case 'file':
      return { key: u.uri, label: fileName(rel), icon: GROUP_ICONS.file };
    case 'type':
      return { key: u.containingType ?? '', label: u.containingType ?? '(no type)', icon: GROUP_ICONS.type };
    case 'member':
      return { key: `${u.containingType ?? ''}.${u.containingMember ?? ''}`, label: u.containingMember ?? '(type level)', icon: GROUP_ICONS.member };
  }
}

/** Stable order of the usages: file path, then position (the order the host returns, made explicit). */
export function orderUsages<T extends UsageItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character));
}

/**
 * The tree: the active groupings nest in GROUPING_ORDER; groups of the kind grouping follow KIND_ORDER, other groups
 * are sorted by label; usages keep file/position order. Leaves carry their index in tree (= Next/Previous) order.
 */
export function buildUsageTree<T extends UsageItem>(items: readonly T[], groupings: readonly Grouping[], filters: UsageFilters, roots: readonly string[] = []): { nodes: UsageTreeNode<T>[]; ordered: T[] } {
  const active = GROUPING_ORDER.filter((g) => groupings.includes(g));
  const ordered: T[] = [];
  const build = (list: T[], level: number, parentId: string): UsageTreeNode<T>[] => {
    if (level >= active.length) {
      return list.map((usage) => {
        const index = ordered.length;
        ordered.push(usage);
        return { kind: 'usage', id: `${parentId}/u${usage.uri}#${usage.range.start.line}:${usage.range.start.character}`, usage, index };
      });
    }
    const g = active[level]!;
    const buckets = new Map<string, { label: string; icon: string; items: T[] }>();
    for (const u of list) {
      const k = groupKey(u, g, roots);
      let b = buckets.get(k.key);
      if (!b) buckets.set(k.key, (b = { label: k.label, icon: k.icon, items: [] }));
      b.items.push(u);
    }
    const keys = [...buckets.keys()].sort((a, b) =>
      g === 'kind' ? KIND_ORDER.indexOf(a as KindGroup) - KIND_ORDER.indexOf(b as KindGroup) : buckets.get(a)!.label.localeCompare(buckets.get(b)!.label) || (a < b ? -1 : a > b ? 1 : 0),
    );
    return keys.map((key) => {
      const b = buckets.get(key)!;
      const id = `${parentId}/${g}:${key}`;
      return { kind: 'group', grouping: g, id, key, label: b.label, icon: b.icon, count: b.items.length, children: build(b.items, level + 1, id) };
    });
  };
  const nodes = build(orderUsages(applyFilters(items, filters)), 0, '');
  return { nodes, ordered };
}

/** Next / previous usage index (wraps around); -1 when there is none. */
export function stepIndex(current: number | undefined, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current === undefined || current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/**
 * The preview label of a usage: the source line trimmed (and shortened to `max`), with the highlight of the name
 * moved accordingly. Highlights are [start, end) offsets into the label (TreeItemLabel).
 */
export function previewLabel(line: string, start: number, end: number, max = 120): { label: string; highlights: [number, number][] } {
  const lead = line.length - line.trimStart().length;
  const text = line.trim();
  const s = Math.min(text.length, Math.max(0, start - lead));
  const e = Math.min(text.length, Math.max(s, end - lead));
  if (text.length <= max) return { label: text, highlights: e > s ? [[s, e]] : [] };
  // Too long: keep the name visible (cut the start when it is far right), mark the cuts with "…".
  const from = e > max - 1 ? Math.max(0, Math.min(s - 20, text.length - (max - 1))) : 0;
  const prefix = from > 0 ? '…' : '';
  let room = max - prefix.length;
  const suffix = from + room < text.length ? '…' : '';
  if (suffix) room -= 1;
  const body = text.slice(from, from + room);
  const hs = Math.max(0, s - from) + prefix.length;
  const he = Math.min(e - from + prefix.length, prefix.length + body.length);
  return { label: prefix + body + suffix, highlights: he > hs ? [[hs, he]] : [] };
}

/** "Read · OrderService.Find · Shop.Api" (description and accessible label). */
export function usageDescription(u: Pick<UsageItem, 'kind' | 'isTest' | 'containingMember' | 'containingType' | 'range'>, place: string): string {
  const owner = [u.containingType, u.containingMember].filter(Boolean).join('.');
  return [KIND_TITLES[u.kind], u.isTest ? 'in tests' : undefined, owner || undefined, `${place}:${u.range.start.line + 1}`].filter(Boolean).join(' · ');
}

export interface ExportInput<T extends UsageItem> {
  subject: string;
  total: number;
  truncated: boolean;
  items: readonly T[];
  groupings: readonly Grouping[];
  filters: UsageFilters;
  roots: readonly string[];
}

const mdEscape = (s: string): string => s.replace(/([\\`*_[\]#|<>])/g, '\\$1');

/** The current tree as Markdown: headings per group level (up to ####, then bullets), one bullet per usage with its line. */
export function usagesToMarkdown<T extends UsageItem>(input: ExportInput<T>): string {
  const { nodes, ordered } = buildUsageTree(input.items, input.groupings, input.filters, input.roots);
  const lines: string[] = [`# Usages of ${mdEscape(input.subject)}`, ''];
  const shown = ordered.length;
  const filters = describeFilters(input.filters);
  lines.push(`${shown} shown of ${input.total}${input.truncated ? ' (list capped by the search limit)' : ''}${filters ? `; filters: ${filters}` : ''}.`, '');
  const walk = (list: UsageTreeNode<T>[], depth: number) => {
    for (const n of list) {
      if (n.kind === 'group') {
        if (depth < 3) lines.push(`${'#'.repeat(depth + 2)} ${mdEscape(n.label)} (${n.count})`, '');
        else lines.push(`${'  '.repeat(depth - 3)}- **${mdEscape(n.label)}** (${n.count})`);
        walk(n.children, depth + 1);
        if (depth < 3) lines.push('');
      } else {
        const u = n.usage;
        const rel = relativePath(u.uri, input.roots);
        const indent = depth > 3 ? '  '.repeat(depth - 3) : '';
        lines.push(`${indent}- ${mdEscape(rel)}:${u.range.start.line + 1} — ${KIND_TITLES[u.kind]}${u.isTest ? ', in tests' : ''}: \`${u.lineText.trim().replace(/`/g, "'")}\``);
      }
    }
  };
  walk(nodes, 0);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Usage kinds with their counts in a result (the kind filter shows them). */
export function kindCounts(items: readonly Pick<UsageItem, 'kind'>[]): { kind: UsageKind; count: number }[] {
  const m = new Map<UsageKind, number>();
  for (const u of items) m.set(u.kind, (m.get(u.kind) ?? 0) + 1);
  return KIND_ORDER.filter((k): k is UsageKind => k !== 'tests' && m.has(k as UsageKind)).map((kind) => ({ kind, count: m.get(kind)! }));
}

/** The next search limit for "Show more" (×4, at most 50000). */
export const nextLimit = (limit: number): number => Math.min(50000, limit * 4);
