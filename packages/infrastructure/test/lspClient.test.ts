import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CancellationSource, CancelledError, type LspConnection, RpcError, StartupError } from '@refyntra/application';
import { CLIENT_CAPABILITIES, createLspConnectionFactory, redactServerLine } from '../src';

const SERVER = path.join(__dirname, 'support', 'fakeLspServer.cjs');
const lines: string[] = [];
const logger = { log: (_l: string, c: string, m: string) => void lines.push(`${c} ${m}`) };
const ctx = { providerRouteId: 'python.pyright', attempt: 1, workspaceFolders: [{ uri: 'file:///ws', name: 'ws' }] };
let conn: LspConnection | undefined;

afterEach(async () => {
  await conn?.shutdown();
  conn = undefined;
  lines.length = 0;
});

function factory(args: string[] = [], extra: Partial<Parameters<typeof createLspConnectionFactory>[0]> = {}) {
  const spawned: string[] = [];
  const f = createLspConnectionFactory({
    name: 'fake',
    resolveLaunch: async () => ({ command: process.execPath, args: [SERVER, ...args] }),
    logger,
    configuration: (section) => (section === 'python' ? { pythonPath: 'p' } : undefined),
    onSpawn: (l) => spawned.push(l.command),
    ...extra,
  });
  return { f, spawned };
}

describe('LSP client', () => {
  it('initializes over Content-Length framing with workspace folders and the read-only client capabilities', async () => {
    const { f, spawned } = factory();
    conn = await f(ctx);
    expect(spawned).toHaveLength(1);
    expect(conn.serverCapabilities).toMatchObject({ renameProvider: { prepareProvider: true } });
    expect(conn.serverInfo).toEqual({ name: 'fake-lsp', version: '9.9' });
    const state = (await conn.request('test/state', null)) as { init: { rootUri: string; workspaceFolders: unknown; capabilities: unknown; processId: number }; notifications: string[] };
    expect(state.init.rootUri).toBe('file:///ws');
    expect(state.init.workspaceFolders).toEqual([{ uri: 'file:///ws', name: 'ws' }]);
    expect(state.init.capabilities).toEqual(JSON.parse(JSON.stringify(CLIENT_CAPABILITIES)));
    expect(state.notifications).toContain('initialized');
  });

  it('answers server requests: configuration by section, applyEdit refused, unknown methods → MethodNotFound', async () => {
    conn = await factory().f(ctx);
    const r = (await conn.request('test/askClient', null)) as Record<string, { result?: unknown; error?: { code: number } }>;
    expect(r.config!.result).toEqual([{ pythonPath: 'p' }, null]);
    expect(r.edit!.result).toMatchObject({ applied: false });
    expect(r.unknown!.error!.code).toBe(-32601);
    expect(r.folders!.result).toEqual([{ uri: 'file:///ws', name: 'ws' }]);
  });

  it('cancellation sends $/cancelRequest and rejects with CancelledError; a late answer is dropped', async () => {
    conn = await factory().f(ctx);
    const source = new CancellationSource();
    const p = conn.request('test/slow', null, source.token);
    setTimeout(() => source.cancel(), 50);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    const state = (await conn.request('test/state', null)) as { cancels: number[] };
    expect(state.cancels.length).toBe(1);
  });

  it('LSP error responses reach the caller as RpcError with the LSP code (ContentModified)', async () => {
    conn = await factory().f(ctx);
    const e = await conn.request('test/contentModified', null).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(-32801);
  });

  it('a malformed frame closes the session (fatal) and kills the process', async () => {
    conn = await factory().f(ctx);
    const closed = new Promise<Error | undefined>((r) => conn!.onClose(r));
    await conn.request('test/garbage', null).catch(() => undefined);
    expect((await closed)?.message).toMatch(/JSON/);
  });

  it('a crash fires onClose once; requests then fail', async () => {
    conn = await factory().f(ctx);
    const closed = new Promise<Error | undefined>((r) => conn!.onClose(r));
    void conn.request('test/crash', null).catch(() => undefined);
    expect((await closed)?.message).toMatch(/exited|closed/);
    await expect(conn.request('test/state', null)).rejects.toBeTruthy();
  });

  it('a server that never answers initialize → StartupError ServerStartFailed (process killed)', async () => {
    const { f } = factory(['--no-init'], { initializeTimeoutMs: 300 });
    const e = await f(ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StartupError);
    expect((e as StartupError).reasonCode).toBe('ServerStartFailed');
  });

  it('a missing executable → StartupError ServerNotFound', async () => {
    const f = createLspConnectionFactory({ name: 'missing', resolveLaunch: async () => ({ command: path.join(__dirname, 'no-such-server.exe'), args: [] }), logger });
    const e = await f(ctx).catch((x: unknown) => x);
    expect((e as StartupError).reasonCode).toBe('ServerNotFound');
  });

  it('shutdown sends shutdown + exit and the process ends', async () => {
    conn = await factory().f(ctx);
    const closed = new Promise<void>((r) => conn!.onClose(() => r()));
    await conn.shutdown();
    await closed;
    conn = undefined;
  });

  it('stderr lines are logged with paths redacted', async () => {
    conn = await factory().f(ctx);
    await conn.request('test/state', null);
    await new Promise((r) => setTimeout(r, 50));
    const stderr = lines.filter((l) => l.startsWith('lsp:fake:stderr'));
    expect(stderr.join('\n')).not.toMatch(/someone/);
    expect(redactServerLine('open C:\\Users\\a\\b.py and /home/a/c.rs and file:///x/y')).toBe('open <path> and <path> and <path>');
    expect(redactServerLine('x'.repeat(400)).length).toBeLessThan(310);
  });
});
