import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeEfMigrations } from '@refyntra/application';
import type { EfContextInfo, EfMigrationsResult } from '@refyntra/contracts';
import {
  INSTALL_DOTNET_EF,
  buildEfTree,
  displayCommand,
  efArgs,
  efContextKey,
  efHealthText,
  manifestHasDotnetEf,
  migrationNameProblem,
  parseDebuggerString,
  parseEfVersion,
  parseMigrationsList,
  selectionProblem,
  statusFromList,
  toQueryStringExpressions,
  touchesDatabase,
} from '../../src/efCoreModel';

// EF Core tools (efCoreModel.ts): tree model, dotnet-ef command lines (no shell), output parsing, LINQ → SQL helpers.

const loc = (file: string, line = 3) => ({ uri: `file:///work/My%20App/${file}`, range: { start: { line, character: 0 }, end: { line, character: 5 } } });

function ctx(name: string, migrations: string[], extra: Partial<EfContextInfo> = {}): EfContextInfo {
  return {
    name,
    fullName: `Shop.Data.${name}`,
    projectName: 'Shop.Data',
    projectUri: 'file:///work/My%20App/Shop.Data/Shop.Data.csproj',
    migrationsProjectUri: 'file:///work/My%20App/Shop.Data/Shop.Data.csproj',
    migrationsNamespace: 'Shop.Data.Migrations',
    location: loc(`${name}.cs`),
    onModelCreating: loc(`${name}.cs`, 10),
    migrations: migrations.map((id) => ({ id, name: id.replace(/^\d{14}_/, ''), className: id.replace(/^\d{14}_/, ''), location: loc(`Migrations/${id}.cs`), designerLocation: loc(`Migrations/${id}.Designer.cs`) })),
    snapshot: migrations.length ? { name: `${name}ModelSnapshot`, location: loc(`Migrations/${name}ModelSnapshot.cs`) } : null,
    configurations: [],
    ...extra,
  };
}

const result = (...contexts: EfContextInfo[]): EfMigrationsResult => ({ contexts, state: 'Ready', snapshotId: 's1' });

describe('EF Core tree model', () => {
  it('lists contexts with migrations in host order, then the snapshot and configurations', () => {
    const tree = buildEfTree(result(ctx('AuditContext', []), ctx('ShopContext', ['20250101000000_Initial', '20250201000000_AddEmail'], { configurations: [{ name: 'OrderConfiguration', location: loc('OrderConfiguration.cs') }] })));
    expect(tree.map((n) => n.label)).toEqual(['AuditContext', 'ShopContext']);
    expect(tree[0]!.description).toBe('0 migrations');
    expect(tree[0]!.children!.map((n) => n.kind)).toEqual(['info']);
    const shop = tree[1]!;
    expect(shop.description).toBe('2 migrations');
    expect(shop.children!.map((n) => `${n.kind}:${n.label}`)).toEqual(['migration:Initial', 'migration:AddEmail', 'snapshot:Model snapshot', 'configuration:OrderConfiguration']);
    expect(shop.children![0]!.description).toBe('2025-01-01 00:00');
    expect(shop.children![0]!.contextValue).toBe('refyntra.ef.migration');
    // Only the last migration offers Remove Last Migration.
    expect(shop.children![1]!.contextValue).toBe('refyntra.ef.migration.last');
    expect(shop.children![0]!.location!.uri).toMatch(/Migrations\/20250101000000_Initial\.cs$/);
    expect(shop.location).toEqual(loc('ShopContext.cs', 10));
    expect(shop.tooltip).toContain('Check Status');
  });

  it('shows applied / pending only after an explicit status check', () => {
    const c = ctx('ShopContext', ['20250101000000_Initial', '20250201000000_AddEmail']);
    const parsed = parseMigrationsList('[{"id":"20250101000000_Initial","applied":true},{"id":"20250201000000_AddEmail","applied":false}]')!;
    const tree = buildEfTree(result(c), new Map([[efContextKey(c), statusFromList(parsed, '10:00')]]));
    expect(tree[0]!.description).toBe('2 migrations · 1 pending');
    expect(tree[0]!.children!.map((n) => n.icon)).toEqual(['pass', 'circle-large-outline', 'file-code']);
    expect(tree[0]!.children![1]!.description).toBe('2025-02-01 00:00 · pending');
    const offline = parseMigrationsList('[{"id":"20250101000000_Initial"},{"id":"20250201000000_AddEmail"}]')!;
    expect(offline.connected).toBe(false);
    const t2 = buildEfTree(result(c), new Map([[efContextKey(c), statusFromList(offline, '10:00')]]));
    expect(t2[0]!.description).toContain('status unknown');
    expect(t2[0]!.children![0]!.icon).toBe('git-commit');
    // A migration added after the check: the status says it is out of date instead of "up to date".
    const added = ctx('ShopContext', ['20250101000000_Initial', '20250201000000_AddEmail', '20250301000000_Third']);
    const t3 = buildEfTree(result(added), new Map([[efContextKey(added), statusFromList(parsed, '10:00')]]));
    expect(t3[0]!.description).toBe('3 migrations · status out of date (check again)');
  });

  it('tells same-named contexts apart by project', () => {
    const a = ctx('AppDbContext', []);
    const b = { ...ctx('AppDbContext', []), fullName: 'Other.AppDbContext', projectName: 'Other', projectUri: 'file:///work/Other/Other.csproj' };
    const tree = buildEfTree(result(a, b));
    expect(tree.map((n) => n.description)).toEqual(['Shop.Data · 0 migrations', 'Other · 0 migrations']);
    expect(new Set(tree.map((n) => n.id)).size).toBe(2);
  });

  it('is empty without a result', () => {
    expect(buildEfTree(undefined)).toEqual([]);
  });
});

