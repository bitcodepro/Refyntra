// Related view presentation: icons per relation kind and group, header message. Pure: unit-tested with vitest.

/** Codicon id per relation kind (namespaced framework kinds fall back to their namespace, then a generic arrow). */
const KIND_ICON: Readonly<Record<string, string>> = {
  declaration: 'symbol-field',
  'mediatr.handler': 'symbol-event',
  'mediatr.notificationHandler': 'symbol-event',
  'mediatr.request': 'mail',
  'mediatr.response': 'reply',
  'mediatr.send': 'send',
  'mediatr.behavior': 'layers',
  'handler.handler': 'symbol-event',
  'handler.request': 'mail',
  'handler.dispatch': 'send',
  'aspnet.endpoint': 'globe',
  'di.registration': 'plug',
  'di.implementation': 'plug',
  'di.service': 'plug',
  'di.openGenericUsage': 'plug',
  'efcore.entity': 'database',
  'efcore.dbContext': 'database',
  'efcore.configuration': 'database',
  'efcore.navigation': 'database',
  'efcore.table': 'database',
  'efcore.query': 'database',
  'efcore.migration': 'database',
  implementation: 'symbol-class',
  reference: 'references',
  test: 'beaker',
};

const NAMESPACE_ICON: Readonly<Record<string, string>> = { mediatr: 'symbol-event', aspnet: 'globe', di: 'plug', efcore: 'database', http: 'cloud', css: 'symbol-color', web: 'browser', fixture: 'symbol-misc' };

/** Codicon per group (the group row). */
const GROUP_ICON: Readonly<Record<string, string>> = {
  declarations: 'symbol-field',
  handlers: 'symbol-event',
  callers: 'call-incoming',
  clients: 'cloud',
  endpoints: 'globe',
  data: 'database',
  styles: 'symbol-color',
  usedBy: 'references',
  registrations: 'plug',
  implementations: 'symbol-class',
  references: 'references',
  tests: 'beaker',
  unused: 'circle-slash',
};

export function relationIcon(kind: string, group?: string): string {
  if (KIND_ICON[kind]) return KIND_ICON[kind]!;
  if (group === 'clients') return 'cloud';
  const ns = kind.includes('.') ? kind.slice(0, kind.indexOf('.')) : undefined;
  if (ns && NAMESPACE_ICON[ns]) return NAMESPACE_ICON[ns]!;
  return group && GROUP_ICON[group] ? GROUP_ICON[group]! : 'arrow-right';
}

export function groupIcon(group: string): string {
  return GROUP_ICON[group] ?? 'list-tree';
}

/** The view message above the tree: which symbol is shown and whether the view follows the cursor. */
export function relatedHeader(subject: string | undefined, pinned: boolean, followCursor: boolean): string | undefined {
  if (!subject) return pinned ? 'Pinned — nothing shown yet.' : undefined;
  if (pinned) return `Related to ${subject} — pinned (does not follow the cursor)`;
  return followCursor ? `Related to ${subject} — follows the cursor` : `Related to ${subject}`;
}

/** One preview line for the tooltip: trimmed, shortened to `max` characters. */
export function previewLine(text: string | undefined, max = 160): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Highlighting language of a file for the tooltip code block. */
export function languageOfUri(uri: string): string {
  const ext = uri.slice(uri.lastIndexOf('.') + 1).toLowerCase();
  return ({ cs: 'csharp', ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', rs: 'rust', css: 'css', scss: 'scss', less: 'less', html: 'html' } as Record<string, string>)[ext] ?? '';
}
