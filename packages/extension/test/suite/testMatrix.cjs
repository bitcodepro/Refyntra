// Test framework versions on a temp copy of tests/fixtures/TestMatrix (runTest.mjs scenario "test-matrix"): xUnit v3 on
// VSTest and on Microsoft Testing Platform, NUnit 4 and 5, MSTest 2 and 4, MSTest.Sdk (MTP). Every project has the same
// tests: Passes, Fails, Skipped and Adds with one passing and one failing data row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const PROJECTS = ['MSTest2', 'MSTest4', 'MSTestSdk', 'NUnit4', 'NUnit5', 'XUnit3', 'XUnit3Mtp'];

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    await waitFor(() => PROJECTS.every((p) => a.testing.state().ids.some((i) => i.endsWith(`|${p}.MatrixTests.Adds`))), 'discovered tests of every project', 90000);
    return a;
  }

  const idOf = (a, suffix) => {
    const id = a.testing.state().ids.find((i) => i.endsWith(suffix));
    assert.ok(id, `test item ${suffix}`);
    return id;
  };

  return [
    [
      'test-matrix: every framework version is discovered with its data rows',
      async () => {
        const a = await ready();
        for (const p of PROJECTS) {
          const rows = a.testing.state().ids.filter((i) => i.includes(`|${p}.MatrixTests.Adds|`));
          assert.equal(rows.length, 2, `${p}: ${rows.join(', ')}`);
        }
      },
    ],
    ...PROJECTS.map((p) => [
      `test-matrix: ${p} runs → 2 passed, 2 failed, 1 skipped`,
      async () => {
        const a = await ready();
        const proj = a.testing.state().ids.find((i) => i.startsWith('dotnet:proj:') && i.endsWith(`${p}.csproj`));
        assert.ok(proj, `project item of ${p}`);
        await a.testing.runIds([proj]);
        const st = a.testing.state();
        const c = { passed: 0, failed: 0, skipped: 0, errored: 0 };
        for (const [id, r] of Object.entries(st.results)) if (id.includes(`|${p}.MatrixTests.`) && (!id.includes('.Adds') || id.includes('.Adds|'))) c[r.outcome]++;
        assert.deepEqual(c, { passed: 2, failed: 2, skipped: 1, errored: 0 }, JSON.stringify(Object.fromEntries(Object.entries(st.results).filter(([id]) => id.includes(p))), null, 1));
        assert.match(st.results[idOf(a, `|${p}.MatrixTests.Fails`)].message ?? '', /5|4/);
      },
    ]),
    ...['XUnit3', 'NUnit4', 'MSTest4', 'MSTest2', 'XUnit3Mtp', 'MSTestSdk'].map((p) => [
      `test-matrix: ${p} runs one data row alone (server mode)`,
      async () => {
        const a = await ready();
        const row = a.testing.state().ids.find((i) => i.includes(`|${p}.MatrixTests.Adds|`) && /2, 2, 5/.test(i));
        assert.ok(row, `the failing row of ${p}.Adds`);
        await a.testing.runIds([row]);
        const st = a.testing.state();
        assert.equal(st.lastServerCases, 1, `exactly one case went to the server (${st.lastServerCases})`);
        assert.equal(st.lastServerResults, 1, `the server ran that case only (${st.lastServerResults} results)`);
        assert.deepEqual(st.lastRun, [row]);
        assert.equal(st.results[row].outcome, 'failed');
        assert.match(st.results[row].message ?? '', /5/);
      },
    ]),
    ...['XUnit3Mtp', 'MSTestSdk', 'NUnit5'].map((p) => [
      `test-matrix: ${p} runs one test only`,
      async () => {
        const a = await ready();
        const id = idOf(a, `|${p}.MatrixTests.Passes`);
        await a.testing.runIds([id]);
        const st = a.testing.state();
        assert.deepEqual(st.lastRun, [id]);
        assert.equal(st.results[id].outcome, 'passed');
      },
    ]),
    // MSTest.Sdk is left out: netcoredbg verifies the breakpoint and the test runs, but it never stops (known
    // limitation, documented in ADR-009); Run works.
    ...['XUnit3Mtp'].map((p) => [
      `test-matrix: debug a ${p} test (Microsoft Testing Platform, launched by netcoredbg) stops at a breakpoint`,
      async () => {
        const a = await ready();
        const rel = `${p}/MatrixTests.cs`;
        const text = fs.readFileSync(path.join(root(), p, 'MatrixTests.cs'), 'utf8').split(/\r?\n/);
        const sumLine = text.findIndex((l) => l.includes('var sum = 2 + 2;'));
        const line = sumLine >= 0 ? sumLine : text.findIndex((l) => l.includes('public void Passes()'));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(path.join(root(), ...rel.split('/'))), new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        const stops = [];
        const dap = [];
        const tStart = Date.now();
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: (session) => ({
            onWillReceiveMessage: (m) => {
              dap.push(`> ${m.command}`);
            },
            onDidSendMessage: (m) => {
              dap.push(`< ${m.type === 'event' ? 'event ' + m.event : m.command + (m.success === false ? ' FAILED ' + m.message : '')}`);
              if (m.type === 'event' && m.event === 'stopped') stops.push({ session, body: m.body });
              if (m.type === 'event' && m.event === 'breakpoint') dap.push(`bp ${JSON.stringify(m.body).slice(0, 200)}`);
              if (m.type === 'event' && (m.event === 'exited' || m.event === 'terminated' || m.event === 'thread')) dap.push(`${m.event} ${JSON.stringify(m.body ?? {}).slice(0, 80)}`);
              if (m.type === 'event' && m.event === 'module' && /MSTest|XUnit/i.test(JSON.stringify(m.body))) dap.push(`module ${JSON.stringify(m.body).slice(0, 220)}`);
              if (m.type === 'response' && m.command === 'setBreakpoints') dap.push(`< setBreakpoints ${JSON.stringify(m.body).slice(0, 200)}`);
              if (m.type === 'event' && m.event === 'output') dap.push(`out ${String(m.body.output).trim().slice(0, 300)}`);
            },
          }),
        });
        try {
          const done = a.testing.runIds([idOf(a, `|${p}.MatrixTests.Passes`)], true);
          const stop = await waitFor(() => stops[0], `a stop in the debugged ${p} test`, 120000).catch((e) => {
            throw new Error(`${e.message} | DAP tail: ${dap.filter((x) => !x.startsWith('< event module') && (!x.startsWith('module ') || /MSTestSdk\.dll|XUnit3Mtp\.dll/.test(x)) && !x.startsWith('out ')).slice(-40).join(' || ')}`);
          });
          assert.equal(stop.body.reason, 'breakpoint');
          const st = await stop.session.customRequest('stackTrace', { threadId: stop.body.threadId, startFrame: 0, levels: 1 });
          assert.equal(st.stackFrames[0].line, line + 1);
          await stop.session.customRequest('continue', { threadId: stop.body.threadId });
          await done;
          assert.equal(a.testing.state().results[idOf(a, `|${p}.MatrixTests.Passes`)].outcome, 'passed');
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
        }
      },
    ]),
    [
      'test-matrix: debug one XUnit3Mtp data row (server mode under netcoredbg) → only that row runs, one stop',
      async () => {
        const a = await ready();
        const p = 'XUnit3Mtp';
        const text = fs.readFileSync(path.join(root(), p, 'MatrixTests.cs'), 'utf8').split(/\r?\n/);
        const line = text.findIndex((l) => l.includes('public void Adds('));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(path.join(root(), p, 'MatrixTests.cs')), new vscode.Position(line, 0)));
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
          const row = a.testing.state().ids.find((i) => i.includes(`|${p}.MatrixTests.Adds|`) && /2, 2, 5/.test(i));
          assert.ok(row, 'the failing row of Adds');
          await Promise.race([a.testing.runIds([row], true), new Promise((_, rej) => setTimeout(() => rej(new Error('the debug run did not finish')), 240000))]);
          const st = a.testing.state();
          assert.equal(st.lastServerCases, 1, `one node went to the server (${st.lastServerCases})`);
          assert.equal(st.lastServerResults, 1, `the server ran that node only (${st.lastServerResults})`);
          assert.equal(stops.length, 1, `one stop: ${JSON.stringify(stops)}`);
          assert.equal(st.results[row].outcome, 'failed');
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await Promise.race([vscode.debug.stopDebugging(), new Promise((r) => setTimeout(r, 15000))]);
        }
      },
    ],
  ];
};
