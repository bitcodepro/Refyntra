import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFindQuery } from '@refyntra/application';
import { RELATION_GROUP_ORDER } from '@refyntra/contracts';
import { relationGroupTitle } from '@refyntra/domain';
import {
  RENAME_CLASS_UNAVAILABLE,
  WebStyleService,
  WebStylesLanguageAdapter,
  joinSpec,
  parseHtml,
  parseScript,
  parseStylesheet,
  webStylesScriptFramework,
} from '@refyntra/adapter-web-styles';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'WebStyles');
const ROOT = 'file:///w%3A/fx/';

function files(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(ROOT + path.relative(fixture, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  walk(fixture);
  return out;
}

function service() {
  const all = files();
  return new WebStyleService({ files: { listFiles: async () => [...all.keys()].sort(), readFile: async (u) => all.get(u) } });
}

function at(rel: string, needle: string, offset = 0) {
  const text = files().get(ROOT + rel)!;
  const i = text.indexOf(needle);
  expect(i, `${needle} in ${rel}`).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, i + offset);
  const line = before.split('\n').length - 1;
  return { uri: ROOT + rel, position: { line, character: before.length - before.lastIndexOf('\n') - 1 } };
}

const short = (u: string) => u.slice(ROOT.length);
const text = (rel: string) => files().get(ROOT + rel)!;

describe('stylesheet parser (vscode-css-languageservice)', () => {
  it('reads classes and ids of every selector, skipping comments and attribute values', () => {
    const f = parseStylesheet(ROOT + 'plain/css/site.css', text('plain/css/site.css'), 'css');
    expect([...new Set(f.classes.map((c) => c.name))].sort()).toEqual(['card', 'highlight', 'unused-thing']);
    expect(f.ids.map((i) => i.name)).toEqual(['main']);
    expect(f.imports.map((i) => i.spec)).toEqual(['base.css']); // url(img/bg.png) is not an import
    expect(f.isModule).toBe(false);
  });

  it('SCSS: @use namespace, variables, mixins, uses and &-suffix classes', () => {
    const theme = parseStylesheet(ROOT + 'scss/theme.scss', text('scss/theme.scss'), 'scss');
    expect(theme.imports).toMatchObject([{ spec: 'vars', namespace: 'v' }]);
    expect(theme.classes.map((c) => c.name).sort()).toEqual(['btn', 'btn-large']);
    expect(theme.classes.find((c) => c.name === 'btn-large')!.derived).toBe(true);
    expect(theme.variableUses).toMatchObject([{ name: 'primary', namespace: 'v' }]);
    expect(theme.mixinUses).toMatchObject([{ name: 'card', namespace: 'v' }]);
    const vars = parseStylesheet(ROOT + 'scss/_vars.scss', text('scss/_vars.scss'), 'scss');
    expect(vars.variables.map((v) => v.name)).toEqual(['primary']);
    expect(vars.mixins.map((m) => m.name)).toEqual(['card']);
    expect(vars.variableUses.map((v) => v.name)).toEqual(['padding', 'padding']); // a parameter, not a global definition
  });

  it('LESS variables', () => {
    const f = parseStylesheet(ROOT + 'scss/theme.less', text('scss/theme.less'), 'less');
    expect(f.variables.map((v) => v.name)).toEqual(['accent']);
    expect(f.variableUses.map((v) => v.name)).toEqual(['accent']);
  });

  it('CSS Modules are recognised by the file name', () => {
    expect(parseStylesheet(ROOT + 'react/Button.module.css', '.root{}', 'css').isModule).toBe(true);
  });
});

describe('HTML scanner (vscode-html-languageservice)', () => {
  it('reads class/id attributes, stylesheet links, <style> and <script> blocks; template syntax is dynamic', () => {
    const f = parseHtml(ROOT + 'plain/index.html', text('plain/index.html'));
    expect(f.links.map((l) => l.spec)).toEqual(['css/site.css']);
    expect(f.classUses.map((c) => c.name)).toEqual(['card', 'highlight', 'inline-only', 'base', 'highlight']);
    expect(f.idUses.map((i) => i.name)).toEqual(['main', 'main']);
    expect(f.inline[0]!.classes.map((c) => c.name)).toEqual(['inline-only']);
    expect(f.inline[0]!.classes[0]!.range.start.line).toBe(6); // positions are in the HTML document
    expect(f.dynamic).toHaveLength(1);
  });
});

describe('script scanner', () => {
  it('CSS Modules: static members, string keys, dynamic access; comments ignored', () => {
    const f = parseScript(text('react/Button.tsx'));
    expect(f.moduleImports).toMatchObject([{ alias: 'styles', spec: './Button.module.css' }]);
    expect(f.moduleUses.map((u) => u.member)).toEqual(['root', 'primary']);
    expect(f.classUses.map((c) => c.name)).toEqual(['shared']);
    const d = parseScript(text('react/Dynamic.tsx'));
    expect(d.moduleUses).toHaveLength(1);
    expect(d.moduleUses[0]!.member).toBeUndefined();
    expect(d.dynamic.map((x) => x.form).sort()).toEqual(['className template literal', 's[…]']);
  });

  it('clsx, classList, side-effect stylesheet imports, JSX ids', () => {
    const f = parseScript(text('react/App.tsx'));
    expect(f.styleImports.map((s) => s.spec)).toEqual(['./app.css']);
    expect(f.classUses.map((c) => `${c.form}:${c.name}`).sort()).toEqual(['classList.add:shared', 'clsx:active', 'clsx:app']);
    expect(f.idUses.map((i) => i.name)).toEqual(['root']);
  });

  it('does not read `const id = …` or a TS class declaration as markup', () => {
    const f = parseScript("const id = 'x';\nclass Foo {}\nconst className = cond;\n");
    expect(f.idUses).toEqual([]);
    expect(f.classUses).toEqual([]);
  });
});

describe('paths', () => {
  it('joins relative specifiers and refuses URLs, packages and root paths', () => {
    expect(joinSpec('file:///w%3A/a/b/x.css', '../c/y.css', true)).toBe('file:///w%3A/a/c/y.css');
    expect(joinSpec('file:///w%3A/a/x.tsx', 'pkg/y.css', false)).toBeUndefined();
    expect(joinSpec('file:///w%3A/a/x.css', 'https://cdn/x.css', true)).toBeUndefined();
  });
});

describe('relations', () => {
  it('CSS Module member → the rule of the resolved module (proven)', async () => {
    const s = service();
    const t = at('react/Button.tsx', 'styles.root', 'styles.'.length + 1);
    const r = await s.relationsAt(t.uri, t.position);
    expect(r.relations.map((x) => [x.relationKind, x.group, x.confidence, short(x.target.location!.uri), x.target.location!.range.start.line])).toEqual([['css.moduleClass', 'styles', 'proven', 'react/Button.module.css', 0]]);
    const k = at('react/Button.tsx', "styles['primary']", 9);
    expect((await s.relationsAt(k.uri, k.position)).relations.map((x) => x.target.location!.range.start.line)).toEqual([4]);
  });

  it('dynamic styles[name] stays unknown (no relation)', async () => {
    const t = at('react/Dynamic.tsx', 's[name]', 3);
    expect((await service().relationsAt(t.uri, t.position)).relations).toEqual([]);
  });

  it('CSS Module rule → its static users; possibly-unused only without dynamic access', async () => {
    const s = service();
    const t = at('react/Button.module.css', '.root', 2);
    const users = (await s.relationsAt(t.uri, t.position)).relations;
    expect(users.map((x) => [x.relationKind, x.group, x.confidence, short(x.target.location!.uri)])).toEqual([['css.moduleUse', 'usedBy', 'proven', 'react/Button.tsx']]);
    const file = (await s.relationsAt(t.uri, { line: 3, character: 0 })).relations;
    expect(file.filter((x) => x.group === 'unused').map((x) => x.target.label)).toEqual(['.unusedModule — Button.module.css:9, may be used dynamically']);
    expect(file.filter((x) => x.group === 'usedBy').map((x) => x.relationKind)).toEqual(['css.importedBy']);
    const dyn = await s.relationsAt(ROOT + 'react/Dynamic.module.scss', { line: 3, character: 0 });
    expect(dyn.relations.filter((x) => x.group === 'unused')).toEqual([]);
    const a = await s.relationsAt(ROOT + 'react/Dynamic.module.scss', { line: 0, character: 1 });
    expect(a.relations).toEqual([]);
  });

  it('class in HTML → rule in the linked stylesheet (heuristic), inline <style>, and @import closure', async () => {
    const s = service();
    const t = at('plain/index.html', 'class="card', 8);
    const r = (await s.relationsAt(t.uri, t.position)).relations;
    expect(r.map((x) => [x.relationKind, x.group, x.confidence, short(x.target.location!.uri), x.target.location!.range.start.line])).toEqual([
      ['css.rule', 'styles', 'heuristic', 'plain/css/site.css', 3],
      ['css.rule', 'styles', 'heuristic', 'plain/css/site.css', 7],
    ]);
    expect(r[0]!.limitations[0]).toMatch(/^Heuristic/);
    expect(r[0]!.provenance.kind).toBe('heuristic');
    const inline = at('plain/index.html', 'inline-only"', 1);
    expect((await s.relationsAt(inline.uri, inline.position)).relations.map((x) => [short(x.target.location!.uri), x.target.location!.range.start.line])).toEqual([['plain/index.html', 6]]);
    const base = at('plain/index.html', 'class="base"', 8);
    expect((await s.relationsAt(base.uri, base.position)).relations.map((x) => short(x.target.location!.uri))).toEqual(['plain/css/base.css']);
  });

  it('a class defined in two stylesheets and linked from none is ambiguous', async () => {
    const t = at('react/Button.tsx', 'className="shared"', 12);
    const r = (await service().relationsAt(t.uri, t.position)).relations;
    expect(r.map((x) => short(x.target.location!.uri)).sort()).toEqual(['dup/a.css', 'dup/b.css']);
    expect(r.every((x) => x.target.label.endsWith('(ambiguous)'))).toBe(true);
    expect(r[0]!.limitations).toEqual(expect.arrayContaining([expect.stringMatching(/^Ambiguous: 2/), expect.stringMatching(/links no stylesheet/)]));
  });

  it('global rule → its users in HTML and code (heuristic)', async () => {
    const s = service();
    const t = at('plain/css/site.css', '.highlight {', 2);
    const r = (await s.relationsAt(t.uri, t.position)).relations;
    expect(r.map((x) => [x.relationKind, short(x.target.location!.uri), x.target.location!.range.start.line])).toEqual([
      ['css.classUse', 'plain/index.html', 10],
      ['css.classUse', 'plain/index.html', 15],
    ]);
    const id = at('plain/css/site.css', '#main', 1);
    expect((await s.relationsAt(id.uri, id.position)).relations.map((x) => x.relationKind)).toEqual(['css.idUse', 'css.idUse']);
    const shared = await s.relationsAt(ROOT + 'dup/a.css', { line: 0, character: 2 });
    expect(shared.relations.map((x) => short(x.target.location!.uri)).sort()).toEqual(['react/App.tsx', 'react/Button.tsx']);
    const unused = await s.relationsAt(ROOT + 'plain/css/site.css', { line: 0, character: 0 });
    expect(unused.relations.filter((x) => x.group === 'unused').map((x) => x.target.label)).toEqual(['.unused-thing — site.css:17, may be used dynamically']);
  });

  it('clsx and a side-effect import link to the component stylesheet', async () => {
    const t = at('react/App.tsx', "'app'", 2);
    const r = (await service().relationsAt(t.uri, t.position)).relations;
    expect(r.map((x) => [short(x.target.location!.uri), x.limitations.length])).toEqual([['react/app.css', 1]]);
  });

  it('SCSS @use namespace and @import: variable and mixin uses ↔ definitions (proven)', async () => {
    const s = service();
    const v = at('scss/theme.scss', 'v.$primary', 3);
    const def = (await s.relationsAt(v.uri, v.position)).relations;
    expect(def.map((x) => [x.relationKind, x.group, x.confidence, short(x.target.location!.uri), x.target.location!.range.start.line])).toEqual([['css.variable', 'styles', 'proven', 'scss/_vars.scss', 0]]);
    const m = at('scss/legacy.scss', '@include card', 10);
    expect((await s.relationsAt(m.uri, m.position)).relations.map((x) => [x.relationKind, short(x.target.location!.uri)])).toEqual([['css.mixin', 'scss/_vars.scss']]);
    const users = (await s.relationsAt(ROOT + 'scss/_vars.scss', { line: 0, character: 2 })).relations;
    expect(users.map((x) => [x.relationKind, short(x.target.location!.uri)]).sort()).toEqual([
      ['css.variableUse', 'scss/legacy.scss'],
      ['css.variableUse', 'scss/theme.scss'],
    ]);
    const imp = at('scss/theme.scss', "'vars'", 2);
    expect((await s.relationsAt(imp.uri, imp.position)).relations.map((x) => [x.relationKind, short(x.target.location!.uri)])).toEqual([['css.import', 'scss/_vars.scss']]);
  });

  it('an unsaved document text wins over the index', async () => {
    const all = files();
    const s = new WebStyleService({
      files: { listFiles: async () => [...all.keys()], readFile: async (u) => all.get(u) },
      documentText: (u) => (u.endsWith('react/Button.tsx') ? 'import styles from "./Button.module.css";\nstyles.primary;\n' : undefined),
    });
    const r = await s.relationsAt(ROOT + 'react/Button.tsx', { line: 1, character: 9 });
    expect(r.relations.map((x) => x.target.location!.range.start.line)).toEqual([4]);
  });

  it('the index updates incrementally', async () => {
    const s = service();
    await s.index.ensureScanned();
    const v = s.index.version;
    s.index.fileChanged(ROOT + 'dup/b.css', '.other {}');
    expect(s.index.version).toBeGreaterThan(v);
    const t = at('react/Button.tsx', 'className="shared"', 12);
    expect((await s.relationsAt(t.uri, t.position)).relations.map((x) => short(x.target.location!.uri))).toEqual(['dup/a.css']);
    s.index.fileDeleted(ROOT + 'dup/a.css');
    expect((await s.relationsAt(t.uri, t.position)).relations).toEqual([]);
  });
});

describe('route, framework module, Find', () => {
  it('Related on the route; Actions explain why Rename CSS class is unavailable', async () => {
    const s = service();
    let trusted = true;
    const route = new WebStylesLanguageAdapter({ service: s, workspaceId: 'w', isTrusted: () => trusted, revision: () => 3 });
    expect(route.handles(ROOT + 'a.scss')).toBe(true);
    expect(route.handles(ROOT + 'a.tsx')).toBe(false);
    const t = at('plain/css/site.css', '.card', 2);
    const r = await route.related(t);
    expect(r.value.subject?.displayName).toBe('.card');
    expect(r.workspaceRevision).toBe(3);
    expect(r.sessionEpoch).toBe(route.currentEpoch());
    const caps = await route.capabilities(t);
    const rename = caps.value.find((c) => c.capabilityId === 'css.renameClass')!;
    expect(rename.state).toBe('unavailable');
    expect(rename.message).toContain(RENAME_CLASS_UNAVAILABLE);
    const mod = await route.capabilities(at('react/Button.module.css', '.root', 2));
    expect(mod.value.find((c) => c.capabilityId === 'css.renameClass')!.reasonCode).toBe('CssModuleRenameNotSupported');
    trusted = false;
    expect(route.health().state).toBe('TrustRequired');
    await expect(route.related(t)).rejects.toThrow();
  });

  it('the framework module answers on the TS/JS route, also without a language result', async () => {
    const fw = webStylesScriptFramework(service(), ['ts'], () => true);
    const t = at('react/Button.tsx', 'styles.root', 8);
    expect((await fw.relatedWithoutLanguage!(t)).map((x) => x.relationKind)).toEqual(['css.moduleClass']);
    expect(await webStylesScriptFramework(service(), ['ts'], () => false).relatedWithoutLanguage!(t)).toEqual([]);
  });

  it('Find css: lists selectors by name', async () => {
    const r = await service().find('card', 50);
    expect(r.items.map((i) => `${i.label}|${i.kind}|${i.detail}`)).toEqual(['.card|style|.card', '.card|style|.card > .highlight:hover']);
    expect((await service().find('', 500)).items.some((i) => i.label === '#main')).toBe(true);
    expect(parseFindQuery('css:btn')).toMatchObject({ css: true, text: 'btn', errors: [] });
    expect(parseFindQuery('css: type:').errors).toHaveLength(1);
  });

  it('group titles and order', () => {
    expect(RELATION_GROUP_ORDER.indexOf('styles')).toBeLessThan(RELATION_GROUP_ORDER.indexOf('usedBy'));
    expect(relationGroupTitle('usedBy')).toBe('Used by');
    expect(relationGroupTitle('unused')).toBe('Possibly unused');
    expect(relationGroupTitle('styles')).toBe('Styles');
  });
});
