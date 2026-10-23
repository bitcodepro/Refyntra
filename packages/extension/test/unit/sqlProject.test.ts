import { describe, expect, it } from 'vitest';
import { dacpacName, dbBuildCommand, pickDacpac, sqlProjectKind } from '../../src/sqlProjectModel';

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

  it('picks the newest matching .dacpac written by this build', () => {
    const c = [
      { file: '/w/Db/bin/Debug/Shop.dacpac', mtime: 50 },
      { file: '/w/Db/bin/Release/Shop.dacpac', mtime: 200 },
      { file: '/w/Db/bin/Release/master.dacpac', mtime: 300 },
    ];
    expect(pickDacpac('Shop.dacpac', c, 100)).toBe('/w/Db/bin/Release/Shop.dacpac');
    expect(pickDacpac('Shop.dacpac', c, 250)).toBeUndefined();
  });
});
