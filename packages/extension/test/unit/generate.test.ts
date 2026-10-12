import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EQUALITY_OPTIONS,
  GENERATE_COMMAND,
  type GenerateKindData,
  allowsEmptySelection,
  delegationGroups,
  generateKinds,
  generateRequest,
  kindPickItems,
  memberPickItems,
  needsMemberPick,
  parseGenerateRequest,
} from '../../src/generateModel';

const kinds: GenerateKindData[] = [
  { kind: 'toString', title: 'Formatting members (ToString)', members: [{ id: '_a', name: '_a', detail: 'int · field', picked: true }] },
  { kind: 'constructor', title: 'Constructor', members: [{ id: '_a', name: '_a', detail: 'int · field', picked: true }, { id: 'B', name: 'B', detail: 'string · property', picked: false }] },
  {
    kind: 'delegating',
    title: 'Delegating members',
    members: [
      { id: '_log|M:Log', name: 'void Log(string m)', detail: 'Logger', picked: false, group: '_log' },
      { id: '_repo|M:Get', name: 'int Get()', detail: 'Repo', picked: false, group: '_repo' },
      { id: '_log|P:Count', name: 'int Count', detail: 'Logger', picked: false, group: '_log' },
    ],
  },
  { kind: 'implement', title: 'Missing members', members: [{ id: 'M:Area', name: 'double Area()', detail: 'IShape', picked: true }] },
];

describe('Generate (code/generate glue)', () => {
  it('orders the kinds like Rider and drops unknown ones', () => {
    const bad = [...kinds, { kind: 'nope', title: 'x', members: [] } as unknown as GenerateKindData];
    expect(generateKinds(bad).map((k) => k.kind)).toEqual(['constructor', 'implement', 'delegating', 'toString']);
    const items = kindPickItems(kinds);
    expect(items[0]).toEqual({ label: '$(symbol-constructor) Constructor', description: '2 members to initialise', kindId: 'constructor' });
  });

  it('lists members with their preselection; delegating members per field', () => {
    expect(memberPickItems(kinds[1]!.members)).toEqual([
      { label: '_a', description: 'int · field', picked: true, id: '_a' },
      { label: 'B', description: 'string · property', picked: false, id: 'B' },
    ]);
    expect(delegationGroups(kinds[2]!.members)).toEqual(['_log', '_repo']);
    expect(memberPickItems(kinds[2]!.members, '_log').map((m) => m.id)).toEqual(['_log|M:Log', '_log|P:Count']);
  });

  it('implements all missing members without a picker; only a constructor may have no members', () => {
    expect(needsMemberPick('implement')).toBe(false);
    expect(needsMemberPick('overrides')).toBe(true);
    expect(allowsEmptySelection('constructor')).toBe(true);
    expect(allowsEmptySelection('equality')).toBe(false);
  });

  it('builds the host request with the equality options', () => {
    expect(generateRequest('equality', ['_a'], ['operators'])).toEqual({ kind: 'equality', members: ['_a'], equatable: false, operators: true });
    expect(generateRequest('equality', ['_a'], EQUALITY_OPTIONS.filter((o) => o.picked).map((o) => o.id))).toEqual({ kind: 'equality', members: ['_a'], equatable: true, operators: false });
    expect(generateRequest('toString', undefined)).toEqual({ kind: 'toString' });
  });

  it('accepts a request argument for running without pickers', () => {
    expect(parseGenerateRequest({ kind: 'implement' })).toEqual({ kind: 'implement' });
    expect(parseGenerateRequest({ kind: 'equality', members: ['_a'], equatable: true, operators: false })).toEqual({ kind: 'equality', members: ['_a'], equatable: true, operators: false });
    expect(parseGenerateRequest({ kind: 'nope' })).toBeUndefined();
    expect(parseGenerateRequest({ kind: 'toString', members: [1] })).toBeUndefined();
    expect(parseGenerateRequest(undefined)).toBeUndefined();
  });

  it('is bound to Alt+Insert in the Visual Studio and ReSharper presets, C# editors only', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { keybindings: { command: string; key: string; when: string }[]; commands: { command: string }[]; configuration: { properties: Record<string, { default: unknown }> } };
    };
    const keys = pkg.contributes.keybindings.filter((k) => k.command === GENERATE_COMMAND);
    expect(keys.map((k) => k.key)).toEqual(['alt+insert', 'alt+insert']);
    expect(keys.some((k) => k.when.includes("preset == 'visualStudio'"))).toBe(true);
    expect(keys.some((k) => k.when.includes("preset == 'resharper'"))).toBe(true);
    expect(keys.every((k) => k.when.includes('editorLangId == csharp'))).toBe(true);
    expect(pkg.contributes.commands.some((c) => c.command === GENERATE_COMMAND)).toBe(true);
    expect(pkg.contributes.configuration.properties['refyntra.postfix.enabled']?.default).toBe(true);
  });
});
