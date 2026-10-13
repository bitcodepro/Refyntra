import type { Range, StructureAccessibility, StructureMember, StructureMemberKind, StructureType, StructureTypeKind } from '@refyntra/contracts';
import { MatchRank, matchRank } from './searchEverywhereModel';

// File Structure (Rider's Ctrl+F12): sections per type and #region, filters, camel-hump matching and the row at the
// cursor. Pure: unit-tested with vitest (no vscode). The C# host answers code/fileStructure (protocol 1.13); other
// languages fall back to VS Code's document symbols (fromDocumentSymbols).

export type StructureFilter = 'methods' | 'properties' | 'fields' | 'events' | 'nestedTypes' | 'inherited';

export const FILTER_ORDER: readonly StructureFilter[] = ['methods', 'properties', 'fields', 'events', 'nestedTypes', 'inherited'];

export const FILTER_TITLES: Readonly<Record<StructureFilter, string>> = {
  methods: 'methods',
  properties: 'properties',
  fields: 'fields',
  events: 'events',
  nestedTypes: 'nested types',
  inherited: 'inherited members',
};

export const FILTER_ICONS: Readonly<Record<StructureFilter, string>> = {
  methods: 'symbol-method',
  properties: 'symbol-property',
  fields: 'symbol-field',
  events: 'symbol-event',
  nestedTypes: 'symbol-class',
  inherited: 'type-hierarchy-super',
};

/** true = shown. Inherited members are off by default (Rider's "Show inherited members"). */
export type StructureFilters = Readonly<Record<StructureFilter, boolean>>;

export const DEFAULT_FILTERS: StructureFilters = { methods: true, properties: true, fields: true, events: true, nestedTypes: true, inherited: false };

/** Reads stored filters back (unknown keys ignored, missing ones default). */
export function loadFilters(value: unknown): StructureFilters {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<StructureFilter, unknown>>;
  const out = { ...DEFAULT_FILTERS };
  for (const f of FILTER_ORDER) if (typeof v[f] === 'boolean') out[f] = v[f] as boolean;
  return out;
}

/** The filter a member kind belongs to. */
export function filterOf(kind: StructureMemberKind): StructureFilter {
  switch (kind) {
    case 'method':
    case 'constructor':
    case 'destructor':
    case 'operator':
      return 'methods';
    case 'property':
    case 'indexer':
      return 'properties';
    case 'event':
      return 'events';
    default:
      return 'fields';
  }
}

const MEMBER_ICONS: Readonly<Record<StructureMemberKind, string>> = {
  method: 'symbol-method',
  constructor: 'symbol-constructor',
  destructor: 'symbol-method',
  operator: 'symbol-operator',
  property: 'symbol-property',
  indexer: 'symbol-property',
  field: 'symbol-field',
  constant: 'symbol-constant',
  event: 'symbol-event',
  enumMember: 'symbol-enum-member',
};

const TYPE_ICONS: Readonly<Record<StructureTypeKind, string>> = {
  class: 'symbol-class',
  record: 'symbol-class',
  struct: 'symbol-struct',
  recordStruct: 'symbol-struct',
  interface: 'symbol-interface',
  enum: 'symbol-enum',
  delegate: 'symbol-method',
};

const KIND_WORDS: Readonly<Record<StructureMemberKind | StructureTypeKind, string>> = {
  method: 'method',
  constructor: 'constructor',
  destructor: 'finalizer',
  operator: 'operator',
  property: 'property',
  indexer: 'indexer',
  field: 'field',
  constant: 'constant',
  event: 'event',
  enumMember: 'enum member',
  class: 'class',
  record: 'record',
  struct: 'struct',
  recordStruct: 'record struct',
  interface: 'interface',
  enum: 'enum',
  delegate: 'delegate',
};

const ACCESS_WORDS: Readonly<Record<StructureAccessibility, string>> = {
  public: 'public',
  internal: 'internal',
  protected: 'protected',
  private: 'private',
  protectedInternal: 'protected internal',
  privateProtected: 'private protected',
};

export interface StructureInput {
  types: readonly StructureType[];
  /** False for the document-symbol fallback: no accessibility is known. */
  accessibility: boolean;
  /** False for the fallback: no inherited members can be asked for. */
  inheritedAvailable: boolean;
  /** The fallback's section of top-level functions and variables (named after the file; it has no type row). */
  fileSection?: string;
}

