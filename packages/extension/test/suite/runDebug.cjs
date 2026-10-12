// Run and Debug e2e on a temp copy of tests/fixtures/Runnable (runTest.mjs scenario "run-debug"), every other
// extension disabled: the runnable-project model of the host, the bundled netcoredbg (breakpoint, locals, continue,
// exit code), a web app run with its launch profile (HTTP request to its URL, browser URL), the bundled debugpy with
// the system Python, dynamic configurations, CodeLens and Generate launch.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (rel) => path.join(root(), ...rel.split('/'));

  /** DAP events of every debug session (stopped, exited, output), recorded by a tracker for all types. */
  const events = new Map();
  let tracking;
  function track() {
    if (tracking) return;
    tracking = vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: (session) => ({
        onDidSendMessage: (m) => {
          if (m.type !== 'event') return;
          if (!events.has(session.id)) events.set(session.id, []);
          events.get(session.id).push(m);
        },
      }),
    });
  }
  const eventsOf = (s, name) => (events.get(s.id) ?? []).filter((e) => e.event === name);

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    await waitFor(async () => (await a.run.refresh()).some((t) => t.label === 'ConsoleApp' && t.runnable), 'ConsoleApp in the run targets', 60000);
    return a;
  }

  const target = (a, label) => {
    const t = a.run.targets().find((x) => x.label === label);
    assert.ok(t, `run target ${label}`);
    return t;
  };

  async function lineOf(rel, needle) {
    const text = fs.readFileSync(file(rel), 'utf8');
    const i = text.split(/\r?\n/).findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return i; // 0-based
  }

  async function startedSession(start, type) {
    const before = new Set();
    const started = new Promise((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((s) => {
        if (s.type !== type || before.has(s.id)) return;
        sub.dispose();
        resolve(s);
      });
    });
    const ok = await start();
    assert.equal(ok, true, 'debugging started');
    return Promise.race([started, new Promise((_, rej) => setTimeout(() => rej(new Error('no debug session started')), 240000))]);
  }

  function ended(session) {
    return new Promise((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id !== session.id) return;
        sub.dispose();
        resolve();
      });
    });
  }

  /** The top frame and its local variables once the session stopped. */
  async function stoppedAt(session) {
    const stop = await waitFor(() => eventsOf(session, 'stopped')[0], 'the stopped event', 240000);
    const threadId = stop.body.threadId;
    const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const frame = st.stackFrames[0];
    const scopes = await session.customRequest('scopes', { frameId: frame.id });
    const vars = {};
    for (const sc of scopes.scopes) {
      if (sc.expensive) continue;
      const v = await session.customRequest('variables', { variablesReference: sc.variablesReference });
      for (const x of v.variables) vars[x.name] = x.value;
    }
    return { threadId, frame, vars, reason: stop.body.reason };
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

  return [
    [
      'run: the host classifies the projects (console, web, worker, multi-target; tests not runnable; libraries left out)',
      async () => {
        const a = await ready();
        const ts = a.run.targets().filter((t) => t.language === 'dotnet');
        const byName = Object.fromEntries(ts.map((t) => [t.label, t]));
        assert.deepEqual(Object.keys(byName).sort(), ['AppTests', 'ConsoleApp', 'MultiApp', 'WebApp', 'WorkerApp']);
        assert.equal(byName.WebApp.kindLabel, 'web app');
        assert.equal(byName.WorkerApp.kindLabel, 'worker service');
        assert.equal(byName.AppTests.runnable, false);
        assert.match(byName.AppTests.note, /Test project/);
        assert.deepEqual(byName.MultiApp.dotnet.project.targetFrameworks.slice().sort(), ['net10.0', 'net8.0']);
        assert.deepEqual(byName.WebApp.dotnet.profiles.map((p) => p.name), ['http', 'staging']);
        assert.ok(a.run.targets().some((t) => t.language === 'python' && t.label === 'main.py'), 'the Python entry file is a target');
        // The Run view lists them under .NET / Python.
        const groups = a.run.getChildren();
        assert.deepEqual(groups.map((g) => g.label), ['.NET', 'Python']);
        assert.match(a.run.statusBarText(), /^\$\(play\) /);
      },
    ],
    [
      'run: dynamic configurations show up for VS Code (launch per profile, attach)',
      async () => {
        const a = await ready();
        const cfgs = await a.run.dynamicConfigurations('refyntra-dotnet');
        const names = cfgs.map((c) => c.name);
        assert.ok(names.includes('Refyntra: ConsoleApp'), names.join(', '));
        assert.ok(names.includes('Refyntra: WebApp (http)') && names.includes('Refyntra: WebApp (staging)'), names.join(', '));
        assert.ok(names.includes('Refyntra: MultiApp [net10.0]'), names.join(', '));
        assert.ok(cfgs.some((c) => c.request === 'attach' && c.processId === '${command:refyntra.pickDotnetProcess}'));
        const py = await a.run.dynamicConfigurations('refyntra-python');
        assert.equal(py.length, 1);
        assert.match(py[0].program, /main\.py$/);
      },
    ],
    [
      'run: CodeLens "Run | Debug" over the first top-level statement of Program.cs',
      async () => {
        await ready();
        const uri = vscode.Uri.file(file('ConsoleApp/Program.cs'));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        const line = await lineOf('ConsoleApp/Program.cs', 'var greeting');
        const lenses = await waitFor(async () => {
          const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 10);
          const run = ls.filter((l) => l.command && /Run|Debug/.test(l.command.title) && /refyntra\.(run|debug)/.test(l.command.command));
          return run.length === 2 ? run : undefined;
        }, 'Run and Debug lenses', 30000);
        assert.ok(lenses.every((l) => l.range.start.line === line));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'debug: netcoredbg stops at a breakpoint in the console app, shows the locals, continues to the exit code',
      async () => {
        const a = await ready();
        track();
        const rel = 'ConsoleApp/Program.cs';
        const line = await lineOf(rel, 'Console.WriteLine');
        const uri = vscode.Uri.file(file(rel));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        try {
          const session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
          const done = ended(session);
          const at = await stoppedAt(session);
          assert.equal(at.reason, 'breakpoint');
          assert.equal(at.frame.line, line + 1, `stopped at line ${line + 1}`);
          assert.match(at.frame.source.path.replace(/\\/g, '/'), /ConsoleApp\/Program\.cs$/);
          assert.equal(at.vars.greeting, '"Hello Run"');
          assert.equal(at.vars.count, '41');
          // An expression in the paused frame (netcoredbg evaluates with the bundled Roslyn).
          const ev = await session.customRequest('evaluate', { expression: 'count + 1', frameId: at.frame.id, context: 'watch' });
          assert.equal(ev.result, '42');

          // Inline values (Rider-like): the provider evaluates the names of the stopped method up to the stopped line.
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
          const none = new vscode.CancellationTokenSource().token;
          const inline = await a.inlineValues.values.provideInlineValues(doc, new vscode.Range(0, 0, doc.lineCount - 1, 0), { frameId: at.frame.id, stoppedLocation: new vscode.Range(line, 0, line, 0) }, none);
          const texts = inline.map((v) => v.text);
          assert.ok(texts.includes('greeting = "Hello Run"'), texts.join(' | '));
          assert.ok(texts.includes('count = 41'), texts.join(' | '));
          assert.ok(texts.some((t) => /^version = \{(System\.Version|1\.2)\}$/.test(t)), texts.join(' | '));
          assert.ok(inline.every((v) => v.range.start.line <= line), 'nothing after the stopped line');
          // Hover evaluates the whole member chain (args.Length), never a call.
          const lenLine = await lineOf(rel, 'args.Length');
          const lenCol = doc.lineAt(lenLine).text.indexOf('Length') + 2;
          assert.equal(a.inlineValues.hover.provideEvaluatableExpression(doc, new vscode.Position(lenLine, lenCol)).expression, 'args.Length');
          // Immediate Window: an expression, an assignment (restored so the exit code stays 7), an expanded object.
          await vscode.commands.executeCommand('refyntra.showImmediate');
          await waitFor(() => a.immediate.frame(), 'the Immediate Window bound to the stopped frame', 10000);
          const plus = await a.immediate.evaluate('count + 1');
          assert.equal(plus.result?.value, '42', JSON.stringify(plus));
          const assign = await a.immediate.evaluate('count = 5');
          assert.ok(!assign.error, assign.error);
          assert.equal((await a.immediate.evaluate('count')).result?.value, '5');
          await a.immediate.evaluate('count = 41');
          const obj = await a.immediate.evaluate('version');
          assert.ok(obj.result && obj.result.ref > 0, `version is expandable: ${JSON.stringify(obj)}`);
          const members = await a.immediate.expand(obj.result.id);
          const byName = Object.fromEntries(members.map((m) => [m.label, m.value]));
          assert.equal(byName.Major, '1', JSON.stringify(members));
          assert.equal(byName.Minor, '2');
          const bad = await a.immediate.evaluate('noSuchName');
          assert.ok(bad.error, 'an unknown name is an error entry');
          await vscode.commands.executeCommand('workbench.action.closePanel');
          await session.customRequest('continue', { threadId: at.threadId });
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          const exited = eventsOf(session, 'exited')[0];
          assert.ok(exited, 'exited event');
          assert.equal(exited.body.exitCode, 7, 'the program returned 7');
          assert.equal(a.run.hooks.debugExitCodes.get(session.id), 7);
          const out = eventsOf(session, 'output').map((e) => e.body.output).join('');
          assert.match(out, /Hello Run 41/);
        } finally {
          vscode.debug.removeBreakpoints([bp]);
        }
      },
    ],
    [
      'constructor: Create and initialize field from a constructor parameter, Undo restores the file',
      async () => {
        const p = file('Svc.cs');
        const original = ['namespace Demo;', '', 'public interface IRepo { }', '', 'public class Svc', '{', '    private readonly IRepo _other;', '', '    public Svc(IRepo other, IRepo repo)', '    {', '        _other = other;', '    }', '}', ''].join('\n');
        fs.writeFileSync(p, original);
        try {
          const uri = vscode.Uri.file(p);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
          const at = doc.positionAt(original.indexOf('repo)') + 1);
          const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(at, at), undefined, 50);
          const titles = actions.map((x) => x.title);
          assert.ok(titles.includes("Create and initialize property 'Repo'"), titles.join(' | '));
          assert.ok(titles.includes("Register 'IRepo' in DI…"), titles.join(' | '));
          const create = actions.find((x) => x.title === "Create and initialize field '_repo'");
          assert.ok(create, titles.join(' | '));
          assert.equal(await vscode.commands.executeCommand(create.command.command, ...create.command.arguments), true);
          const text = doc.getText();
          assert.ok(text.includes('    private readonly IRepo _other;\n    private readonly IRepo _repo;\n'), text);
          assert.ok(text.includes('        _other = other;\n        _repo = repo;\n    }'), text);
          await vscode.window.showTextDocument(doc);
          await vscode.commands.executeCommand('undo');
          assert.equal(doc.getText(), original, 'one Undo restores the file');
          // On an unassigned readonly field: Initialize from constructor (creates the constructor).
          const field = ['namespace Demo;', 'public class W', '{', '    private readonly IRepo _repo;', '}', ''].join('\n');
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), field);
          await vscode.workspace.applyEdit(edit);
          const onField = doc.positionAt(field.indexOf('_repo') + 1);
          const fa = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(onField, onField), undefined, 50);
          const init = fa.find((x) => x.title === "Initialize '_repo' from constructor");
          assert.ok(init, fa.map((x) => x.title).join(' | '));
          assert.equal(await vscode.commands.executeCommand(init.command.command, ...init.command.arguments), true);
          assert.ok(doc.getText().includes('    public W(IRepo repo)\n    {\n        _repo = repo;\n    }'), doc.getText());
          await vscode.commands.executeCommand('workbench.action.files.revert');
        } finally {
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
          fs.rmSync(p, { force: true });
        }
      },
    ],
    [
      'run: the web app starts with its launch profile, answers on the profile URL, the browser URL is opened; Stop ends it',
      async () => {
        const a = await ready();
        const web = target(a, 'WebApp');
        await a.run.select(web, { profile: 'http', configuration: 'Debug' });
        a.run.hooks.openedUrls.length = 0;
        const session = await a.run.run(web.id);
        assert.ok(session, 'a run session');
        try {
          await waitFor(() => /Now listening on: http:\/\/localhost:5187/.test(session.output), 'Now listening on', 240000);
          const r = await get('http://localhost:5187/');
          assert.equal(r.status, 200);
          assert.equal(r.body, 'Hello from WebApp in Development');
          await waitFor(() => a.run.hooks.openedUrls.includes('http://localhost:5187'), 'the browser URL', 10000);
          assert.equal(a.run.sessions.has(web.id), true);
        } finally {
          a.run.stop(web.id);
        }
        await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not stop')), 30000))]);
        assert.equal(a.run.sessions.has(web.id), false, 'session removed after Stop');
        await assert.rejects(get('http://localhost:5187/'), 'nothing listens after Stop');
      },
    ],
    [
      'run: the console app runs without debugging and reports its exit code',
      async () => {
        const a = await ready();
        const session = await a.run.run(target(a, 'ConsoleApp').id);
        const code = await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not finish')), 240000))]);
        assert.equal(code, 7);
        assert.match(session.output, /Hello Run 41/);
      },
    ],
    [
      'debug: the bundled debugpy stops at a breakpoint in a Python file with the system interpreter',
      async () => {
        const a = await ready();
        track();
        const py = a.run.debuggers.python();
        assert.ok(py, 'a Python interpreter (python3 in the container)');
        const rel = 'scripts/main.py';
        const line = await lineOf(rel, 'print(');
        const uri = vscode.Uri.file(file(rel));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        try {
          const session = await startedSession(() => a.run.debug(uri), 'refyntra-python');
          const done = ended(session);
          const at = await stoppedAt(session);
          assert.equal(at.frame.line, line + 1);
          assert.equal(at.vars.answer, '6');
          assert.equal(at.vars.numbers, '[1, 2, 3]');
          await session.customRequest('continue', { threadId: at.threadId });
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          const exited = await waitFor(() => eventsOf(session, 'exited')[0], 'exited', 10000).catch(() => undefined);
          if (exited) assert.equal(exited.body.exitCode, 0);
        } finally {
          vscode.debug.removeBreakpoints([bp]);
        }
      },
    ],
    [
      'run: Generate launch.json writes the configurations; Health names the bundled debuggers',
      async () => {
        const a = await ready();
        const uri = await vscode.commands.executeCommand('refyntra.generateLaunchJson');
        assert.ok(uri, 'launch.json written');
        const json = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
        const names = json.configurations.map((c) => c.name);
        assert.ok(names.includes('Refyntra: ConsoleApp'));
        const console = json.configurations.find((c) => c.name === 'Refyntra: ConsoleApp');
        assert.equal(console.program, '${workspaceFolder}/ConsoleApp/bin/Debug/net10.0/ConsoleApp.dll');
        assert.ok(json.configurations.some((c) => c.type === 'refyntra-python'));
        // Running it again does not duplicate entries.
        await vscode.commands.executeCommand('refyntra.generateLaunchJson');
        const again = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
        assert.equal(again.configurations.length, json.configurations.length);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.rmSync(path.dirname(uri.fsPath), { recursive: true, force: true });
        const status = a.run.debuggers.status();
        assert.ok(status.netcoredbg.path, 'netcoredbg found');
        assert.match(status.netcoredbg.version, /netcoredbg 3\.2\.0-1092/);
        assert.match(status.debugpy.version, /debugpy 1\.8\.22/);
        assert.match(a.healthPage.model().sections.map((s) => s.headline).join('\n'), /Run and debug: ready/);
      },
    ],
    [
      'run: nothing is left running',
      async () => {
        const a = await api();
        a.run.stop();
        await waitFor(() => a.run.sessions.size === 0 && !vscode.debug.activeDebugSession, 'no sessions', 30000);
        tracking?.dispose();
      },
    ],
  ];
};
