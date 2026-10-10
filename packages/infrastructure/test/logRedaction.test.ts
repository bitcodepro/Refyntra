import { describe, expect, it } from 'vitest';
import { SinkLogger } from '../src';

function capture() {
  const lines: string[] = [];
  const logger = new SinkLogger({ appendLine: (l) => lines.push(l) }, () => 'debug', () => new Date(0));
  return { lines, logger };
}

describe('SinkLogger never writes source text or environment values', () => {
  it('redacts text-bearing keys at the top level', () => {
    const { lines, logger } = capture();
    logger.log('info', 'c', 'm', { text: 'class Secret {}', newText: 'x', env: { A: 'B' }, count: 2 });
    expect(lines[0]).toContain('text=[redacted]');
    expect(lines[0]).not.toContain('Secret');
    expect(lines[0]).toContain('count=2');
  });

  it('redacts text-bearing keys nested inside object and array fields', () => {
    const { lines, logger } = capture();
    logger.log('info', 'c', 'm', { change: { uri: 'file:///a.cs', text: 'class NestedSecret {}' }, list: [{ contents: 'ArraySecret' }], process: { environment: { TOKEN: 'EnvSecret' } } });
    expect(lines[0]).not.toMatch(/NestedSecret|ArraySecret|EnvSecret/);
    expect(lines[0]).toContain('file:///a.cs');
  });
});
