// Test double of the web worker process: answers initialize/memory, crashes on "crash", hangs on "hang".
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'related' && req.params.uri === 'file:///crash') process.exit(5);
  if (req.method === 'related' && req.params.uri === 'file:///hang') return;
  if (req.method === 'shutdown') { process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n'); process.exit(0); }
  const result = req.method === 'initialize' ? { protocolVersion: 1, typescriptVersion: 'fake', projects: [], truncated: false } : { relations: [], notes: [`pid ${process.pid}`] };
  process.stdout.write(JSON.stringify({ id: req.id, result }) + '\n');
});
