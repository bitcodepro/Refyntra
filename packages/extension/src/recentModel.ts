// Recent Files (Ctrl+E) and Recent Locations (Ctrl+Shift+E), Rider-style: ordering, dedupe, persistence and
// re-anchoring of stored positions when a document changes. Pure: unit-tested with vitest (no vscode).

/** At most this many entries are kept per list (workspaceState stays small). */
export const RECENT_LIMIT = 50;
export const RECENT_FILES_KEY = 'refyntra.recentFiles';
export const RECENT_LOCATIONS_KEY = 'refyntra.recentLocations';
export const RECENT_STORE_VERSION = 1;
/** A cursor that rests this long becomes a visited location. */
export const VISIT_REST_MS = 1500;

// ---- Recent Files ------------------------------------------------------------------------------------------------

/** The file becomes the most recent one (moved to the front, never twice). */
export function touchFile(list: readonly string[], uri: string, limit = RECENT_LIMIT): string[] {
  return [uri, ...list.filter((u) => u !== uri)].slice(0, limit);
}

export function removeFile(list: readonly string[], uri: string): string[] {
  return list.filter((u) => u !== uri);
}

/** A renamed file or folder keeps its place (folder: every file under it). */
export function renameUri(uri: string, oldUri: string, newUri: string): string {
  if (uri === oldUri) return newUri;
  const prefix = oldUri.endsWith('/') ? oldUri : `${oldUri}/`;
  return uri.startsWith(prefix) ? `${newUri.replace(/\/$/, '')}/${uri.slice(prefix.length)}` : uri;
}

export function renameFiles(list: readonly string[], oldUri: string, newUri: string): string[] {
  return dedupeStrings(list.map((u) => renameUri(u, oldUri, newUri)));
}

/** Files deleted (or a deleted folder) leave the list. */
export function deleteFiles(list: readonly string[], deleted: string): string[] {
  const prefix = deleted.endsWith('/') ? deleted : `${deleted}/`;
  return list.filter((u) => u !== deleted && !u.startsWith(prefix));
}

function dedupeStrings(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/**
 * The order the Recent Files list shows: most recent first, open editors not yet recorded after them, and the current
 * file second from the top (like Rider), so Enter on the first row switches back to the previous file.
 */
export function recentFileOrder(list: readonly string[], currentUri: string | undefined, openUris: readonly string[] = []): string[] {
  const all = dedupeStrings([...list, ...openUris]);
  if (!currentUri || !all.includes(currentUri)) return all;
  const others = all.filter((u) => u !== currentUri);
  if (others.length === 0) return [currentUri];
  return [others[0]!, currentUri, ...others.slice(1)];
}

// ---- Recent Locations --------------------------------------------------------------------------------------------

export type LocationKind = 'edited' | 'visited';

export interface RecentLocation {
  uri: string;
  /** 0-based. */
  line: number;
  character: number;
  kind: LocationKind;
  /** The code line (for edits: the edited line) when the location was recorded or last re-anchored. */
  lineText: string;
  /** Milliseconds since the epoch. */
  time: number;
}

export const locationId = (l: Pick<RecentLocation, 'uri' | 'line'>): string => `${l.uri}#${l.line}`;

/**
 * Records a location at the front. One entry per line: the same line replaces the older entry; an edited line stays
 * "edited" when it is visited again.
 */
export function recordLocation(list: readonly RecentLocation[], loc: RecentLocation, limit = RECENT_LIMIT): RecentLocation[] {
  const old = list.find((l) => l.uri === loc.uri && l.line === loc.line);
  const kind: LocationKind = old?.kind === 'edited' || loc.kind === 'edited' ? 'edited' : 'visited';
  return [{ ...loc, kind }, ...list.filter((l) => l !== old)].slice(0, limit);
}

export function removeLocation(list: readonly RecentLocation[], id: string): RecentLocation[] {
  return list.filter((l) => locationId(l) !== id);
}

/** One text change as VS Code reports it: the replaced range (old coordinates) and the shape of the inserted text. */
export interface LineChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  /** Line breaks in the inserted text. */
  insertedLines: number;
  /** Length of the inserted text after its last line break (or the whole text without one). */
  insertedLastLineLength: number;
}

