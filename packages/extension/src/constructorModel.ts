// Constructor and DI helpers (protocol 1.11, code/constructorActions): the C# host lists the actions at a position and
// computes them with Roslyn (semantic types, usings, partial types, naming rules, compile check). This module is the
// pure glue between the host's answers and the editor (code action specs, pickers, hash checks); unit-tested with vitest.

/** What a code action passes to its command: the document and the cursor offset. */
export interface CtorTarget {
  uri: string;
  offset: number;
}

/** The host's action (code/constructorActions items). */
export interface CtorActionItem {
  actionId: string;
  title: string;
  kind: 'quickfix' | 'rewrite';
  preferred: boolean;
  member?: string | null;
  members?: string[] | null;
  typeId?: string | null;
}

/** What a command needs from the item to compute it again on the host. */
export interface CtorActionArgs {
  actionId: string;
  member?: string;
  members?: string[];
  typeId?: string;
  type?: string;
  constructorId?: string;
}

export const CTOR_PREFIX = 'csharp.ctor.';
export const REGISTER_DI_ACTION = 'csharp.ctor.registerDi';
export const GENERATE_ACTION = 'csharp.ctor.generate';
export const CREATE_INJECTED_ACTION = 'csharp.ctor.createInjectedField';
export const ADD_PARAMETERS_ACTION = 'csharp.ctor.addParameters';
export const INITIALIZE_ALL_ACTION = 'csharp.ctor.initializeAllParameters';
export const INITIALIZE_MEMBERS_ACTION = 'csharp.ctor.initializeMembers';

/** The command each host action runs (the command ids of the earlier text-based helpers are kept). */
const COMMANDS: Readonly<Record<string, string>> = {
  'csharp.ctor.introduceField': 'refyntra.ctor.introduce',
  'csharp.ctor.introduceProperty': 'refyntra.ctor.introduce',
  'csharp.ctor.initializeExisting': 'refyntra.ctor.introduce',
  'csharp.ctor.initializeAllParameters': 'refyntra.ctor.initializeAllParameters',
  'csharp.ctor.initializeMembers': 'refyntra.ctor.initializeMembers',
  'csharp.ctor.addParameters': 'refyntra.ctor.addParameters',
  'csharp.ctor.createInjectedField': 'refyntra.ctor.createInjectedField',
  'csharp.ctor.registerDi': 'refyntra.ctor.registerDi',
  'csharp.ctor.generate': 'refyntra.ctor.generate',
};

export interface CtorActionSpec {
  title: string;
  /** Editor kind: quickfix.refyntra.constructor or refactor.rewrite.refyntra.constructor. */
  kind: 'quickfix' | 'rewrite';
  command: string;
  args: CtorActionArgs;
  preferred: boolean;
}

/** Valid host items as code action specs, in host order, without duplicates (same action and title). */
export function ctorActionSpecs(items: readonly CtorActionItem[]): CtorActionSpec[] {
  const out: CtorActionSpec[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (!i || typeof i.actionId !== 'string' || !i.actionId.startsWith(CTOR_PREFIX) || typeof i.title !== 'string') continue;
    const command = COMMANDS[i.actionId];
    if (!command) continue;
    const args: CtorActionArgs = { actionId: i.actionId };
    if (typeof i.member === 'string') args.member = i.member;
    if (Array.isArray(i.members)) args.members = i.members.filter((m) => typeof m === 'string');
    if (typeof i.typeId === 'string') args.typeId = i.typeId;
    const key = `${i.actionId}|${i.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: i.title, kind: i.kind === 'quickfix' ? 'quickfix' : 'rewrite', command, args, preferred: !!i.preferred });
  }
  return out;
}

/** The arguments of a ctor command, or undefined when malformed (a command can also be run from a keybinding). */
export function parseCtorArgs(arg: unknown, fallbackActionId: string): CtorActionArgs {
  if (!arg || typeof arg !== 'object') return { actionId: fallbackActionId };
  const a = arg as Record<string, unknown>;
  const out: CtorActionArgs = { actionId: typeof a.actionId === 'string' && a.actionId.startsWith(CTOR_PREFIX) ? a.actionId : fallbackActionId };
  if (typeof a.member === 'string') out.member = a.member;
  if (Array.isArray(a.members)) out.members = a.members.filter((m): m is string => typeof m === 'string');
  if (typeof a.typeId === 'string') out.typeId = a.typeId;
  if (typeof a.type === 'string') out.type = a.type;
  return out;
}

/** A choice the host asks for (members, a constructor, a type, an implementation, a composition root). */
export interface ChoiceItem {
  id: string;
  label: string;
  detail?: string | null;
  picked: boolean;
}

/** QuickPick items of host choices; `picked` preselects in a multi-select picker. */
export function choiceItems(choices: readonly ChoiceItem[]): { label: string; description?: string; picked: boolean; id: string }[] {
  return choices.map((c) => ({ label: c.label, ...(c.detail ? { description: c.detail } : {}), picked: !!c.picked, id: c.id }));
}

/** The request after the user's answer to a host question. */
export function answer(args: CtorActionArgs, need: 'members' | 'constructor' | 'type', picked: readonly string[]): CtorActionArgs {
  if (need === 'members') return { ...args, members: [...picked] };
  if (need === 'constructor') return { ...args, constructorId: picked[0] };
  return { ...args, type: picked[0] };
}

/** A type name the user may type instead of picking a choice. */
export function isTypeName(text: string): boolean {
  return /^[A-Za-z_][\w.]*(<[\w.<>, ?[\]]+>)?\??(\[\])*$/.test(text.trim());
}

export type Lifetime = 'Scoped' | 'Transient' | 'Singleton';

export const LIFETIME_ITEMS: readonly { label: Lifetime; description: string }[] = [
  { label: 'Scoped', description: 'one per request / scope (default for services using a DbContext)' },
  { label: 'Transient', description: 'a new instance every time' },
  { label: 'Singleton', description: 'one for the application (must be thread-safe, no scoped dependencies)' },
];

/** The files whose current text is not the text the host computed the edits for (nothing is applied then). */
export function staleFiles(files: readonly { uri: string; documentHash: string }[], currentHash: (uri: string) => string | undefined): string[] {
  return files.filter((f) => currentHash(f.uri) !== f.documentHash).map((f) => f.uri);
}

/** The title of the registration in the preview: `Register IRepo → SqlRepo (Scoped)`. */
export function registrationTitle(service: string, implementation: string | undefined, lifetime: Lifetime): string {
  return `Register ${service}${implementation && implementation !== service ? ` → ${implementation}` : ''} (${lifetime})`;
}
