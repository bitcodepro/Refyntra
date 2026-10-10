import { describe, expect, it } from 'vitest';
import type { RuleAbstention, RuleDiagnostic } from '@refyntra/contracts';
import { countByReason, explain, groupByUri, ruleLevel } from '../../src/diagnosticsModel';

const loc = (uri: string, line: number) => ({ uri, range: { start: { line, character: 0 }, end: { line, character: 5 } } });
const diag = (uri: string, line: number): RuleDiagnostic => ({
  id: 'OR1001',
  severity: 'warning',
  message: `captured at ${line}`,
  location: loc(uri, line),
  relatedLocations: [
    { location: loc(uri, line), message: 'Singleton registration' },
    { location: loc('file:///b.cs', 3), message: 'Constructor parameter' },
  ],
  evidence: [],
  confidence: 'proven',
  completeness: 'complete',
  helpUri: 'https://example/docs/rules/OR1001.md',
});
const abst = (reason: string, line?: number): RuleAbstention => ({ ruleId: 'OR1001', reason, message: `m ${reason}`, ...(line !== undefined ? { location: loc('file:///a.cs', line) } : {}) });

describe('rule settings', () => {
  it('accepts off|information|warning and falls back to the default for anything else', () => {
    expect(ruleLevel('OR1001', 'off')).toBe('off');
    expect(ruleLevel('OR1001', 'information')).toBe('information');
    expect(ruleLevel('OR1001', 'error')).toBe('warning');
    expect(ruleLevel('OR1001', undefined)).toBe('warning');
    expect(ruleLevel('OR9999', undefined)).toBe('off');
  });
});

describe('grouping for the DiagnosticCollection', () => {
  it('groups by document, sorts by position and drops rules that are off', () => {
    const g = groupByUri([diag('file:///a.cs', 9), diag('file:///a.cs', 2), diag('file:///c.cs', 1)], () => 'warning');
    expect([...g.keys()]).toEqual(['file:///a.cs', 'file:///c.cs']);
    expect(g.get('file:///a.cs')!.map((d) => d.location.range.start.line)).toEqual([2, 9]);
    expect(groupByUri([diag('file:///a.cs', 1)], () => 'off').size).toBe(0);
  });
});

describe('explanation', () => {
  it('lists the proof path of warnings and the abstentions with counts, never as problems', () => {
    const text = explain([diag('file:///a.cs', 4)], [abst('FactoryRegistration', 7), abst('FactoryRegistration', 8), abst('KeyedService')], 'complete');
    expect(text).toContain('## Warnings (proven paths): 1');
    expect(text).toContain('1. Singleton registration (file:///a.cs:5)');
    expect(text).toContain('2. Constructor parameter (file:///b.cs:4)');
    expect(text).toContain('## Not checked (abstentions): 3');
    expect(text).toContain('- FactoryRegistration: 2');
    expect(text).toContain('These are not problems');
  });

  it('filters to one line of one document', () => {
    const text = explain([diag('file:///a.cs', 4)], [abst('TryAdd', 7)], 'partial', 'file:///a.cs', 7);
    expect(text).toContain('## Warnings (proven paths): 0');
    expect(text).toContain('OR1001 TryAdd (file:///a.cs:8)');
    expect(text).toContain('analysis completeness: partial');
    expect(countByReason([abst('B'), abst('A'), abst('B')])).toEqual([['B', 2], ['A', 1]]);
  });
});
