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

/**
 * The command that asks MSBuild where the build puts the .dacpac (the same configuration as the build): any OutputPath,
 * UseArtifactsOutput or SqlTargetName is evaluated by MSBuild itself.
 */
export function dbOutputQuery(build: DbBuildCommand): { command: string; args: string[] } {
  const props = ['-getProperty:SqlTargetPath', '-getProperty:TargetPath'];
  if (build.command === 'dotnet') return { command: 'dotnet', args: ['msbuild', build.args[1]!, ...props, `-p:Configuration=${build.args[3]!}`] };
  return { command: build.command, args: [build.args[0]!, ...props, build.args[2]!.replace(/^\//, '-')] };
}

/** The .dacpac from the query's output ({"Properties": {...}}): SqlTargetPath, else a TargetPath ending in .dacpac. */
export function dacpacFromQuery(output: string, projectDir: string): string | undefined {
  let props: Record<string, string> = {};
  try {
    props = (JSON.parse(output.slice(output.indexOf('{'))) as { Properties?: Record<string, string> }).Properties ?? {};
  } catch {
    return undefined;
  }
  const file = [props['SqlTargetPath'], props['TargetPath']].find((p) => p && /\.dacpac$/i.test(p.trim()));
  return file ? path.resolve(projectDir, file.trim()) : undefined;
}

/**
 * Without an answer from MSBuild (older than 17.8 has no -getProperty): the .dacpac named like the project's in a folder
 * under the bin root named after the built configuration (bin/Debug, bin/x64/Debug), never another configuration's.
 * Only folders below the bin root count (a checkout under /work/Debug does not make every file Debug's). Both path
 * separators are read on every OS. Not filtered by the build's start time: an up-to-date build does not rewrite the file.
 */
export function pickDacpac(name: string, configuration: string, binRoot: string, candidates: { file: string; mtime: number }[]): string | undefined {
  const parts = (p: string) => p.split(/[\\/]+/).filter((s) => s.length > 0).map((s) => s.toLowerCase());
  const root = parts(binRoot);
  const config = configuration.toLowerCase();
  const named = candidates.filter((c) => {
    const p = parts(c.file);
    if (p.length <= root.length + 1 || root.some((s, i) => p[i] !== s)) return false;
    return p[p.length - 1] === name.toLowerCase() && p.slice(root.length, -1).includes(config);
  });
  named.sort((a, b) => b.mtime - a.mtime);
  return named[0]?.file;
}
