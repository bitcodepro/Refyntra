// EF Core tools e2e (ADR-011). Scenario "ef-tools" runs on a temp copy of tests/fixtures/EfTools (two DbContexts,
// migrations in the default and in a custom folder, OR1011 cases, a console app for Show SQL for LINQ); the repository
// fixture is never touched and every database is a SQLite file in the temp folder. dotnet-ef must be on
// PATH (the Linux e2e image installs it during the image build); without it the cases that run dotnet ef are skipped
// with the reason, and the command lines are still checked. treeCases run in the "efcore" scenario (EfCore fixture).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function efReady(api, csharp, waitFor) {
  const a = await api();
  await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
  await waitFor(async () => {
    await a.efCore.refresh();
    return a.efCore.state().contexts > 0;
  }, 'the EF Core view model', 120000);
  return a;
}

exports.treeCases = ({ api, csharp, waitFor }) => [
  [
    'EF Core view: DbContexts of the EfCore fixture with their migrations, snapshot and configuration',
    async () => {
      const a = await efReady(api, csharp, waitFor);
      assert.deepEqual(a.efCore.state().outline, [
        'ReportingDbContext — 0 migrations',
        '  No migrations yet — Add Migration creates the first one',
        '  OrderConfiguration — configuration',
        'ShopDbContext — 1 migration',
        '  Initial — 2025-01-01 00:00',
        '  Model snapshot — ShopDbContextModelSnapshot',
        '  OrderConfiguration — configuration',
      ]);
      // Applied/pending is never checked by itself, and nothing ran.
      assert.equal(a.efCore.state().lastCommand, undefined);
      assert.ok(a.efCore.healthText().startsWith('2 DbContexts found from source'));
    },
  ],
];

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (rel) => path.join(root(), 'EfTools.App', ...rel.split('/'));
  const project = () => file('EfTools.App.csproj');
  const codeOf = (d) => (typeof d.code === 'object' ? d.code.value : d.code);
  const refyntra = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Refyntra');
  let hasTool;

  async function ready() {
    return efReady(api, csharp, waitFor);
  }

  async function tool(a) {
    if (hasTool === undefined) hasTool = (await a.efCore.detectTool(path.dirname(project()))).state === 'found';
    return hasTool;
  }

  const skip = (what) => console.log(`      SKIP ${what}: dotnet-ef is not installed here (the Linux e2e image installs it; Refyntra never installs it).`);

  const expectedTail = () => ['--project', project(), '--startup-project', project(), '--context'];

  return [
    [
      'EF Core view: two contexts, migrations in id order, custom folder/namespace, snapshots',
      async () => {
        const a = await ready();
        assert.deepEqual(a.efCore.state().outline, [
          'AuditContext — 1 migration',
          '  AuditStart — 2025-03-02 00:00',
          '  Model snapshot — AuditContextModelSnapshot',
          'BloggingContext — 2 migrations',
          '  InitialCreate — 2025-03-01 00:00',
          '  AddBlogs — 2025-03-15 00:00',
          '  Model snapshot — BloggingContextModelSnapshot',
        ]);
      },
    ],
    [
      'Show SQL for LINQ outside a debug session explains how and changes nothing',
      async () => {
        const a = await ready();
        const doc = await vscode.workspace.openTextDocument(file('Program.cs'));
        const editor = await vscode.window.showTextDocument(doc);
        const line = doc.getText().split(/\r?\n/).findIndex((l) => l.includes('var sql = query.ToQueryString()'));
        const col = doc.lineAt(line).text.indexOf('query.');
        editor.selection = new vscode.Selection(line, col, line, col + 5);
        assert.equal(await vscode.commands.executeCommand('refyntra.ef.showSql'), undefined);
        assert.match(a.efCore.state().lastSqlMessage, /stopped \.NET debug session/);
        assert.equal(vscode.debug.breakpoints.length, 0, 'no breakpoint is added without the user choosing it');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'Update Database asks first: declined, nothing runs; confirmed, the temp SQLite database is migrated',
      async () => {
        const a = await ready();
        const blogging = (await a.efCore.getChildren()).find((n) => n.label === 'BloggingContext');
        const before = a.efCore.state().lastCommand;
        assert.equal(await vscode.commands.executeCommand('refyntra.ef.updateDatabase', blogging, { confirmed: false, startupProject: project() }), undefined);
        assert.deepEqual(a.efCore.state().lastCommand, before, 'a declined confirmation runs nothing');
        if (!(await tool(a))) return skip('database update');
        // The fixture's database: a SQLite file in the temp folder (BloggingContext.DbPath), started fresh.
        const db = path.join(require('node:os').tmpdir(), 'eftools-fixture.db');
        fs.rmSync(db, { force: true });
        const code = await vscode.commands.executeCommand('refyntra.ef.updateDatabase', blogging, { confirmed: true, startupProject: project() });
        assert.equal(code, 0, a.efCore.state().lastCommand?.display);
        assert.deepEqual(a.efCore.state().lastCommand.args, ['ef', 'database', 'update', ...expectedTail(), 'EfTools.App.Data.BloggingContext']);
        assert.ok(fs.existsSync(db), 'the SQLite file was created in the temp folder');
      },
    ],
    [
      'Check Status runs dotnet ef migrations list only on request and marks applied migrations',
      async () => {
        const a = await ready();
        if (!(await tool(a))) return skip('check status');
        const blogging = (await a.efCore.getChildren()).find((n) => n.label === 'BloggingContext');
        const st = await vscode.commands.executeCommand('refyntra.ef.checkStatus', blogging, { confirmed: true, startupProject: project() });
        assert.ok(st && st.connected, 'connected');
        assert.match(a.efCore.state().outline.find((l) => l.startsWith('BloggingContext')), /up to date/);
        assert.ok(a.efCore.state().outline.includes('  AddBlogs — 2025-03-15 00:00 · applied'), a.efCore.state().outline.join('\n'));
      },
    ],
    [
      'Add Migration runs dotnet ef as a task; the new migration appears last; Generate SQL Script opens an editor',
      async () => {
        const a = await ready();
        const blogging = (await a.efCore.getChildren()).find((n) => n.label === 'BloggingContext');
        if (!(await tool(a))) return skip('add migration and SQL script');
        const code = await vscode.commands.executeCommand('refyntra.ef.addMigration', blogging, { name: 'AddPosts', startupProject: project() });
        assert.equal(code, 0, a.efCore.state().lastCommand?.display);
        assert.deepEqual(a.efCore.state().lastCommand.args, ['ef', 'migrations', 'add', 'AddPosts', ...expectedTail(), 'EfTools.App.Data.BloggingContext']);
        assert.match(a.efCore.state().lastCommand.display, /^dotnet ef migrations add AddPosts --project /);
        assert.ok(fs.readdirSync(file('Migrations')).some((f) => /^\d{14}_AddPosts\.cs$/.test(f)), 'migration file written next to the others');
        await waitFor(async () => {
          await a.efCore.refresh();
          const o = a.efCore.state().outline;
          const i = o.findIndex((l) => l.startsWith('BloggingContext'));
          return o[i + 3]?.startsWith('  AddPosts — ') ? o : undefined;
        }, 'AddPosts as the third BloggingContext migration', 120000);

        const opened = new Promise((resolve) => {
          const sub = vscode.workspace.onDidOpenTextDocument((d) => {
            if (d.languageId !== 'sql' || d.uri.scheme !== 'untitled') return;
            sub.dispose();
            resolve(d);
          });
        });
        const fresh = (await a.efCore.getChildren()).find((n) => n.label === 'BloggingContext');
        assert.equal(await vscode.commands.executeCommand('refyntra.ef.generateScript', fresh, { idempotent: false, startupProject: project() }), 0);
        const sqlDoc = await opened;
        assert.match(sqlDoc.getText(), /CREATE TABLE/);
        assert.match(sqlDoc.getText(), /__EFMigrationsHistory/);
        // SQLite has no idempotent scripts (dotnet ef says so); the plain script runs from the first migration.
        assert.ok(!a.efCore.state().lastCommand.args.includes('--idempotent'));
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      },
    ],
    [
      'Remove Last Migration (confirmed) deletes the unapplied migration again',
      async () => {
        const a = await ready();
        if (!(await tool(a))) return skip('remove last migration');
        const blogging = (await a.efCore.getChildren()).find((n) => n.label === 'BloggingContext');
        assert.equal(blogging.context.migrations.at(-1).name, 'AddPosts');
        const code = await vscode.commands.executeCommand('refyntra.ef.removeLastMigration', blogging, { confirmed: true, startupProject: project() });
        assert.equal(code, 0, a.efCore.state().lastCommand?.display);
        assert.ok(!fs.readdirSync(file('Migrations')).some((f) => /AddPosts/.test(f)));
        await waitFor(async () => {
          await a.efCore.refresh();
          return a.efCore.state().outline.some((l) => l.startsWith('BloggingContext — 2 migrations')) ? true : undefined;
        }, 'two migrations again', 120000);
      },
    ],
    [
      'OR1011: possible N+1 results as hints with the docs link; Add .Include applies as one edit and Undo restores',
      async () => {
        await ready();
        const doc = await vscode.workspace.openTextDocument(file('Cases/NPlusOne.cs'));
        await vscode.window.showTextDocument(doc);
        const list = await waitFor(() => {
          const d = refyntra(doc.uri);
          return d.length >= 6 ? d : undefined;
        }, 'six OR1011 results', 120000);
        assert.ok(list.every((d) => codeOf(d) === 'OR1011' && d.severity === vscode.DiagnosticSeverity.Hint), list.map((d) => `${codeOf(d)}:${d.severity}`).join(' '));
        assert.match(String(list[0].code.target), /docs\/rules\/OR1011\.md$/);
        const before = doc.getText();
        const d = list.find((x) => doc.getText(x.range) === 'blog.Owner' && doc.lineAt(x.range.start.line).text.includes('Owner!.Name'));
        assert.ok(d, 'the result in LoopOverInlineQuery');
        const actions = await waitFor(async () => {
          const l = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range, vscode.CodeActionKind.QuickFix.value)) ?? [];
          return l.some((x) => x.title === 'Add .Include(x => x.Owner) (Refyntra)') ? l : undefined;
        }, 'the quick fix', 30000);
        const fix = actions.find((x) => x.title === 'Add .Include(x => x.Owner) (Refyntra)');
        await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
        await waitFor(() => doc.getText().includes('_db.Blogs.Include(x => x.Owner).Where(b => b.Rating > 1).ToList()'), 'Include added', 30000);
        await waitFor(() => refyntra(doc.uri).length === 5, 'one result fewer', 90000);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), before);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      },
    ],
    [
      'Show SQL for LINQ: stopped at a breakpoint, the selected IQueryable is translated by ToQueryString() in the frame',
      async () => {
        const a = await ready();
        const rel = 'Program.cs';
        const uri = vscode.Uri.file(file(rel));
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = doc.getText().split(/\r?\n/).findIndex((l) => l.includes('var sql = query.ToQueryString()'));
        const t = await waitFor(async () => (await a.run.refresh()).find((x) => x.label === 'EfTools.App' && x.runnable), 'EfTools.App run target', 120000);
        const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        try {
          const started = new Promise((resolve) => {
            const sub = vscode.debug.onDidStartDebugSession((s) => {
              if (s.type !== 'refyntra-dotnet') return;
              sub.dispose();
              resolve(s);
            });
          });
          assert.equal(await a.run.debug(t.id), true);
          const session = await started;
          await waitFor(() => (vscode.debug.activeStackItem instanceof vscode.DebugStackFrame ? true : undefined), 'stopped at the breakpoint', 240000);
          const editor = await vscode.window.showTextDocument(doc);
          const col = doc.lineAt(line).text.indexOf('query.');
          editor.selection = new vscode.Selection(line, col, line, col + 5);
          const sql = await vscode.commands.executeCommand('refyntra.ef.showSql');
          assert.equal(typeof sql, 'string', a.efCore.state().lastSqlMessage);
          assert.match(sql, /SELECT/);
          assert.match(sql, /FROM "Blogs"/);
          assert.match(sql, /ORDER BY/);
          const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'refyntra-sql');
          assert.ok(shown, 'the SQL is shown in a read-only editor');
          assert.equal(shown.document.languageId, 'sql');
          await vscode.debug.stopDebugging(session);
        } finally {
          vscode.debug.removeBreakpoints([bp]);
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
      },
    ],
  ];
};
