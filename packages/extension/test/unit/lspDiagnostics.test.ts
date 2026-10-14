import { describe, expect, it } from 'vitest';
import { newErrors } from '../../src/lspDiagnosticsModel';

const d = (message: string, line = 0, severity: 1 | 2 = 1, code?: string) => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, severity, message, ...(code ? { code } : {}) });

describe('newErrors (result check of language server refactorings)', () => {
  it('an error that moved to another line is not new; a second identical one is', () => {
    expect(newErrors([d('x is undefined', 1)], [d('x is undefined', 5)])).toEqual([]);
    expect(newErrors([d('x is undefined', 1)], [d('x is undefined', 5), d('x is undefined', 9)])).toHaveLength(1);
  });
  it('warnings are ignored; a different message or code is new', () => {
    expect(newErrors([], [d('unused', 0, 2)])).toEqual([]);
    expect(newErrors([d('a', 0, 1, 'E1')], [d('a', 0, 1, 'E2'), d('b')]).map((x) => x.message)).toEqual(['a', 'b']);
  });
  it('a fixed error is simply gone', () => {
    expect(newErrors([d('a'), d('b')], [d('b')])).toEqual([]);
  });
});
