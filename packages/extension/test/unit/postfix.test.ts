import { describe, expect, it } from 'vitest';
import { POSTFIX_SORT_PREFIX, postfixCacheKey, postfixCompletions, postfixDot } from '../../src/postfixModel';

const templates = [
  { name: 'foreach', detail: 'foreach (var number in numbers)\n{\n}', snippet: 'foreach (var ${1:number} in numbers)\n{\n    $0\n}' },
  { name: 'var', detail: 'var numbers2 = numbers;', snippet: 'var ${1:numbers2} = numbers;$0' },
];

describe('postfix templates (code/postfix glue)', () => {
  it('finds the dot before the cursor, also after a partly typed name', () => {
    expect(postfixDot('        numbers.', 16)).toBe(15);
    expect(postfixDot('        numbers.fo', 18)).toBe(15);
    expect(postfixDot('        GetItems().fo', 21)).toBe(18);
    expect(postfixDot('x1.', 3)).toBe(2);
  });

  it('ignores ranges, null-conditional access, spaces before the dot and number literals', () => {
    expect(postfixDot('a..', 3)).toBeUndefined();
    expect(postfixDot('a?.', 3)).toBeUndefined();
    expect(postfixDot('a .', 3)).toBeUndefined();
    expect(postfixDot('var x = 1.', 10)).toBeUndefined();
    expect(postfixDot('numbers', 7)).toBeUndefined();
    expect(postfixDot('.', 1)).toBeUndefined();
  });

  it('replaces the expression, the dot and the typed name; filters on the whole text; sorts after members', () => {
    const line = '        numbers.fo';
    const items = postfixCompletions(templates, { start: { line: 4, character: 8 }, end: { line: 4, character: 15 } }, line, { line: 4, character: 18 });
    expect(items.map((i) => i.label)).toEqual(['foreach', 'var']);
    expect(items[0]!.filterText).toBe('numbers.foreach');
    expect(items[0]!.range).toEqual({ start: { line: 4, character: 8 }, end: { line: 4, character: 18 } });
    expect(items[0]!.sortText.startsWith(POSTFIX_SORT_PREFIX)).toBe(true);
    expect(items[0]!.sortText < items[1]!.sortText).toBe(true);
    expect(items[0]!.snippet).toBe(templates[0]!.snippet);
  });

  it('offers nothing for a multi-line expression, a moved dot or malformed items', () => {
    const line = '        numbers.';
    expect(postfixCompletions(templates, { start: { line: 3, character: 8 }, end: { line: 4, character: 15 } }, line, { line: 4, character: 16 })).toEqual([]);
    expect(postfixCompletions(templates, { start: { line: 4, character: 8 }, end: { line: 4, character: 12 } }, line, { line: 4, character: 16 })).toEqual([]);
    expect(postfixCompletions(templates, null, line, { line: 4, character: 16 })).toEqual([]);
    const bad = [...templates, templates[0]!, { name: 'Bad Name', detail: '', snippet: 'x' }, { name: 'x', detail: '', snippet: 3 } as unknown as (typeof templates)[number]];
    expect(postfixCompletions(bad, { start: { line: 4, character: 8 }, end: { line: 4, character: 15 } }, line, { line: 4, character: 16 }).map((i) => i.label)).toEqual(['foreach', 'var']);
  });

  it('caches per document version and dot position', () => {
    expect(postfixCacheKey('file:///a.cs', 3, 4, 15)).not.toBe(postfixCacheKey('file:///a.cs', 4, 4, 15));
    expect(postfixCacheKey('file:///a.cs', 3, 4, 15)).toBe(postfixCacheKey('file:///a.cs', 3, 4, 15));
  });
});