/** The inserted text's shape (for LineChange). */
export function insertedShape(text: string): { insertedLines: number; insertedLastLineLength: number } {
  const parts = text.split(/\r\n|\r|\n/);
  return { insertedLines: parts.length - 1, insertedLastLineLength: parts[parts.length - 1]!.length };
}

/**
 * Re-anchors one location after a change in its document; undefined when its line was deleted. Lines after the change
 * shift; a line inside the replaced range is gone; whole lines replaced (from column 0 to column 0) are gone too.
 */
export function reanchor(loc: RecentLocation, c: LineChange): RecentLocation | undefined {
  const L = loc.line;
  if (L < c.startLine) return loc;
  const removed = c.endLine - c.startLine;
  if (L > c.endLine) return { ...loc, line: L + c.insertedLines - removed };
  if (removed === 0) {
    // Same line edited: the line stays; a cursor after the change moves with it.
    if (loc.character >= c.endCharacter && L === c.startLine) {
      const delta = c.insertedLines === 0 ? c.insertedLastLineLength - (c.endCharacter - c.startCharacter) : 0;
      return c.insertedLines === 0 ? { ...loc, character: Math.max(0, loc.character + delta) } : { ...loc, line: L + c.insertedLines, character: c.insertedLastLineLength + (loc.character - c.endCharacter) };
    }
    return loc;
  }
  const wholeLines = c.startCharacter === 0 && c.endCharacter === 0 && c.insertedLastLineLength === 0;
  if (L === c.startLine) return wholeLines ? undefined : loc;
  if (L < c.endLine) return undefined;
  // L === endLine: the rest of the line after the replaced range survives, joined to the inserted text.
  if (wholeLines) return { ...loc, line: c.startLine + c.insertedLines };
  if (loc.character >= c.endCharacter) {
    const base = c.insertedLines === 0 ? c.startCharacter + c.insertedLastLineLength : c.insertedLastLineLength;
    return { ...loc, line: c.startLine + c.insertedLines, character: base + (loc.character - c.endCharacter) };
  }
  return undefined;
}

/**
 * Applies the changes of one document change event (VS Code reports them in the coordinates of the document before
 * the event, non-overlapping) to every location of that document. Locations that land on the same line are merged.
 */
export function applyChanges(list: readonly RecentLocation[], uri: string, changes: readonly LineChange[]): RecentLocation[] {
  const sorted = [...changes].sort((a, b) => b.startLine - a.startLine || b.startCharacter - a.startCharacter);
  const out: RecentLocation[] = [];
  for (const l of list) {
    if (l.uri !== uri) {
      out.push(l);
      continue;
    }
    let cur: RecentLocation | undefined = l;
    for (const c of sorted) {
      cur = reanchor(cur, c);
      if (!cur) break;
    }
    if (cur) out.push(cur);
  }
  return mergeSameLine(out);
}

/** Keeps the first (most recent) entry of each line; "edited" wins when a merged entry was edited. */
function mergeSameLine(list: readonly RecentLocation[]): RecentLocation[] {
  const byId = new Map<string, RecentLocation>();
  const order: string[] = [];
  for (const l of list) {
    const id = locationId(l);
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, l);
      order.push(id);
    } else if (l.kind === 'edited' && prev.kind !== 'edited') byId.set(id, { ...prev, kind: 'edited' });
  }
  return order.map((id) => byId.get(id)!);
}

export function renameLocations(list: readonly RecentLocation[], oldUri: string, newUri: string): RecentLocation[] {
  return mergeSameLine(list.map((l) => ({ ...l, uri: renameUri(l.uri, oldUri, newUri) })));
}

export function deleteLocations(list: readonly RecentLocation[], deleted: string): RecentLocation[] {
  const prefix = deleted.endsWith('/') ? deleted : `${deleted}/`;
  return list.filter((l) => l.uri !== deleted && !l.uri.startsWith(prefix));
}

/** Refreshes the stored code line of every location of a document (after re-anchoring). */
export function refreshLineTexts(list: readonly RecentLocation[], uri: string, lineAt: (line: number) => string | undefined): RecentLocation[] {
  return list.map((l) => {
    if (l.uri !== uri) return l;
    const t = lineAt(l.line);
    return t === undefined || t === l.lineText ? l : { ...l, lineText: t };
  });
}

