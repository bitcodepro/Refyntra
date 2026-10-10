import type { SearchFilters } from '@refyntra/contracts';

export interface ParsedFindQuery {
  /** Free text left after removing filters. */
  text: string;
  filters: SearchFilters;
  /** User-facing problems (e.g. "type: and member: cannot be combined"). */
  errors: string[];
}

/** Only filters that are actually implemented. Shown as the QuickPick hint. */
export const FIND_FILTER_HINT = 'Filters: type:  member:  project:NAME  route:/path  method:GET';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Splits on whitespace, keeping `key:"quoted value"` together. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /(\S+?:"[^"]*"?|"[^"]*"?|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) tokens.push(m[1]!);
  return tokens;
}

function unquote(v: string): string {
  return v.replace(/^"/, '').replace(/"$/, '');
}

/**
 * Parses `type:`, `member:`, `project:NAME`, `route:TEXT`, `method:VERB`. `type:Foo` is `type:` plus the text
 * "Foo". Unknown `x:y` tokens stay as text (C# `global::` etc.).
 */
export function parseFindQuery(input: string): ParsedFindQuery {
  const filters: SearchFilters = {};
  const errors: string[] = [];
  const text: string[] = [];
  for (const token of tokenize(input)) {
    const m = /^(type|member|project|route|method):(.*)$/i.exec(token);
    if (!m) {
      text.push(unquote(token));
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = unquote(m[2] ?? '');
    switch (key) {
      case 'type':
        filters.type = true;
        if (value) text.push(value);
        break;
      case 'member':
        filters.member = true;
        if (value) text.push(value);
        break;
      case 'project':
        if (value) filters.project = value;
        else errors.push('project: needs a project name, e.g. project:Shop.Api');
        break;
      case 'route':
        filters.route = value;
        break;
      case 'method': {
        const verb = value.toUpperCase();
        if (!verb) errors.push('method: needs an HTTP method, e.g. method:GET');
        else if (!HTTP_METHODS.has(verb)) errors.push(`Unknown HTTP method "${value}"`);
        else filters.method = verb;
        break;
      }
    }
  }
  if (filters.type && filters.member) errors.push('type: and member: cannot be combined');
  if ((filters.route !== undefined || filters.method) && (filters.type || filters.member)) errors.push('route:/method: search endpoints and cannot be combined with type:/member:');
  return { text: text.join(' ').trim(), filters, errors };
}

export function hasAnyFilter(f: SearchFilters): boolean {
  return !!(f.type || f.member || f.project || f.route !== undefined || f.method);
}
