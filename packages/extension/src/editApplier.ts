import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PlannedChange, PlannedFileCreate, PlannedFileDelete, PlannedFileRename, PlannedTextChange } from '@refyntra/contracts';
import type { ApplyFileReport, ApplyReport, ApplyResourceReport, CaptureOptions, CapturedEdit, CommitResult, EditApplier, EditConfirmation } from '@refyntra/application';
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

interface CreateTarget {
  change: PlannedFileCreate;
  uri: vscode.Uri;
}

interface RenameTarget {
  change: PlannedFileRename;
  oldUri: vscode.Uri;
  newUri: vscode.Uri;
}

interface DeleteTarget {
  change: PlannedFileDelete;
  uri: vscode.Uri;
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

/** Entry metadata of the planned edits in the Refactor Preview: pre-checked, grouped by the plan title per file. */
export function confirmationMetadata(confirmation: EditConfirmation, editCount: number): vscode.WorkspaceEditEntryMetadata {
  return {
    needsConfirmation: false,
    label: confirmation.label,
    description: confirmation.description ?? `${editCount} edit${editCount === 1 ? '' : 's'}`,
    iconPath: new vscode.ThemeIcon('tools'),
  };
}

/**
 * The editor opens its Refactor Preview only for an edit with an entry that "needs confirmation", and such entries start
 * unchecked. So the planned edits are plain (pre-checked) entries and one empty edit (no text change, at the start of the
 * first file) carries the confirmation: it opens the panel and changes nothing whether it is checked or not
 * (ADR-004 Amendment 6).
 */
export const PREVIEW_ANCHOR: vscode.WorkspaceEditEntryMetadata = {
  needsConfirmation: true,
  label: 'Refyntra: checked before this preview',
  description: 'no change — apply or discard the edits above',
  iconPath: new vscode.ThemeIcon('shield'),
};

/**
 * The only place that calls workspace.applyEdit. No save, no rollback.
 *
 * Created files (Move Type to File, Generate handler) come first, each as its own WorkspaceEdit.createFile with the
 * planned text (overwrite off). Only when every created file is confirmed (exists with exactly the planned text) are
 * the text targets checked again, synchronously, and the text edit started; otherwise the text edit is not attempted
 * (reported per file). The created file is written to disk (a created file cannot stay unsaved); the text edits are not
 * saved. See ADR-004 Amendment 2 for why the create comes first.
 *
 * Order: every text edit in ONE WorkspaceEdit (all-or-nothing for text); only when every text target is
 * confirmed, each file rename as its own WorkspaceEdit (the editor moves open and dirty documents with the file).
 * A rename is refused (not attempted) when its target appeared meanwhile; later renames are not attempted after a
 * rename that did not complete. Every step is reconciled against the editor and the disk.
 *
 * Deleted files (Safe Delete) come last, each as its own WorkspaceEdit.deleteFile, only after every text target and file
 * rename was confirmed, and only while the file still has exactly the planned text on disk and no unsaved or different
 * text in an editor (checked synchronously right before the delete). Confirmed = the file is gone from the disk.
 *
 * Fault injection for tests: `faults.rejectNextApply` makes the next text apply resolve false without calling VS Code;
 * `faults.rejectNextFileRename` does the same for the next file rename; `faults.beforeFileRename` runs right before
 * each file rename (e.g. to create the target in that moment).
 */
export class VsCodeEditApplier implements EditApplier {
  readonly faults: {
    rejectNextApply: boolean;
    rejectNextFileRename: boolean;
    beforeFileRename: ((oldUri: string, newUri: string) => void | Promise<void>) | undefined;
    /** Created files: the next create resolves false without calling VS Code. */
    rejectNextCreate: boolean;
    /** Created files: runs right after the creates and before the text targets are checked again. */
    afterCreate: ((uri: string) => void | Promise<void>) | undefined;
    /** Deleted files: the next delete resolves false without calling VS Code. */
    rejectNextDelete: boolean;
    /** Deleted files: runs right before each delete (e.g. to change the file in that moment). */
    beforeDelete: ((uri: string) => void | Promise<void>) | undefined;
  } = {
    rejectNextApply: false,
    rejectNextFileRename: false,
    beforeFileRename: undefined,
    rejectNextCreate: false,
    afterCreate: undefined,
    rejectNextDelete: false,
    beforeDelete: undefined,
  };

