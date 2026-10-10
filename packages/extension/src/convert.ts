import * as vscode from 'vscode';
import type { Location, Position, Range } from '@refyntra/contracts';

export function toPosition(p: vscode.Position): Position {
  return { line: p.line, character: p.character };
}

export function fromPosition(p: Position): vscode.Position {
  return new vscode.Position(Math.max(0, p.line), Math.max(0, p.character));
}

export function fromRange(r: Range): vscode.Range {
  return new vscode.Range(fromPosition(r.start), fromPosition(r.end));
}

export function fromLocation(l: Location): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(l.uri, true), fromRange(l.range));
}

/** Opens a protocol location; only file: URIs from the backend are opened (backend output is untrusted). */
export async function openLocation(l: Location | undefined, preserveFocus = false): Promise<void> {
  if (!l) return;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(l.uri, true);
  } catch {
    void vscode.window.showWarningMessage('Refyntra: the backend returned an invalid location.');
    return;
  }
  if (uri.scheme !== 'file') {
    void vscode.window.showWarningMessage(`Refyntra: refusing to open a non-file location (${uri.scheme}:).`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const range = fromRange(l.range);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(range.start, range.start), preserveFocus, preview: true });
}

export function shortPath(uri: string): string {
  try {
    const u = vscode.Uri.parse(uri, true);
    return vscode.workspace.asRelativePath(u, false);
  } catch {
    return uri;
  }
}
