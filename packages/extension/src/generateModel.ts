// Rider-style Generate (Alt+Insert) for C#, computed by the C# host (protocol 1.10, code/generate).
// Pure: unit-tested with vitest (no vscode). The command (generate.ts) shows these as QuickPicks.

export const GENERATE_COMMAND = 'refyntra.generate';

export type GenerateKindId = 'constructor' | 'equality' | 'toString' | 'properties' | 'implement' | 'overrides' | 'delegating';

export interface GenerateMemberData {
  id: string;
  name: string;
  detail: string;
  picked: boolean;
  group?: string | null;
}

export interface GenerateKindData {
  kind: GenerateKindId;
  title: string;
  members: GenerateMemberData[];
}

/** Order and icon of each kind in the picker (Rider's Generate menu order). */
export const GENERATE_KINDS: Readonly<Record<GenerateKindId, { order: number; icon: string; noun: string }>> = {
  constructor: { order: 0, icon: 'symbol-constructor', noun: 'members to initialise' },
  properties: { order: 1, icon: 'symbol-property', noun: 'fields' },
  implement: { order: 2, icon: 'symbol-interface', noun: 'missing members' },
  overrides: { order: 3, icon: 'symbol-method', noun: 'members to override' },
  delegating: { order: 4, icon: 'symbol-field', noun: 'members to delegate' },
  equality: { order: 5, icon: 'symbol-operator', noun: 'members to compare' },
  toString: { order: 6, icon: 'symbol-string', noun: 'members to show' },
};

const isKind = (k: unknown): k is GenerateKindId => typeof k === 'string' && Object.prototype.hasOwnProperty.call(GENERATE_KINDS, k);

/** Known kinds with valid members, in the picker order. */
export function generateKinds(kinds: readonly GenerateKindData[]): GenerateKindData[] {
  return kinds
    .filter((k) => k && isKind(k.kind) && typeof k.title === 'string' && Array.isArray(k.members))
    .map((k) => ({ ...k, members: k.members.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string') }))
    .sort((a, b) => GENERATE_KINDS[a.kind].order - GENERATE_KINDS[b.kind].order);
}

/** The first QuickPick: one item per kind. */
export function kindPickItems(kinds: readonly GenerateKindData[]): { label: string; description: string; kindId: GenerateKindId }[] {
  return generateKinds(kinds).map((k) => ({
    label: `$(${GENERATE_KINDS[k.kind].icon}) ${k.title}`,
    description: k.members.length ? `${k.members.length} ${GENERATE_KINDS[k.kind].noun}` : '',
    kindId: k.kind,
  }));
}

/** Missing members are all generated (no member picker); every other kind lets the user choose. */
export function needsMemberPick(kind: GenerateKindId): boolean {
  return kind !== 'implement';
}

/** A constructor may take no parameters; every other kind needs at least one member. */
export function allowsEmptySelection(kind: GenerateKindId): boolean {
  return kind === 'constructor';
}

/** Delegating: the fields / properties members can be delegated through, in host order. */
export function delegationGroups(members: readonly GenerateMemberData[]): string[] {
  return [...new Set(members.map((m) => m.group).filter((g): g is string => typeof g === 'string' && g.length > 0))];
}

/** The member QuickPick items (of one delegation group when given). */
export function memberPickItems(members: readonly GenerateMemberData[], group?: string): { label: string; description: string; picked: boolean; id: string }[] {
  return members.filter((m) => group === undefined || m.group === group).map((m) => ({ label: m.name, description: m.detail, picked: !!m.picked, id: m.id }));
}

export const EQUALITY_OPTIONS = [
  { id: 'equatable', label: 'Implement IEquatable<T>', picked: true },
  { id: 'operators', label: 'Generate == and != operators', picked: false },
] as const;

export interface GenerateRequestData {
  kind: GenerateKindId;
  members?: string[];
  equatable?: boolean;
  operators?: boolean;
}

/** The host request of a kind: the picked member ids and (equality) the picked options. */
export function generateRequest(kind: GenerateKindId, memberIds: readonly string[] | undefined, options: readonly string[] = []): GenerateRequestData {
  const r: GenerateRequestData = { kind };
  if (memberIds) r.members = [...memberIds];
  if (kind === 'equality') {
    r.equatable = options.includes('equatable');
    r.operators = options.includes('operators');
  }
  return r;
}

/** The optional argument of GENERATE_COMMAND (a request to run without pickers), or undefined when absent or malformed. */
export function parseGenerateRequest(arg: unknown): GenerateRequestData | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { kind?: unknown; members?: unknown; equatable?: unknown; operators?: unknown };
  if (!isKind(a.kind)) return undefined;
  if (a.members !== undefined && !(Array.isArray(a.members) && a.members.every((m) => typeof m === 'string'))) return undefined;
  const r: GenerateRequestData = { kind: a.kind };
  if (Array.isArray(a.members)) r.members = [...(a.members as string[])];
  if (typeof a.equatable === 'boolean') r.equatable = a.equatable;
  if (typeof a.operators === 'boolean') r.operators = a.operators;
  return r;
}
