/**
 * Which documents the document sync forwards (pure, no vscode import).
 * Inside the workspace folders: always. Outside (library files a definition lookup opens, SDK sources):
 * only once they carry unsaved edits, or when already tracked.
 */
export function shouldTrackDocument(d: { inWorkspace: boolean; dirty: boolean; tracked: boolean }): boolean {
  return d.inWorkspace || d.dirty || d.tracked;
}
