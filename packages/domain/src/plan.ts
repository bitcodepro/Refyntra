import type { DelegatedProvenance, Evidence, InputFingerprint, PlannedChange, PlannedTextChange, Position, RefactorPlanDto } from '@refyntra/contracts';
import { comparePositions } from './location';

/**
 * Delegated plan: the edits come from a public provider dispatch (e.g. VS Code's TypeScript rename
 * provider). Only the lifecycle of our bridge and local text fingerprints are known; the provider's project context,
 * snapshot and semantic read set stay `unknown`. Never `valid`, never compiled.
 */
export interface DelegatedRefactorPlan {
  planId: string;
  actionId: string;
  providerRouteId: string;
  workspaceId: string;
  kind: 'delegated';
  /** Lifecycle of our bridge only (a restart of the route = a new epoch). */
  bridgeEpoch: string;
  /** Local id of the provider observation the preview was built from. */
  observationId: string;
  observedWorkspaceRevision: number;
  /** SHA-256 of the text of every observed document (the source document and every target). */
  observedInputs: InputFingerprint[];
  backendContext: 'unknown';
  backendSnapshot: 'unknown';
  semanticReadSet: 'unknown';
  /** Shown in the preview: the semantic coverage is the provider's, not Refyntra's. */
  coverage: 'provider-managed';
  /** Where the provider was asked (re-asked before apply). */
  origin: { uri: string; position: Position; newName: string };
  /** Text only: a delegated plan never carries resource operations. */
  writeSet: PlannedTextChange[];
  evidence: Evidence[];
  limitations: string[];
  validation: {
    status: 'limited' | 'invalid';
    compilationDelta: 'not-run';
    /** Set once the provider was asked again before apply. */
    providerReprepared: boolean;
    /** Set once the re-asked provider returned exactly the previewed edit. */
    returnedEditsMatchedPreview: boolean;
  };
  title: string;
  /**
   * Present when the edits come from a language server process Refyntra started itself (Python: bundled Pyright;
   * Rust: bundled rust-analyzer). Refyntra owned the server's view of the open documents: these are the document
   * versions the server computed the rename on. The semantic engine is still third-party, so the plan stays
   * `delegated` (ADR-002 amendment); the versions make the re-ask before apply stricter.
   */
  serverSession?: { server: string; serverVersion?: string; processOwner: 'refyntra'; documentVersions: { uri: string; version: number }[] };
}

export type AnyRefactorPlan = RefactorPlanDto | DelegatedRefactorPlan;

export function delegatedProvenance(providerRouteId: string, observationId: string): DelegatedProvenance {
  return { kind: 'delegated', providerRouteId, observationId, sessionEpoch: 'unknown', snapshotId: 'unknown', projectContextId: 'unknown' };
}

/**
 * Plan lifecycle. A plan is single use:
 *   Prepared → Previewing → Revalidating → Applying → Applied | Failed
 * plus Stale, Cancelled, Discarded. Every state except the four in-flight ones is terminal.
 */
export type PlanState = 'Prepared' | 'Previewing' | 'Revalidating' | 'Applying' | 'Applied' | 'Failed' | 'Stale' | 'Cancelled' | 'Discarded';

const TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  Prepared: ['Previewing', 'Stale', 'Cancelled', 'Discarded', 'Failed'],
  Previewing: ['Revalidating', 'Stale', 'Cancelled', 'Discarded', 'Failed'],
  Revalidating: ['Applying', 'Stale', 'Cancelled', 'Discarded', 'Failed'],
  // Once apply started the editor decides; cancellation is no longer promised.
  Applying: ['Applied', 'Failed'],
  Applied: [],
  Failed: [],
  Stale: [],
  Cancelled: [],
  Discarded: [],
};

export const TERMINAL_PLAN_STATES: readonly PlanState[] = ['Applied', 'Failed', 'Stale', 'Cancelled', 'Discarded'];

export function isTerminalPlanState(s: PlanState): boolean {
  return TRANSITIONS[s].length === 0;
}

