// Target framework compatibility e2e (runTest.mjs scenarios "compat" and "compat-sdk-missing", Docker image with the
// .NET 8 SDK and the .NET 9 runtime next to SDK 10): on a temp copy of tests/fixtures/Compat — net8.0 web API (MediatR,
// DI, EF Core 8), net8.0 and net9.0 consoles, netstandard2.0/2.1 libraries, a net8.0;net10.0 library, a net8.0 xUnit
// project — Find and Related across target frameworks, Run of the net8.0 web app and the net9.0 console, Debug of the
// net8.0 console with a breakpoint (netcoredbg), the test runner on the net8.0 xUnit project. "compat-sdk-missing": a
// global.json that pins an SDK that is not installed → Health names it and offers Open global.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (rel) => path.join(root(), ...rel.split('/'));
  const LONG = 600000;

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    await waitFor(async () => (await a.run.refresh()).some((t) => t.label === 'Compat.Cli' && t.runnable), 'Compat.Cli in the run targets', 60000);
    return a;
  }

  const target = (a, label) => {
    const t = a.run.targets().find((x) => x.label === label);
    assert.ok(t, `run target ${label}`);
    return t;
  };

  function lineOf(rel, needle) {
    const i = fs.readFileSync(file(rel), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return i;
  }

  function get(url) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    });
  }

  async function relatedAt(a, rel, needle, offset) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file(rel)));
    const r = await a.engine.related({ uri: doc.uri.toString(), position: doc.positionAt(doc.getText().indexOf(needle) + offset) });
    assert.equal(r.kind, 'related', JSON.stringify(r));
    return { relations: r.groups.flatMap((g) => g.relations) };
  }

  return [
    [
      'compat: every target framework loads (net8.0, net9.0, net10.0, netstandard2.0/2.1), one context per framework',
      async () => {
        const a = await ready();
        const h = csharp(a.health());
        const tfms = h.projects.map((p) => `${path.basename(p.projectPath, '.csproj')} ${p.targetFramework}`).sort();
        assert.deepEqual(tfms, ['Compat.Api net8.0', 'Compat.Cli net8.0', 'Compat.Console net9.0', 'Compat.Contracts netstandard2.0', 'Compat.Multi net10.0', 'Compat.Multi net8.0', 'Compat.Shared netstandard2.1', 'Compat.Tests net8.0']);
        assert.ok(h.projects.every((p) => p.state === 'loaded'));
      },
    ],
    [
      'compat: Related from the netstandard2.0 request finds the MediatR handler and the DI registration in the net8.0 app',
      async () => {
        const a = await ready();
        const rel = await relatedAt(a, 'Compat.Contracts/Orders.cs', 'class GetOrderQuery', 6);
        assert.ok(rel.relations.some((r) => r.relationKind === 'mediatr.handler' && JSON.stringify(r.target).includes('GetOrderHandler')), JSON.stringify(rel.relations.map((r) => r.relationKind)));
        const clock = await relatedAt(a, 'Compat.Contracts/Orders.cs', 'interface IClock', 10);
        assert.ok(clock.relations.some((r) => r.relationKind === 'di.registration' && r.target.label.includes('AddSingleton<IClock, SystemClock>')));
      },
    ],
    [
      'compat: the net8.0 web app runs and answers through MediatR, the net9.0 console runs on .NET 9',
      async () => {
        const a = await ready();
        const web = target(a, 'Compat.Api');
        await a.run.select(web, { profile: 'http', configuration: 'Debug' });
        const session = await a.run.run(web.id);
        try {
          await waitFor(() => /Now listening on: http:\/\/localhost:5291/.test(session.output), 'Now listening on', LONG);
          assert.equal((await get('http://localhost:5291/')).body, 'Compat API on net8 8');
          const order = await get('http://localhost:5291/orders/2');
          assert.equal(order.status, 200);
          assert.equal(order.body, 'Order 2: 108.00');
        } finally {
          a.run.stop(web.id);
        }
        await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not stop')), 30000))]);
        const console9 = await a.run.run(target(a, 'Compat.Console').id);
        const code = await Promise.race([console9.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not finish')), LONG))]);
        assert.equal(code, 9);
        assert.match(console9.output, /Order 9: 50\.00 on 9/);
      },
    ],
    [
      'compat: netcoredbg stops at a breakpoint in the net8.0 console and the program runs to its exit code',
      async () => {
        const a = await ready();
        const rel = 'Compat.Cli/Program.cs';
        const line = lineOf(rel, 'Console.WriteLine');
        const uri = vscode.Uri.file(file(rel));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)));
        const events = [];
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => m.type === 'event' && events.push(m) }) });
        vscode.debug.addBreakpoints([bp]);
        try {
          const started = new Promise((resolve) => {
            const sub = vscode.debug.onDidStartDebugSession((s) => {
              if (s.type !== 'refyntra-dotnet') return;
              sub.dispose();
              resolve(s);
            });
          });
          assert.equal(await a.run.debug(target(a, 'Compat.Cli').id), true);
          const session = await started;
          const ended = new Promise((resolve) => {
            const sub = vscode.debug.onDidTerminateDebugSession((s) => s.id === session.id && (sub.dispose(), resolve()));
          });
          const stop = await waitFor(() => events.find((e) => e.event === 'stopped'), 'the stopped event', LONG);
          assert.equal(stop.body.reason, 'breakpoint');
          const frame = (await session.customRequest('stackTrace', { threadId: stop.body.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
          assert.equal(frame.line, line + 1);
          const price = await session.customRequest('evaluate', { expression: 'price', frameId: frame.id, context: 'watch' });
          assert.equal(price.result, '180.0');
          await session.customRequest('continue', { threadId: stop.body.threadId });
          await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          assert.equal(a.run.hooks.debugExitCodes.get(session.id), 8);
        } finally {
          vscode.debug.removeBreakpoints([bp]);
          tracker.dispose();
        }
      },
    ],
    [
      'compat: the test runner discovers and runs the net8.0 xUnit project',
      async () => {
        const a = await ready();
        await waitFor(() => a.testing.state().ids.some((i) => i.endsWith('|Compat.Tests.PriceTests.RunsOnNet8')), 'discovered tests', 60000);
        const roots = a.testing.state().ids.filter((i) => i.startsWith('dotnet:proj:'));
        assert.equal(roots.length, 1);
        await a.testing.runIds(roots);
        const st = a.testing.state();
        const outcomes = Object.entries(st.results).filter(([id]) => id.startsWith('dotnet:')).map(([, r]) => r.outcome);
        assert.ok(outcomes.length >= 4, JSON.stringify(st.results));
        assert.ok(outcomes.every((o) => o === 'passed'), JSON.stringify(st.results, null, 1));
        assert.equal(st.results[st.ids.find((i) => i.endsWith('|Compat.Tests.PriceTests.RunsOnNet8'))].outcome, 'passed');
      },
    ],
    [
      'compat: nothing is left running',
      async () => {
        const a = await api();
        a.run.stop();
        await waitFor(() => a.run.sessions.size === 0 && !vscode.debug.activeDebugSession, 'no sessions', 30000);
      },
    ],
  ];
};

exports.sdkMissing = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  return [
    [
      'compat: a global.json pinning a missing SDK → Health names it, offers Open global.json, which opens it',
      async () => {
        const a = await api();
        await waitFor(() => csharp(a.health())?.reasonCode === 'SdkNotFound', 'SdkNotFound', 120000);
        const gj = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'global.json');
        assert.match(csharp(a.health()).message, /global\.json asks for \.NET SDK 8\.0\.100 \(rollForward: disable, accepts exactly 8\.0\.100\)/);
        const page = a.healthPage.model().sections[0];
        assert.equal(page.primary.id, 'installSdk');
        const open = page.more.find((m) => m.id === 'openGlobalJson');
        assert.ok(open, JSON.stringify(page.more));
        assert.equal(path.normalize(open.arg), path.normalize(gj));
        await vscode.commands.executeCommand('refyntra.showHealth');
        await a.healthPage.dispatch({ type: 'action', key: open.key });
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === gj, 'global.json opened', 10000);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
  ];
};
