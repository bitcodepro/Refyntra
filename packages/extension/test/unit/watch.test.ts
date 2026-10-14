import { describe, expect, it } from 'vitest';
import { WatchOutput, watchArgs, watchStatusAfter, watchStatusText } from '../../src/watchModel';

// Output of `dotnet watch run` (SDK 10, Linux, stdin not a console), measured in Docker.
const START = `dotnet watch 🔥 Hot reload enabled. For a list of supported edits, see https://aka.ms/dotnet/hot-reload.
dotnet watch 💡 Press Ctrl+R to restart.
  Determining projects to restore...
  All projects are up-to-date for restore.
  w -> /app/w/bin/Debug/net10.0/w.dll

Build succeeded.
dotnet watch ⌚ Loading projects ...
dotnet watch ⌚ Loaded 1 project(s) in 1.3s.
dotnet watch ⌚ Waiting for changes
`;
const RUDE = `dotnet watch ⌚ File updated: ./Program.cs
dotnet watch 🔥 Restart is needed to apply the changes.
dotnet watch ❌ [w (net10.0)] /app/w/Program.cs(2,13): error ENC0014: Updating the base class and/or base interface(s) of class requires restarting the application.
`;
const PROMPT = '  ❔ Do you want to restart your app? Yes (y) / No (n) / Always (a) / Never (v)';

describe('dotnet watch status', () => {
  it('follows the run: building, watching, hot reload applied, rude edit, exited', () => {
    let s = watchStatusAfter({ state: 'starting' }, START);
    expect(s.state).toBe('running');
    expect(watchStatusText(s)).toBe('$(flame) Hot Reload: watching');
    s = watchStatusAfter(s, 'dotnet watch ⌚ File changed: ./Program.cs');
    expect(s.state).toBe('building');
    s = watchStatusAfter(s, 'dotnet watch 🔥 [w (net10.0)] Hot reload succeeded.');
    expect(s).toEqual({ state: 'applied', detail: '[w (net10.0)] Hot reload succeeded.' });
    s = watchStatusAfter(s, RUDE);
    expect(s.state).toBe('rudeEdit');
    expect(s.detail).toBe('Restart is needed to apply the changes.');
    s = watchStatusAfter(s, 'dotnet watch ⌚ [w (net10.0)] Exited');
    expect(s.state).toBe('waiting');
    s = watchStatusAfter(s, 'dotnet watch ⌚ Waiting for a file to change before restarting dotnet...');
    expect(s.state).toBe('waiting');
    s = watchStatusAfter(s, '/app/w/Program.cs(3,1): error CS1002: ; expected\n\x1b[31mBuild FAILED.\x1b[0m');
    expect(s.state).toBe('failed');
    expect(watchStatusText({ state: 'rudeEdit' })).toMatch(/restart needed/);
  });

  it('a prompt without a final newline counts once', () => {
    const o = new WatchOutput();
    expect(o.push(START)).toBe(false);
    expect(o.push(RUDE)).toBe(false);
    expect(o.push(PROMPT.slice(0, 12))).toBe(false);
    expect(o.push(PROMPT.slice(12))).toBe(true);
    expect(o.status).toMatchObject({ state: 'rudeEdit', prompt: true });
    expect(o.push('  ❔ tick Object\ntick Object\n')).toBe(false);
    // A later rude edit asks again.
    o.push('dotnet watch ⌚ File updated: ./Program.cs\n');
    expect(o.push(`${RUDE}${PROMPT}\n`)).toBe(true);
  });

  it('--non-interactive restarts on rude edits by itself (policy restart)', () => {
    expect(watchArgs(['watch', 'run', '--project', 'a.csproj'], 'restart')).toEqual(['watch', '--non-interactive', 'run', '--project', 'a.csproj']);
    expect(watchArgs(['watch', 'run'], 'ask')).toEqual(['watch', 'run']);
    expect(watchArgs(['run'], 'restart')).toEqual(['run']);
    expect(watchArgs(['watch', '--non-interactive', 'run'], 'restart')).toEqual(['watch', '--non-interactive', 'run']);
  });
});