export function canTransition(from: PlanState, to: PlanState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class PlanTransitionError extends Error {
  constructor(
    readonly from: PlanState,
    readonly to: PlanState,
  ) {
    super(`Illegal plan transition ${from} → ${to}`);
    this.name = 'PlanTransitionError';
  }
}

export interface PlanStateChange {
  from: PlanState;
  to: PlanState;
  reason?: string;
}

/** Owns the state of one prepared plan. Not thread-safe by design: the extension host is single threaded. */
export class PlanLifecycle<P extends { planId: string } = AnyRefactorPlan> {
  private current: PlanState = 'Prepared';
  private lastReason: string | undefined;
  readonly history: PlanStateChange[] = [];

  constructor(readonly plan: P) {}

  get state(): PlanState {
    return this.current;
  }

  get reason(): string | undefined {
    return this.lastReason;
  }

  get isTerminal(): boolean {
    return isTerminalPlanState(this.current);
  }

  transition(to: PlanState, reason?: string): void {
    if (!canTransition(this.current, to)) throw new PlanTransitionError(this.current, to);
    this.history.push({ from: this.current, to, ...(reason !== undefined ? { reason } : {}) });
    this.current = to;
    this.lastReason = reason;
  }

  /** Transition when legal; returns false (no throw) otherwise. Used for invalidation (stale/discard). */
  tryTransition(to: PlanState, reason?: string): boolean {
    if (!canTransition(this.current, to)) return false;
    this.transition(to, reason);
    return true;
  }
}

export interface PlanValidationIssue {
  code: 'unsupported-change' | 'non-file-uri' | 'unsorted-edits' | 'overlapping-edits' | 'duplicate-document' | 'missing-hash' | 'empty-plan' | 'wrong-kind' | 'unordered-changes' | 'invalid-rename' | 'invalid-create';
  message: string;
  uri?: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Structural validator for a backend plan (backend output is untrusted).
 * Text-only, file: URIs, sorted non-overlapping edits, hashes present, one change per document.
 */
export function validatePlanStructure(plan: AnyRefactorPlan): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (plan.kind === 'delegated') {
    // A delegated plan never claims owned validity, a compilation check or a backend identity.
    const v = plan.validation as { status: string; compilationDelta: string };
    if ((v.status !== 'limited' && v.status !== 'invalid') || v.compilationDelta !== 'not-run' || plan.backendContext !== 'unknown' || plan.backendSnapshot !== 'unknown' || plan.semanticReadSet !== 'unknown') {
      issues.push({ code: 'wrong-kind', message: 'A delegated plan cannot claim owned-semantic validation' });
    }
  } else if (plan.kind !== 'owned-semantic') issues.push({ code: 'wrong-kind', message: `Unsupported plan kind ${String((plan as { kind: unknown }).kind)}` });
  if (!Array.isArray(plan.writeSet) || plan.writeSet.length === 0) {
    issues.push({ code: 'empty-plan', message: 'The plan contains no changes' });
    return issues;
  }
  const seen = new Set<string>();
  const texts = new Map<string, string>();
  const renames: Extract<PlannedChange, { kind: 'rename' }>[] = [];
  const creates: Extract<PlannedChange, { kind: 'create' }>[] = [];
  let sawOther = false;
  for (const change of plan.writeSet as PlannedChange[]) {
    if (change && change.kind === 'create') {
      if (sawOther) issues.push({ code: 'unordered-changes', message: 'A created file follows a text change or a file rename; created files must come first', uri: change.uri });
      creates.push(change);
      continue;
    }
    sawOther = true;
    if (change && change.kind === 'rename') {
      renames.push(change);
      continue;
    }
    if (!change || change.kind !== 'text') {
      issues.push({ code: 'unsupported-change', message: 'Only text changes, file renames and created files are supported in this version' });
      continue;
    }
    if (renames.length > 0) issues.push({ code: 'unordered-changes', message: 'A text change follows a file rename; file renames must come after every text change', uri: change.uri });
    texts.set(change.uri, change.resultHash);
    if (typeof change.uri !== 'string' || !change.uri.startsWith('file:')) issues.push({ code: 'non-file-uri', message: 'Change targets a non-file URI', uri: change.uri });
    if (seen.has(change.uri)) issues.push({ code: 'duplicate-document', message: 'Document appears twice in the plan', uri: change.uri });
    seen.add(change.uri);
    if (!HASH_RE.test(change.expectedHash ?? '') || !HASH_RE.test(change.resultHash ?? '')) issues.push({ code: 'missing-hash', message: 'Change has no valid content hash', uri: change.uri });
    const edits = change.edits ?? [];
    for (let i = 1; i < edits.length; i++) {
      const prev = edits[i - 1]!;
      const cur = edits[i]!;
      const order = comparePositions(prev.range.start, cur.range.start);
      if (order > 0) issues.push({ code: 'unsorted-edits', message: 'Edits are not sorted by start', uri: change.uri });
      else if (comparePositions(prev.range.end, cur.range.start) > 0 || (order === 0 && comparePositions(prev.range.start, prev.range.end) !== 0)) {
        issues.push({ code: 'overlapping-edits', message: 'Edits overlap', uri: change.uri });
      }
    }
  }
  issues.push(...validateFileRenames(plan, renames, texts));
  issues.push(...validateFileCreates(plan, creates, texts, renames));
  return issues;
}

/** Largest created file (UTF-16 code units) a plan may carry; the host refuses larger ones earlier. */
export const MAX_CREATED_FILE_CHARS = 512 * 1024;

/**
 * Created files: only in an owned-semantic plan that lists them (`fileCreate.files`), file: URIs, `*.cs` without an
 * encoded path separator, a valid hash and a text within the size limit, never a text target or a file rename source
 * or target of the same plan, no duplicates (ignoring case). The EditApplier checks `resultHash` = SHA-256(text) and the
 * absence of the target again before creating it.
 */
function validateFileCreates(
  plan: AnyRefactorPlan,
  creates: readonly Extract<PlannedChange, { kind: 'create' }>[],
  texts: ReadonlyMap<string, string>,
  renames: readonly Extract<PlannedChange, { kind: 'rename' }>[],
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (creates.length === 0) return issues;
  const listed = plan.kind === 'owned-semantic' ? (plan.fileCreate?.files ?? []) : [];
  if (plan.kind !== 'owned-semantic' || !plan.fileCreate || listed.length !== creates.length) {
    issues.push({ code: 'unsupported-change', message: 'This plan cannot create files' });
    return issues;
  }
  const seen = new Set<string>();
  const renamed = new Set(renames.flatMap((r) => [String(r.oldUri).toLowerCase(), String(r.newUri).toLowerCase()]));
  for (const c of creates) {
    const bad = (message: string) => issues.push({ code: 'invalid-create', message, uri: c.uri });
    if (typeof c.uri !== 'string' || !c.uri.startsWith('file:')) {
      issues.push({ code: 'non-file-uri', message: 'A created file is not a local file', uri: String(c.uri) });
      continue;
    }
    if (!HASH_RE.test(c.resultHash ?? '')) issues.push({ code: 'missing-hash', message: 'A created file has no valid content hash', uri: c.uri });
    if (typeof c.text !== 'string') bad('A created file has no text');
    else if (c.text.length > MAX_CREATED_FILE_CHARS) bad('A created file is larger than this version creates');
    if (!/\.cs$/.test(lastSegment(c.uri)) || /%2F|%5C/i.test(lastSegment(c.uri)) || lastSegment(c.uri) === '.cs') bad('A created file is not a C# file or contains a path separator');
    if (!listed.includes(c.uri)) bad('A created file is not listed by the plan');
    const key = c.uri.toLowerCase();
    if (seen.has(key)) bad('A file is created twice');
    seen.add(key);
    if ([...texts.keys()].some((u) => u.toLowerCase() === key)) bad('A created file is also edited by the plan');
    if (renamed.has(key)) bad('A created file is also renamed by the plan');
  }
  return issues;
}

const lastSegment = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const folderOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);