describe('dotnet ef command lines', () => {
  const t = { project: '/work/My App/Shop.Data/Shop.Data.csproj', startupProject: "/work/My App/Shop's Api/Api.csproj", context: 'Shop.Data.ShopContext' };

  it('passes every value as one argument (paths with spaces and quotes stay intact, no shell)', () => {
    const args = efArgs({ kind: 'add', name: 'AddEmail' }, t);
    expect(args).toEqual(['ef', 'migrations', 'add', 'AddEmail', '--project', '/work/My App/Shop.Data/Shop.Data.csproj', '--startup-project', "/work/My App/Shop's Api/Api.csproj", '--context', 'Shop.Data.ShopContext']);
    expect(displayCommand('dotnet', args)).toBe(`dotnet ef migrations add AddEmail --project "/work/My App/Shop.Data/Shop.Data.csproj" --startup-project "/work/My App/Shop's Api/Api.csproj" --context Shop.Data.ShopContext`);
    expect(displayCommand('dotnet', ['a$b', 'x"y', ''])).toBe('dotnet "a\\$b" "x\\"y" ""');
  });

  it('builds remove, update, script and list', () => {
    const tail = ['--project', t.project, '--startup-project', t.startupProject, '--context', t.context];
    expect(efArgs({ kind: 'remove' }, t)).toEqual(['ef', 'migrations', 'remove', ...tail]);
    expect(efArgs({ kind: 'update' }, t)).toEqual(['ef', 'database', 'update', ...tail]);
    expect(efArgs({ kind: 'update', migration: '20250101000000_Initial' }, t)).toEqual(['ef', 'database', 'update', '20250101000000_Initial', ...tail]);
    expect(efArgs({ kind: 'script', idempotent: true, output: 'C:\\Temp dir\\s.sql' }, t)).toEqual(['ef', 'migrations', 'script', '--idempotent', '--output', 'C:\\Temp dir\\s.sql', ...tail]);
    expect(efArgs({ kind: 'script', idempotent: false, to: 'B', output: 'o.sql' }, t)).toEqual(['ef', 'migrations', 'script', '0', 'B', '--output', 'o.sql', ...tail]);
    expect(efArgs({ kind: 'script', idempotent: false, from: 'A', to: 'B', output: 'o.sql' }, t)).toEqual(['ef', 'migrations', 'script', 'A', 'B', '--output', 'o.sql', ...tail]);
    expect(efArgs({ kind: 'list' }, t)).toEqual(['ef', 'migrations', 'list', '--json', ...tail]);
  });

  it('asks for confirmation exactly for the commands that connect to a database', () => {
    expect(touchesDatabase({ kind: 'update' })).toBe(true);
    expect(touchesDatabase({ kind: 'remove' })).toBe(true);
    expect(touchesDatabase({ kind: 'list' })).toBe(true);
    expect(touchesDatabase({ kind: 'add', name: 'X' })).toBe(false);
    expect(touchesDatabase({ kind: 'script', idempotent: true, output: 'o' })).toBe(false);
  });

  it('validates migration names', () => {
    expect(migrationNameProblem('AddEmail')).toBeUndefined();
    expect(migrationNameProblem('_v2')).toBeUndefined();
    expect(migrationNameProblem('')).toMatch(/Enter a name/);
    expect(migrationNameProblem('2Add')).toMatch(/letters/);
    expect(migrationNameProblem('Add Email')).toMatch(/letters/);
    expect(migrationNameProblem('x; rm -rf /')).toMatch(/letters/);
  });

  it('declares no Drop Database command', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { contributes: { commands: { command: string; title: string }[] } };
    const ef = pkg.contributes.commands.filter((c) => c.command.startsWith('refyntra.ef.'));
    expect(ef.length).toBeGreaterThan(5);
    expect(ef.some((c) => /drop/i.test(c.command + c.title))).toBe(false);
  });
});

