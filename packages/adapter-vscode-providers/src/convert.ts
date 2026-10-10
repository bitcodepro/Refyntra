import type { Location, Range, SymbolKind, TextEditDto } from '@refyntra/contracts';

// Structural readers for provider results. Provider output is untrusted: anything malformed is dropped
// (navigation) or refused (rename), never guessed.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** The string form of a vscode.Uri (or a plain string); undefined when the value is not a URI. */
export function uriString(u: unknown): string | undefined {
  if (typeof u === 'string') return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : undefined;
  if (!isObj(u) || typeof u.scheme !== 'string' || typeof u.toString !== 'function') return undefined;
  const s = String(u);
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : undefined;
}

export function schemeOf(uri: string): string {
  const i = uri.indexOf(':');
  return i > 0 ? uri.slice(0, i).toLowerCase() : '';
}

const isCoord = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

function readPosition(p: unknown): { line: number; character: number } | undefined {
  if (!isObj(p) || !isCoord(p.line) || !isCoord(p.character)) return undefined;
  return { line: p.line, character: p.character };
}

export function readRange(r: unknown): Range | undefined {
  if (!isObj(r)) return undefined;
  const start = readPosition(r.start);
  const end = readPosition(r.end);
  if (!start || !end) return undefined;
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) return undefined;
  return { start, end };
}

/** vscode.Location or vscode.LocationLink (the target selection range is the name of the declaration). */
export function readLocation(v: unknown): Location | undefined {
  if (!isObj(v)) return undefined;
  if (v.targetUri !== undefined) {
    const uri = uriString(v.targetUri);
    const range = readRange(v.targetSelectionRange) ?? readRange(v.targetRange);
    return uri && range ? { uri, range } : undefined;
  }
  const uri = uriString(v.uri);
  const range = readRange(v.range);
  return uri && range ? { uri, range } : undefined;
}

/** undefined: the provider dispatch returned no list at all (typically: no provider). */
export function readLocations(v: unknown): Location[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  return list.map(readLocation).filter((l): l is Location => !!l);
}

/** vscode.SymbolKind (0-based enum values of the public API) → contract SymbolKind. */
export function mapSymbolKind(kind: unknown): SymbolKind {
  switch (kind) {
    case 1:
    case 2:
    case 3:
      return 'namespace';
    case 4:
      return 'class';
    case 5:
    case 11:
    case 24:
      return 'method';
    case 6:
      return 'property';
    case 7:
    case 21:
      return 'field';
    case 8:
      return 'constructor';
    case 9:
      return 'enum';
    case 10:
      return 'interface';
    case 22:
      return 'struct';
    case 23:
      return 'event';
    default:
      return 'other';
  }
}

/** vscode.SymbolKind: Class, Enum, Interface, Struct. */
const TYPE_VS_KINDS: ReadonlySet<number> = new Set([4, 9, 10, 22]);
/** vscode.SymbolKind: Method, Property, Field, Constructor, EnumMember, Event (a top-level function is not a member). */
const MEMBER_VS_KINDS: ReadonlySet<number> = new Set([5, 6, 7, 8, 21, 23]);
export const isTypeSymbol = (s: ProviderSymbol) => TYPE_VS_KINDS.has(s.vsKind);
export const isMemberSymbol = (s: ProviderSymbol) => MEMBER_VS_KINDS.has(s.vsKind);

export interface ProviderSymbol {
  name: string;
  kind: SymbolKind;
  /** The provider's vscode.SymbolKind value. */
  vsKind: number;
  containerName?: string;
  /** Declaration name location. */
  location: Location;
  /** Full extent of the declaration (equal to the name range for SymbolInformation). */
  extent: Range;
}

/** vscode.SymbolInformation[] (workspace symbols). undefined: no list returned. */
export function readWorkspaceSymbols(v: unknown): ProviderSymbol[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return [];
  const out: ProviderSymbol[] = [];
  for (const s of v) {
    if (!isObj(s) || typeof s.name !== 'string' || s.name.length === 0) continue;
    const location = readLocation(s.location);
    if (!location) continue;
    // The TypeScript extension shows functions and methods as "name()" in workspace symbols.
    const name = s.name.length > 2 && s.name.endsWith('()') ? s.name.slice(0, -2) : s.name;
    out.push({ name, kind: mapSymbolKind(s.kind), vsKind: typeof s.kind === 'number' ? s.kind : -1, ...(typeof s.containerName === 'string' && s.containerName ? { containerName: s.containerName } : {}), location, extent: location.range });
  }
  return out;
}

