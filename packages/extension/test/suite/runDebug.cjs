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
      'run: the host classifies the projects (console, web, worker, multi-target; tests not runnable and not listed in the Run view; libraries left out)',
      async () => {
        const a = await ready();
        const ts = a.run.targets().filter((t) => t.language === 'dotnet');
        const byName = Object.fromEntries(ts.map((t) => [t.label, t]));
        // The solution's projects, plus the project files of the folder that it does not list (Desktop/*).
        assert.deepEqual(Object.keys(byName).sort(), ['AppTests', 'BlazorClient', 'ConsoleApp', 'MauiApp', 'MultiApp', 'WebApp', 'WinFormsApp', 'WorkerApp', 'WpfApp']);
        assert.equal(byName.ConsoleApp.group, 'Runnable.sln');
        assert.equal(byName.BlazorClient.group, 'Other projects');
        // MAUI is never offered; WinForms and WPF run on Windows only.
        assert.equal(byName.MauiApp.runnable, false, 'MAUI is not offered');
        for (const n of ['WinFormsApp', 'WpfApp']) assert.equal(byName[n].runnable, process.platform === 'win32', `${n} runs on Windows only`);
        assert.equal(byName.WebApp.kindLabel, 'web app');
        assert.equal(byName.WorkerApp.kindLabel, 'worker service');
        assert.equal(byName.AppTests.runnable, false);
        assert.match(byName.AppTests.note, /Test project/);
        assert.deepEqual(byName.MultiApp.dotnet.project.targetFrameworks.slice().sort(), ['net10.0', 'net8.0']);
        assert.deepEqual(byName.WebApp.dotnet.profiles.map((p) => p.name), ['http', 'staging']);
        assert.ok(a.run.targets().some((t) => t.language === 'python' && t.label === 'main.py'), 'the Python entry file is a target');
        // The Run view lists them under .NET / Python.
        const groups = a.run.getChildren();
        assert.deepEqual(groups.map((g) => g.label), ['.NET · Runnable.sln', '.NET · Other projects', 'Python']);
        // Only runnable targets are listed: not the test project, MAUI, WPF or WinForms.
        const dotnet = a.run.getChildren(groups[0]).map((n) => n.target.label);
        const others = a.run.getChildren(groups[1]).map((n) => n.target.label);
        assert.deepEqual(others, process.platform === 'win32' ? ['BlazorClient', 'WinFormsApp', 'WpfApp'] : ['BlazorClient']);
        assert.ok(!dotnet.includes('AppTests'), dotnet.join(', '));
        assert.ok(dotnet.includes('ConsoleApp'), dotnet.join(', '));
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
          // Completions come from Roslyn at the stopped position (netcoredbg has no DAP completions).
          const names = await a.immediate.completions('cou', 3);
          assert.ok(names.includes('count'), JSON.stringify(names));
          const vmembers = await a.immediate.completions('version.Ma', 10);
          assert.ok(vmembers.includes('Major'), JSON.stringify(vmembers));
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
      'run: a web app that does not print "Now listening" opens the browser once its port answers; refyntra.run.openBrowser always/never',
      async () => {
        const a = await ready();
        const settingsPath = file('WebApp/Properties/launchSettings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        // Its own logging: the host's start-up lines are filtered out, so only the port tells that the app is up.
        settings.profiles.quiet = { commandName: 'Project', launchBrowser: false, launchUrl: 'health', applicationUrl: 'http://localhost:5189',
          environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development', 'Logging__LogLevel__Microsoft.Hosting.Lifetime': 'None' } };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        await waitFor(async () => (await a.run.refresh()).some((t) => t.label === 'WebApp' && t.dotnet?.profiles.some((p) => p.name === 'quiet')), 'the quiet profile', 30000);
        const cfg = vscode.workspace.getConfiguration('refyntra');
        const web = target(a, 'WebApp');
        const start = async () => {
          a.run.hooks.openedUrls.length = 0;
          const session = await a.run.run(web.id);
          assert.ok(session, 'a run session');
          return session;
        };
        const stop = async (session) => {
          a.run.stop(web.id);
          await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not stop')), 30000))]);
        };
        try {
          // launchBrowser false: no browser as in Visual Studio; "always" opens it anyway, at the launchUrl.
          await cfg.update('run.openBrowser', 'always', vscode.ConfigurationTarget.Workspace);
          await a.run.select(web, { profile: 'quiet', configuration: 'Debug' });
          let session = await start();
          try {
            await waitFor(async () => (await get('http://localhost:5189/').catch(() => undefined))?.status === 200, 'the quiet app answering', 240000);
            assert.doesNotMatch(session.output, /Now listening on/);
            await waitFor(() => a.run.hooks.openedUrls.includes('http://localhost:5189/health'), 'the browser URL from the port check', 15000);
            assert.equal(a.run.hooks.openedUrls.length, 1, a.run.hooks.openedUrls.join(', '));
          } finally {
            await stop(session);
          }
          await cfg.update('run.openBrowser', 'never', vscode.ConfigurationTarget.Workspace);
          await a.run.select(web, { profile: 'http', configuration: 'Debug' });
          session = await start();
          try {
            await waitFor(() => /Now listening on: http:\/\/localhost:5187/.test(session.output), 'Now listening on', 240000);
            await new Promise((r) => setTimeout(r, 2000));
            assert.deepEqual(a.run.hooks.openedUrls, [], 'never: no browser although launchBrowser is true');
          } finally {
            await stop(session);
          }
        } finally {
          await cfg.update('run.openBrowser', undefined, vscode.ConfigurationTarget.Workspace);
        }
      },
    ],
    [
      'debug: the browser setting and the port check cover every start (dropdown configuration, F5); a failed start opens nothing',
      async () => {
        const a = await ready();
        track();
        const cfg = vscode.workspace.getConfiguration('refyntra');
        const folder = vscode.workspace.workspaceFolders[0];
        const web = target(a, 'WebApp');
        const stopAll = async () => {
          await vscode.debug.stopDebugging();
          await waitFor(async () => !(await get('http://localhost:5189/').catch(() => undefined)) && !(await get('http://localhost:5187/').catch(() => undefined)), 'the web app stopped', 30000);
        };
        try {
          // A configuration of the Run and Debug dropdown (dynamic), for the quiet profile (launchBrowser false, no start-up line):
          // "always" applies at start and the port check opens the browser once.
          await cfg.update('run.openBrowser', 'always', vscode.ConfigurationTarget.Workspace);
          const quiet = (await a.run.dynamicConfigurations('refyntra-dotnet')).find((c) => c.launchProfile === 'quiet');
          assert.ok(quiet, 'a dropdown configuration for the quiet profile');
          assert.equal(quiet.launchBrowser.enabled, false, 'the configuration itself keeps the profile value');
          a.run.hooks.openedUrls.length = 0;
          assert.equal(await vscode.debug.startDebugging(folder, quiet), true);
          await waitFor(() => a.run.hooks.openedUrls.includes('http://localhost:5189/health'), 'the browser from the port check (debug)', 240000);
          await new Promise((r) => setTimeout(r, 1500));
          assert.equal(a.run.hooks.openedUrls.length, 1, a.run.hooks.openedUrls.join(', '));
          await stopAll();

          // F5 without launch.json (an empty configuration) on the selected http profile: "never" wins over launchBrowser true.
          await cfg.update('run.openBrowser', 'never', vscode.ConfigurationTarget.Workspace);
          await a.run.select(web, { profile: 'http', configuration: 'Debug' });
          a.run.hooks.openedUrls.length = 0;
          // The real F5 (workbench.action.debug.start) with a C# file of the app open and no launch.json.
          await vscode.window.showTextDocument(vscode.Uri.file(file('WebApp/Program.cs')));
          await vscode.commands.executeCommand('workbench.action.debug.start');
          await waitFor(async () => (await get('http://localhost:5187/').catch(() => undefined))?.status === 200, 'the http app answering (F5)', 240000);
          await new Promise((r) => setTimeout(r, 2000));
          assert.deepEqual(a.run.hooks.openedUrls, [], 'never: no browser from F5');
          await stopAll();

          // A start that fails before a session exists (no program, no build): nothing is opened, nothing keeps waiting.
          await cfg.update('run.openBrowser', 'always', vscode.ConfigurationTarget.Workspace);
          a.run.hooks.openedUrls.length = 0;
          const broken = { ...quiet, name: 'Refyntra: broken', build: false, program: file('WebApp/bin/Debug/missing/WebApp.dll') };
          const started = await vscode.debug.startDebugging(folder, broken);
          assert.equal(started, false, 'the broken configuration does not start');
          // The quiet app's port now answers through a Run: only the Run's own check may open the browser, once.
          await a.run.select(web, { profile: 'quiet', configuration: 'Debug' });
          const session = await a.run.run(web.id);
          try {
            await waitFor(() => a.run.hooks.openedUrls.length > 0, 'the run browser', 240000);
            await new Promise((r) => setTimeout(r, 1500));
            assert.deepEqual(a.run.hooks.openedUrls, ['http://localhost:5189/health'], 'no extra browser from the failed debug start');
          } finally {
            a.run.stop(web.id);
            await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not stop')), 30000))]);
          }
        } finally {
          await cfg.update('run.openBrowser', undefined, vscode.ConfigurationTarget.Workspace);
          await a.run.select(web, { profile: 'http', configuration: 'Debug' });
        }
      },
    ],
    [
      'run group: the web app starts first and is waited for, then the console app; the group node counts them; Stop Group ends them',
      async () => {
        const a = await ready();
        const cfg = vscode.workspace.getConfiguration('refyntra');
        await cfg.update('run.groups', [{ name: 'Backend', targets: ['WebApp', 'ConsoleApp', 'NoSuchApp'] }], vscode.ConfigurationTarget.Workspace);
        const web = target(a, 'WebApp');
        await a.run.select(web, { profile: 'http', configuration: 'Debug' });
        a.run.hooks.groupReadiness.length = 0;
        try {
          assert.deepEqual(a.run.groups().map((g) => g.name), ['Backend']);
          assert.equal(await a.run.startGroup('Backend'), true);
          assert.deepEqual(a.run.hooks.groupReadiness, [{ target: 'WebApp', ready: true }], 'the web app listened before the console app started');
          assert.equal(a.run.isRunning(web), 'run');
          const r = await get('http://localhost:5187/');
          assert.equal(r.status, 200);
          const roots = await a.run.getChildren(undefined);
          const node = roots.find((n) => n.kind === 'launchGroup');
          assert.ok(node, 'the group is a node of the Run view');
          const item = a.run.getTreeItem(node);
          assert.match(String(item.description), /[12] of 2 running/);
          assert.equal(item.contextValue, 'refyntra.launchGroup.running');
          const kids = await a.run.getChildren(node);
          assert.deepEqual(kids.map((k) => k.target.label), ['WebApp', 'ConsoleApp']);
          // A click on the running web app shows its own terminal (the one opened for this start).
          await a.run.focus(web.id);
          assert.equal(a.run.hooks.focused.at(-1), 'terminal');
          assert.match(a.run.sessions.get(web.id).terminal?.name ?? '', /WebApp/, 'the session knows its own terminal');
          await waitFor(() => vscode.window.activeTerminal === a.run.sessions.get(web.id).terminal, 'the web app terminal shown', 10000);
          await a.run.stopGroup('Backend');
          await waitFor(() => !a.run.sessions.has(web.id), 'the web app stopped', 30000);
          await assert.rejects(get('http://localhost:5187/'), 'nothing listens after Stop Group');
        } finally {
          await a.run.stopGroup('Backend');
          await cfg.update('run.groups', undefined, vscode.ConfigurationTarget.Workspace);
        }
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
      'debug extras: netcoredbg capabilities match ADR-008; a conditional breakpoint stops only when it holds; Run to Cursor; Smart Step Into',
      async () => {
        const a = await ready();
        track();
        const rel = 'ConsoleApp/Program.cs';
        const uri = vscode.Uri.file(file(rel));
        const loop = await lineOf(rel, 'total += Calc.Square(i);');
        const addLine = await lineOf(rel, 'total += Calc.Add(');
        const bigLine = await lineOf(rel, 'var big = ');
        const failLine = await lineOf(rel, 'Calc.TryFail();');
        const outLine = await lineOf(rel, 'Console.Out.WriteLine');
        const twiceBody = await lineOf('ConsoleApp/Calc.cs', 'return x * 2;');
        const cond = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(loop, 0)), true, 'i == 2');
        vscode.debug.addBreakpoints([cond]);
        const extras = a.debugExtras;
        const stops = (s) => eventsOf(s, 'stopped');
        const nthStop = (s, n, what) => waitFor(() => stops(s)[n - 1], what, 120000);
        const top = async (s, threadId) => (await s.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })).stackFrames[0];
        const value = async (s, frameId, expression) => (await s.customRequest('evaluate', { expression, frameId, context: 'watch' })).result;
        /** VS Code focuses the new top frame a moment after the stopped event; its Continue / Run to Cursor act on the focused thread. */
        const focused = (s) =>
          waitFor(async () => {
            const it = vscode.debug.activeStackItem;
            if (!(it instanceof vscode.DebugStackFrame) || it.session.id !== s.id) return false;
            const st = await s.customRequest('stackTrace', { threadId: it.threadId, startFrame: 0, levels: 1 });
            return st.stackFrames[0]?.id === it.frameId;
          }, 'VS Code focuses the stopped frame', 30000);
        async function runToCursor(s, line, n) {
          await focused(s);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: false });
          await vscode.commands.executeCommand('editor.debug.action.runToCursor');
          const e = await nthStop(s, n, `stop #${n} (Run to Cursor, line ${line + 1})`);
          const f = await top(s, e.body.threadId);
          assert.equal(f.line, line + 1, `Run to Cursor stopped at line ${line + 1}`);
          return { e, f };
        }
        const userBreakpoints = () => vscode.debug.breakpoints.length;
        try {
          const session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
          const done = ended(session);
          // 1. Conditional breakpoint: the loop runs four times, it stops once, with i == 2.
          const first = await nthStop(session, 1, 'the conditional breakpoint');
          assert.equal(first.body.reason, 'breakpoint');
          let f = await top(session, first.body.threadId);
          assert.equal(f.line, loop + 1);
          assert.equal(await value(session, f.id, 'i'), '2');
          assert.equal(await value(session, f.id, 'total'), '1');
          // The capabilities VS Code sees: the table in ADR-008 (absent = false) plus what Refyntra's proxy emulates.
          const caps = extras.hooks.capabilities;
          assert.ok(caps, 'the initialize response was seen');
          for (const [k, v] of Object.entries(extras.expectedCapabilities)) assert.equal(!!caps[k], v, `refyntra-dotnet ${k}`);

          // 2. Run to Cursor (VS Code's command, Ctrl+F10 in the visualStudio preset): the loop ends without another
          // stop at the conditional breakpoint (i == 3 does not hold).
          ({ f } = await runToCursor(session, addLine, 2));
          assert.equal(await value(session, f.id, 'total'), '14');

          // 3. Smart Step Into: the calls of the statement in the order they run; into Twice (Square already ran).
          const before = userBreakpoints();
          extras.hooks.pick = (items) => items.find((i) => i.target.label === 'Calc.Twice(int)');
          await focused(session);
          let out = await extras.smartStepInto();
          assert.deepEqual(extras.hooks.lastTargets.targets.map((t) => t.label), ['Calc.Square(int)', 'Calc.Twice(int)', 'Calc.Add(int, int)']);
          assert.equal(out.kind, 'target', JSON.stringify(out));
          assert.equal(out.at.line, twiceBody + 1);
          assert.ok(out.at.path.replace(/\\/g, '/').endsWith('ConsoleApp/Calc.cs'), out.at.path);
          f = await top(session, stops(session)[2].body.threadId);
          assert.equal(f.line, twiceBody + 1);
          assert.equal(await value(session, f.id, 'x'), '3');
          assert.equal(userBreakpoints(), before, 'the temporary breakpoints are removed');

          // 4. A call that is not made (short-circuit): Smart Step Into stops at the next statement and says so.
          await runToCursor(session, bigLine, 4);
          extras.hooks.pick = (items) => items.find((i) => i.target.label === 'Calc.Check(int)');
          await focused(session);
          out = await extras.smartStepInto();
          assert.equal(out.kind, 'returned', JSON.stringify(out));
          assert.equal(out.at.line, failLine + 1);
          assert.ok(extras.hooks.messages.some((m) => /Calc\.Check\(int\) was not called/.test(m)));
          assert.equal(userBreakpoints(), before);

          // 5. A framework method (no source): listed, refused honestly, the program stays where it is.
          await runToCursor(session, outLine, 6);
          extras.hooks.pick = (items) => items.find((i) => /WriteLine/.test(i.target.label));
          await focused(session);
          out = await extras.smartStepInto();
          assert.equal(out.kind, 'refused', JSON.stringify(out));
          assert.match(out.message, /no source in the solution/);
          assert.equal(stops(session).length, 6, 'no continue after a refusal');
          extras.hooks.pick = undefined;

          await session.customRequest('continue', { threadId: stops(session)[5].body.threadId });
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          assert.equal(a.run.hooks.debugExitCodes.get(session.id), 7);
          assert.match(eventsOf(session, 'output').map((e) => e.body.output).join(''), /Total 24 False/);
        } finally {
          extras.hooks.pick = undefined;
          vscode.debug.removeBreakpoints([cond]);
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
      },
    ],
    [
      'debug extras: Break on Exception Types stops on the chosen type only',
      async () => {
        const a = await ready();
        track();
        const extras = a.debugExtras;
        const throwLine = await lineOf('ConsoleApp/Calc.cs', 'throw new InvalidOperationException');
        try {
          await vscode.commands.executeCommand('refyntra.breakOnExceptionTypes', ['System.InvalidOperationException']);
          let session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
          let done = ended(session);
          const stop = await waitFor(() => eventsOf(session, 'stopped')[0], 'the exception stop', 240000);
          assert.equal(stop.body.reason, 'exception');
          const f = (await session.customRequest('stackTrace', { threadId: stop.body.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
          assert.equal(f.line, throwLine + 1);
          const info = await session.customRequest('exceptionInfo', { threadId: stop.body.threadId });
          assert.match(info.exceptionId, /System\.InvalidOperationException/);
          await session.customRequest('continue', { threadId: stop.body.threadId });
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          assert.equal(eventsOf(session, 'stopped').length, 1);

          // Another type: the InvalidOperationException is thrown and caught without a stop.
          await vscode.commands.executeCommand('refyntra.breakOnExceptionTypes', ['System.ArgumentException']);
          session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
          done = ended(session);
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 240000))]);
          assert.equal(eventsOf(session, 'stopped').length, 0, 'no stop for a type that is not thrown');
          assert.equal(a.run.hooks.debugExitCodes.get(session.id), 7);
        } finally {
          await vscode.workspace.getConfiguration('refyntra').update('debug.dotnet.breakOnExceptionTypes', undefined, vscode.ConfigurationTarget.Workspace);
        }
      },
    ],
    [
      'debug extras: hit counts and logpoints (emulated by Refyntra in front of netcoredbg): == 3, % 2, logpoint, logpoint + condition, Step Over a call with a logpoint',
      async () => {
        const a = await ready();
        track();
        const extras = a.debugExtras;
        const rel = 'ConsoleApp/Program.cs';
        const uri = vscode.Uri.file(file(rel));
        const calc = vscode.Uri.file(file('ConsoleApp/Calc.cs'));
        const loop = await lineOf(rel, 'total += Calc.Square(i);');
        const addLine = await lineOf(rel, 'total += Calc.Add(');
        const bigLine = await lineOf(rel, 'var big = ');
        const squareLine = await lineOf('ConsoleApp/Calc.cs', 'public static int Square');
        const at = (u, line, opts = {}) => new vscode.SourceBreakpoint(new vscode.Location(u, new vscode.Position(line, 0)), true, opts.condition, opts.hitCondition, opts.logMessage);
        const output = (s) => eventsOf(s, 'output').map((e) => e.body.output).join('');
        /** Debugs ConsoleApp with these breakpoints; at every stop records `i` and continues; returns the stops and the output. */
        async function debugWith(bps) {
          vscode.debug.addBreakpoints(bps);
          try {
            const session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
            const done = ended(session);
            let finished = false;
            void done.then(() => (finished = true));
            const seen = [];
            for (;;) {
              const next = await waitFor(() => finished || eventsOf(session, 'stopped')[seen.length], `stop #${seen.length + 1} or the end`, 240000);
              if (next === true) break;
              const f = (await session.customRequest('stackTrace', { threadId: next.body.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
              const i = (await session.customRequest('evaluate', { expression: 'i', frameId: f.id, context: 'watch' })).result;
              seen.push({ reason: next.body.reason, line: f.line - 1, i });
              await session.customRequest('continue', { threadId: next.body.threadId });
            }
            assert.equal(a.run.hooks.debugExitCodes.get(session.id), 7, 'the program ends normally');
            return { session, stops: seen, output: output(session) };
          } finally {
            vscode.debug.removeBreakpoints(bps);
          }
        }

        // The capabilities: netcoredbg's own (ADR-008) and what VS Code sees through Refyntra's proxy.
        let r = await debugWith([at(uri, loop, { hitCondition: '== 3' })]);
        assert.deepEqual(r.stops, [{ reason: 'breakpoint', line: loop, i: '2' }], 'hit count == 3 stops once, at the third iteration');
        const raw = extras.proxyStats().adapterCapabilities;
        for (const [k, v] of Object.entries(extras.adapterCapabilities)) assert.equal(!!raw[k], v, `netcoredbg ${k}`);
        assert.equal(extras.hooks.capabilities.supportsLogPoints, true);
        assert.equal(extras.hooks.capabilities.supportsHitConditionalBreakpoints, true);
        assert.equal(extras.proxyStats().swallowedStops, 3, 'hits 1, 2 and 4 were real stops the proxy resumed');

        r = await debugWith([at(uri, loop, { hitCondition: '% 2' })]);
        assert.deepEqual(r.stops.map((x) => x.i), ['1', '3'], 'hit count % 2 stops at every second hit');

        r = await debugWith([at(uri, loop, { logMessage: 'i={i} total={total}' })]);
        assert.deepEqual(r.stops, [], 'a logpoint never stops');
        assert.match(r.output, /i=0 total=0\ni=1 total=0\ni=2 total=1\ni=3 total=5\n/);
        assert.match(r.output, /Total 24 False/);

        r = await debugWith([at(uri, loop, { logMessage: 'late i={i}', condition: 'i >= 2' })]);
        assert.deepEqual(r.stops, []);
        assert.equal((r.output.match(/late i=\d/g) ?? []).join(','), 'late i=2,late i=3', 'the condition still filters the logpoint');

        // Step Over a call that runs into a logpoint: it logs, and the step ends at the next statement as usual.
        const plain = at(uri, addLine);
        const log = at(calc, squareLine, { logMessage: 'sq {x}' });
        vscode.debug.addBreakpoints([plain, log]);
        try {
          const session = await startedSession(() => a.run.debug(target(a, 'ConsoleApp').id), 'refyntra-dotnet');
          const done = ended(session);
          const first = await waitFor(() => eventsOf(session, 'stopped')[0], 'the breakpoint on the Add line', 240000);
          assert.equal((await session.customRequest('stackTrace', { threadId: first.body.threadId, startFrame: 0, levels: 1 })).stackFrames[0].line, addLine + 1);
          assert.match(output(session), /sq 0\nsq 1\nsq 2\nsq 3\n/);
          await session.customRequest('next', { threadId: first.body.threadId });
          const step = await waitFor(() => eventsOf(session, 'stopped')[1], 'the end of the step', 120000);
          assert.equal(step.body.reason, 'step');
          const f = (await session.customRequest('stackTrace', { threadId: step.body.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
          assert.equal(f.line, bigLine + 1, 'Step Over ends at the next statement');
          assert.match(output(session), /sq 3\nsq 2\n/, 'the logpoint inside the stepped-over call logged');
          await session.customRequest('continue', { threadId: step.body.threadId });
          await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('session did not end')), 60000))]);
          assert.equal(eventsOf(session, 'stopped').length, 2);
        } finally {
          vscode.debug.removeBreakpoints([plain, log]);
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
      'run: Run with Hot Reload (dotnet watch --non-interactive) shows its state in the status bar',
      async () => {
        const a = await ready();
        const session = await a.run.run(target(a, 'ConsoleApp').id, true);
        try {
          assert.ok(session.watch, 'a watch run has the Hot Reload indicator');
          // The console app exits (code 7); dotnet watch then waits for a file change.
          await waitFor(() => session.watch.status.state === 'waiting', 'the indicator says waiting', 240000).catch((e) => {
            throw new Error(`${e.message}; state ${session.watch.status.state}; output:
${session.output.slice(-3000)}`);
          });
          assert.equal(session.watch.text(), '$(watch) Hot Reload: waiting for changes');
        } finally {
          a.run.stop(target(a, 'ConsoleApp').id);
          await Promise.race([session.done, new Promise((_, rej) => setTimeout(() => rej(new Error(`watch did not stop: pid ${session.pid}
${session.output.slice(-1500)}`)), 30000))]);
        }
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
