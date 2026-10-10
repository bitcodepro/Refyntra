// Narrow ports over the public VS Code API. The adapter core reads every provider result structurally, so it runs
// (and is unit-tested) without the `vscode` module; vscodeBridge.ts implements these ports with the real API.

/**
 * Executes a public VS Code command (vscode.commands.executeCommand). The adapter only calls the documented provider
 * commands listed in PROVIDER_COMMANDS; it never registers a Definition/Rename provider itself.
 */
export interface CommandExecutor {
  executeCommand<T = unknown>(command: string, ...args: unknown[]): PromiseLike<T>;
}

/** Builds the argument values the provider commands expect (vscode.Uri, vscode.Position). */
export interface ProviderValues {
  uri(uri: string): unknown;
  position(position: { line: number; character: number }): unknown;
}

export type ReadResult =
  | { ok: true; text: string; open: boolean }
  | { ok: false; reason: 'not-utf8' | 'unreadable' | 'not-file' };

/**
 * Current text of a document as the editor shows it: the open buffer, or the file read from disk (strict UTF-8, BOM
 * stripped). Must not open documents (that is an editor event).
 */
export interface DocumentReader {
  read(uri: string): Promise<ReadResult>;
}

/** SHA-256 hex of a UTF-8 string (node:crypto in production). */
export type Hasher = (text: string) => string;

export const PROVIDER_COMMANDS = {
  documentSymbols: 'vscode.executeDocumentSymbolProvider',
  workspaceSymbols: 'vscode.executeWorkspaceSymbolProvider',
  references: 'vscode.executeReferenceProvider',
  definitions: 'vscode.executeDefinitionProvider',
  prepareRename: 'vscode.prepareRename',
  rename: 'vscode.executeDocumentRenameProvider',
} as const;
