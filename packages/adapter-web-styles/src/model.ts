import type { Range } from '@refyntra/contracts';

// Facts extracted from one file. Pure data: produced by the parsers (stylesheet.ts, html.ts, script.ts) and combined by
// the index (webStyles.ts). Ranges are 0-based line/character (UTF-16), like every Refyntra location.

export type StyleLanguage = 'css' | 'scss' | 'less';

/** A class or id selector inside a rule's selector. */
export interface SelectorName {
  name: string;
  /** The name itself, without the leading `.` or `#`. */
  range: Range;
  /** The whole selector text it appeared in, e.g. ".card > .title:hover". */
  selector: string;
  /** Derived from a SCSS/LESS parent suffix (`&-large` under `.btn` → `btn-large`). */
  derived?: boolean;
}

export interface NamedDefinition {
  name: string;
  range: Range;
}

export interface NamedUse {
  name: string;
  /** SCSS module namespace (`v.$x`, `@include v.m`), absent for unqualified uses. */
  namespace?: string;
  range: Range;
}

export interface StyleImport {
  /** The import text as written (`'./vars'`, `"theme.css"`). */
  spec: string;
  range: Range;
  /** `@use 'x' as y`: the namespace (default: the file name without `_` and extension); `*` for `as *`. Absent for @import. */
  namespace?: string;
}

export interface StylesheetFacts {
  kind: 'stylesheet';
  language: StyleLanguage;
  /** `*.module.css|scss|less`: class names are locally scoped and reached through the imported object. */
  isModule: boolean;
  classes: SelectorName[];
  ids: SelectorName[];
  imports: StyleImport[];
  variables: NamedDefinition[];
  mixins: NamedDefinition[];
  variableUses: NamedUse[];
  mixinUses: NamedUse[];
}

/** A class/id token used from markup or script. */
export interface NameUse {
  name: string;
  range: Range;
  /** How it was written, e.g. `class="…"`, `className="…"`, `classList.add`, `clsx`, `getElementById`. */
  form: string;
}

/** A class string that cannot be read statically (template literal, expression). */
export interface DynamicUse {
  form: string;
  range: Range;
}

export interface HtmlFacts {
  kind: 'html';
  classUses: NameUse[];
  idUses: NameUse[];
  /** `<link rel="stylesheet" href="…">`. */
  links: StyleImport[];
  /** `<style>` blocks of the page, parsed as CSS (ranges are in the HTML document). */
  inline: StylesheetFacts[];
  dynamic: DynamicUse[];
}

/** `import styles from './x.module.css'` (also `import * as styles`, `const styles = require(…)`). */
export interface ModuleImport {
  alias: string;
  spec: string;
  range: Range;
}

/** `styles.foo`, `styles['foo']` (static) or `styles[expr]` (dynamic: member undefined). */
export interface ModuleMemberUse {
  alias: string;
  member?: string;
  range: Range;
}

export interface ScriptFacts {
  kind: 'script';
  moduleImports: ModuleImport[];
  moduleUses: ModuleMemberUse[];
  /** Side-effect stylesheet imports (`import './app.css'`): the stylesheets of this component. */
  styleImports: StyleImport[];
  classUses: NameUse[];
  idUses: NameUse[];
  dynamic: DynamicUse[];
}

export type FileFacts = StylesheetFacts | HtmlFacts | ScriptFacts;

export function inRange(r: Range, line: number, character: number): boolean {
  if (line < r.start.line || line > r.end.line) return false;
  if (line === r.start.line && character < r.start.character) return false;
  if (line === r.end.line && character > r.end.character) return false;
  return true;
}
