import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { offerAt, parseTemplates, previewBody } from '../../src/liveTemplatesModel';

describe('C# live templates', () => {
  const templates = parseTemplates(fs.readFileSync(path.join(__dirname, '..', '..', 'snippets', 'csharp.json'), 'utf8'));

  it('loads every template with a unique prefix', () => {
    expect(templates.length).toBeGreaterThan(30);
    const prefixes = templates.map((t) => t.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of ['prop', 'ctor', 'foreach', 'try', 'fact', 'theory', 'ntest', 'testm', 'cw']) expect(prefixes).toContain(p);
  });

  it('offers templates where a statement or member starts, not after a dot, in a string or a comment', () => {
    expect(offerAt('    fore')).toEqual({ word: 'fore' });
    expect(offerAt('')).toEqual({ word: '' });
    expect(offerAt('    list.fore')).toBeUndefined();
    expect(offerAt('    var s = "fore')).toBeUndefined();
    expect(offerAt('    // fore')).toBeUndefined();
    expect(offerAt('    var s = "x"; fore')).toEqual({ word: 'fore' });
  });

  it('shows a plain preview of the body', () => {
    expect(previewBody('foreach (var ${1:item} in ${2:collection})\n{\n\t$0\n}')).toBe('foreach (var item in collection)\n{\n    \n}');
    expect(previewBody('public ${1|class,sealed class|} ${2:${TM_FILENAME_BASE}}')).toBe('public class FileName');
  });
});
