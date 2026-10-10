import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CancellationSource, CancelledError, RpcError, TransportError } from '@refyntra/application';
import { FramingError, JsonRpcConnection, MessageReader, SinkLogger, SupervisedProcess, encodeMessage } from '../src';

function collect(max?: number) {
  const messages: unknown[] = [];
  const errors: FramingError[] = [];
  const reader = new MessageReader((m) => messages.push(m), (e) => errors.push(e), max);
  return { reader, messages, errors };
}

describe('Content-Length framing', () => {
  it('decodes frames split across arbitrary chunks, including multi-byte UTF-8', () => {
    const { reader, messages } = collect();
    const bytes = Buffer.concat([encodeMessage({ a: 'привет' }), encodeMessage({ b: 2 })]);
    for (let i = 0; i < bytes.length; i += 3) reader.push(bytes.subarray(i, i + 3));
    expect(messages).toEqual([{ a: 'привет' }, { b: 2 }]);
  });

  it('treats a non-JSON body as a fatal malformed frame and stops decoding', () => {
    const { reader, messages, errors } = collect();
    reader.push(Buffer.from('Content-Length: 3\r\n\r\nabc'));
    reader.push(encodeMessage({ ok: true }));
    expect(errors.map((e) => e.reasonCode)).toEqual(['MalformedFrame']);
    expect(messages).toEqual([]);
  });

  it('rejects a missing/invalid Content-Length and an overlong header', () => {
    for (const raw of ['Foo: 1\r\n\r\n{}', 'Content-Length: -1\r\n\r\n{}', 'garbage\r\n\r\n']) {
      const { reader, errors } = collect();
      reader.push(Buffer.from(raw));
      expect(errors[0]?.reasonCode).toBe('MalformedFrame');
    }
    const { reader, errors } = collect();
    reader.push(Buffer.alloc(9000, 'x'));
    expect(errors[0]?.reasonCode).toBe('MalformedFrame');
  });

  it('rejects oversized frames before buffering the body', () => {
    const { reader, errors } = collect(10);
    reader.push(Buffer.from('Content-Length: 11\r\n\r\n'));
    expect(errors[0]?.reasonCode).toBe('FrameTooLarge');
  });
});

function pair() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const client = new JsonRpcConnection(s2c, c2s);
  const server = new JsonRpcConnection(c2s, s2c);
  return { client, server, s2c };
}

describe('JSON-RPC connection', () => {
  it('correlates responses by id and maps errors', async () => {
    const { client, server } = pair();
    server.onRequest(async (method, params) => {
      if (method === 'fail') throw new RpcError(-33004, 'stale', { reasonCode: 'StaleSnapshot', message: 'stale' });
      return { echo: params };
    });
    const [a, b] = await Promise.all([client.sendRequest('x', 1), client.sendRequest('y', 2)]);
    expect(a).toEqual({ echo: 1 });
    expect(b).toEqual({ echo: 2 });
    const err = await client.sendRequest('fail', null).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).reasonCode).toBe('StaleSnapshot');
  });

  it('cancellation sends $/cancelRequest, rejects locally and ignores the late reply', async () => {
    const { client, server } = pair();
    let serverSawCancel = false;
    server.onRequest(
      (_m, _p, token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            serverSawCancel = true;
            resolve('late');
          });
        }),
    );
    const s = new CancellationSource();
    const p = client.sendRequest('slow', null, s.token);
    await new Promise((r) => setImmediate(r));
    s.cancel();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSawCancel).toBe(true);
    expect(client.isClosed).toBe(false);
  });

  it('a malformed frame from the peer closes the connection and rejects pending requests', async () => {
    const { client, server, s2c } = pair();
    server.onRequest(() => new Promise(() => undefined));
    const closed = new Promise<Error | undefined>((r) => client.onClose(r));
    const pending = client.sendRequest('never', null);
    s2c.write('Content-Length: 5\r\n\r\n{bad}');
    const err = await closed;
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).reasonCode).toBe('MalformedFrame');
    await expect(pending).rejects.toBeInstanceOf(TransportError);
    await expect(client.sendRequest('after', null)).rejects.toBeInstanceOf(TransportError);
  });

  it('an oversized incoming frame is fatal', async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new JsonRpcConnection(s2c, c2s, { maxMessageBytes: 64 });
    const closed = new Promise<Error | undefined>((r) => client.onClose(r));
    s2c.write(encodeMessage({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(100) }));
    expect(((await closed) as TransportError).reasonCode).toBe('FrameTooLarge');
  });

  it('refuses to send an oversized outgoing request', async () => {
    const c2s = new PassThrough();
    const client = new JsonRpcConnection(new PassThrough(), c2s, { maxMessageBytes: 64 });
    await expect(client.sendRequest('big', 'x'.repeat(100))).rejects.toBeInstanceOf(TransportError);
  });

  it('a response without result or error is a protocol violation', async () => {
    const { client, server, s2c } = pair();
    server.onRequest(() => new Promise(() => undefined));
    const pending = client.sendRequest('m', null);
    s2c.write(encodeMessage({ jsonrpc: '2.0', id: 1 }));
    await expect(pending).rejects.toBeInstanceOf(TransportError);
  });

  it('end of the input stream closes the connection', async () => {
    const { client, s2c } = pair();
    const closed = new Promise<Error | undefined>((r) => client.onClose(r));
    s2c.end();
    expect(((await closed) as TransportError).reasonCode).toBe('StreamClosed');
  });
});

describe('logger', () => {
  it('never writes text-bearing fields', () => {
    const lines: string[] = [];
    const log = new SinkLogger({ appendLine: (l) => lines.push(l) }, () => 'debug', () => new Date(0));
    log.log('info', 'c', 'msg', { text: 'class Secret {}', newText: 'x', traceId: 't1', count: 3 });
    expect(lines[0]).toBe('1970-01-01T00:00:00.000Z [info] [c] msg text=[redacted] newText=[redacted] traceId=t1 count=3');
    log.log('debug', 'c', 'filtered');
    const quiet = new SinkLogger({ appendLine: (l) => lines.push(l) }, () => 'warn');
    quiet.log('info', 'c', 'dropped');
    expect(lines).toHaveLength(2);
  });
});

describe('process supervisor', () => {
  it('spawns without a shell, detects exit and kills the process tree on dispose', async () => {
    // Parent node process spawns a long-lived child, prints its pid, then waits.
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);";
    const proc = await SupervisedProcess.start({ command: process.execPath, args: ['-e', script] });
    const childPid = await new Promise<number>((resolve) => proc.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true);
    let exitSeen = false;
    proc.onExit(() => (exitSeen = true));
    await proc.dispose(100);
    expect(proc.hasExited).toBe(true);
    expect(exitSeen).toBe(true);
    for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(childPid)).toBe(false);
  }, 20000);

  it('reports a missing executable as ENOENT', async () => {
    await expect(SupervisedProcess.start({ command: 'refyntra-definitely-missing-exe', args: [] })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes arguments verbatim (no shell interpolation)', async () => {
    const proc = await SupervisedProcess.start({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '$(echo hi)', 'a & b', '"q"'] });
    const out = await new Promise<string>((resolve) => {
      let s = '';
      proc.stdout.on('data', (d: Buffer) => (s += String(d)));
      proc.exited.then(() => resolve(s));
    });
    expect(JSON.parse(out)).toEqual(['$(echo hi)', 'a & b', '"q"']);
  });
});
