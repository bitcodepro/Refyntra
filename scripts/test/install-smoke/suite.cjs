// Runs inside the VS Code started by scripts/test/install-smoke.mjs. The extension under test is the INSTALLED
// refyntra.refyntra from the temp extensions dir (no extension development path points at the repository).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const env = process.env;
const scenario = env.REFYNTRA_SMOKE_SCENARIO;
const lc = (p) => path.resolve(p).toLowerCase();

async function waitFor(predicate, what, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
async function at(rel, needle, offset = 1) {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `${needle} in ${rel}`);
  return { doc, at: { uri: doc.uri.toString(), position: doc.positionAt(i + offset) } };
}
const csharp = (h) => h.adapters.find((a) => a.adapterId === 'csharp');
const relations = (r) => r.groups.flatMap((g) => g.relations);

let ext;
let api;
const report = { scenario, hostPids: [] };

const common = [
  [
    'the extension is the installed copy, not the repository',
    async () => {
      assert.equal(env.REFYNTRA_HOST_PATH, undefined, 'REFYNTRA_HOST_PATH must be unset');
      ext = vscode.extensions.getExtension(env.REFYNTRA_SMOKE_EXTENSION_ID);
      assert.ok(ext, `${env.REFYNTRA_SMOKE_EXTENSION_ID} is installed`);
      report.extensionPath = ext.extensionPath;
      assert.ok(lc(ext.extensionPath).startsWith(lc(env.REFYNTRA_SMOKE_EXTENSIONS_DIR) + path.sep), `${ext.extensionPath} is inside the temp extensions dir`);
      assert.ok(!lc(ext.extensionPath).startsWith(lc(env.REFYNTRA_SMOKE_REPO)), 'not loaded from the repository');
      assert.ok(/[^\x00-\x7f]/.test(ext.extensionPath) && / /.test(ext.extensionPath), 'install path has spaces and non-ASCII characters');
      api = await ext.activate();
      assert.ok(api && api.engine, 'activate() returned the API');
      assert.equal(lc(api.extensionPath), lc(ext.extensionPath));
    },
  ],
  [
    'Ready, with the host started from <installed>/host/Refyntra.Host.dll',
    async () => {
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(api.health())?.state), 'host ready', 300000);
      const h = csharp(api.health());
      assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
      const launches = api.hostLaunches();
      assert.ok(launches.length >= 1, 'a host was spawned');
      const l = launches[launches.length - 1];
      const dll = path.join(ext.extensionPath, 'host', 'Refyntra.Host.dll');
      report.hostLaunch = `${l.command} ${l.args.join(' ')}`;
      assert.equal(l.command, 'dotnet');
      assert.equal(lc(l.args[0]), lc(dll), 'host dll from the installed payload');
      assert.equal(lc(l.cwd), lc(path.dirname(dll)));
      assert.ok(!lc(l.args[0]).startsWith(lc(env.REFYNTRA_SMOKE_REPO)), 'host is not the repository build');
      assert.match(h.hostDescription || '', /^packaged: /);
      report.hostPids = api.hostPids();
      report.sdk = h.sdk && h.sdk.version;
      report.backend = h.backend;
    },
  ],
];