  async capture(writeSet: readonly PlannedChange[], options?: CaptureOptions): Promise<CapturedEdit | { ok: false; reason: string; uri?: string }> {
    const confirmation = options?.confirmation;
    // The Refactor Preview shows and applies one text edit; resource operations keep their own ordered steps.
    if (confirmation && writeSet.some((c) => c.kind !== 'text')) return { ok: false, reason: 'the Refactor Preview handles text changes only' };
    const targets: Target[] = [];
    const renames: RenameTarget[] = [];
    const creates: CreateTarget[] = [];
    const deletes: DeleteTarget[] = [];
    for (const change of writeSet) {
      if (change.kind === 'delete') {
        const uri = vscode.Uri.parse(change.uri, true);
        if (uri.scheme !== 'file') return { ok: false, reason: 'a deleted file is not a local file', uri: change.uri };
        if (!diskExists(uri)) return { ok: false, reason: `${label(uri)} no longer exists`, uri: change.uri };
        deletes.push({ change, uri });
        continue;
      }
      if (deletes.length > 0) return { ok: false, reason: 'a change follows a file deletion' };
      if (change.kind === 'create') {
        if (targets.length > 0 || renames.length > 0) return { ok: false, reason: 'a created file follows a text change' };
        const uri = vscode.Uri.parse(change.uri, true);
        if (uri.scheme !== 'file') return { ok: false, reason: 'a created file is not a local file', uri: change.uri };
        if (typeof change.text !== 'string' || sha256(change.text) !== change.resultHash) return { ok: false, reason: `the text of ${label(uri)} does not match its hash`, uri: change.uri };
        if (targetExists(uri.fsPath) || openDocument(uri)) return { ok: false, reason: `${label(uri)} already exists`, uri: change.uri };
        creates.push({ change, uri });
        continue;
      }
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
    return { ok: true, commit: () => this.commit(targets, renames, creates, deletes, confirmation) };
  }

  /** Builds the text edit after checking every target synchronously; a string is the reason it cannot be applied. */
  private textEdit(targets: Target[], confirmation?: EditConfirmation): vscode.WorkspaceEdit | { started: false; reason: string; uri?: string } {
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
      const metadata = confirmation ? confirmationMetadata(confirmation, t.change.edits.length) : undefined;
      for (const e of t.change.edits) {
        const range = new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character);
        if (metadata) edit.replace(t.uri, range, e.newText, metadata);
        else edit.replace(t.uri, range, e.newText);
      }
      if (confirmation && t === targets[0]) edit.insert(t.uri, new vscode.Position(0, 0), '', PREVIEW_ANCHOR);
    }
    return edit;
  }

  /** Starts the text edit (or resolves true at once when there is no text target). */
  private startText(edit: vscode.WorkspaceEdit, targets: Target[]): Thenable<boolean> {
    if (targets.length === 0) return Promise.resolve(true);
    if (this.faults.rejectNextApply) {
      this.faults.rejectNextApply = false;
      return Promise.resolve(false);
    }
    // With entry metadata "needsConfirmation" the editor opens its Refactor Preview and applies only what the user
    // confirms there (ADR-004 Amendment 6); the post-state is reconciled below exactly as for a direct apply.
    // Plain text edit (no isRefactoring metadata: that may trigger files.refactoring.autoSave).
    return vscode.workspace.applyEdit(edit);
  }

  /** Synchronous check of every target, then the first editor apply is started with no await in between. */
  private commit(targets: Target[], renames: RenameTarget[], creates: CreateTarget[], deletes: DeleteTarget[] = [], confirmation?: EditConfirmation): CommitResult {
    const edit = this.textEdit(targets, confirmation);
    if (!(edit instanceof vscode.WorkspaceEdit)) return edit;
    // The absence precondition once more, synchronously: a target that appeared means nothing is applied at all.
    for (const r of renames) {
      if (targetExists(r.newUri.fsPath)) return { started: false, reason: `${label(r.newUri)} already exists`, uri: r.change.newUri };
    }
    for (const c of creates) {
      if (targetExists(c.uri.fsPath) || openDocument(c.uri)) return { started: false, reason: `${label(c.uri)} already exists`, uri: c.change.uri };
    }
    // The files to delete once more, synchronously: a file that changed means nothing is applied at all.
    for (const d of deletes) {
      const problem = this.deleteProblem(d);
      if (problem) return { started: false, reason: problem, uri: d.change.uri };
    }
    const withDeletes = async (report: ApplyReport): Promise<ApplyReport> => (deletes.length === 0 ? report : { ...report, resources: [...(report.resources ?? []), ...(await this.applyDeletes(report, deletes))] });
    const withRenames = async (report: ApplyReport): Promise<ApplyReport> =>
      withDeletes(renames.length === 0 ? report : { ...report, resources: [...(report.resources ?? []), ...(await this.applyRenames(report, renames))] });
    if (creates.length > 0) return { started: true, result: this.applyCreates(creates, targets).then(withRenames) };
    const applying = this.startText(edit, targets);
    return {
      started: true,
      result: Promise.resolve(applying)
        .then(
          (accepted) => this.reconcile(targets, accepted),
          () => this.reconcile(targets, false),
        )
        .then(withRenames),
    };
  }