/**
 * vscode.DocumentSymbol[] (hierarchical, flattened with container names) or SymbolInformation[]. undefined: no list
 * returned (typically: no provider for the document).
 */
export function readDocumentSymbols(v: unknown, uri: string): ProviderSymbol[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return [];
  const out: ProviderSymbol[] = [];
  const visit = (s: unknown, container: string | undefined, depth: number) => {
    if (!isObj(s) || typeof s.name !== 'string' || s.name.length === 0 || depth > 64) return;
    if (s.location !== undefined) {
      const location = readLocation(s.location);
      if (location) out.push({ name: s.name, kind: mapSymbolKind(s.kind), vsKind: typeof s.kind === 'number' ? s.kind : -1, ...(typeof s.containerName === 'string' && s.containerName ? { containerName: s.containerName } : {}), location, extent: location.range });
      return;
    }
    const extent = readRange(s.range);
    const selection = readRange(s.selectionRange) ?? extent;
    if (!extent || !selection) return;
    out.push({ name: s.name, kind: mapSymbolKind(s.kind), vsKind: typeof s.kind === 'number' ? s.kind : -1, ...(container ? { containerName: container } : {}), location: { uri, range: selection }, extent });
    if (Array.isArray(s.children)) for (const c of s.children) visit(c, container ? `${container}.${s.name}` : s.name, depth + 1);
  };
  for (const s of v) visit(s, undefined, 0);
  return out;
}

export interface ProviderTextChange {
  uri: string;
  edits: TextEditDto[];
}

export type EditReadResult =
  | { ok: true; changes: ProviderTextChange[] }
  | { ok: false; reasonCode: 'OpaqueEdit' | 'ResourceOperation' | 'NonFileTarget'; message: string; uri?: string };

/**
 * Reads a vscode.WorkspaceEdit through its public surface only (`entries()`, `size`). Refused: anything that is not a
 * plain text edit on a file: URI (snippet edits, end-of-line changes, unreadable entries), and any resource that
 * `size` counts but `entries()` does not list (a file create/rename/delete or another non-text operation).
 */
export function readWorkspaceEdit(v: unknown): EditReadResult {
  const opaque = (message: string, uri?: string): EditReadResult => ({ ok: false, reasonCode: 'OpaqueEdit', message, ...(uri ? { uri } : {}) });
  if (!isObj(v) || typeof v.entries !== 'function') return opaque('The provider returned an edit whose changes cannot be read through the public API.');
  let entries: unknown;
  try {
    entries = (v.entries as () => unknown)();
  } catch {
    return opaque('The provider returned an edit whose changes cannot be read through the public API.');
  }
  if (!Array.isArray(entries)) return opaque('The provider returned an edit whose changes cannot be read through the public API.');
  if (typeof v.size === 'number' && v.size !== entries.length) {
    return { ok: false, reasonCode: 'ResourceOperation', message: 'The provider edit contains file operations (create, rename or delete) besides text edits.' };
  }
  const byUri = new Map<string, TextEditDto[]>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) return opaque('The provider edit contains an entry that is not a text edit list.');
    const uri = uriString(entry[0]);
    if (!uri) return opaque('The provider edit targets a resource without a readable URI.');
    if (schemeOf(uri) !== 'file') return { ok: false, reasonCode: 'NonFileTarget', message: `The provider edit changes a resource that is not a local file (${schemeOf(uri) || 'unknown'}: scheme).`, uri };
    const list = byUri.get(uri) ?? [];
    for (const e of entry[1] as unknown[]) {
      if (!isObj(e)) return opaque('The provider edit contains a change that is not a text edit.', uri);
      if (e.snippet !== undefined) return opaque('The provider edit contains a snippet edit.', uri);
      if (e.newEol !== undefined && e.newEol !== null) return opaque('The provider edit changes line endings.', uri);
      const range = readRange(e.range);
      if (!range || typeof e.newText !== 'string') return opaque('The provider edit contains a change that is not a plain text edit.', uri);
      list.push({ range, newText: e.newText });
    }
    byUri.set(uri, list);
  }
  return { ok: true, changes: [...byUri.entries()].filter(([, edits]) => edits.length > 0).map(([uri, edits]) => ({ uri, edits })) };
}