const scenarios = {
  shop: [
    [
      'Find: type: GetOrder',
      async () => {
        const r = await api.engine.find('type: GetOrder');
        assert.ok(r.items.some((i) => i.label === 'GetOrderQuery'), JSON.stringify(r.items.map((i) => i.label)));
      },
    ],
    [
      'Related: GetOrderQuery → handler, Send call site, endpoint',
      async () => {
        const { at: p } = await at('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(');
        const rel = await api.engine.related(p);
        assert.equal(rel.kind, 'related', JSON.stringify(rel));
        const kinds = relations(rel).map((r) => r.relationKind);
        for (const want of ['mediatr.handler', 'mediatr.send', 'aspnet.endpoint']) assert.ok(kinds.includes(want), `${want} in ${kinds.join(', ')}`);
        assert.equal(relations(rel).find((r) => r.relationKind === 'mediatr.handler').target.symbol.name, 'GetOrderQueryHandler');
      },
    ],
    [
      'Rename preview across both projects changes nothing',
      async () => {
        const { doc, at: p } = await at('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(');
        const before = doc.getText();
        const disk = fs.readFileSync(doc.uri.fsPath);
        const r = await api.engine.prepareRename(p, 'FetchOrderQuery');
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const files = r.plan.writeSet.map((c) => c.uri.split('/').pop());
        for (const want of ['OrderRequests.cs', 'OrderHandlers.cs', 'Program.cs']) assert.ok(files.includes(want), `${want} in ${files.join(', ')}`);
        assert.equal(r.applyEnabled, true, 'apply is offered by default (refyntra.rename.apply)');
        api.engine.discardPlan(r.planId);
        assert.equal(doc.getText(), before);
        assert.deepEqual(fs.readFileSync(doc.uri.fsPath), disk);
      },
    ],
  ],
  'di-rules': [
    [
      'OR1001: three warnings in Problems from the installed host',
      async () => {
        const all = await waitFor(() => {
          const d = vscode.languages.getDiagnostics().flatMap(([uri, list]) => list.filter((x) => x.source === 'Refyntra').map((x) => ({ uri, d: x })));
          return d.length >= 3 ? d : undefined;
        }, 'three OR1001 diagnostics', 120000);
        assert.equal(all.length, 3);
        for (const x of all) assert.equal(typeof x.d.code === 'object' ? x.d.code.value : x.d.code, 'OR1001');
        assert.deepEqual(all.map((x) => path.basename(x.uri.fsPath)).sort(), ['Program.cs', 'Transitive.cs', 'Typeof.cs']);
      },
    ],
  ],
};

const route = (id) => api.health().adapters.find((a) => a.providerRouteId === id);
scenarios.pyrust = [
  [
    'Python: the installed package runs its bundled Pyright (servers/pyright) on the editor Node runtime',
    async () => {
      const { doc, at: pos } = await at('app/use.py', 'get_order(1)', 2);
      await vscode.window.showTextDocument(doc);
      const r = await waitFor(async () => {
        const x = await api.engine.related(pos);
        return x.kind === 'related' && x.groups.some((g) => g.group === 'declarations') ? x : undefined;
      }, 'Pyright Related', 120000);
      assert.match(r.groups[0].relations[0].target.location.uri, /orders\.py$/);
      const l = api.lspLaunches().find((x) => x.args.some((a) => a.endsWith('langserver.index.js')));
      assert.ok(l, JSON.stringify(api.lspLaunches()));
      assert.equal(lc(l.args[0]), lc(path.join(ext.extensionPath, 'servers', 'pyright', 'langserver.index.js')));
      assert.equal(l.command, process.execPath);
    },
  ],
  [
    'Rust: the installed package runs its own rust-analyzer binary (servers/rust-analyzer), never one from PATH',
    async () => {
      const { doc, at: pos } = await at('src/usage.rs', 'get_order(1)', 2);
      await vscode.window.showTextDocument(doc);
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(route('rust.rust-analyzer').state), 'rust-analyzer started', 180000);
      assert.notEqual(route('rust.rust-analyzer').state, 'Failed', JSON.stringify(route('rust.rust-analyzer')));
      const r = await waitFor(async () => {
        const x = await api.engine.related(pos);
        return x.kind === 'related' && x.groups.some((g) => g.group === 'declarations') ? x : undefined;
      }, 'rust-analyzer Related', 120000);
      assert.match(r.groups[0].relations[0].target.location.uri, /lib\.rs$/);
      const l = api.lspLaunches().find((x) => /rust-analyzer(\.exe)?$/.test(x.command));
      assert.ok(l, JSON.stringify(api.lspLaunches()));
      assert.equal(lc(path.dirname(l.command)), lc(path.join(ext.extensionPath, 'servers', 'rust-analyzer')));
      report.lspLaunches = api.lspLaunches();
    },
  ],
];

exports.run = async function run() {
  if (!scenarios[scenario]) throw new Error(`Unknown scenario ${scenario}`);
  const failures = [];
  for (const [title, fn] of [...common, ...scenarios[scenario]]) {
    try {
      await fn();
      console.log(`  ✓ ${title}`);
    } catch (e) {
      console.log(`  ✗ ${title}\n    ${e && e.stack ? e.stack : e}`);
      failures.push(title);
      if (!api) break;
    }
  }
  if (api) report.hostPids = api.hostPids();
  fs.writeFileSync(env.REFYNTRA_SMOKE_REPORT, JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(`${failures.length} install-smoke test(s) failed in ${scenario}`);
};
