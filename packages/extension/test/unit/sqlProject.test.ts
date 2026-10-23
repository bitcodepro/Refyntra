import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dacpacFromQuery, dacpacName, dbBuildCommand, dbOutputQuery, pickDacpac, sqlProjectKind } from '../../src/sqlProjectModel';

const SDK = '<Project Sdk="Microsoft.Build.Sql/2.3.0">\n  <PropertyGroup><Name>Shop</Name></PropertyGroup>\n</Project>';
const LEGACY =
  '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n  <PropertyGroup><SqlTargetName>ShopDb</SqlTargetName></PropertyGroup>\n  <Import Project="$(SQLDBExtensionsRefPath)\\Microsoft.Data.Tools.Schema.SqlTasks.targets" />\n</Project>';

describe('database projects', () => {
  it('tells SDK-style projects from Visual Studio (SSDT) ones', () => {
    expect(sqlProjectKind(SDK)).toBe('sdk');
    expect(sqlProjectKind('<Project Sdk="MSBuild.Sdk.SqlProj/3.0.0"></Project>')).toBe('sdk');
    expect(sqlProjectKind('<Project>\n  <Sdk Name="Microsoft.Build.Sql" Version="1.0.0" />\n</Project>')).toBe('sdk');
    expect(sqlProjectKind(LEGACY)).toBe('legacy');
  });

  it('names the .dacpac after SqlTargetName, else the project file', () => {
    expect(dacpacName('/w/Db/Shop.sqlproj', SDK)).toBe('Shop.dacpac');
    expect(dacpacName('/w/Db/Shop.sqlproj', LEGACY)).toBe('ShopDb.dacpac');
    expect(dacpacName('/w/Db/Shop.sqlproj', '<SqlTargetName>$(Name)X</SqlTargetName>')).toBe('Shop.dacpac');
  });

  it('builds SDK-style projects with dotnet, legacy ones only with a Visual Studio MSBuild', () => {
    expect(dbBuildCommand('sdk', '/w/Db/Shop.sqlproj', 'Release', undefined)).toMatchObject({ command: 'dotnet', args: ['build', '/w/Db/Shop.sqlproj', '-c', 'Release'] });
    expect(dbBuildCommand('legacy', '/w/Db/Shop.sqlproj', 'Debug', undefined)).toBeUndefined();
    expect(dbBuildCommand('legacy', '/w/Db/Shop.sqlproj', 'Debug', 'C:/VS/MSBuild.exe')?.args).toEqual(['/w/Db/Shop.sqlproj', '/t:Build', '/p:Configuration=Debug', '/nologo', '/v:minimal']);
  });

  it("falls back to the requested configuration's .dacpac, however old, never a newer one of another configuration", () => {
    // An older Debug build, a newer Release build, then an unchanged Debug rebuild whose property query failed.
    const c = [
      { file: '/w/Db/bin/Debug/Shop.dacpac', mtime: 50 },
      { file: '/w/Db/bin/Release/Shop.dacpac', mtime: 200 },
      { file: '/w/Db/bin/Release/master.dacpac', mtime: 300 },
    ];
    expect(pickDacpac('Shop.dacpac', 'Debug', c)).toBe('/w/Db/bin/Debug/Shop.dacpac');
    expect(pickDacpac('Shop.dacpac', 'release', c)).toBe('/w/Db/bin/Release/Shop.dacpac');
    expect(pickDacpac('Shop.dacpac', 'Debug', [{ file: 'C:\\w\\Db\\bin\\x64\\Debug\\Shop.dacpac', mtime: 1 }])).toBe('C:\\w\\Db\\bin\\x64\\Debug\\Shop.dacpac');
    // Only another configuration's file: nothing (reported as not found), not the wrong artifact.
    expect(pickDacpac('Shop.dacpac', 'Debug', c.slice(1))).toBeUndefined();
    expect(pickDacpac('Other.dacpac', 'Debug', c)).toBeUndefined();
  });

  it('asks MSBuild for SqlTargetPath/TargetPath with the build configuration', () => {
    const sdk = dbBuildCommand('sdk', '/w/Db/Shop.sqlproj', 'Release', undefined)!;
    expect(dbOutputQuery(sdk)).toEqual({ command: 'dotnet', args: ['msbuild', '/w/Db/Shop.sqlproj', '-getProperty:SqlTargetPath', '-getProperty:TargetPath', '-p:Configuration=Release'] });
    const legacy = dbBuildCommand('legacy', '/w/Db/Shop.sqlproj', 'Debug', 'C:/VS/MSBuild.exe')!;
    expect(dbOutputQuery(legacy)).toEqual({ command: 'C:/VS/MSBuild.exe', args: ['/w/Db/Shop.sqlproj', '-getProperty:SqlTargetPath', '-getProperty:TargetPath', '-p:Configuration=Debug'] });
  });

  it('reads the .dacpac from MSBuild: a custom OutputPath, artifacts output, a relative path', () => {
    const json = (sql: string, target: string) => JSON.stringify({ Properties: { SqlTargetPath: sql, TargetPath: target } });
    expect(dacpacFromQuery(json('/w/dist/db/Shop.dacpac', '/w/dist/db/Shop.dacpac'), '/w/Db')).toBe(path.resolve('/w/dist/db/Shop.dacpac'));
    expect(dacpacFromQuery(json('/w/artifacts/bin/Shop/debug/Shop.dacpac', ''), '/w/Db')).toBe(path.resolve('/w/artifacts/bin/Shop/debug/Shop.dacpac'));
    expect(dacpacFromQuery(json('', 'out/Shop.dacpac'), '/w/Db')).toBe(path.resolve('/w/Db', 'out/Shop.dacpac'));
    expect(dacpacFromQuery('MSBuild version 17\n' + json('', '/w/Db/bin/Debug/Shop.dll'), '/w/Db')).toBeUndefined();
    expect(dacpacFromQuery('error MSB1001', '/w/Db')).toBeUndefined();
  });
});