  /**
   * Created files first (each its own createFile with the planned bytes, overwrite off), reconciled one by one; then,
   * only when every create is confirmed, the text targets are checked again synchronously and the text edit starts.
   * A text edit that is not attempted reports its targets as `unchanged` with the reason. Nothing is rolled back.
   */
  private async applyCreates(creates: CreateTarget[], targets: Target[]): Promise<ApplyReport> {
    const resources: ApplyResourceReport[] = [];
    let go = true;
    for (const c of creates) {
      if (!go) {
        resources.push({ kind: 'create', uri: c.change.uri, status: 'not-attempted', detail: 'an earlier created file did not complete' });
        continue;
      }
      let accepted: boolean;
      if (this.faults.rejectNextCreate) {
        this.faults.rejectNextCreate = false;
        accepted = false;
      } else if (targetExists(c.uri.fsPath)) {
        resources.push({ kind: 'create', uri: c.change.uri, status: 'refused', detail: `${label(c.uri)} appeared right before it was created` });
        go = false;
        continue;
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(c.uri, { overwrite: false, ignoreIfExists: false, contents: new TextEncoder().encode(c.change.text) });
        try {
          accepted = await vscode.workspace.applyEdit(edit);
        } catch {
          accepted = false;
        }
      }
      const status = this.reconcileCreate(c, accepted);
      resources.push({ kind: 'create', uri: c.change.uri, ...status });
      if (status.status !== 'confirmed') go = false;
      try {
        await this.faults.afterCreate?.(c.change.uri);
      } catch {
        // Test hook only.
      }
    }
    if (!go) {
      return { editorAccepted: false, files: targets.map((t) => ({ uri: t.change.uri, status: 'unchanged' as const, detail: 'not attempted: the file was not created' })), resources };
    }
    // The text targets once more, synchronously, right before the text edit starts (the creates took time).
    const edit = this.textEdit(targets);
    if (!(edit instanceof vscode.WorkspaceEdit)) {
      return { editorAccepted: false, files: targets.map((t) => ({ uri: t.change.uri, status: 'unchanged' as const, detail: `not attempted: ${edit.reason}` })), resources };
    }
    let accepted: boolean;
    try {
      accepted = await this.startText(edit, targets);
    } catch {
      accepted = false;
    }
    const report = await this.reconcile(targets, accepted);
    return { ...report, resources };
  }

  /**
   * Undo of a created file (user action after an apply): deletes the file only while it still has exactly the planned
   * text on disk and no unsaved changes in an editor. Checked synchronously right before the delete starts.
   */
  async deleteCreatedFile(uri: vscode.Uri, resultHash: string): Promise<boolean> {
    let text: string | undefined;
    try {
      text = decodeUtf8(fs.readFileSync(uri.fsPath));
    } catch {
      return false;
    }
    const doc = openDocument(uri);
    if (text === undefined || sha256(text) !== resultHash || (doc && (doc.isDirty || sha256(doc.getText()) !== resultHash))) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    try {
      return await vscode.workspace.applyEdit(edit);
    } catch {
      return false;
    }
  }

