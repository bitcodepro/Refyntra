import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_RULE_IDS } from '@refyntra/contracts';
import { INSPECTION_LEVELS, RULE_SETTING_DEFAULTS, compilerQuickFixes, quickFixesOf, ruleLevel, severityOf } from '../../src/diagnosticsModel';
import { FIX_ALL_ACTIONS, offerEditActions, parseEditActionTarget, parseFixAllTarget } from '../../src/editActionsModel';

// Inspections OR1002–OR1010: settings, severities, quick fixes offered from diagnostics (diagnostics.ts).

const INSPECTIONS = ANALYSIS_RULE_IDS.filter((id) => id !== 'OR1001');

describe('inspection settings', () => {
  it('accepts off|hint|info|warning|error and falls back to the default otherwise', () => {
    expect(ruleLevel('OR1002', 'hint')).toBe('hint');
    expect(ruleLevel('OR1002', 'error')).toBe('error');
    expect(ruleLevel('OR1002', 'info')).toBe('info');
    expect(ruleLevel('OR1002', 'loud')).toBe('warning');
    expect(ruleLevel('OR1008', undefined)).toBe('hint');
    // OR1001 keeps its own levels.
    expect(ruleLevel('OR1001', 'hint')).toBe('warning');
  });

  it('maps levels to severities', () => {
    expect(severityOf('off')).toBeUndefined();
    expect(severityOf('hint')).toBe('hint');
    expect(severityOf('info')).toBe('information');
    expect(severityOf('information')).toBe('information');
    expect(severityOf('warning')).toBe('warning');
    expect(severityOf('error')).toBe('error');
  });

  it('declares one setting per inspection with the same default and levels as the model', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as unknown;
    const props = (pkg as { contributes: { configuration: { properties: Record<string, { default: string; enum: string[] }> } } }).contributes.configuration.properties;
    for (const id of INSPECTIONS) {
      const p = props[`refyntra.rules.${id}`];
      expect(p, id).toBeDefined();
      expect(p!.default).toBe(RULE_SETTING_DEFAULTS[id]);
      expect(p!.enum).toEqual([...INSPECTION_LEVELS]);
    }
  });
});

describe('quick fixes from diagnostics', () => {
  it('keeps only edit-action fixes, once each', () => {
    expect(quickFixesOf([{ actionId: 'csharp.edit.fix.usingVar', title: 'Dispose' }, { actionId: 'csharp.edit.fix.usingVar', title: 'again' }, { actionId: 'evil', title: 'x' }, null])).toEqual([
      { actionId: 'csharp.edit.fix.usingVar', title: 'Dispose' },
    ]);
    expect(quickFixesOf(undefined)).toEqual([]);
  });

  it("offers Add 'await' and Discard on the compiler's CS4014 only", () => {
    expect(compilerQuickFixes('CS4014').map((f) => f.actionId)).toEqual(['csharp.edit.fix.addAwait', 'csharp.edit.fix.discardTask']);
    expect(compilerQuickFixes({ value: 'CS4014', target: 'x' })).toHaveLength(2);
    expect(compilerQuickFixes('CS0168')).toEqual([]);
  });

  it('runs the fixes through the edit-action command and Fix in scope', () => {
    expect(parseEditActionTarget({ uri: 'file:///a.cs', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, actionId: 'csharp.edit.fix.removeFormat', version: 3 })?.actionId).toBe('csharp.edit.fix.removeFormat');
    for (const id of ['awaitSyncCall', 'asyncVoidToTask', 'addAwait', 'discardTask', 'usingVar', 'materialize', 'stringBuilder', 'predicateOverload', 'removeMaterialization', 'removeFormat'])
      expect(FIX_ALL_ACTIONS.has(`csharp.edit.fix.${id}`), id).toBe(true);
    expect(parseFixAllTarget({ uri: 'file:///a.cs', actionId: 'csharp.edit.fix.usingVar', title: 'Dispose' })?.actionId).toBe('csharp.edit.fix.usingVar');
  });

  it('never lists quick fixes in the refactoring menu (they belong to their diagnostics)', () => {
    expect(offerEditActions([{ actionId: 'csharp.edit.fix.removeFormat', title: 'Use the string directly', kind: 'quickfix.refyntra.OR1010' }])).toEqual([]);
  });
});
