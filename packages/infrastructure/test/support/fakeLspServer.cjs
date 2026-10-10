// A tiny fake language server for the LSP client tests (stdio, Content-Length framing). Test-only.
let buf = Buffer.alloc(0);
const seen = { init: undefined, notifications: [], cancels: [], answers: {} };
let nextId = 1000;
const pendingServerRequests = new Map();
function send(m) {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function serverRequest(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const slow = new Map();
async function handle(m) {
  if (m.method === undefined) {
    const r = pendingServerRequests.get(m.id);
    if (r) { pendingServerRequests.delete(m.id); r(m); }
    return;
  }
  if (m.id === undefined) {
    seen.notifications.push(m.method);
    if (m.method === '$/cancelRequest') {
      seen.cancels.push(m.params.id);
      const s = slow.get(m.params.id);
      if (s) { clearTimeout(s); slow.delete(m.params.id); send({ jsonrpc: '2.0', id: m.params.id, error: { code: -32800, message: 'cancelled' } }); }
    }
    if (m.method === 'exit') process.exit(0);
    return;
  }
  switch (m.method) {
    case 'initialize':
      seen.init = m.params;
      process.stderr.write('starting in C:\\Users\\someone\\project with /home/someone/x\n');
      return send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { renameProvider: { prepareProvider: true }, definitionProvider: true }, serverInfo: { name: 'fake-lsp', version: '9.9' } } });
    case 'test/state':
      return send({ jsonrpc: '2.0', id: m.id, result: seen });
    case 'test/askClient': {
      const config = await serverRequest('workspace/configuration', { items: [{ section: 'python' }, { section: 'other' }] });
      const edit = await serverRequest('workspace/applyEdit', { edit: { changes: {} } });
      const unknown = await serverRequest('custom/unknown', {});
      const folders = await serverRequest('workspace/workspaceFolders', null);
      return send({ jsonrpc: '2.0', id: m.id, result: { config, edit, unknown, folders } });
    }
    case 'test/slow':
      slow.set(m.id, setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: 'late' }), 5000));
      return;
    case 'test/contentModified':
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32801, message: 'content modified' } });
    case 'test/garbage':
      process.stdout.write('Content-Length: 5\r\n\r\nnope!');
      return;
    case 'test/crash':
      process.exit(3);
      return;
    case 'shutdown':
      return send({ jsonrpc: '2.0', id: m.id, result: null });
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
  }
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.subarray(end + 4, end + 4 + len).toString('utf8');
    buf = buf.subarray(end + 4 + len);
    void handle(JSON.parse(body));
  }
});
if (process.argv.includes('--no-init')) process.stdin.removeAllListeners('data');