/**
 * File rename resource operations: only in an owned-semantic plan that offered them (`fileRename.included`),
 * file: URIs, same folder, `*.cs` → `*.cs`, never case-only, each source a text target of the plan with the same
 * result hash, no target that is another source or a text target, no duplicates.
 */
function validateFileRenames(plan: AnyRefactorPlan, renames: readonly Extract<PlannedChange, { kind: 'rename' }>[], texts: ReadonlyMap<string, string>): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (renames.length === 0) return issues;
  if (plan.kind !== 'owned-semantic' || !plan.fileRename?.included) {
    issues.push({ code: 'unsupported-change', message: 'This plan cannot rename files' });
    return issues;
  }
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const r of renames) {
    const bad = (message: string) => issues.push({ code: 'invalid-rename', message, uri: r.oldUri });
    if (typeof r.oldUri !== 'string' || typeof r.newUri !== 'string' || !r.oldUri.startsWith('file:') || !r.newUri.startsWith('file:')) {
      issues.push({ code: 'non-file-uri', message: 'A file rename targets a non-file URI', uri: String(r.oldUri) });
      continue;
    }
    if (!HASH_RE.test(r.resultHash ?? '')) issues.push({ code: 'missing-hash', message: 'File rename has no valid content hash', uri: r.oldUri });
    if (folderOf(r.oldUri) !== folderOf(r.newUri)) bad('A file rename moves the file to another folder');
    if (!/\.cs$/.test(lastSegment(r.oldUri)) || !/\.cs$/.test(lastSegment(r.newUri)) || /%2F|%5C/i.test(lastSegment(r.newUri))) bad('A file rename changes the file kind or contains a path separator');
    if (r.oldUri.toLowerCase() === r.newUri.toLowerCase()) bad('A case-only file rename is not supported');
    if (texts.get(r.oldUri) !== r.resultHash) bad('A renamed file is not a text target of the plan with the same result');
    if (texts.has(r.newUri)) bad('A file rename targets a file the plan edits');
    const oldKey = r.oldUri.toLowerCase();
    const newKey = r.newUri.toLowerCase();
    if (sources.has(oldKey) || targets.has(newKey) || sources.has(newKey) || targets.has(oldKey)) bad('A file appears twice in the file renames');
    sources.add(oldKey);
    targets.add(newKey);
  }
  return issues;
}
