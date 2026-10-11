import type { ParameterSpec, PlannedChange, PlannedFileDelete, SignatureInfo } from '@refyntra/contracts';
import type { AnyRefactorPlan, PlanState, PlanValidationIssue } from '@refyntra/domain';
import { type PreviewFileModel, sha256 } from './textEdits';

// Pure text and models of the code refactorings (Safe Delete, Extract Method, Change Signature). No vscode import:
// unit-tested with vitest.

export interface CodeSummaryInput {
  plan: AnyRefactorPlan;
  state: PlanState;
  issues: readonly PlanValidationIssue[];
  applyEnabled: boolean;
}

export function plannedDeletes(plan: AnyRefactorPlan): PlannedFileDelete[] {
  return (plan.writeSet as readonly PlannedChange[]).filter((c): c is PlannedFileDelete => c.kind === 'delete');
}

/** The preview model of a deleted file: a diff to an empty file; a problem when the current text is not the planned one. */
export function deletedFilePreview(change: PlannedFileDelete, current: string): PreviewFileModel {
  return {
    uri: change.uri,
    original: current,
    modified: '',
    editCount: 1,
    ...(sha256(current) !== change.expectedHash ? { problem: 'the file changed since the plan was prepared' } : {}),
  };
}

export function codeRefactorSummary(input: CodeSummaryInput, files: readonly PreviewFileModel[], invalid: boolean, fileLabel: (uri: string) => string): string {
  const plan = input.plan;
  const deleted = new Set(plannedDeletes(plan).map((d) => d.uri));
  const edited = files.filter((f) => !deleted.has(f.uri));
  const limited = plan.validation.status === 'limited';
  const lines = [`# ${plan.title}`, ''];
  lines.push(
    invalid
      ? '> **This preview is invalid** and cannot be applied: the planned edits do not match the current text. Run the action again.'
      : !input.applyEnabled
        ? '> **Preview only.** Applying is turned off (`refyntra.rename.apply`). No file is changed.'
        : limited
          ? '> **Partly validated.** Review the limitations below; Apply asks for an explicit confirmation. Refyntra revalidates the plan after you confirm and refuses to apply if anything changed since this preview.'
          : '> Review the edits, then choose **Apply**. Refyntra revalidates the plan after you confirm and refuses to apply if anything changed since this preview.',
    '',
  );
  if (edited.length > 0) lines.push('## Edits', '', ...edited.map((f) => `- ${fileLabel(f.uri)} — ${f.editCount} edit(s), not saved`), '');
  if (deleted.size > 0) {
    lines.push('## Deleted files', '', ...[...deleted].map((u) => `- ${fileLabel(u)} — deleted after the edits, only while its text is unchanged`), '');
    lines.push(
      '## Order and failure',
      '',
      'The text edits are applied first (all or nothing). Only when every edit is confirmed is the file deleted, as its own step. If the delete fails, the edits stay applied and Refyntra says exactly that; nothing is rolled back automatically.',
      '',
    );
  }
  if (invalid) lines.push('## Problems (apply disabled)', '', ...files.filter((f) => f.problem).map((f) => `- ${fileLabel(f.uri)}: ${f.problem}`), '');
  if (input.issues.length) lines.push('## Problems (apply blocked)', '', ...input.issues.map((i) => `- ${i.message}${i.uri ? ` (${fileLabel(i.uri)})` : ''}`), '');
  if (plan.kind === 'owned-semantic') {
    lines.push(
      `- Project contexts checked: ${plan.validation.checkedContexts.length}`,
      `- Validation: ${plan.validation.status}; compilation delta (new compiler errors compared with before): ${plan.validation.compilationDelta}`,
      `- Plan state: ${input.state}`,
      '',
    );
  }
  lines.push('## Limitations', '', ...plan.limitations.map((l) => `- ${l}`), '- A write by another program in the very last moment cannot be excluded with the VS Code API; the result is checked afterwards and reported per file.', '');
  if (plan.evidence.length) lines.push('## Evidence', '', ...plan.evidence.map((e) => `- ${e.description}`), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- Change Signature editor model

/** One row of the Change Signature editor. */
export interface SignatureRow {
  /** Index of the existing parameter; undefined for an added parameter. */
  from?: number;
  name: string;
  type: string;
  modifiers: string;
  defaultValue?: string;
  callSiteValue?: string;
}

export function initialRows(info: SignatureInfo): SignatureRow[] {
  return info.parameters.map((p, i) => ({ from: i, name: p.name, type: p.type, modifiers: p.modifiers, ...(p.defaultValue ? { defaultValue: p.defaultValue } : {}) }));
}

export function moveRow(rows: readonly SignatureRow[], index: number, delta: -1 | 1): SignatureRow[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return [...rows];
  const out = [...rows];
  [out[index], out[target]] = [out[target]!, out[index]!];
  return out;
}

export function removeRow(rows: readonly SignatureRow[], index: number): SignatureRow[] {
  return rows.filter((_, i) => i !== index);
}

export function renameRow(rows: readonly SignatureRow[], index: number, name: string): SignatureRow[] {
  return rows.map((r, i) => (i === index ? { ...r, name } : r));
}

export function addRow(rows: readonly SignatureRow[], row: { name: string; type: string; defaultValue?: string; callSiteValue?: string }): SignatureRow[] {
  // A params array stays last: the new parameter goes in front of it.
  const paramsAt = rows.findIndex((r) => /\bparams\b/.test(r.modifiers));
  const added: SignatureRow = { name: row.name, type: row.type, modifiers: '', ...(row.defaultValue ? { defaultValue: row.defaultValue } : {}), ...(row.callSiteValue ? { callSiteValue: row.callSiteValue } : {}) };
  if (paramsAt < 0) return [...rows, added];
  return [...rows.slice(0, paramsAt), added, ...rows.slice(paramsAt)];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while']);

/** Why a name is not a plain C# identifier (undefined when it is). */
export function identifierProblem(name: string): string | undefined {
  if (!IDENT.test(name)) return 'Use letters, digits and _ (not starting with a digit).';
  if (KEYWORDS.has(name)) return `${name} is a C# keyword.`;
  return undefined;
}

/** Problems of the edited rows before anything is sent (the host checks everything again). */
export function rowsProblem(rows: readonly SignatureRow[]): string | undefined {
  const names = new Set<string>();
  for (const r of rows) {
    const p = identifierProblem(r.name);
    if (p) return `${r.name}: ${p}`;
    if (names.has(r.name)) return `Two parameters are named ${r.name}.`;
    names.add(r.name);
    if (r.from === undefined && !r.callSiteValue && !r.defaultValue) return `${r.name} needs a call-site value or a default value.`;
  }
  return undefined;
}

export function isUnchanged(rows: readonly SignatureRow[], info: SignatureInfo): boolean {
  return rows.length === info.parameters.length && rows.every((r, i) => r.from === i && r.name === info.parameters[i]!.name);
}

export function toSpec(rows: readonly SignatureRow[]): ParameterSpec[] {
  return rows.map((r) =>
    r.from !== undefined
      ? { from: r.from, name: r.name }
      : { name: r.name, type: r.type, ...(r.defaultValue ? { defaultValue: r.defaultValue } : {}), ...(r.callSiteValue ? { callSiteValue: r.callSiteValue } : {}) },
  );
}

/** "(int id, string name = \"x\")" for the editor title. */
export function signatureText(rows: readonly SignatureRow[]): string {
  return `(${rows.map((r) => `${r.modifiers ? `${r.modifiers} ` : ''}${r.type} ${r.name}${r.defaultValue ? ` = ${r.defaultValue}` : ''}`).join(', ')})`;
}

/** Label of one row: what happens to the parameter. */
export function rowDescription(row: SignatureRow, info: SignatureInfo): string {
  if (row.from === undefined) return `new · call sites get ${row.callSiteValue ?? `the default (${row.defaultValue})`}`;
  const old = info.parameters[row.from];
  const parts: string[] = [];
  if (old && old.name !== row.name) parts.push(`renamed from ${old.name}`);
  return parts.join(' · ');
}

/** Removed parameters (by their current names). */
export function removedNames(rows: readonly SignatureRow[], info: SignatureInfo): string[] {
  const kept = new Set(rows.flatMap((r) => (r.from !== undefined ? [r.from] : [])));
  return info.parameters.flatMap((p, i) => (kept.has(i) ? [] : [p.name]));
}
