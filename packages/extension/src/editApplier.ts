import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PlannedChange, PlannedFileRename, PlannedTextChange } from '@refyntra/contracts';
import type { ApplyFileReport, ApplyReport, ApplyResourceReport, CapturedEdit, CommitResult, EditApplier } from '@refyntra/application';
import { applyTextEditsToText, decodeUtf8, sha256 } from './textEdits';

export { applyTextEditsToText, decodeUtf8, sha256 } from './textEdits';

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key && !d.isClosed);
}

const label = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false);

interface Target {
  change: PlannedTextChange;
  uri: vscode.Uri;
  diskText: string | undefined;
}

interface RenameTarget {
  change: PlannedFileRename;
  oldUri: vscode.Uri;
  newUri: vscode.Uri;
}

/**
 * True when `fsPath` or a sibling with the same name ignoring case exists (synchronous: used inside the final check,
 * where no await is allowed). A folder that cannot be listed counts as "exists" (refuse rather than guess).
 */
export function targetExists(fsPath: string): boolean {
  try {
    if (fs.existsSync(fsPath)) return true;
    const name = path.basename(fsPath).toLowerCase();
    return fs.readdirSync(path.dirname(fsPath)).some((n) => n.toLowerCase() === name);
  } catch {
    return true;
  }
}

/** Synchronous, read-only existence check of a file on disk. */
function diskExists(uri: vscode.Uri): boolean {
  try {
    return fs.statSync(uri.fsPath).isFile();
  } catch {
    return false;
  }
}

/**
 * The only place that calls workspace.applyEdit. No save, no rollback.
 *
 * Order: every text edit in ONE WorkspaceEdit (all-or-nothing for text); only when every text target is
 * confirmed, each file rename as its own WorkspaceEdit (the editor moves open and dirty documents with the file).
 * A rename is refused (not attempted) when its target appeared meanwhile; later renames are not attempted after a
 * rename that did not complete. Every step is reconciled against the editor and the disk.
 *
 * Fault injection for tests: `faults.rejectNextApply` makes the next text apply resolve false without calling VS Code;
 * `faults.rejectNextFileRename` does the same for the next file rename; `faults.beforeFileRename` runs right before
 * each file rename (e.g. to create the target in that moment).
 */
export class VsCodeEditApplier implements EditApplier {
  readonly faults: { rejectNextApply: boolean; rejectNextFileRename: boolean; beforeFileRename: ((oldUri: string, newUri: string) => void | Promise<void>) | undefined } = {
    rejectNextApply: false,
    rejectNextFileRename: false,
    beforeFileRename: undefined,
  };

  async capture(writeSet: readonly PlannedChange[]): Promise<CapturedEdit | { ok: false; reason: string; uri?: string }> {
    const targets: Target[] = [];
    const renames: RenameTarget[] = [];
    for (const change of writeSet) {
      if (change.kind === 'rename') {
        const oldUri = vscode.Uri.parse(change.oldUri, true);
        const newUri = vscode.Uri.parse(change.newUri, true);
        if (oldUri.scheme !== 'file' || newUri.scheme !== 'file') return { ok: false, reason: 'a file rename is not on local files', uri: change.oldUri };
        if (!targets.some((t) => t.change.uri === change.oldUri && t.change.resultHash === change.resultHash)) return { ok: false, reason: `the rename of ${label(oldUri)} has no matching text change`, uri: change.oldUri };
        if (targetExists(newUri.fsPath)) return { ok: false, reason: `${label(newUri)} already exists`, uri: change.newUri };
        renames.push({ change, oldUri, newUri });
        continue;
      }
      if (change.kind !== 'text') return { ok: false, reason: 'the plan contains an unsupported operation' };
      if (renames.length > 0) return { ok: false, reason: 'a text change follows a file rename' };
      const uri = vscode.Uri.parse(change.uri, true);
      if (uri.scheme !== 'file') return { ok: false, reason: 'a target is not a local file', uri: change.uri };
      let diskText: string | undefined;
      if (!openDocument(uri)) {
        // Closed file: read it now, just before the final synchronous check. Never open it (that is an editor event).
        try {
          diskText = decodeUtf8(await vscode.workspace.fs.readFile(uri));
        } catch {
          return { ok: false, reason: `${label(uri)} cannot be read`, uri: change.uri };
        }
        if (diskText === undefined) return { ok: false, reason: `${label(uri)} is not UTF-8`, uri: change.uri };
      }
      targets.push({ change, uri, diskText });
    }
    return { ok: true, commit: () => this.commit(targets, renames) };
  }

