import { describe, expect, it } from 'vitest';
import { RpcReader, encodeRpc, mtpNodeAsResult } from '../../src/mtpServer';

describe('Microsoft Testing Platform server protocol', () => {
  it('frames JSON-RPC with Content-Length and reads messages split across chunks', () => {
    const bytes = Buffer.concat([encodeRpc({ id: 1, method: 'initialize', params: {} }), encodeRpc({ method: 'x', params: { t: 'é' } })]);
    const r = new RpcReader();
    const out = [...r.push(bytes.subarray(0, 10)), ...r.push(bytes.subarray(10, 60)), ...r.push(bytes.subarray(60))];
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', method: 'x', params: { t: 'é' } }]);
  });

  it('turns MSTest and xUnit nodes into result rows', () => {
    const ms = mtpNodeAsResult({ uid: '1', 'display-name': 'Adds (2,2,5)', 'execution-state': 'failed', 'location.type': 'M.MatrixTests', 'location.method': 'Adds(System.Int32,System.Int32,System.Int32)', 'error.message': 'expected: 5', 'time.duration-ms': 3 });
    expect(ms).toEqual({ className: 'M.MatrixTests', methodName: 'Adds', testName: 'Adds (2,2,5)', outcome: 'failed', message: 'expected: 5', durationMs: 3 });
    const xu = mtpNodeAsResult({ uid: '2', 'display-name': 'X.MatrixTests.Adds(a: 2, b: 2, sum: 5)', 'execution-state': 'passed' });
    expect(xu).toMatchObject({ className: 'X.MatrixTests', methodName: 'Adds', outcome: 'passed' });
    expect(mtpNodeAsResult({ uid: '3', 'display-name': 'S', 'execution-state': 'skipped', 'location.type': 'X.T' }).outcome).toBe('skipped');
  });
});