export interface StructureRow {
  id: string;
  /** Codicon id. */
  icon: string;
  /** The signature ("Find(int) : OrderDto?") or the type name. */
  label: string;
  /** Kind and accessibility in words ("method · private static"), the declaring type of inherited members. */
  description: string;
  kind: StructureMemberKind | StructureTypeKind;
  isType: boolean;
  inherited: boolean;
  navigable: boolean;
  /** Undefined: the active document. */
  uri?: string;
  range: Range;
  selectionRange: Range;
}

export interface StructureSection {
  title: string;
  rows: StructureRow[];
}

const memberId = (t: StructureType, m: StructureMember): string => `${t.fullName}.${m.name}@${m.selectionRange.start.line}:${m.selectionRange.start.character}`;

function describe(kind: StructureMemberKind | StructureTypeKind, access: StructureAccessibility, isStatic: boolean, withAccess: boolean): string {
  const words = [KIND_WORDS[kind]];
  if (withAccess) words.push(`${ACCESS_WORDS[access]}${isStatic ? ' static' : ''}`);
  else if (isStatic) words.push('static');
  return words.join(' · ');
}

/** Name match for type-to-filter: exact, prefix, camel humps (`gO` finds GetOrder) or substring. */
export function nameMatches(query: string, name: string): boolean {
  const q = query.trim();
  return !q || matchRank(q, name) !== MatchRank.None;
}

/**
 * The sections the list shows: per type (in source order) its own row and members, a new section whenever the
 * `#region` changes, then the inherited members per declaring type. Filters hide member kinds, nested types and
 * inherited members; the query keeps rows whose name matches.
 */
export function structureSections(input: StructureInput, filters: StructureFilters, query = ''): StructureSection[] {
  const out: StructureSection[] = [];
  const q = query.trim();
  for (const t of input.types) {
    if (t.containingType && !filters.nestedTypes) continue;
    const typeRow: StructureRow = {
      id: `type:${t.fullName}`,
      icon: TYPE_ICONS[t.kind] ?? 'symbol-class',
      label: t.fullName,
      description: describe(t.kind, t.accessibility, t.isStatic, input.accessibility),
      kind: t.kind,
      isType: true,
      inherited: false,
      navigable: true,
      range: t.range,
      selectionRange: t.selectionRange,
    };
    const sections: StructureSection[] = [];
    let current: StructureSection | undefined;
    let region: string | null = null;
    const typeTitle = t.signature || t.fullName;
    if (t.fullName !== input.fileSection && nameMatches(q, t.name)) {
      current = { title: typeTitle, rows: [typeRow] };
      sections.push(current);
    }
    for (const m of t.members) {
      if (!filters[filterOf(m.kind)] || !nameMatches(q, m.name)) continue;
      const r = m.region ?? null;
      if (!current || r !== region) {
        current = { title: r ? `${t.fullName} · #region ${r}` : current && region ? `${t.fullName}` : typeTitle, rows: [] };
        sections.push(current);
        region = r;
      }
      current.rows.push({
        id: memberId(t, m),
        icon: MEMBER_ICONS[m.kind] ?? 'symbol-misc',
        label: m.signature || m.name,
        description: describe(m.kind, m.accessibility, m.isStatic, input.accessibility),
        kind: m.kind,
        isType: false,
        inherited: false,
        navigable: true,
        range: m.range,
        selectionRange: m.selectionRange,
      });
    }
    if (filters.inherited && input.inheritedAvailable) {
      const byType = new Map<string, StructureMember[]>();
      for (const m of t.inherited) {
        if (!filters[filterOf(m.kind)] || !nameMatches(q, m.name)) continue;
        const key = m.declaringType ?? '?';
        byType.set(key, [...(byType.get(key) ?? []), m]);
      }
      for (const [declaring, members] of byType) {
        sections.push({
          title: `${t.fullName} · inherited from ${declaring}`,
          rows: members.map((m) => ({
            id: `inherited:${t.fullName}:${declaring}.${m.name}:${m.signature}`,
            icon: MEMBER_ICONS[m.kind] ?? 'symbol-misc',
            label: m.signature || m.name,
            description: [describe(m.kind, m.accessibility, m.isStatic, input.accessibility), m.navigable ? '' : 'no source (metadata)'].filter(Boolean).join(' · '),
            kind: m.kind,
            isType: false,
            inherited: true,
            navigable: m.navigable && !!m.uri,
            ...(m.uri ? { uri: m.uri } : {}),
            range: m.range,
            selectionRange: m.selectionRange,
          })),
        });
      }
    }
    out.push(...sections.filter((s) => s.rows.length > 0));
  }
  return out;
}