  /**
   * Undo of a deleted file (user action after a Safe Delete): creates the file again with its previewed text, only while
   * it does not exist (also ignoring case). Checked synchronously right before the create starts.
   */
  async restoreDeletedFile(uri: vscode.Uri, text: string): Promise<boolean> {
    if (targetExists(uri.fsPath) || openDocument(uri)?.isDirty) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: new TextEncoder().encode(text) });
    try {
      return (await vscode.workspace.applyEdit(edit)) && diskExists(uri);
    } catch {
      return false;
    }
  }

  /**
   * Undo of applied text edits (Code Cleanup): replaces each open document's text with `text` only while its current
   * text still hashes to `fromHash` (checked synchronously right before the edit starts). One workspace edit, not saved.
   * Returns false when a document is not open or changed (nothing is edited then).
   */
  async restoreTexts(items: readonly { uri: string; fromHash: string; text: string }[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const item of items) {
      const doc = openDocument(vscode.Uri.parse(item.uri, true));
      if (!doc || sha256(doc.getText()) !== item.fromHash) return false;
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), item.text);
    }
    try {
      return await vscode.workspace.applyEdit(edit);
    } catch {
      return false;
    }
  }

  /** Why a planned delete must not happen now (its text changed, unsaved changes, unreadable), or undefined. Synchronous. */
  private deleteProblem(d: DeleteTarget): string | undefined {
    let text: string | undefined;
    try {
      text = decodeUtf8(fs.readFileSync(d.uri.fsPath));
    } catch {
      return `${label(d.uri)} cannot be read`;
    }
    if (text === undefined || sha256(text) !== d.change.expectedHash) return `${label(d.uri)} changed`;
    const doc = openDocument(d.uri);
    if (doc && (doc.isDirty || sha256(doc.getText()) !== d.change.expectedHash)) return `${label(d.uri)} has unsaved changes`;
    return undefined;
  }

  /**
   * Deleted files: one deleteFile each, only after every text target and file rename was confirmed, and only while the
   * file is unchanged (checked right before each delete). Never rolled back.
   */
  private async applyDeletes(report: ApplyReport, deletes: DeleteTarget[]): Promise<ApplyResourceReport[]> {
    const out: ApplyResourceReport[] = [];
    const earlier = (report.resources ?? []).every((r) => r.status === 'confirmed');
    let go = report.editorAccepted && report.files.every((f) => f.status === 'confirmed') && earlier;
    for (const d of deletes) {
      if (!go) {
        out.push({ kind: 'delete', uri: d.change.uri, status: 'not-attempted', detail: report.files.every((f) => f.status === 'confirmed') && earlier ? 'an earlier file deletion did not complete' : 'the earlier edits were not all confirmed' });
        continue;
      }
      try {
        await this.faults.beforeDelete?.(d.change.uri);
      } catch {
        // Test hook only.
      }
      const problem = this.deleteProblem(d);
      if (problem) {
        out.push({ kind: 'delete', uri: d.change.uri, status: 'refused', detail: `${problem}; the file was not deleted` });
        go = false;
        continue;
      }
      let accepted: boolean;
      if (this.faults.rejectNextDelete) {
        this.faults.rejectNextDelete = false;
        accepted = false;
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(d.uri, { ignoreIfNotExists: false });
        try {
          accepted = await vscode.workspace.applyEdit(edit);
        } catch {
          accepted = false;
        }
      }
      const onDisk = diskExists(d.uri);
      let status: { status: ApplyResourceReport['status']; detail?: string };
      if (!onDisk) status = { status: 'confirmed' };
      else {
        let same = false;
        try {
          same = sha256(decodeUtf8(fs.readFileSync(d.uri.fsPath)) ?? '') === d.change.expectedHash;
        } catch {
          same = false;
        }
        status = same ? { status: 'failed', detail: accepted ? 'the editor reported success but the file still exists' : 'the editor did not delete the file' } : { status: 'unknown', detail: 'after the delete: the file exists with other text' };
      }
      out.push({ kind: 'delete', uri: d.change.uri, ...status });
      if (status.status !== 'confirmed') go = false;
    }
    return out;
  }

  /** confirmed = the file exists with exactly the planned text (editor buffer or disk); failed = it does not exist. */
  private reconcileCreate(c: CreateTarget, accepted: boolean): { status: ApplyResourceReport['status']; detail?: string } {
    const doc = openDocument(c.uri);
    let text = doc?.getText();
    const onDisk = diskExists(c.uri);
    if (text === undefined && onDisk) {
      try {
        text = decodeUtf8(fs.readFileSync(c.uri.fsPath));
      } catch {
        text = undefined;
      }
    }
    if (onDisk && text !== undefined && sha256(text) === c.change.resultHash) return { status: 'confirmed' };
    if (!onDisk && !doc) return { status: 'failed', detail: accepted ? 'the editor reported success but the file does not exist' : 'the editor did not create the file' };
    return { status: 'unknown', detail: `after the create: file ${onDisk ? 'present' : 'absent'}${text !== undefined && sha256(text) !== c.change.resultHash ? ', its text differs from the preview' : ''}` };
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
    if ((report.resources ?? []).some((r) => r.status !== 'confirmed')) report = { ...report, editorAccepted: false };
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
