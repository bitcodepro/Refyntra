// C# live templates: the definitions (snippets/csharp.json, VS Code snippet syntax) and when they are offered.

export interface LiveTemplate {
  name: string;
  prefix: string;
  description: string;
  body: string;
}

/** Parses the snippet file ({ name: { prefix, description, body: string | string[] } }); invalid entries are skipped. */
export function parseTemplates(json: string): LiveTemplate[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const out: LiveTemplate[] = [];
  for (const [name, v] of Object.entries(data as Record<string, unknown>)) {
    const t = v as { prefix?: unknown; description?: unknown; body?: unknown };
    if (typeof t?.prefix !== 'string' || !t.prefix) continue;
    const body = Array.isArray(t.body) ? t.body.filter((x): x is string => typeof x === 'string').join('\n') : typeof t.body === 'string' ? t.body : undefined;
    if (body === undefined) continue;
    out.push({ name, prefix: t.prefix, description: typeof t.description === 'string' ? t.description : name, body });
  }
  return out;
}

/**
 * Whether templates are offered at this point of the line: the word being typed starts the template prefix, and the
 * cursor is not after a member access (`x.`, where postfix templates apply) nor inside a string or a line comment.
 */
export function offerAt(lineBeforeCursor: string): { word: string } | undefined {
  const m = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(lineBeforeCursor);
  const word = m?.[1] ?? '';
  const before = lineBeforeCursor.slice(0, lineBeforeCursor.length - word.length);
  if (/\.\s*$/.test(before)) return undefined;
  let inString = false;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (!inString && ch === '/' && before[i + 1] === '/') return undefined;
    if (ch === '"' && before[i - 1] !== '\\') inString = !inString;
  }
  if (inString) return undefined;
  return { word };
}

/** A shown, plain-text form of a snippet body: placeholders replaced by their default text. */
export function previewBody(body: string): string {
  let out = body.replace(/\$\{TM_FILENAME_BASE\}/g, 'FileName');
  for (let i = 0; i < 5; i++) out = out.replace(/\$\{\d+:([^{}]*)\}/g, '$1').replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, '$1');
  return out.replace(/\$\{TM_FILENAME_BASE\}/g, 'FileName').replace(/\$\d+/g, '').replace(/\t/g, '    ');
}
