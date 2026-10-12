// Stack trace navigation e2e on a temp copy of tests/fixtures/StackTraces (runTest.mjs scenario "stack-trace").
// The traces name paths of another machine; frames are matched to the copy by path suffix or looked up by symbol.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), ...rel.split('/'));

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 180000);
    return a;
  }

  /** 1-based line of the first line containing `needle`. */
  async function lineOf(rel, needle) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().split(/\r?\n/).findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return i + 1;
  }

  function activeAt() {
    const ed = vscode.window.activeTextEditor;
    assert.ok(ed, 'an editor is open');
    return { path: ed.document.uri.fsPath, line: ed.selection.active.line + 1 };
  }

  const sameFile = (a, b) => a.toLowerCase().replace(/\\/g, '/') === b.toLowerCase().replace(/\\/g, '/');

  const TRACE = [
    '2024-05-01 10:00:00.123 [ERR] System.InvalidOperationException: Order 42 was not found',
    '   at Sample.Orders.OrderService.Load(Int32 id) in C:\\agent\\_work\\1\\s\\StackTraces\\Orders\\OrderService.cs:line 7',
    '   at Sample.Util.Helpers.Describe(Int32 value) in /build/src/Helpers.cs:line 5',
    '   at Sample.Orders.OrderService.Load(Int32 id) in /home/ci/StackTraces/Orders/OrderService.cs:line 500',
    '   at Sample.Orders.OrderService.<LoadAllAsync>d__3.MoveNext()',
    '--- End of stack trace from previous location ---',
    '   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()',
    '   at System.Runtime.CompilerServices.TaskAwaiter.HandleNonSuccessAndDebuggerNotification(Task task)',
    '   at Sample.Orders.OrderService.<>c.<Load>b__1_0(Int32 i)',
    '   at Sample.Orders.Gone.Missing()',
  ].join('\n');

  return [
    [
      'stack trace: the command parses a pasted trace; frames are matched by path suffix, external frames collapse',
      async () => {
        const a = await ready();
        const parsed = await vscode.commands.executeCommand('refyntra.openStackTrace', TRACE);
        assert.equal(parsed.frameCount, 8);
        const frames = a.stackTrace.frames();
        assert.deepEqual(frames.map((f) => f.status), ['user', 'ambiguous', 'user', 'bySymbol', 'external', 'external', 'bySymbol', 'bySymbol']);
        assert.ok(sameFile(frames[0].matches[0], file('Orders/OrderService.cs').fsPath), frames[0].matches[0]);
        assert.equal(frames[1].matches.length, 2);
        const [group] = a.stackTrace.getChildren();
        assert.equal(a.stackTrace.getTreeItem(group).label, 'System.InvalidOperationException: Order 42 was not found');
        const children = a.stackTrace.getChildren(group);
        const external = children.find((n) => n.kind === 'external');
        assert.ok(external, 'two System frames collapse into one node');
        const item = a.stackTrace.getTreeItem(external);
        assert.equal(item.label, '2 external frames');
        assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        const first = a.stackTrace.getTreeItem(children[0]);
        assert.match(first.accessibilityInformation.label, /^Frame 1 of 8: Sample\.Orders\.OrderService\.Load, OrderService\.cs line 7, your code$/);
        assert.equal(first.command.command, 'refyntra.stackTrace.openFrame');
      },
    ],
    [
      'stack trace: opening a frame puts the cursor on the line of the workspace file',
      async () => {
        const a = await ready();
        const r = await a.stackTrace.openFrame(0);
        assert.equal(r.kind, 'opened', JSON.stringify(r));
        const at = activeAt();
        assert.ok(sameFile(at.path, file('Orders/OrderService.cs').fsPath), at.path);
        assert.equal(at.line, 7);
        assert.equal(await lineOf('Orders/OrderService.cs', 'public int Load(int id)'), 7);
        // The target line is highlighted briefly (decoration on the opened editor, 0-based line).
        const flash = a.stackTrace.lastHighlight();
        assert.ok(flash && sameFile(vscode.Uri.parse(flash.uri).fsPath, file('Orders/OrderService.cs').fsPath), JSON.stringify(flash));
        assert.equal(flash.line, 6);
      },
    ],
    [
      'stack trace: two files with the same name — the user chooses, then the chosen file opens at the line',
      async () => {
        const a = await ready();
        let offered;
        a.stackTrace.testPicker = async (items) => {
          offered = items.map((i) => i.label);
          return items.find((i) => /Util/.test(i.label));
        };
        try {
          const r = await a.stackTrace.openFrame(1);
          assert.equal(r.kind, 'opened', JSON.stringify(r));
        } finally {
          a.stackTrace.testPicker = undefined;
        }
        assert.equal(offered.length, 2, JSON.stringify(offered));
        const at = activeAt();
        assert.ok(sameFile(at.path, file('Util/Helpers.cs').fsPath), at.path);
        assert.equal(at.line, 5);
      },
    ],
    [
      'stack trace: a line past the end says the line may have moved and finds the method by symbol (proven)',
      async () => {
        const a = await ready();
        const r = await a.stackTrace.openFrame(2);
        assert.equal(r.kind, 'opened', JSON.stringify(r));
        assert.match(r.notice, /may have moved/);
        assert.equal(r.confidence, 'proven');
        assert.equal(activeAt().line, 7);
      },
    ],
    [
      'stack trace: an async frame without a file opens the user method (likely, by name)',
      async () => {
        const a = await ready();
        const r = await a.stackTrace.openFrame(3);
        assert.equal(r.kind, 'opened', JSON.stringify(r));
        assert.equal(r.confidence, 'likely');
        assert.equal(activeAt().line, await lineOf('Orders/OrderService.cs', 'LoadAllAsync'));
      },
    ],
    [
      'stack trace: a lambda in an overloaded method offers the overloads; a missing symbol is reported, not invented',
      async () => {
        const a = await ready();
        let offered;
        a.stackTrace.testPicker = async (items) => {
          offered = items;
          return items.find((i) => /string/i.test(i.label)) ?? items[1];
        };
        try {
          const r = await a.stackTrace.openFrame(6);
          assert.equal(r.kind, 'opened', JSON.stringify(r));
        } finally {
          a.stackTrace.testPicker = undefined;
        }
        assert.equal(offered.length, 2);
        assert.ok(offered.every((i) => /likely/.test(i.description)), JSON.stringify(offered.map((i) => i.description)));
        assert.equal(activeAt().line, await lineOf('Orders/OrderService.cs', 'public int Load(string code)'));
        const missing = await a.stackTrace.openFrame(7);
        assert.equal(missing.kind, 'none');
        assert.match(missing.message, /does not recover missing symbols/);
      },
    ],
    [
      'stack trace: Related on a frame opens it and shows Related for that code',
      async () => {
        const a = await ready();
        await vscode.commands.executeCommand('refyntra.stackTrace.related', 0);
        assert.equal(activeAt().line, 7);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
  ];
};
