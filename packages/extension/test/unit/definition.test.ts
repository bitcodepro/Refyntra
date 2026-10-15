import { describe, expect, it } from 'vitest';
import { declarationHasNoBody, definitionTargets } from '../../src/definitionModel';

const loc = (uri: string, line: number) => ({ uri, range: { start: { line, character: 0 }, end: { line, character: 5 } } });

describe('Ctrl+Click in C#', () => {
  it('sees declarations without a body', () => {
    expect(declarationHasNoBody('    string Greet(string name, int times);')).toBe(true);
    expect(declarationHasNoBody('    public abstract double Area();')).toBe(true);
    expect(declarationHasNoBody('    public string Greet(string n) => n;')).toBe(false);
    expect(declarationHasNoBody('    public void Run()')).toBe(false);
  });

  it('a method with a body opens its declaration; an interface member or a click on a declaration opens the implementations', () => {
    const decl = [loc('file:///I.cs', 7)];
    const impls = [loc('file:///A.cs', 15), loc('file:///B.cs', 21)];
    const base = { subjectKind: 'method', declarations: decl, implementations: impls, clickedOnDeclaration: false, inInterface: false };
    expect(definitionTargets({ ...base, declarationLine: '    public virtual string Greet() => "x";' })).toEqual(decl);
    expect(definitionTargets({ ...base, declarationLine: '    string Greet(string name, int times);' })).toEqual(impls);
    expect(definitionTargets({ ...base, declarationLine: '    string Name { get; }', inInterface: true })).toEqual(impls);
    expect(definitionTargets({ ...base, declarationLine: '    public void Run()', clickedOnDeclaration: true })).toEqual(impls);
    expect(definitionTargets({ ...base, subjectKind: 'interface', declarationLine: 'public interface IGreeter' })).toEqual(impls);
    expect(definitionTargets({ ...base, implementations: [], declarationLine: '    string Greet();' })).toEqual(decl);
  });
});