describe('dotnet ef output', () => {
  it('reads the JSON of migrations list after the build lines', () => {
    const out = 'Build started...\nBuild succeeded.\n[\n  {\n    "id": "20250101000000_Initial",\n    "name": "Initial",\n    "safeName": "Initial",\n    "applied": true\n  }\n]\n';
    expect(parseMigrationsList(out)).toEqual({ migrations: [{ id: '20250101000000_Initial', applied: true }], connected: true });
    expect(parseMigrationsList('Build failed.')).toBeUndefined();
    expect(parseMigrationsList('[ not json')).toBeUndefined();
    expect(parseMigrationsList('[]')).toEqual({ migrations: [], connected: true });
  });

  it('reads the dotnet-ef version and the local manifest', () => {
    expect(parseEfVersion('Entity Framework Core .NET Command-line Tools\n9.0.10\n')).toBe('9.0.10');
    expect(parseEfVersion('Could not execute because the specified command or file was not found.')).toBeUndefined();
    expect(manifestHasDotnetEf('{"version":1,"isRoot":true,"tools":{"dotnet-ef":{"version":"9.0.10","commands":["dotnet-ef"]}}}')).toBe(true);
    expect(manifestHasDotnetEf('{"version":1,"tools":{}}')).toBe(false);
    expect(manifestHasDotnetEf('{oops')).toBe(false);
  });

  it('explains a missing dotnet-ef with the install command as text', () => {
    expect(efHealthText({ state: 'missing', localManifest: false }, 2)).toContain(INSTALL_DOTNET_EF);
    expect(efHealthText({ state: 'missing', localManifest: false }, 2)).toContain('never installs');
    expect(efHealthText({ state: 'missing', localManifest: true }, 1)).toContain('dotnet tool restore');
    expect(efHealthText({ state: 'found', version: '9.0.10', source: 'global' }, 1)).toBe('1 DbContext found from source; dotnet-ef 9.0.10 (global or on PATH) runs migrations commands as tasks.');
    expect(efHealthText({ state: 'unknown' }, 3)).toMatch(/^3 DbContexts/);
  });
});

describe('LINQ to SQL helpers', () => {
  it('evaluates DebugView.Query first, then the static call, then the extension call', () => {
    expect(toQueryStringExpressions(' query; ')).toEqual(['(query).DebugView.Query', 'Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToQueryString(query)', '(query).ToQueryString()']);
  });

  it('reads a debugger string result', () => {
    expect(parseDebuggerString('"SELECT \\"b\\".\\"Id\\"\\nFROM \\"Blogs\\" AS \\"b\\""')).toBe('SELECT "b"."Id"\nFROM "Blogs" AS "b"');
    expect(parseDebuggerString('"tab\\there \\u0041"')).toBe('tab\there A');
    expect(parseDebuggerString('{System.Linq.Queryable}')).toBeUndefined();
    expect(parseDebuggerString(undefined)).toBeUndefined();
  });

  it('rejects empty selections and statements', () => {
    expect(selectionProblem('  ')).toMatch(/Select an IQueryable/);
    expect(selectionProblem('var q = db.Blogs;')).toMatch(/not a statement/);
    expect(selectionProblem('a; b')).toMatch(/not a statement/);
    expect(selectionProblem('db.Blogs.Where(b => b.Rating > 3)')).toBeUndefined();
  });
});

describe('efcore/migrations from the host (untrusted data)', () => {
  it('drops malformed entries and fills defaults', () => {
    const r = sanitizeEfMigrations(
      {
        contexts: [
          { name: 'A', projectUri: 'file:///a.csproj', migrations: [{ id: 'm1' }, { name: 'no id' }, null], configurations: [{ name: 'C', location: { uri: 'file:///c.cs' } }, 3], snapshot: { nope: 1 } },
          { projectUri: 'file:///b.csproj' },
          'x',
        ],
        state: 'Ready',
      },
      's9',
    );
    expect(r.snapshotId).toBe('s9');
    expect(r.contexts).toHaveLength(1);
    const c = r.contexts[0]!;
    expect(c.fullName).toBe('A');
    expect(c.migrationsProjectUri).toBe('file:///a.csproj');
    expect(c.migrations).toEqual([{ id: 'm1', name: 'm1', className: '', location: null, designerLocation: null }]);
    expect(c.configurations).toEqual([{ name: 'C', location: null }]);
    expect(c.snapshot).toBeNull();
    expect(sanitizeEfMigrations(null, 's').contexts).toEqual([]);
  });
});