export type LocationsMode = 'all' | 'edited';

export interface LocationSection {
  title: 'Edited' | 'Visited';
  items: RecentLocation[];
}

/** The sections the list shows: Edited then Visited (most recent first in each); only Edited in the "edited" mode. */
export function locationSections(list: readonly RecentLocation[], mode: LocationsMode): LocationSection[] {
  const edited = list.filter((l) => l.kind === 'edited');
  const visited = list.filter((l) => l.kind === 'visited');
  const out: LocationSection[] = [];
  if (edited.length) out.push({ title: 'Edited', items: edited });
  if (mode === 'all' && visited.length) out.push({ title: 'Visited', items: visited });
  return out;
}

// ---- Persistence -------------------------------------------------------------------------------------------------

export interface RecentFilesStore {
  version: number;
  files: string[];
}

export interface RecentLocationsStore {
  version: number;
  items: RecentLocation[];
}

/** A stored value read back: invalid entries dropped, duplicates removed, the limit applied. */
export function loadFiles(value: unknown): string[] {
  const v = value as Partial<RecentFilesStore> | undefined;
  if (!v || typeof v !== 'object' || v.version !== RECENT_STORE_VERSION || !Array.isArray(v.files)) return [];
  return dedupeStrings(v.files.filter((f): f is string => typeof f === 'string' && f.length > 0)).slice(0, RECENT_LIMIT);
}

export function loadLocations(value: unknown): RecentLocation[] {
  const v = value as Partial<RecentLocationsStore> | undefined;
  if (!v || typeof v !== 'object' || v.version !== RECENT_STORE_VERSION || !Array.isArray(v.items)) return [];
  const ok = v.items.filter(
    (l): l is RecentLocation =>
      !!l &&
      typeof l.uri === 'string' &&
      Number.isInteger(l.line) &&
      l.line >= 0 &&
      Number.isInteger(l.character) &&
      l.character >= 0 &&
      (l.kind === 'edited' || l.kind === 'visited') &&
      typeof l.lineText === 'string' &&
      typeof l.time === 'number',
  );
  return mergeSameLine(ok.map((l) => ({ uri: l.uri, line: l.line, character: l.character, kind: l.kind, lineText: l.lineText.slice(0, 500), time: l.time }))).slice(0, RECENT_LIMIT);
}

export const filesStore = (files: readonly string[]): RecentFilesStore => ({ version: RECENT_STORE_VERSION, files: [...files] });
export const locationsStore = (items: readonly RecentLocation[]): RecentLocationsStore => ({ version: RECENT_STORE_VERSION, items: [...items] });

// ---- Presentation ------------------------------------------------------------------------------------------------

/** Path of a file relative to the workspace folder that contains it (or the full path outside every folder). */
export function relativePath(uri: string, folders: readonly string[]): string {
  for (const f of folders) {
    const prefix = f.endsWith('/') ? f : `${f}/`;
    if (uri.startsWith(prefix)) return decodeURIComponent(uri.slice(prefix.length));
  }
  return decodeURIComponent(uri.replace(/^[a-z-]+:\/\//, ''));
}

export function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

export function folderOf(relative: string): string {
  const i = relative.lastIndexOf('/');
  return i > 0 ? relative.slice(0, i) : '';
}

/** A document symbol reduced to what the containing member needs. */
export interface SymbolSpan {
  name: string;
  /** VS Code SymbolKind number. */
  kind: number;
  startLine: number;
  endLine: number;
  children: readonly SymbolSpan[];
}

// SymbolKind: File 0, Module 1, Namespace 2, Package 3 — containers that are not part of a member name.
const NAMESPACE_KINDS = new Set([0, 1, 2, 3]);

/** "OrderService.Find": the type and member chain around a line, from document symbols (namespaces left out). */
export function memberFromSymbols(symbols: readonly SymbolSpan[], line: number): string | undefined {
  const chain: string[] = [];
  let level: readonly SymbolSpan[] = symbols;
  for (;;) {
    const hit = level.find((s) => s.startLine <= line && line <= s.endLine);
    if (!hit) break;
    if (!NAMESPACE_KINDS.has(hit.kind)) chain.push(hit.name.replace(/\(.*$/, ''));
    level = hit.children;
  }
  return chain.length ? chain.join('.') : undefined;
}

const NOT_MEMBERS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'fixed', 'checked', 'unchecked', 'else', 'do', 'try', 'finally', 'get', 'set', 'init', 'add', 'remove', 'nameof', 'typeof', 'sizeof', 'default', 'when', 'await', 'throw', 'base', 'this', 'var', 'in', 'is', 'as', 'out', 'ref', 'yield', 'not', 'and', 'or', 'with']);

/** Strings and comments blanked (a rough scan: enough for braces and names on one line). */
function codeOnly(text: string): string {
  return text
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/@?\$?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "''");
}

