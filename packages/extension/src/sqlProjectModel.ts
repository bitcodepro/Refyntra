import * as path from 'node:path';

/**
 * SQL database projects (.sqlproj) and their build output, the .dacpac. Two kinds:
 * - "sdk": SDK-style (Microsoft.Build.Sql or MSBuild.Sdk.SqlProj): `dotnet build` makes the .dacpac on any OS;
 * - "legacy": the Visual Studio (SSDT) project: needs the MSBuild of a Visual Studio with SQL Server Data Tools (Windows).
 */
export type SqlProjectKind = 'sdk' | 'legacy';

export function sqlProjectKind(text: string): SqlProjectKind {
  if (/<Project\b[^>]*\bSdk\s*=\s*"[^"]*(Microsoft\.Build\.Sql|MSBuild\.Sdk\.SqlProj)/i.test(text)) return 'sdk';
  if (/<Sdk\s+Name\s*=\s*"(Microsoft\.Build\.Sql|MSBuild\.Sdk\.SqlProj)"/i.test(text)) return 'sdk';
  return 'legacy';
}

function property(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(text);
  return m && m[1] && !m[1].includes('$(') ? m[1] : undefined;
}

/** The .dacpac file name: $(SqlTargetName), else $(TargetName), else the project file name. */
export function dacpacName(projectFile: string, text: string): string {
  return (property(text, 'SqlTargetName') ?? property(text, 'TargetName') ?? path.basename(projectFile, path.extname(projectFile))) + '.dacpac';
}

export interface DbBuildCommand {
  title: string;
  command: string;
  args: string[];
  cwd: string;
}

/** The build command; undefined for a legacy project when no Visual Studio MSBuild is known. */
export function dbBuildCommand(kind: SqlProjectKind, projectFile: string, configuration: string, msbuild: string | undefined): DbBuildCommand | undefined {
  const cwd = path.dirname(projectFile);
  const title = `Build ${path.basename(projectFile)} (.dacpac)`;
  if (kind === 'sdk') return { title, command: 'dotnet', args: ['build', projectFile, '-c', configuration], cwd };
  if (!msbuild) return undefined;
  return { title, command: msbuild, args: [projectFile, '/t:Build', `/p:Configuration=${configuration}`, '/nologo', '/v:minimal'], cwd };
}

/** Among candidate .dacpac paths (with modification times), the one this build wrote: the newest named like the project's. */
export function pickDacpac(name: string, candidates: { file: string; mtime: number }[], since: number): string | undefined {
  const fresh = candidates.filter((c) => path.basename(c.file).toLowerCase() === name.toLowerCase() && c.mtime >= since);
  fresh.sort((a, b) => b.mtime - a.mtime);
  return fresh[0]?.file;
}
