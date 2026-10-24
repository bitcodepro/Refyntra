import { describe, expect, it } from 'vitest';
import { groupBySolution, solutionProjectPaths } from '../../src/runModel';

describe('several solutions and projects in one folder', () => {
  it('reads the projects of .sln and .slnx files', () => {
    const sln = 'Project("{FAE04EC0}") = "Api", "src\\Api\\Api.csproj", "{1}"\nEndProject\nProject("{2150E333}") = "docs", "docs", "{2}"\nEndProject\nProject("{FAE04EC0}") = "Lib", "..\\shared\\Lib\\Lib.csproj", "{3}"\n';
    expect(solutionProjectPaths('C:\\repo\\backend\\Backend.sln', sln)).toEqual(['C:\\repo\\backend\\src\\Api\\Api.csproj', 'C:\\repo\\shared\\Lib\\Lib.csproj']);
    const slnx = '<Solution><Folder Name="/src/"><Project Path="src/Worker/Worker.csproj" /></Folder></Solution>';
    expect(solutionProjectPaths('/repo/tools/Tools.slnx', slnx)).toEqual(['/repo/tools/src/Worker/Worker.csproj']);
  });

  it('groups projects by the first solution that lists them, others apart', () => {
    const g = groupBySolution(['C:\\r\\A\\A.csproj', 'C:\\r\\B\\B.csproj', 'C:\\r\\C\\C.csproj'], [{ name: 'Backend.sln', projects: ['c:\\r\\a\\a.csproj'] }, { name: 'Tools.sln', projects: ['C:\\r\\B\\B.csproj', 'C:\\r\\A\\A.csproj'] }], true);
    expect([...g.values()]).toEqual(['Backend.sln', 'Tools.sln', 'Other projects']);
  });
});

describe('run groups', async () => {
  const { parseRunGroups, readinessEndpoint, groupSessionName } = await import('../../src/runModel');
  it('cleans the setting', () => {
    expect(parseRunGroups([{ name: ' Backend ', targets: ['Api', 'Worker', 3] }, { name: 'Backend', targets: ['X'] }, { name: 'Empty', targets: [] }, { targets: ['Y'] }, 'z'])).toEqual([{ name: 'Backend', targets: ['Api', 'Worker'] }]);
    expect(parseRunGroups(undefined)).toEqual([]);
  });
  it('finds the port a web project listens on', () => {
    expect(readinessEndpoint('https://localhost:7001;http://localhost:5001')).toEqual({ host: 'localhost', port: 7001 });
    expect(readinessEndpoint('http://*:8080')).toEqual({ host: 'localhost', port: 8080 });
    expect(readinessEndpoint(undefined)).toBeUndefined();
    // IPv6 literals and their ports; wildcards are reached on localhost.
    expect(readinessEndpoint('http://[::]:5189')).toEqual({ host: 'localhost', port: 5189 });
    expect(readinessEndpoint('http://[::1]:5189')).toEqual({ host: '::1', port: 5189 });
    expect(readinessEndpoint('https://[::1]')).toEqual({ host: '::1', port: 443 });
    expect(readinessEndpoint('http://0.0.0.0:5000')).toEqual({ host: 'localhost', port: 5000 });
    expect(readinessEndpoint('http://+:5000')).toEqual({ host: 'localhost', port: 5000 });
    expect(readinessEndpoint('not a url')).toBeUndefined();
  });
  it('names debug sessions after the group', () => {
    expect(groupSessionName('Backend', 'Api')).toBe('Backend › Api');
  });
});

describe('run group entries', async () => {
  const { resolveGroupEntry, groupEntryOf } = await import('../../src/runModel');
  const ts = [
    { id: 'a', label: 'Api', relativePath: 'backend/Api/Api.csproj' },
    { id: 'b', label: 'Api', relativePath: 'tools/Api/Api.csproj' },
    { id: 'w', label: 'Worker', relativePath: 'backend/Worker/Worker.csproj' },
  ];
  it('a repeated name needs the path; paths match with either separator and, on Windows, any case', () => {
    expect(resolveGroupEntry('Api', ts, false)).toBe('ambiguous');
    expect(resolveGroupEntry('tools\\Api\\Api.csproj', ts, false)?.toString()).toBe(ts[1]!.toString());
    expect((resolveGroupEntry('Tools/API/api.csproj', ts, true) as { id: string }).id).toBe('b');
    expect(resolveGroupEntry('Tools/API/api.csproj', ts, false)).toBeUndefined();
    expect((resolveGroupEntry('Worker', ts, false) as { id: string }).id).toBe('w');
    expect(resolveGroupEntry('Nope', ts, false)).toBeUndefined();
  });
  it('Create Run Group saves the path only when the name repeats', () => {
    expect(groupEntryOf(ts[0]!, ts)).toBe('backend/Api/Api.csproj');
    expect(groupEntryOf(ts[2]!, ts)).toBe('Worker');
  });
});
