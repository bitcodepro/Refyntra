import type { TextEditDto } from '@refyntra/contracts';
import { type ProviderSymbol, readDocumentSymbols, readLocations, readRange, readWorkspaceSymbols, schemeOf, uriString } from '@refyntra/adapter-vscode-providers';

// Structural readers for LSP results. Server output is untrusted: malformed entries are dropped (navigation) or the
// whole edit is refused (rename), never guessed. LSP SymbolKind is 1-based; the shared readers expect VS Code's
// 0-based enum, so kinds are shifted by one before reading.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

function shiftKinds(v: unknown, depth = 0): unknown {
  if (!isObj(v) || depth > 64) return v;
  const out: Obj = { ...v };
  if (typeof v.kind === 'number') out.kind = v.kind - 1;
  if (Array.isArray(v.children)) out.children = v.children.map((c) => shiftKinds(c, depth + 1));
  // WorkspaceSymbol may carry a location without a range (resolve not requested): the start of the file.
  if (isObj(v.location) && v.location.range === undefined && typeof v.location.uri === 'string') {
    out.location = { uri: v.location.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  return out;
}

export function readLspDocumentSymbols(v: unknown, uri: string): ProviderSymbol[] | undefined {
  return readDocumentSymbols(Array.isArray(v) ? v.map((s) => shiftKinds(s)) : v, uri);
}

export function readLspWorkspaceSymbols(v: unknown): ProviderSymbol[] | undefined {
  return readWorkspaceSymbols(Array.isArray(v) ? v.map((s) => shiftKinds(s)) : v);
}

/** Location | Location[] | LocationLink[] | null. */
export const readLspLocations = readLocations;

export interface LspTextChange {
  uri: string;
  /** The document version the server says it edited (TextDocumentEdit), or null/undefined when it did not say. */
  version?: number | null;
  edits: TextEditDto[];
}

export type LspEditReadResult =
  | { ok: true; changes: LspTextChange[] }
  | { ok: false; reasonCode: 'OpaqueEdit' | 'ResourceOperation' | 'NonFileTarget'; message: string; uri?: string };

/**
 * Reads an LSP WorkspaceEdit (`changes` or `documentChanges`). Refused: resource operations (create/rename/delete a
 * file), snippet edits, change annotations that need confirmation, non-file targets and anything malformed.
 */
export function readLspWorkspaceEdit(v: unknown): LspEditReadResult {
  const opaque = (message: string, uri?: string): LspEditReadResult => ({ ok: false, reasonCode: 'OpaqueEdit', message, ...(uri ? { uri } : {}) });
  if (!isObj(v)) return opaque('The language server returned an edit that cannot be read.');
  const byUri = new Map<string, LspTextChange>();
  const addEdits = (uriRaw: unknown, version: unknown, edits: unknown): LspEditReadResult | undefined => {
    const uri = uriString(uriRaw);
    if (!uri) return opaque('The language server edit targets a resource without a readable URI.');
    if (schemeOf(uri) !== 'file') return { ok: false, reasonCode: 'NonFileTarget', message: `The language server edit changes a resource that is not a local file (${schemeOf(uri) || 'unknown'}: scheme).`, uri };
    if (!Array.isArray(edits)) return opaque('The language server edit contains an entry that is not a text edit list.', uri);
    const entry = byUri.get(uri) ?? { uri, edits: [] };
    if (typeof version === 'number') {
      if (entry.version !== undefined && entry.version !== null && entry.version !== version) return opaque('The language server edit names two versions of one document.', uri);
      entry.version = version;
    } else if (entry.version === undefined) entry.version = null;
    for (const e of edits) {
      if (!isObj(e)) return opaque('The language server edit contains a change that is not a text edit.', uri);
      if (e.snippet !== undefined) return opaque('The language server edit contains a snippet edit.', uri);
      const range = readRange(e.range);
      if (!range || typeof e.newText !== 'string') return opaque('The language server edit contains a change that is not a plain text edit.', uri);
      entry.edits.push({ range, newText: e.newText });
    }
    byUri.set(uri, entry);
    return undefined;
  };
  if (v.documentChanges !== undefined) {
    if (!Array.isArray(v.documentChanges)) return opaque('The language server edit has malformed documentChanges.');
    for (const dc of v.documentChanges) {
      if (!isObj(dc)) return opaque('The language server edit has a malformed document change.');
      if (typeof dc.kind === 'string') {
        return { ok: false, reasonCode: 'ResourceOperation', message: `The rename would ${dc.kind === 'rename' ? 'rename' : dc.kind === 'create' ? 'create' : 'delete'} a file; file operations from a language server rename are refused in this version.` };
      }
      const td = dc.textDocument;
      if (!isObj(td)) return opaque('The language server edit has a document change without a document.');
      const err = addEdits(td.uri, td.version, dc.edits);
      if (err) return err;
    }
  } else if (v.changes !== undefined) {
    if (!isObj(v.changes)) return opaque('The language server edit has malformed changes.');
    for (const [uri, edits] of Object.entries(v.changes)) {
      const err = addEdits(uri, undefined, edits);
      if (err) return err;
    }
  }
  return { ok: true, changes: [...byUri.values()].filter((c) => c.edits.length > 0) };
}
