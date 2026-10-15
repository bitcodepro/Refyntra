// Test runner e2e on a temp copy of tests/fixtures/TestRunner (runTest.mjs scenario "tests"), every other extension
// disabled: discovery from the C# host (xUnit, NUnit, MSTest), run all with the expected pass / fail / skip counts, one
// theory case, debug with a breakpoint in the code under test (netcoredbg attached to the test host), Rerun Failed
// through VS Code's own command, incremental discovery after an edit, CodeLens "Run | Debug", Run Tests for This Code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (rel) => path.join(root(), ...rel.split('/'));
  const LONG = 600000;

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    await waitFor(() => a.testing.state().ids.some((i) => i.endsWith('|MSTestTests.AddTests.AddRows')), 'discovered tests', 60000);
    return a;
  }

  const idOf = (a, suffix) => {
    const id = a.testing.state().ids.find((i) => i.endsWith(suffix));
    assert.ok(id, `test item ${suffix}`);
    return id;
  };

  function lineOf(rel, needle) {
    const i = fs.readFileSync(file(rel), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return i;
  }

  const counts = (results, ids) => {
    const c = { passed: 0, failed: 0, skipped: 0, errored: 0 };
    for (const id of ids) if (results[id]) c[results[id].outcome]++;
    return c;
  };

  return [
    [
      'tests: discovery lists project → namespace → class → method → data cases (xUnit, NUnit, MSTest)',
      async () => {
        const a = await ready();
        const outline = a.testing.state().outline;
        assert.deepEqual(outline, [
          'MSTestTests',
          '  MSTestTests',
          '    AddTests',
          '      AddsZero',
          '      AddRows',
          '        (1, 1, 2)',
          '        (3, 4, 7)',
          'NUnitTests',
          '  NUnitTests.Arithmetic',
          '    DivideTests',
          '      DividesEvenly',
          '      DivideCases',
          '        (8, 2, 4)',
          '        (9, 3, 3)',
          '      DivideSource',
          '      IgnoredOnPurpose',
          'XUnitTests',
          '  XUnitTests',
          '    CalculatorTests',
          '      AddsTwoNumbers',
          '      FailsOnPurpose',
          '      SkippedOnPurpose',
          '      AddTheory',
          '        (1, 2, 3)',
          '        (2, 2, 4)',
          '        (5, 5, 11)',
          '      DividesByThree',
          '      Nested',
          '        NestedPasses',
        ]);
        const item = a.testing.item(idOf(a, '|XUnitTests.CalculatorTests.AddsTwoNumbers'));
        assert.match(item.uri.fsPath.replace(/\\/g, '/'), /XUnitTests\/CalculatorTests\.cs$/);
        assert.equal(item.range.start.line, lineOf('XUnitTests/CalculatorTests.cs', 'public void AddsTwoNumbers'));
      },
    ],
    [
      'tests: run all → 13 passed, 2 failed, 2 skipped (data rows and run-time cases included), failure at the assert line',
      async () => {
        const a = await ready();
        const roots = a.testing.state().ids.filter((i) => i.startsWith('dotnet:proj:'));
        assert.equal(roots.length, 3);
        await a.testing.runIds(roots);
        const st = a.testing.state();
        const reported = Object.keys(st.results).filter((i) => i.startsWith('dotnet:'));
        assert.deepEqual(counts(st.results, reported), { passed: 13, failed: 2, skipped: 2, errored: 0 }, JSON.stringify(st.results, null, 1));
        // Run-time cases (MemberData, TestCaseSource) were added under their methods.
        assert.ok(st.ids.some((i) => i.includes('DividesByThree|~(a: 6, b: 3)')), st.ids.join('\n'));
        assert.ok(st.ids.some((i) => i.includes('DivideSource|~(4,2)')), st.ids.join('\n'));
        const theoryCase = st.results[idOf(a, 'AddTheory|(5, 5, 11)')];
        assert.equal(theoryCase.outcome, 'failed');
        assert.match(theoryCase.message, /Expected: 11/);
        assert.equal(theoryCase.location.line, lineOf('XUnitTests/CalculatorTests.cs', 'Assert.Equal(expected, Calculator.Add(a, b))') + 1);
        assert.equal(st.results[idOf(a, '|XUnitTests.CalculatorTests.SkippedOnPurpose')].outcome, 'skipped');
        assert.equal(st.results[idOf(a, '|NUnitTests.Arithmetic.DivideTests.IgnoredOnPurpose')].outcome, 'skipped');
        assert.equal(st.results[idOf(a, '|XUnitTests.CalculatorTests+Nested.NestedPasses')].outcome, 'passed');
        assert.equal(st.running, false);
      },
    ],
    [
      'tests: Rerun Failed (VS Code command) runs exactly the failed tests',
      async () => {
        const a = await ready();
        const before = a.testing.state().runs;
        await vscode.commands.executeCommand('testing.reRunFailTests');
        await waitFor(() => a.testing.state().runs > before && !a.testing.state().running, 'the rerun', LONG);
        const st = a.testing.state();
        assert.deepEqual(st.lastRun.slice().sort(), [idOf(a, 'AddTheory|(5, 5, 11)'), idOf(a, '|XUnitTests.CalculatorTests.FailsOnPurpose')].sort());
        assert.equal(st.results[idOf(a, '|XUnitTests.CalculatorTests.FailsOnPurpose')].outcome, 'failed');
      },
    ],
    [
      'tests: one theory case runs its method only (precise filter), the case reports its own result',
      async () => {
        const a = await ready();
        const id = idOf(a, 'AddTheory|(1, 2, 3)');
        const before = a.testing.state().runs;
        await a.testing.runIds([id]);
        const st = a.testing.state();
        assert.equal(st.runs, before + 1);
        assert.deepEqual(st.lastRun, [id]);
        assert.equal(st.results[id].outcome, 'passed');
        assert.equal(st.results[idOf(a, 'AddTheory|(5, 5, 11)')].outcome, 'failed');
      },
    ],
    [
      'tests: debug a test → netcoredbg attached to the test host stops at a breakpoint in the code under test',
      async () => {
        const a = await ready();
        const rel = 'Calc/Calculator.cs';
        const line = lineOf(rel, 'var sum = a + b;');
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file(rel)), new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        const stops = [];
        const dap = [];
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: (session) => ({
            onDidSendMessage: (m) => {
              if (m.type === 'event' && m.event === 'stopped') stops.push({ session, body: m.body });
              if (m.type === 'response' && !m.success) dap.push(`${m.command}: ${m.message}`);
              if (m.type === 'event' && m.event === 'output') dap.push(String(m.body.output).trim());
            },
            onError: (e) => dap.push(`error: ${e}`),
            onExit: (code) => dap.push(`adapter exit ${code}`),
          }),
        });
        let done;
        try {
          const id = idOf(a, '|XUnitTests.CalculatorTests.AddsTwoNumbers');
          done = a.testing.runIds([id], true);
          const stop = await waitFor(() => stops[0], 'a stop in the debugged test host', 240000).catch((e) => {
            throw new Error(`${e.message}
trace: ${a.testing.state().debugTrace.join(' | ')}
DAP: ${dap.join(' | ')}`);
          });
          assert.equal(stop.body.reason, 'breakpoint');
          const st = await stop.session.customRequest('stackTrace', { threadId: stop.body.threadId, startFrame: 0, levels: 2 });
          const top = st.stackFrames[0];
          assert.match(top.source.path.replace(/\\/g, '/'), /Calc\/Calculator\.cs$/);
          assert.equal(top.line, line + 1);
          assert.match(st.stackFrames[1].name, /AddsTwoNumbers/);
          const ev = await stop.session.customRequest('evaluate', { expression: 'a + b', frameId: top.id, context: 'watch' });
          assert.equal(ev.result, '5');
          assert.ok(a.testing.state().lastDebugProcessId > 0);
          assert.equal(a.testing.state().lastServerCases, 1, 'debugged through vstest.console');
          await stop.session.customRequest('continue', { threadId: stop.body.threadId });
          await done;
          done = undefined;
          assert.equal(a.testing.state().results[id].outcome, 'passed');
        } finally {
          if (done) {
            a.testing.cancelAll();
            await Promise.race([done.catch(() => undefined), new Promise((r) => setTimeout(r, 30000))]);
          }
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await Promise.race([vscode.debug.stopDebugging(), new Promise((r) => setTimeout(r, 15000))]);
        }
      },
    ],
    [
      'tests: debug one theory row → only that row runs under the debugger (vstest.console server), one stop',
      async () => {
        const a = await ready();
        const rel = 'Calc/Calculator.cs';
        const line = lineOf(rel, 'var sum = a + b;');
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file(rel)), new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        const stops = [];
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: (session) => ({
            onDidSendMessage: (m) => {
              if (m.type === 'event' && m.event === 'stopped') {
                stops.push(m.body);
                void session.customRequest('continue', { threadId: m.body.threadId });
              }
            },
          }),
        });
        try {
          const id = idOf(a, 'AddTheory|(2, 2, 4)');
          await a.testing.runIds([id], true);
          const st = a.testing.state();
          assert.equal(st.lastServerCases, 1, `one case went to vstest.console (${st.debugTrace.join(' | ')})`);
          assert.equal(stops.length, 1, `one stop: ${JSON.stringify(stops)}`);
          assert.equal(st.results[id].outcome, 'passed');
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await vscode.debug.stopDebugging();
        }
      },
    ],
    [
      'tests: CodeLens "Run | Debug" over test classes and methods, with the last result',
      async () => {
        await ready();
        const uri = vscode.Uri.file(file('XUnitTests/CalculatorTests.cs'));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        const lenses = await waitFor(async () => {
          const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 50);
          const mine = ls.filter((l) => l.command && /^refyntra\.tests\.(run|debug)$/.test(l.command.command));
          return mine.length >= 16 ? mine : undefined;
        }, 'test lenses', 30000);
        const line = lineOf('XUnitTests/CalculatorTests.cs', 'public void FailsOnPurpose');
        const at = lenses.filter((l) => l.range.start.line === line).map((l) => l.command.title);
        assert.deepEqual(at, ['$(error) Run', 'Debug']);
        await vscode.workspace.getConfiguration('refyntra').update('tests.codeLens', false, vscode.ConfigurationTarget.Workspace);
        try {
          const off = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 50);
          assert.ok(!off.some((l) => l.command && /^refyntra\.tests\./.test(l.command.command)));
        } finally {
          await vscode.workspace.getConfiguration('refyntra').update('tests.codeLens', undefined, vscode.ConfigurationTarget.Workspace);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'tests: an edit re-discovers only that document (a new test appears, then goes away on undo)',
      async () => {
        const a = await ready();
        const uri = vscode.Uri.file(file('MSTestTests/AddTests.cs'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const line = lineOf('MSTestTests/AddTests.cs', 'public void AddsZero');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(line - 1, 0), '    [TestMethod]\n    public void AddsOne()\n    {\n    }\n\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await waitFor(() => a.testing.state().ids.some((i) => i.endsWith('|MSTestTests.AddTests.AddsOne')), 'the new test', 30000);
        await vscode.commands.executeCommand('undo');
        await waitFor(() => !a.testing.state().ids.some((i) => i.endsWith('|MSTestTests.AddTests.AddsOne')), 'the test gone after undo', 30000);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      },
    ],
    [
      'tests: Run Tests for This Code runs the tests Related lists for a production method',
      async () => {
        const a = await ready();
        const uri = vscode.Uri.file(file('Calc/Calculator.cs'));
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        const line = lineOf('Calc/Calculator.cs', 'public static int Divide');
        const col = editor.document.lineAt(line).text.indexOf('Divide') + 1;
        editor.selection = new vscode.Selection(line, col, line, col);
        const ran = await vscode.commands.executeCommand('refyntra.tests.runRelated');
        const names = ran.map((i) => i.slice(i.lastIndexOf('.') + 1)).sort();
        assert.deepEqual(names, ['DivideCases', 'DivideSource', 'DividesByThree', 'DividesEvenly', 'NestedPasses']);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'tests: Continuous Run runs the test classes of a saved test file',
      async () => {
        const a = await ready();
        const cts = new vscode.CancellationTokenSource();
        const project = a.testing.item(a.testing.state().ids.find((i) => i.startsWith('dotnet:proj:') && i.endsWith('XUnitTests.csproj')));
        const profile = a.testing.runProfile;
        await profile.runHandler(new vscode.TestRunRequest([project], undefined, profile, true), cts.token);
        const uri = vscode.Uri.file(file('XUnitTests/CalculatorTests.cs'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const before = a.testing.state().runs;
        try {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(uri, new vscode.Position(doc.lineCount, 0), '\n');
          assert.ok(await vscode.workspace.applyEdit(edit));
          assert.ok(await doc.save());
          await waitFor(() => a.testing.state().runs > before && !a.testing.state().running, 'the continuous run after the save', LONG);
          const classes = a.testing.state().lastRun.map((i) => i.slice(i.lastIndexOf('|') + 1)).sort();
          assert.deepEqual(classes, ['XUnitTests.CalculatorTests', 'XUnitTests.CalculatorTests+Nested']);
        } finally {
          cts.cancel();
          cts.dispose();
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
      },
    ],
    [
      'tests: Coverage profile: line coverage with coverlet.collector when the project references it, else skipped with a reason',
      async () => {
        const a = await ready();
        const xunit = a.testing.state().ids.find((i) => i.startsWith('dotnet:proj:') && i.endsWith('XUnitTests.csproj'));
        await a.testing.runIds([xunit], false, true);
        const covered = a.testing.coveredFiles.map((f) => f.replace(/\\/g, '/'));
        assert.ok(covered.some((f) => f.endsWith('Calc/Calculator.cs')), covered.join(', '));
        const nunit = a.testing.state().ids.find((i) => i.startsWith('dotnet:proj:') && i.endsWith('NUnitTests.csproj'));
        await a.testing.runIds([nunit], false, true);
        assert.deepEqual(a.testing.coveredFiles, [], 'NUnitTests does not reference coverlet.collector: no coverage');
        assert.equal(a.testing.state().results[idOf(a, '|NUnitTests.Arithmetic.DivideTests.DividesEvenly')].outcome, 'passed', 'the tests still ran');
      },
    ],
    [
      'tests: Python tests need pytest: listed and run when it is installed, otherwise Health says why',
      async () => {
        const a = await ready();
        const dir = file('pytests');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'test_sample.py'), 'def test_adds():\n    assert 1 + 1 == 2\n\n\ndef test_fails():\n    assert 1 + 1 == 3\n');
        try {
          await a.testing.refresh(true);
          const st = a.testing.state();
          assert.ok(['installed', 'missing'].includes(st.pytest), st.pytest);
          if (st.pytest === 'missing') {
            assert.match(a.testing.healthText(), /pytest is not installed/);
            assert.ok(!st.ids.some((i) => i.startsWith('python:')), 'no Python tests without pytest');
          } else {
            const fileId = 'python:pytests/test_sample.py';
            assert.ok(st.ids.includes(fileId), st.ids.join('\n'));
            await a.testing.runIds([fileId]);
            const r = a.testing.state().results;
            assert.equal(r['python:pytests/test_sample.py::test_adds'].outcome, 'passed');
            assert.equal(r['python:pytests/test_sample.py::test_fails'].outcome, 'failed');
          }
          // Health shows the note in its Run and debug section.
          await vscode.commands.executeCommand('refyntra.showHealthText');
          const doc = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'refyntra-health'), 'health document');
          assert.match(doc.getText(), /- Tests: C# tests \(xUnit, NUnit, MSTest\)/);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
      },
    ],
  ];
};
