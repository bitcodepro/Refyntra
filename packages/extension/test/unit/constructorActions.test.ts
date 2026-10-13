import { describe, expect, it } from 'vitest';
import {
  LIFETIME_ITEMS,
  answer,
  choiceItems,
  ctorActionSpecs,
  isTypeName,
  parseCtorArgs,
  registrationTitle,
  staleFiles,
} from '../../src/constructorModel';
import { FIX_ALL_ACTIONS, FIX_ALL_SCOPE_ITEMS, fixAllVariant, parseFixAllTarget } from '../../src/editActionsModel';

// The constructor / DI helpers are computed by the C# host (protocol 1.11, code/constructorActions; tested in
// ConstructorTests.cs). These tests cover the glue: host items → code actions, questions → pickers, hash checks.

describe('host constructor actions → code actions', () => {
  const items = [
    { actionId: 'csharp.ctor.initializeExisting', title: "Initialize field '_repo'", kind: 'rewrite' as const, preferred: true, member: '_repo' },
    { actionId: 'csharp.ctor.introduceField', title: "Create and initialize field '_repo'", kind: 'rewrite' as const, preferred: false },
    { actionId: 'csharp.ctor.initializeMembers', title: "Initialize '_x' from constructor", kind: 'quickfix' as const, preferred: true, members: ['_x'] },
    { actionId: 'csharp.ctor.registerDi', title: "Register 'IRepo' in DI…", kind: 'rewrite' as const, preferred: false, typeId: 'T:Demo.IRepo' },
    { actionId: 'csharp.ctor.introduceField', title: "Create and initialize field '_repo'", kind: 'rewrite' as const, preferred: false },
    { actionId: 'csharp.edit.invertIf', title: 'Invert', kind: 'rewrite' as const, preferred: false },
    { actionId: 'csharp.ctor.unknown', title: 'x', kind: 'rewrite' as const, preferred: false },
  ];

  it('keeps host order and the command ids of the earlier helpers, drops duplicates and foreign ids', () => {
    const specs = ctorActionSpecs(items);
    expect(specs.map((s) => s.command)).toEqual(['refyntra.ctor.introduce', 'refyntra.ctor.introduce', 'refyntra.ctor.initializeMembers', 'refyntra.ctor.registerDi']);
    expect(specs[0]).toMatchObject({ preferred: true, args: { actionId: 'csharp.ctor.initializeExisting', member: '_repo' } });
    expect(specs[2]).toMatchObject({ kind: 'quickfix', args: { members: ['_x'] } });
    expect(specs[3]!.args.typeId).toBe('T:Demo.IRepo');
  });

  it('parses command arguments (a keybinding passes none)', () => {
    expect(parseCtorArgs(undefined, 'csharp.ctor.addParameters')).toEqual({ actionId: 'csharp.ctor.addParameters' });
    expect(parseCtorArgs({ actionId: 'csharp.ctor.introduceProperty', members: ['a', 1] }, 'csharp.ctor.introduceField')).toEqual({ actionId: 'csharp.ctor.introduceProperty', members: ['a'] });
    expect(parseCtorArgs({ actionId: 'evil' }, 'csharp.ctor.introduceField').actionId).toBe('csharp.ctor.introduceField');
  });
});

describe('questions of the host', () => {
  it('turns choices into picker items and answers into the next request', () => {
    expect(choiceItems([{ id: 'a', label: '_a', detail: 'IRepo · field · not initialised', picked: true }])).toEqual([{ id: 'a', label: '_a', description: 'IRepo · field · not initialised', picked: true }]);
    const args = { actionId: 'csharp.ctor.createInjectedField' };
    expect(answer(args, 'members', ['_a', '_b'])).toEqual({ ...args, members: ['_a', '_b'] });
    expect(answer(args, 'constructor', ['file@12'])).toEqual({ ...args, constructorId: 'file@12' });
    expect(answer(args, 'type', ['T:Demo.IRepo'])).toEqual({ ...args, type: 'T:Demo.IRepo' });
  });

  it('accepts typed type names only', () => {
    expect(isTypeName('IRepo')).toBe(true);
    expect(isTypeName('Demo.IRepo<Order>')).toBe(true);
    expect(isTypeName('ILogger<Svc>?')).toBe(true);
    expect(isTypeName('drop table')).toBe(false);
    expect(isTypeName('')).toBe(false);
  });
});

describe('applying and registering', () => {
  it('applies only when every file still has the text the host saw', () => {
    const files = [{ uri: 'file:///a.cs', documentHash: 'h1' }, { uri: 'file:///b.cs', documentHash: 'h2' }];
    expect(staleFiles(files, (u) => (u.endsWith('a.cs') ? 'h1' : 'h2'))).toEqual([]);
    expect(staleFiles(files, (u) => (u.endsWith('a.cs') ? 'h1' : 'changed'))).toEqual(['file:///b.cs']);
  });

  it('offers the three lifetimes and names the registration', () => {
    expect(LIFETIME_ITEMS.map((l) => l.label)).toEqual(['Scoped', 'Transient', 'Singleton']);
    expect(registrationTitle('IRepo', 'SqlRepo', 'Scoped')).toBe('Register IRepo → SqlRepo (Scoped)');
    expect(registrationTitle('Repo', 'Repo', 'Singleton')).toBe('Register Repo (Singleton)');
  });
});

describe('fix in scope', () => {
  it('offers a scope variant for style-like single actions only', () => {
    expect(fixAllVariant({ title: 'Use explicit type', kind: 'refactor.rewrite.refyntra.explicitType', actionId: 'csharp.edit.varToExplicit', choices: [] })).toEqual({
      title: 'Use explicit type in document, project or solution…',
      kind: 'refactor.rewrite.refyntra.explicitType',
      actionId: 'csharp.edit.varToExplicit',
    });
    expect(fixAllVariant({ title: 'Invert if', kind: 'refactor.rewrite.refyntra.invertIf', actionId: 'csharp.edit.invertIf', choices: [] })).toBeUndefined();
    expect(fixAllVariant({ title: 'Introduce field…', kind: 'k', actionId: 'csharp.edit.toBlockBody', choices: [{ actionId: 'a', label: 'b' }] })).toBeUndefined();
    expect(FIX_ALL_ACTIONS.has('csharp.edit.usingToDeclaration')).toBe(true);
    expect(FIX_ALL_SCOPE_ITEMS.map((s) => s.scope)).toEqual(['document', 'project', 'solution']);
  });

  it('parses the command argument', () => {
    expect(parseFixAllTarget({ uri: 'file:///a.cs', actionId: 'csharp.edit.varToExplicit', title: 'Use explicit type', scope: 'solution' })).toEqual({ uri: 'file:///a.cs', actionId: 'csharp.edit.varToExplicit', title: 'Use explicit type', scope: 'solution' });
    expect(parseFixAllTarget({ uri: 'file:///a.cs', actionId: 'csharp.edit.invertIf' })).toBeUndefined();
    expect(parseFixAllTarget({ uri: 'http://x', actionId: 'csharp.edit.varToExplicit' })).toBeUndefined();
  });
});
