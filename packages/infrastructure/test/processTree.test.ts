import { describe, expect, it } from 'vitest';
import { SupervisedProcess } from '../src';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// POSIX only: on Windows the real host's Job Object owns this (src/dotnet HostProcessTests.NoChildProcessOutlivesTheHost).
describe.skipIf(process.platform === 'win32')('SupervisedProcess process tree (POSIX)', () => {
  it('a child left behind by a voluntarily exiting process is killed on dispose', async () => {
    // Parent: starts a long-lived grandchild, prints its pid, exits when stdin closes without killing it.
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');process.stdin.on('end',()=>process.exit(0));process.stdin.resume();`;
    const proc = await SupervisedProcess.start({ command: process.execPath, args: ['-e', script] });
    const grandchild = await new Promise<number>((resolve) => proc.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);
    await proc.dispose(5000);
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(grandchild)).toBe(false);
  });
});
