import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { CommandExecutor, DocumentReader, Hasher, ProviderValues, ReadResult } from './ports';

/** Strict UTF-8 decode as VS Code shows the text (a leading BOM is not part of it). Undefined when not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
}

export const sha256: Hasher = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface VsCodeProviderBridge {
  commands: CommandExecutor;
  values: ProviderValues;
  documents: DocumentReader;
  hash: Hasher;
}

/**
 * The real ports over the public VS Code API. The `vscode` module is passed in by the composition root (the only
 * place that wires this package), so the adapter core stays loadable and testable without an Extension Host.
 */
export function createVsCodeProviderBridge(api: typeof vscode): VsCodeProviderBridge {
  const openDocument = (uri: string) => api.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);
  return {
    commands: { executeCommand: (command, ...args) => api.commands.executeCommand(command, ...args) },
    values: {
      uri: (uri) => api.Uri.parse(uri, true),
      position: (p) => new api.Position(p.line, p.character),
    },
    documents: {
      async read(uri: string): Promise<ReadResult> {
        let parsed: vscode.Uri;
        try {
          parsed = api.Uri.parse(uri, true);
        } catch {
          return { ok: false, reason: 'unreadable' };
        }
        if (parsed.scheme !== 'file') return { ok: false, reason: 'not-file' };
        const open = openDocument(uri);
        if (open) return { ok: true, text: open.getText(), open: true };
        // Closed: read from disk without opening it (opening a document is an editor event).
        let bytes: Uint8Array;
        try {
          bytes = await api.workspace.fs.readFile(parsed);
        } catch {
          return { ok: false, reason: 'unreadable' };
        }
        const text = decodeUtf8(bytes);
        return text === undefined ? { ok: false, reason: 'not-utf8' } : { ok: true, text, open: false };
      },
    },
    hash: sha256,
  };
}