/** The row to select first: the innermost own row whose declaration contains the line (Rider starts at the caret). */
export function rowAtLine(sections: readonly StructureSection[], line: number): StructureRow | undefined {
  let best: StructureRow | undefined;
  for (const s of sections)
    for (const r of s.rows) {
      if (r.inherited || r.range.start.line > line || r.range.end.line < line) continue;
      if (!best || r.range.start.line > best.range.start.line || (r.range.start.line === best.range.start.line && r.range.end.line <= best.range.end.line)) best = r;
    }
  return best;
}

/** Filters that are off, in words, for the title ("hidden: fields, events"). */
export function hiddenFiltersText(filters: StructureFilters, inheritedAvailable: boolean): string {
  const hidden = FILTER_ORDER.filter((f) => f !== 'inherited' && !filters[f]).map((f) => FILTER_TITLES[f]);
  const parts: string[] = [];
  if (hidden.length) parts.push(`hidden: ${hidden.join(', ')}`);
  if (inheritedAvailable && filters.inherited) parts.push('with inherited members');
  return parts.join('; ');
}

// ---- Fallback: VS Code document symbols ----------------------------------------------------------------------------

/** A document symbol reduced to what File Structure needs (VS Code SymbolKind numbers). */
export interface DocSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children: readonly DocSymbol[];
}

// vscode.SymbolKind: File 0, Module 1, Namespace 2, Package 3, Class 4, Method 5, Property 6, Field 7, Constructor 8,
// Enum 9, Interface 10, Function 11, Variable 12, Constant 13, String 14, Number 15, Boolean 16, Array 17, Object 18,
// Key 19, Null 20, EnumMember 21, Struct 22, Event 23, Operator 24, TypeParameter 25.
const CONTAINER_KINDS: Readonly<Record<number, StructureTypeKind>> = { 4: 'class', 9: 'enum', 10: 'interface', 22: 'struct', 18: 'class' };
const NAMESPACE_KINDS = new Set([0, 1, 2, 3]);

function memberKind(kind: number): StructureMemberKind {
  switch (kind) {
    case 5:
    case 11:
      return 'method';
    case 8:
      return 'constructor';
    case 6:
    case 19:
      return 'property';
    case 13:
      return 'constant';
    case 21:
      return 'enumMember';
    case 23:
      return 'event';
    case 24:
      return 'operator';
    default:
      return 'field';
  }
}

/**
 * Document symbols as File Structure input: classes, interfaces, structs, enums (and objects) become types, their
 * children members; top-level functions and variables go into a section named after the file.
 */
export function fromDocumentSymbols(symbols: readonly DocSymbol[], fileName: string): StructureInput {
  const types: StructureType[] = [];
  const topLevel: StructureMember[] = [];
  const member = (s: DocSymbol): StructureMember => ({
    name: s.name,
    kind: memberKind(s.kind),
    accessibility: 'public',
    isStatic: false,
    signature: s.detail && (s.kind === 5 || s.kind === 11 || s.kind === 8) ? `${s.name}${s.detail.startsWith('(') ? s.detail : ''}` : s.name,
    range: s.range,
    selectionRange: s.selectionRange,
    navigable: true,
  });
  const visit = (s: DocSymbol, container: string | undefined) => {
    if (NAMESPACE_KINDS.has(s.kind)) {
      for (const c of s.children) visit(c, container);
      return;
    }
    const typeKind = CONTAINER_KINDS[s.kind];
    if (!typeKind) {
      if (container === undefined) topLevel.push(member(s));
      return;
    }
    const fullName = container ? `${container}.${s.name}` : s.name;
    const members: StructureMember[] = [];
    types.push({ name: s.name, fullName, kind: typeKind, accessibility: 'public', isStatic: false, signature: fullName, range: s.range, selectionRange: s.selectionRange, containingType: container ?? null, members, inherited: [] });
    for (const c of s.children) {
      if (CONTAINER_KINDS[c.kind] || NAMESPACE_KINDS.has(c.kind)) visit(c, fullName);
      else members.push(member(c));
    }
  };
  for (const s of symbols) visit(s, undefined);
  if (topLevel.length) {
    const first = topLevel[0]!;
    types.unshift({ name: fileName, fullName: fileName, kind: 'class', accessibility: 'public', isStatic: false, signature: fileName, range: first.range, selectionRange: first.selectionRange, containingType: null, members: topLevel, inherited: [] });
  }
  types.sort((a, b) => a.range.start.line - b.range.start.line);
  return { types, accessibility: false, inheritedAvailable: false, ...(topLevel.length ? { fileSection: fileName } : {}) };
}
