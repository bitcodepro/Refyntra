import { describe, expect, it } from 'vitest';
import { CSHARP_CAPABILITY_IDS, ErrorCodes, ReasonCodes } from '../src';

describe('contract constants (protocol-v1.md "Error codes" and "Capability ids")', () => {
  it('lists every JSON-RPC code the host sends', () => {
    expect(ErrorCodes.InternalError).toBe(-32603);
    expect(ErrorCodes.BarrierTimeout).toBe(-33008);
    expect(ErrorCodes.UnknownSymbol).toBe(-33005);
    expect(new Set(Object.values(ErrorCodes)).size).toBe(Object.values(ErrorCodes).length);
  });

  it('lists the reason codes that share a JSON-RPC code', () => {
    for (const r of ['DuplicateId', 'UnsupportedPath', 'InvalidUri', 'NoProjectsLoaded', 'BarrierTimeout', 'InternalError']) expect(Object.values(ReasonCodes)).toContain(r);
  });

  it('defines the C# capability catalogue', () => {
    expect([...CSHARP_CAPABILITY_IDS]).toEqual(['csharp.find', 'csharp.related', 'csharp.rename', 'csharp.references']);
  });
});

describe('analysis/run (additive in 1.1, docs/architecture/protocol-v1.md "Analysis")', () => {
  it('exports the rule catalogue and the OR1001 help page', async () => {
    const c = await import('../src');
    expect(c.ANALYSIS_RULE_IDS).toEqual(['OR1001', 'OR1002', 'OR1003', 'OR1004', 'OR1005', 'OR1006', 'OR1007', 'OR1008', 'OR1009', 'OR1010', 'OR1011']);
    expect(c.ruleHelpUri('OR1005')).toMatch(/docs\/rules\/OR1005\.md$/);
    expect(c.OR1001_HELP_URI).toMatch(/docs\/rules\/OR1001\.md$/);
  });

  it('types a result with diagnostics, abstentions and the snapshot', () => {
    const r: import('../src').AnalysisRunResult = {
      diagnostics: [
        {
          id: 'OR1001',
          severity: 'warning',
          message: 'm',
          location: { uri: 'file:///a.cs', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
          relatedLocations: [],
          evidence: [],
          confidence: 'proven',
          completeness: 'complete',
        },
      ],
      abstentions: [{ ruleId: 'OR1001', reason: 'FactoryRegistration' }],
      completeness: 'complete',
      snapshotId: 's1',
    };
    const method: keyof import('../src').MethodMap = 'analysis/run';
    expect(method).toBe('analysis/run');
    expect(r.diagnostics[0]?.id).toBe('OR1001');
  });
});