  /** Synchronous check of every target, then applyEdit is started with no await in between. */
  private commit(targets: Target[], renames: RenameTarget[]): CommitResult {
    const edit = new vscode.WorkspaceEdit();
    for (const t of targets) {
      const doc = openDocument(t.uri);
      const current = doc ? doc.getText() : t.diskText;
      if (current === undefined) return { started: false, reason: `${label(t.uri)} was closed and not read`, uri: t.change.uri };
      if (sha256(current) !== t.change.expectedHash) return { started: false, reason: `${label(t.uri)} changed`, uri: t.change.uri };
      let result: string;
      try {
        result = applyTextEditsToText(current, t.change.edits);
      } catch {
        return { started: false, reason: `the edits do not fit ${label(t.uri)}`, uri: t.change.uri };
      }
      if (sha256(result) !== t.change.resultHash) return { started: false, reason: `the edits do not produce the previewed result for ${label(t.uri)}`, uri: t.change.uri };
      for (const e of t.change.edits) {
        edit.replace(t.uri, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
      }
    }
    // The absence precondition once more, synchronously: a target that appeared means nothing is applied at all.
    for (const r of renames) {
      if (targetExists(r.newUri.fsPath)) return { started: false, reason: `${label(r.newUri)} already exists`, uri: r.change.newUri };
    }
    let applying: Thenable<boolean>;
    if (this.faults.rejectNextApply) {
      this.faults.rejectNextApply = false;
      applying = Promise.resolve(false);
    } else {
      // Plain text edit (no isRefactoring metadata: that may trigger files.refactoring.autoSave).
      applying = vscode.workspace.applyEdit(edit);
    }
    return {
      started: true,
      result: Promise.resolve(applying)
        .then(
          (accepted) => this.reconcile(targets, accepted),
          () => this.reconcile(targets, false),
        )
        .then(async (report) => (renames.length === 0 ? report : { ...report, resources: await this.applyRenames(report, renames) })),
    };
  }

  /** Compares the post-state of every target with resultHash. Reads only; changes nothing. */
  private async reconcile(targets: Target[], accepted: boolean): Promise<ApplyReport> {
    const files: ApplyFileReport[] = [];
    for (const t of targets) {
      let text: string | undefined;
      try {
        // applyEdit loads closed targets into (dirty) documents; a target that is still closed was not edited.
        text = openDocument(t.uri)?.getText() ?? decodeUtf8(await vscode.workspace.fs.readFile(t.uri));
      } catch {
        text = undefined;
      }
      const h = text === undefined ? undefined : sha256(text);
      files.push({
        uri: t.change.uri,
        status: h === t.change.resultHash ? 'confirmed' : h === t.change.expectedHash ? 'unchanged' : 'unknown',
        ...(h === undefined ? { detail: 'unreadable' } : {}),
      });
    }
    return { editorAccepted: accepted, files };
  }

  /** File rename: the file renames, one operation each, only after every text target was confirmed. Never rolled back. */
  private async applyRenames(report: ApplyReport, renames: RenameTarget[]): Promise<ApplyResourceReport[]> {
    const out: ApplyResourceReport[] = [];
    const base = (r: RenameTarget) => ({ kind: 'rename' as const, oldUri: r.change.oldUri, newUri: r.change.newUri });
    let go = report.editorAccepted && report.files.every((f) => f.status === 'confirmed');
    for (const r of renames) {
      if (!go) {
        out.push({ ...base(r), status: 'not-attempted', detail: report.files.every((f) => f.status === 'confirmed') ? 'an earlier file rename did not complete' : 'the text edits were not all confirmed' });
        continue;
      }
      try {
        await this.faults.beforeFileRename?.(r.change.oldUri, r.change.newUri);
      } catch {
        // Test hook only.
      }
      if (targetExists(r.newUri.fsPath)) {
        out.push({ ...base(r), status: 'refused', detail: `${label(r.newUri)} appeared after the text edits; the file was not renamed` });
        go = false;
        continue;
      }
      let accepted: boolean;
      if (this.faults.rejectNextFileRename) {
        this.faults.rejectNextFileRename = false;
        accepted = false;
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(r.oldUri, r.newUri, { overwrite: false, ignoreIfExists: false });
        try {
          accepted = await vscode.workspace.applyEdit(edit);
        } catch {
          accepted = false;
        }
      }
      const status = this.reconcileRename(r, accepted);
      out.push({ ...base(r), ...status });
      if (status.status !== 'confirmed') go = false;
    }
    return out;
  }

  /**
   * Post-state of one rename: confirmed = the new file exists, its editor text (or disk text, when it is not open) is
   * the planned result, and the old file is gone (no document, not on disk); failed = nothing moved (old file still
   * there with the planned text, no new file); unknown = anything else.
   */
  private reconcileRename(r: RenameTarget, accepted: boolean): { status: ApplyResourceReport['status']; detail?: string } {
    const oldDoc = openDocument(r.oldUri);
    const newDoc = openDocument(r.newUri);
    const oldOnDisk = diskExists(r.oldUri);
    const newOnDisk = diskExists(r.newUri);
    let newText: string | undefined = newDoc?.getText();
    if (newText === undefined && newOnDisk) {
      try {
        newText = decodeUtf8(fs.readFileSync(r.newUri.fsPath));
      } catch {
        newText = undefined;
      }
    }
    if (newOnDisk && !oldOnDisk && !oldDoc && newText !== undefined && sha256(newText) === r.change.resultHash) return { status: 'confirmed' };
    if (!newOnDisk && !newDoc && oldOnDisk && (!oldDoc || sha256(oldDoc.getText()) === r.change.resultHash)) {
      return { status: 'failed', detail: accepted ? 'the editor reported success but the file was not renamed' : 'the editor did not rename the file' };
    }
    return { status: 'unknown', detail: `after the rename: old file ${oldOnDisk ? 'present' : 'absent'}, new file ${newOnDisk ? 'present' : 'absent'}${newText !== undefined && sha256(newText) !== r.change.resultHash ? ', new file text differs from the preview' : ''}` };
  }
}
