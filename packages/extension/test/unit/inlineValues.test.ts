import { describe, expect, it } from 'vitest';
import { enclosingMethodStart, evaluatableChain, inlineValueEntries, maskCode, parameterNames, truncateValue } from '../../src/inlineValuesModel';

const SRC = `namespace Demo;

public class Counter
{
    private int _total;
    public string Name { get; set; } = "x";

    public int Add(int amount, string label = "a")
    {
        var count = amount + 1; // count = 99 in a comment
        int doubled = count * 2;
        _total += doubled;
        this.Name = label;
        foreach (var item in new[] { 1, 2 })
        {
            count++;
        }
        Helper(out var parsed);
        return count + parsed;
    }

    private void Helper(out int value) { value = 3; }
}
`.split('\n');

const at = (needle: string) => SRC.findIndex((l) => l.includes(needle));
const names = (entries: ReturnType<typeof inlineValueEntries>) => entries.map((e) => `${e.line}:${e.expression ?? e.name}`);

describe('inline values (syntax pass)', () => {
  it('masks comments and strings', () => {
    const m = maskCode(['var s = "a = b"; // c = d'])[0]!;
    expect(m.trimEnd()).toBe('var s = "     ";');
    expect(m.length).toBe(25);
  });

  it('finds the enclosing method header', () => {
    expect(enclosingMethodStart(maskCode(SRC), at('return count'))).toBe(at('public int Add'));
    expect(enclosingMethodStart(maskCode(SRC), at('private int _total'))).toBe(-1);
  });

  it('reads parameter names', () => {
    expect(parameterNames('public int Add(int amount, string label = "a", Dictionary<string, int> map)')).toEqual(['amount', 'label', 'map']);
  });

  it('returns parameters, locals, foreach variables, fields and this-members up to the stopped line', () => {
    const e = inlineValueEntries(SRC, at('return count'));
    const n = names(e);
    expect(n).toContain(`${at('public int Add')}:amount`);
    expect(n).toContain(`${at('public int Add')}:label`);
    expect(n).toContain(`${at('var count')}:count`);
    expect(n).toContain(`${at('int doubled')}:doubled`);
    expect(n).toContain(`${at('_total +=')}:_total`);
    expect(n).toContain(`${at('this.Name')}:this.Name`);
    expect(n).toContain(`${at('foreach')}:item`);
    expect(n).toContain(`${at('out var parsed')}:parsed`);
    expect(e.find((x) => x.name === '_total')!.kind).toBe('expression');
    expect(e.find((x) => x.name === 'count')!.kind).toBe('lookup');
    // Nothing after the stopped line, nothing from the other method, nothing from the comment.
    expect(e.every((x) => x.line <= at('return count'))).toBe(true);
    expect(n.filter((x) => x.endsWith(':value'))).toEqual([]);
    expect(n.filter((x) => x === `${at('var count')}:count`)).toHaveLength(1);
  });

  it('limits to the visible range', () => {
    const e = inlineValueEntries(SRC, at('return count'), at('int doubled'), at('int doubled'));
    expect(e.map((x) => x.line)).toEqual(e.map(() => at('int doubled')));
  });

  it('truncates long values', () => {
    expect(truncateValue('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(truncateValue('x\n  y')).toBe('x y');
  });
});

describe('hover evaluation chain', () => {
  const line = '        var x = order.Customer.Address.City + Get(a).B + this.count;';
  it('evaluates the whole member chain up to the hovered segment', () => {
    expect(evaluatableChain(line, line.indexOf('City') + 1)!.expression).toBe('order.Customer.Address.City');
    expect(evaluatableChain(line, line.indexOf('Address') + 2)!.expression).toBe('order.Customer.Address');
    expect(evaluatableChain(line, line.indexOf('count'))!.expression).toBe('this.count');
  });
  it('never evaluates calls', () => {
    expect(evaluatableChain(line, line.indexOf('Get') + 1)).toBeUndefined();
    expect(evaluatableChain(line, line.indexOf('.B') + 1)!.expression).toBe('B');
  });
  it('ignores keywords and literals', () => {
    expect(evaluatableChain(line, line.indexOf('var'))).toBeUndefined();
  });
});

describe('inline values in top-level programs', () => {
  const PROGRAM = ['using Lib;', '', 'var greeting = Greeter.Greeting("Run");', 'var count = args.Length + 41;', 'Console.WriteLine($"{greeting} {count}");', 'return count == 41 ? 7 : 1;'];
  it('returns the top-level locals up to the stopped line', () => {
    // Names inside string interpolations are not read (strings are masked); a plain use shows the value again.
    expect(inlineValueEntries(PROGRAM, 4).map((x) => `${x.line}:${x.name}`)).toEqual(['2:greeting', '3:count']);
    expect(inlineValueEntries(PROGRAM, 5).map((x) => `${x.line}:${x.name}`)).toEqual(['2:greeting', '3:count', '5:count']);
  });
  it('returns nothing inside a type of a file-scoped namespace without a method', () => {
    expect(inlineValueEntries(['namespace A;', 'class B', '{', '    int x = 1;', '}'], 3)).toEqual([]);
  });
});
