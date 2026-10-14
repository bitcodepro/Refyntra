import { describe, expect, it } from 'vitest';
import { MessageReader, caseAsResult, encodeMessage, splitFullyQualifiedName, toTrxResult } from '../../src/vstestProtocol';

describe('vstest.console design-mode protocol', () => {
  it('frames messages as .NET BinaryWriter strings (7-bit length) and reads them back, also split across chunks', () => {
    const big = { MessageType: 'X', Payload: 'é'.repeat(200) };
    const bytes = Buffer.concat([encodeMessage({ MessageType: 'TestSession.Connected' }), encodeMessage(big)]);
    expect(bytes[0]).toBe(Buffer.byteLength(JSON.stringify({ MessageType: 'TestSession.Connected' })));
    const r = new MessageReader();
    const out = [...r.push(bytes.subarray(0, 7)), ...r.push(bytes.subarray(7, 300)), ...r.push(bytes.subarray(300))];
    expect(out).toEqual([{ MessageType: 'TestSession.Connected' }, big]);
  });

  it('splits names: NUnit puts the arguments in the fully qualified name', () => {
    expect(splitFullyQualifiedName('NUnit4.MatrixTests.Adds(1,2,3)')).toEqual({ className: 'NUnit4.MatrixTests', methodName: 'Adds' });
    expect(splitFullyQualifiedName('X.Outer+Inner.M')).toEqual({ className: 'X.Outer+Inner', methodName: 'M' });
    expect(caseAsResult({ Id: '1', FullyQualifiedName: 'XUnit3.MatrixTests.Adds', DisplayName: 'XUnit3.MatrixTests.Adds(a: 2, b: 2, sum: 5)' })).toMatchObject({ className: 'XUnit3.MatrixTests', methodName: 'Adds', testName: 'XUnit3.MatrixTests.Adds(a: 2, b: 2, sum: 5)' });
  });

  it('turns results into the shape the tree uses: outcome, duration, message, stack, stdout', () => {
    const r = toTrxResult({
      TestCase: { Id: '1', FullyQualifiedName: 'M.T.Adds', DisplayName: 'Adds (2,2,5)' },
      Outcome: 2,
      ErrorMessage: 'expected 5',
      ErrorStackTrace: 'at M.T.Adds() in /a/T.cs:line 20',
      Duration: '00:00:01.2500000',
      Messages: [{ Category: 'StdOutMsgs', Text: 'hello' }],
    });
    expect(r).toEqual({ className: 'M.T', methodName: 'Adds', testName: 'Adds (2,2,5)', outcome: 'failed', durationMs: 1250, message: 'expected 5', stackTrace: 'at M.T.Adds() in /a/T.cs:line 20', stdout: 'hello' });
    expect(toTrxResult({ TestCase: { Id: '2', FullyQualifiedName: 'M.T.S', DisplayName: 'S' }, Outcome: 3 }).outcome).toBe('skipped');
    expect(toTrxResult({ TestCase: { Id: '3', FullyQualifiedName: 'M.T.P', DisplayName: 'P' }, Outcome: 1 }).outcome).toBe('passed');
  });
});
