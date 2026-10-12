import { describe, expect, it } from 'vitest';
import { ImmediateHistory, completionPrefix, inputKeyAction, normaliseInput, parsePageMessage, renderImmediateHtml, toNode } from '../../src/immediateModel';

describe('Immediate Window model', () => {
  it('walks the history with Up/Down and keeps the draft', () => {
    const h = new ImmediateHistory();
    h.push('count + 1');
    h.push('x = 5');
    h.push('x = 5');
    expect(h.all).toEqual(['count + 1', 'x = 5']);
    expect(h.previous('dra')).toBe('x = 5');
    expect(h.previous('x = 5')).toBe('count + 1');
    expect(h.previous('count + 1')).toBeUndefined();
    expect(h.next()).toBe('x = 5');
    expect(h.next()).toBe('dra');
    expect(h.next()).toBeUndefined();
  });

  it('maps keys: Enter evaluates, Shift+Enter is a newline, arrows only on the first/last line', () => {
    expect(inputKeyAction('Enter', false, 'a', 1)).toBe('evaluate');
    expect(inputKeyAction('Enter', true, 'a', 1)).toBe('newline');
    expect(inputKeyAction('ArrowUp', false, 'a\nb', 3)).toBe('none');
    expect(inputKeyAction('ArrowUp', false, 'a\nb', 1)).toBe('previous');
    expect(inputKeyAction('ArrowDown', false, 'a\nb', 1)).toBe('none');
    expect(inputKeyAction('ArrowDown', false, 'a\nb', 3)).toBe('next');
  });

  it('turns DAP results into nodes and joins multi-line input', () => {
    expect(toNode(1, 'order', { result: '{Shop.Order}', type: 'Shop.Order', variablesReference: 7 }, 'order')).toEqual({ id: 1, label: 'order', value: '{Shop.Order}', type: 'Shop.Order', ref: 7, evaluateName: 'order' });
    expect(toNode(2, 'Id', { value: '3' }).ref).toBe(0);
    expect(normaliseInput('order\n  .Total;\n')).toBe('order .Total');
    expect(completionPrefix('order.Cu', 8)).toEqual({ prefix: 'Cu', start: 6 });
  });

  it('accepts only known page messages', () => {
    expect(parsePageMessage({ type: 'evaluate', text: 'x' })).toEqual({ type: 'evaluate', text: 'x' });
    expect(parsePageMessage({ type: 'expand', nodeId: '1' })).toBeUndefined();
    expect(parsePageMessage({ type: 'run', command: 'x' })).toBeUndefined();
    expect(parsePageMessage(null)).toBeUndefined();
  });

  it('renders an accessible page with a strict CSP', () => {
    const html = renderImmediateHtml({ nonce: 'abc', cspSource: 'vscode-webview:' });
    expect(html).toContain("default-src &#39;none&#39;; style-src &#39;nonce-abc&#39;; script-src &#39;nonce-abc&#39;");
    expect(html).not.toMatch(/style="/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('<label for="input"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain("setAttribute('role','tree')");
    expect(html).toContain('var(--vscode-');
  });
});

describe('assignments in the Immediate Window', () => {
  it('recognises simple assignments only', async () => {
    const { parseAssignment } = await import('../../src/immediateModel');
    expect(parseAssignment('count = 5')).toEqual({ target: 'count', value: '5' });
    expect(parseAssignment('this.order.Total = 1.5m;')).toEqual({ target: 'this.order.Total', value: '1.5m' });
    expect(parseAssignment('count == 5')).toBeUndefined();
    expect(parseAssignment('count += 5')).toBeUndefined();
    expect(parseAssignment('x => x')).toBeUndefined();
  });
});
