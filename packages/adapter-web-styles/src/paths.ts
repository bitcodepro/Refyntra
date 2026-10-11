// URI arithmetic for import specifiers (no node:path: the package stays platform-free). Workspace URIs are `file:`
// URIs as the editor prints them; comparisons use a decoded, lower-cased key (Windows paths are case-insensitive and
// the editor encodes the drive colon).

export function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function uriKey(uri: string): string {
  return decodeSafe(uri).toLowerCase();
}

export function baseName(uri: string): string {
  return decodeSafe(uri.slice(uri.lastIndexOf('/') + 1));
}

function dirOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/') + 1);
}

/**
 * Joins a relative specifier to the folder of `from`. Returns undefined for URLs (`https:`, `data:`, `//cdn`), package
 * specifiers (when `bareIsRelative` is false) and root-relative paths (`/css/site.css`, resolved by suffix elsewhere).
 */
export function joinSpec(from: string, spec: string, bareIsRelative: boolean): string | undefined {
  const clean = spec.split(/[?#]/)[0]!.trim();
  if (!clean || /^[a-z][\w+.-]*:/i.test(clean) || clean.startsWith('//') || clean.startsWith('/') || clean.startsWith('~')) return undefined;
  if (!clean.startsWith('.') && !bareIsRelative) return undefined;
  const scheme = /^([a-z][\w+.-]*:\/\/[^/]*)/i.exec(from)?.[1] ?? '';
  const parts = dirOf(from).slice(scheme.length).split('/').filter((p, i) => p !== '' || i === 0);
  if (parts[parts.length - 1] === '') parts.pop();
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(encodeURIComponent(decodeSafe(seg)));
  }
  return scheme + parts.join('/');
}

/** Candidate files of a stylesheet import (`@use 'vars'` → vars.scss, _vars.scss, vars/_index.scss, …). */
export function styleImportCandidates(joined: string): string[] {
  const slash = joined.lastIndexOf('/');
  const dir = joined.slice(0, slash + 1);
  const name = joined.slice(slash + 1);
  const out = [joined];
  if (!/\.(css|scss|less)$/i.test(name)) {
    for (const ext of ['.scss', '.css', '.less']) out.push(joined + ext, `${dir}_${name}${ext}`);
    for (const ix of ['_index.scss', 'index.scss', '_index.css', 'index.css']) out.push(`${joined}/${ix}`);
  } else if (!name.startsWith('_')) out.push(`${dir}_${name}`);
  return out;
}
