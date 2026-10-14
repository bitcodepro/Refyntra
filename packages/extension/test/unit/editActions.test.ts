import { describe, expect, it } from 'vitest';
import { CROSS_FILE_PLANS, EDIT_ACTION_COMMAND, KEYBOARD_ACTIONS, canApply, choicePickItems, editActionTitle, editKindMatches, groupEditActions, offerEditActions, parseEditActionTarget } from '../../src/editActionsModel';

const items = [
  { actionId: 'csharp.edit.invertIf', title: "Invert 'if'", kind: 'refactor.rewrite.refyntra.invertIf' },
  { actionId: 'csharp.edit.inlineVariable', title: 'Inline variable', kind: 'refactor.inline.refyntra.variable' },
  { actionId: 'csharp.edit.introduceVariable', title: 'Introduce variable', kind: 'refactor.extract.refyntra.variable' },
];

describe('edit actions (code/editActions glue)', () => {
  it('offers host items in order, filtered by the requested kind', () => {
    expect(offerEditActions(items).map((i) => i.actionId)).toEqual(items.map((i) => i.actionId));
    expect(offerEditActions(items, 'refactor.inline').map((i) => i.actionId)).toEqual(['csharp.edit.inlineVariable']);
    expect(offerEditActions(items, 'refactor.extract').map((i) => i.actionId)).toEqual(['csharp.edit.introduceVariable']);
    expect(offerEditActions(items, 'refactor').length).toBe(3);
    expect(offerEditActions(items, 'quickfix')).toEqual([]);
    expect(offerEditActions(items, 'refactor.rewrite.refyntra.invertIf').map((i) => i.actionId)).toEqual(['csharp.edit.invertIf']);
  });

  it('drops malformed, foreign and duplicate items', () => {
    const bad = [
      ...items,
      items[0]!,
      { actionId: 'csharp.rename', title: 'x', kind: 'refactor.rewrite.refyntra.x' },
      { actionId: 'csharp.edit.x', title: 'x', kind: 'source.fixAll' },
      { actionId: 'csharp.edit.y', title: 3, kind: 'refactor.rewrite.refyntra' } as unknown as (typeof items)[number],
    ];
    expect(offerEditActions(bad).map((i) => i.actionId)).toEqual(items.map((i) => i.actionId));
  });

  it('kind matching is hierarchical both ways', () => {
    expect(editKindMatches(undefined, 'refactor.rewrite.refyntra.x')).toBe(true);
    expect(editKindMatches('refactor.rewrite', 'refactor.rewrite.refyntra.x')).toBe(true);
    expect(editKindMatches('refactor.rewriteX', 'refactor.rewrite.refyntra.x')).toBe(false);
  });

  it('titles name the product', () => {
    expect(editActionTitle(items[0]!)).toBe("Invert 'if' (Refyntra)");
  });

  it('parses only well-formed command arguments', () => {
    const ok = { uri: 'file:///a.cs', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, actionId: 'csharp.edit.invertIf', version: 4 };
    expect(parseEditActionTarget(ok)).toEqual(ok);
    expect(parseEditActionTarget({ ...ok, uri: 'untitled:a' })).toBeUndefined();
    expect(parseEditActionTarget({ ...ok, actionId: 'csharp.rename' })).toBeUndefined();
    expect(parseEditActionTarget({ ...ok, version: 1.5 })).toBeUndefined();
    expect(parseEditActionTarget({ ...ok, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } })).toBeUndefined();
    expect(parseEditActionTarget(undefined)).toBeUndefined();
  });

  it('applies only to the version the edits were computed for', () => {
    expect(canApply(3, 3, 3)).toBe(true);
    expect(canApply(3, 4, 4)).toBe(false);
    expect(canApply(3, 3, 4)).toBe(false);
  });

  it('keyboard commands map to host actions', () => {
    expect(KEYBOARD_ACTIONS['refyntra.introduceVariable']).toMatchObject({ actionId: 'csharp.edit.introduceVariable', needsSelection: true });
    expect(KEYBOARD_ACTIONS['refyntra.inlineVariable']).toMatchObject({ actionId: 'csharp.edit.inlineVariable', needsSelection: false });
    expect(EDIT_ACTION_COMMAND).toBe('refyntra.editAction');
  });
  it('offers the inline member actions (method, field, parameter) under refactor.inline', () => {
    const inline = [
      { actionId: 'csharp.edit.inlineMethod', title: 'Inline method (this call site)', kind: 'refactor.inline.refyntra.methodCall' },
      { actionId: 'csharp.edit.inlineMethodAll', title: 'Inline method (all call sites, remove declaration)', kind: 'refactor.inline.refyntra.method' },
      { actionId: 'csharp.edit.inlineField', title: 'Inline constant', kind: 'refactor.inline.refyntra.field' },
      { actionId: 'csharp.edit.inlineParameter', title: 'Inline parameter', kind: 'refactor.inline.refyntra.parameter' },
    ];
    expect(offerEditActions(inline, 'refactor.inline').map((i) => i.actionId)).toEqual(inline.map((i) => i.actionId));
    expect(offerEditActions(inline, 'refactor.extract')).toEqual([]);
    expect(parseEditActionTarget({ uri: 'file:///a.cs', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, actionId: 'csharp.edit.inlineMethodAll', version: 3 })?.actionId).toBe('csharp.edit.inlineMethodAll');
  });

  it('Inline Method refused with CrossFile becomes the plan of the same action', () => {
    expect(CROSS_FILE_PLANS['csharp.edit.inlineMethod']).toBe('csharp.inlineMethod');
    expect(CROSS_FILE_PLANS['csharp.edit.inlineMethodAll']).toBe('csharp.inlineMethodAll');
    expect(CROSS_FILE_PLANS['csharp.edit.inlineField']).toBeUndefined();
  });

  it('groups Introduce Field / Constant choices into one action asked with a QuickPick', () => {
    const intro = [
      { actionId: 'csharp.edit.introduceVariable', title: 'Introduce variable', kind: 'refactor.extract.refyntra.variable' },
      { actionId: 'csharp.edit.introduceField.initializer', title: 'Introduce field: initialize in the field initializer', kind: 'refactor.extract.refyntra.field' },
      { actionId: 'csharp.edit.introduceField.constructor', title: 'Introduce field: initialize in the constructor(s)', kind: 'refactor.extract.refyntra.field' },
      { actionId: 'csharp.edit.introduceConstant.class', title: 'Introduce constant: constant of the type, replace all occurrences in the type', kind: 'refactor.extract.refyntra.constant' },
      { actionId: 'csharp.edit.introduceParameter', title: 'Introduce parameter (updates every call site; preview first)', kind: 'refactor.extract.refyntra.parameter' },
    ];
    const g = groupEditActions(intro);
    expect(g.map((x) => x.title)).toEqual(['Introduce variable', 'Introduce field…', 'Introduce constant: constant of the type, replace all occurrences in the type', 'Introduce parameter (updates every call site; preview first)']);
    expect(g[1]!.choices.map((c) => c.actionId)).toEqual(['csharp.edit.introduceField.initializer', 'csharp.edit.introduceField.constructor']);
    expect(g[2]!.choices).toEqual([]);
    expect(g[2]!.actionId).toBe('csharp.edit.introduceConstant.class');
    expect(choicePickItems(g[1]!.choices)[1]).toEqual({ label: 'Initialize in the constructor(s)', actionId: 'csharp.edit.introduceField.constructor' });
    const arg = { uri: 'file:///a.cs', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, actionId: 'csharp.edit.introduceField.initializer', version: 1, choices: [...g[1]!.choices, { actionId: 'csharp.rename', label: 'x' }, 7] };
    expect(parseEditActionTarget(arg)?.choices?.map((c) => c.actionId)).toEqual(['csharp.edit.introduceField.initializer', 'csharp.edit.introduceField.constructor']);
    expect(parseEditActionTarget({ ...arg, choices: undefined })?.choices).toBeUndefined();
  });
});