/** The name a line declares (type, method, property, function), or undefined. */
export function declaredName(line: string): string | undefined {
  const t = codeOnly(line);
  const type = /\b(?:class|struct|interface|record|enum)\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)/.exec(t);
  if (type) return type[1];
  if (/^\s*namespace\b/.test(t)) return undefined;
  const fn = /\b(?:function|def|fn)\s+([A-Za-z_]\w*)/.exec(t);
  if (fn) return fn[1];
  if (/^\s*(?:return|await|throw|var|if|for|foreach|while|using|else)\b/.test(t)) return undefined;
  const method = /[\w>\]?)]\s+(?:operator\s*\S+|([A-Za-z_]\w*))\s*(?:<(?:[^()\s]|,\s)*>)?\s*\(/.exec(t);
  if (method && method[1] && !NOT_MEMBERS.has(method[1]) && !/[=]\s*(?:new\s+)?[\w.<>]*\s*$/.test(t.slice(0, method.index + 1))) return method[1];
  const ctor = /^\s*(?:(?:public|private|protected|internal|static)\s+)+([A-Za-z_]\w*)\s*\(/.exec(t);
  if (ctor) return ctor[1];
  const prop = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|required|readonly|new|partial)\s+)+[\w.<>,?[\]\s]+?\s([A-Za-z_]\w*)\s*(?:\{|=>|$)/.exec(t);
  if (prop && !NOT_MEMBERS.has(prop[1]!)) return prop[1];
  const field = /^\s*(?:(?:public|private|protected|internal|static|readonly|const|volatile|new|required)\s+)+[\w.<>,?[\]\s]+?\s([A-Za-z_]\w*)\s*(?:=|;)/.exec(t);
  if (field && !NOT_MEMBERS.has(field[1]!)) return field[1];
  return undefined;
}

/**
 * Fallback when a language has no document symbols (C# without a C# extension): the declarations whose braces
 * enclose the line, found by scanning upwards and counting braces. A heuristic; the member list of File Structure
 * comes from the host instead.
 */
export function memberFromText(lines: readonly string[], line: number): string | undefined {
  const chain: string[] = [];
  const own = lines[line] !== undefined ? declaredName(lines[line]!) : undefined;
  let depth = 0;
  for (let i = line; i >= 0; i--) {
    const text = codeOnly(lines[i] ?? '');
    const upto = text;
    for (let k = upto.length - 1; k >= 0; k--) {
      const ch = upto[k];
      // A closing brace on the line itself ends the block the line belongs to: it does not leave it.
      if (ch === '}') depth += i === line ? 0 : 1;
      else if (ch === '{') {
        if (depth > 0) {
          depth--;
          continue;
        }
        const before = upto.slice(0, k);
        let name = declaredName(before);
        if (!name && before.trim() === '') {
          for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
            const prev = codeOnly(lines[j] ?? '');
            if (prev.trim() === '' || /^\s*\[/.test(prev)) continue;
            name = /[;{}]\s*$/.test(prev) ? undefined : declaredName(prev);
            break;
          }
        }
        if (name && chain[0] !== name) chain.unshift(name);
      }
    }
  }
  if (own && chain[chain.length - 1] !== own && !/\{/.test(codeOnly(lines[line] ?? ''))) chain.push(own);
  return chain.length ? chain.join('.') : undefined;
}
