import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { analyzer, at, fixture, kinds, labels, related, ts } from './helpers';

// React relations proven by the bundled TypeScript checker (tests/fixtures/WebReact, synthetic).

const ROOT = fixture('WebReact');
const a = analyzer(ROOT);

describe('React (TypeScript checker)', () => {
  it('detects the project and its React version', () => {
    const p = a.projects();
    expect(p).toHaveLength(1);
    expect(p[0]!.info.react).toMatchObject({ major: 19, source: 'declared' });
  });

  it('component declaration: JSX usages, props, unused prop and missing required prop as information', () => {
    const r = related(a, ROOT, 'src/components/Button.tsx', 'function Button', 10);
    expect(r.subject).toBe('Button');
    expect(labels(r, 'react.component')).toEqual(['Button (function component)']);
    const usages = kinds(r, 'react.usage');
    expect(usages.map((u) => u.label)).toEqual(['<Button> in App.tsx', '<Button> in App.tsx']);
    expect(usages.every((u) => u.confidence === 'proven')).toBe(true);
    expect(usages.flatMap((u) => u.limitations)).toContain('Information: required props not passed here: size.');
    expect(labels(r, 'react.prop')).toEqual(['label: string', 'onClick?: (() => void) | undefined', 'size: number', "variant?: \"primary\" | \"secondary\" | undefined"]);
    const variant = kinds(r, 'react.prop').find((p) => p.label.startsWith('variant'))!;
    expect(variant.limitations).toEqual(['Information: none of the 2 usages found passes this prop.']);
  });

  it('same-name non-component: the legacy Button class is not linked to JSX elements', () => {
    const r = related(a, ROOT, 'src/legacy/Button.ts', 'class Button', 7);
    expect(r.relations).toEqual([]);
  });

  it('JSX usage: the component and the props each attribute resolves to', () => {
    const r = related(a, ROOT, 'src/App.tsx', '<Button label="Cancel"', 2);
    expect(labels(r, 'react.component')).toEqual(['Button (function component)']);
    expect(kinds(r, 'react.component')[0]!.limitations).toEqual(['Information: required props not passed here: size.']);
    expect(labels(r, 'react.prop')).toEqual(['label: string', 'onClick?: (() => void) | undefined']);
    expect(kinds(r, 'react.prop')[0]!.location!.uri).toMatch(/Button\.tsx$/);
  });

  it('class component and wrapped (memo) component usages', () => {
    const card = related(a, ROOT, 'src/components/Card.tsx', 'class Card', 7);
    expect(labels(card, 'react.component')).toEqual(['Card (class component)']);
    expect(labels(card, 'react.usage')).toEqual(['<Card> in App.tsx']);
    expect(labels(card, 'react.prop')).toEqual(['title: string']);
    const badge = related(a, ROOT, 'src/components/Badge.tsx', 'Badge', 1);
    expect(labels(badge, 'react.usage')).toEqual(['<Badge> in App.tsx']);
  });

  it('prop member: the JSX attributes that set it', () => {
    const r = related(a, ROOT, 'src/components/Button.tsx', 'label: string', 1);
    expect(r.subject).toBe('prop label');
    expect(labels(r, 'react.propUse')).toEqual(['<Button label=…> in App.tsx', '<Button label=…> in App.tsx']);
  });

  it('custom hook: definition and uses', () => {
    const r = related(a, ROOT, 'src/App.tsx', 'useOrders(2)', 2);
    expect(labels(r, 'react.hook')).toEqual(['useOrders (custom hook)']);
    expect(labels(r, 'react.hookUse')).toEqual(['useOrders(…) in App.tsx']);
  });

  it('context: providers and consumers are likely', () => {
    const r = related(a, ROOT, 'src/context/Theme.tsx', 'ThemeContext =', 2);
    expect(labels(r, 'react.context')).toEqual(['ThemeContext (context)']);
    expect(labels(r, 'react.contextProvider')).toEqual(['<ThemeContext.Provider> in Theme.tsx']);
    expect(labels(r, 'react.contextConsumer')).toEqual(['useContext(ThemeContext) in App.tsx']);
    expect(kinds(r, 'react.contextConsumer')[0]!.confidence).toBe('likely');
  });

  it('Find component: lists components, never the same-name class', () => {
    const r = a.find({ kind: 'component', text: '', limit: 50, documents: [] });
    expect(r.items.map((i) => `${i.label}|${i.detail}`)).toEqual(['App|App.tsx', 'Badge|Badge.tsx', 'Button|Button.tsx', 'Card|Card.tsx', 'ThemeProvider|Theme.tsx']);
  });

  it('unsaved text of another file is seen (a typed usage)', () => {
    const app = `${a.projects()[0]!.info.rootUri}/src/App.tsx`;
    const text = ts.sys.readFile(path.join(ROOT, 'src/App.tsx'))!.replace('<Badge', '<Card title="typed" /><Badge');
    const r = a.related({ ...at(ROOT, 'src/components/Card.tsx', 'class Card', 7), documents: [{ uri: app, text }] });
    expect(labels(r, 'react.usage')).toEqual(['<Card> in App.tsx', '<Card> in App.tsx']);
    const back = a.related({ ...at(ROOT, 'src/components/Card.tsx', 'class Card', 7), documents: [{ uri: app, text: null }] });
    expect(labels(back, 'react.usage')).toEqual(['<Card> in App.tsx']);
  });

  it('unsaved editor text is used', () => {
    const r = a.related({
      uri: related.length ? `${a.projects()[0]!.info.rootUri}/src/components/Button.tsx` : '',
      position: { line: 7, character: 18 },
      documents: [{ uri: `${a.projects()[0]!.info.rootUri}/src/components/Button.tsx`, text: 'export interface ButtonProps { label: string }\n\n\n\n\n\n\nexport function Button({ label }: ButtonProps) { return <b>{label}</b>; }\n' }],
    });
    expect(labels(r, 'react.prop')).toEqual(['label: string']);
    a.related({ uri: `${a.projects()[0]!.info.rootUri}/src/components/Button.tsx`, position: { line: 0, character: 0 }, documents: [{ uri: `${a.projects()[0]!.info.rootUri}/src/components/Button.tsx`, text: null }] });
  });
});
