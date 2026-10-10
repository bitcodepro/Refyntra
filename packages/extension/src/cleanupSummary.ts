import { CLEANUP_FIX_IDS, type CleanupFixId, type CleanupReport, DEFAULT_CLEANUP_PROFILE } from '@refyntra/contracts';
import type { AnyRefactorPlan, PlanState, PlanValidationIssue } from '@refyntra/domain';
import { sha256 } from './textEdits';
import type { PreviewFileModel } from './textEdits';

// Pure text and choices of Code Cleanup (no vscode import: unit-tested with vitest).

/** The fixes offered in the per-run picker, with what each does. `editorConfigCodeStyle` is listed but explained, never run. */
export const CLEANUP_FIXES: readonly { id: CleanupFixId; label: string; detail: string; offered: boolean }[] = [
  { id: 'removeUnnecessaryUsings', label: 'Remove unnecessary usings', detail: 'The usings the C# compiler reports as unnecessary in every project context — like Organize Imports, but across many files with one preview. Global usings stay.', offered: true },
  { id: 'sortUsings', label: 'Sort usings', detail: 'Only the order: System first unless .editorconfig sets dotnet_sort_system_directives_first = false; groups separated by blank lines stay.', offered: true },
  { id: 'fileScopedNamespace', label: 'File-scoped namespace', detail: 'Only when .editorconfig sets csharp_style_namespace_declarations = file_scoped and the project uses C# 10 or later; one namespace per file.', offered: true },
  { id: 'whitespace', label: 'Trailing whitespace and final newline', detail: 'Only what .editorconfig asks for (trim_trailing_whitespace, insert_final_newline); never inside strings.', offered: true },
  {
    id: 'editorConfigCodeStyle',
    label: '.editorconfig code-style fixes (IDExxxx)',
    detail: 'Not available: these analyzers and code fixes are internal to Roslyn\'s IDE layers; Refyntra uses public Roslyn APIs only. Use VS Code\'s code actions or dotnet format.',
    offered: false,
  },
];

/** The profile from the setting: known ids only, in run order; the default profile when the setting is empty or invalid. */
export function profileFromSetting(value: unknown): CleanupFixId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CLEANUP_PROFILE];
  const ids = CLEANUP_FIX_IDS.filter((id) => value.includes(id));
  return ids.length > 0 ? ids : [...DEFAULT_CLEANUP_PROFILE];
}

export const fixTitle = (id: string): string => CLEANUP_FIXES.find((f) => f.id === id)?.label ?? id;

/** One phrase per cleanup skip reason (shown instead of the raw code; the code stays for support). */
export const CLEANUP_REASON_PHRASE: Readonly<Record<string, string>> = {
  GeneratedCode: 'generated code',
  ReadOnlyFile: 'read-only file',
  UnsupportedEncoding: 'not UTF-8',
  MixedLineEndings: 'mixed line endings',
  FileTooLarge: 'file too large',
  UnreadableFile: 'file cannot be read',
  IncompleteProject: 'project not completely loaded',
  LinkedContextMismatch: 'different text in its project contexts',
  ConditionalCompilation: 'uses #if',
  LanguageVersion: 'C# version before 10',
  NotSingleNamespace: 'not exactly one namespace',
  NamespaceLayout: 'comment or code on the namespace lines',
  MultiLineString: 'string spanning lines',
  UnsortableUsings: 'comments or directives between usings',
  SemanticsNotProven: 'the meaning of the code could change',
  EditMismatch: 'edits could not be computed exactly',
  NotOffered: 'not available in this version',
  UnknownFix: 'unknown fix',
  MoreSkipped: 'more',
};

export interface CleanupSummaryInput {
  plan: AnyRefactorPlan;
  state: PlanState;
  issues: readonly PlanValidationIssue[];
  applyEnabled: boolean;
}

export function cleanupReport(plan: AnyRefactorPlan): CleanupReport | undefined {
  return plan.kind === 'owned-semantic' ? plan.cleanup : undefined;
}

/** Per fix: in how many files it changed something and how many changes in total. */
export function fixTotals(report: CleanupReport): { id: string; title: string; files: number; changes: number }[] {
  return report.fixes.map((f) => {
    const counts = report.files.flatMap((file) => file.fixes.filter((x) => x.fixId === f.id).map((x) => x.count));
    return { id: f.id, title: f.title, files: counts.length, changes: counts.reduce((a, b) => a + b, 0) };
  });
}

export function cleanupPreviewSummary(input: CleanupSummaryInput, files: readonly PreviewFileModel[], invalid: boolean, fileLabel: (uri: string) => string): string {
  const plan = input.plan;
  const report = cleanupReport(plan);
  const lines = [`# ${plan.title}`, ''];
  lines.push(
    invalid
      ? '> **This preview is invalid** and cannot be applied: the planned edits do not match the current text. Run Code Cleanup again.'
      : input.applyEnabled
        ? '> Review the changes, then choose **Apply**. Refyntra revalidates the plan after you confirm and refuses to apply if anything changed since this preview. The files are edited in the editor and **not saved**.'
        : '> **Preview only.** Applying is turned off (`refyntra.rename.apply`). No file is changed.',
    '',
  );
  if (report) {
    lines.push(`${report.files.length} of ${report.filesInScope} C# file(s) in the scope change.`, '', '## Fixes', '', '| Fix | Files | Changes |', '| --- | ---: | ---: |');
    for (const t of fixTotals(report)) lines.push(`| ${t.title} | ${t.files} | ${t.changes} |`);
    lines.push('', '## Files', '');
    for (const f of report.files) lines.push(`- ${fileLabel(f.uri)} — ${f.fixes.map((x) => `${fixTitle(x.fixId)}: ${x.count}`).join(', ')}`);
    lines.push('');
    const general = report.skipped.filter((s) => !s.uri);
    const perFile = report.skipped.filter((s) => s.uri);
    if (perFile.length || general.length) {
      lines.push('## Skipped', '', 'Nothing is changed where a fix is not provably safe.', '');
      for (const s of general) lines.push(`- ${s.fixId ? `${fixTitle(s.fixId)}: ` : ''}${s.message}`);
      const byReason = new Map<string, typeof perFile>();
      for (const s of perFile) byReason.set(s.reasonCode, [...(byReason.get(s.reasonCode) ?? []), s]);
      for (const [code, list] of byReason) {
        lines.push(`- **${CLEANUP_REASON_PHRASE[code] ?? code}** (${code}), ${list.length}:`);
        for (const s of list) lines.push(`  - ${fileLabel(s.uri!)}${s.fixId ? ` — ${fixTitle(s.fixId)}` : ''}: ${s.message}`);
      }
      lines.push('');
    }
  }
  if (invalid) lines.push('## Problems (apply disabled)', '', ...files.filter((f) => f.problem).map((f) => `- ${fileLabel(f.uri)}: ${f.problem}`), '');
  if (input.issues.length) lines.push('## Problems (apply blocked)', '', ...input.issues.map((i) => `- ${i.message}${i.uri ? ` (${fileLabel(i.uri)})` : ''}`), '');
  if (plan.kind === 'owned-semantic') lines.push(`- Validation: ${plan.validation.status}; project contexts checked: ${plan.validation.checkedContexts.length}`, `- Plan state: ${input.state}`, '');
  lines.push('## Guarantees and limitations', '', ...plan.limitations.map((l) => `- ${l}`), '- Formatting beyond these fixes is not changed; use Format Document for that.', '');
  if (plan.evidence.length) lines.push('## Evidence', '', ...plan.evidence.map((e) => `- ${e.description}`), '');
  return lines.join('\n');
}

/** What Undo needs per file: the previewed original (must hash to expectedHash) and the planned result hash. */
export interface UndoEntry {
  uri: string;
  original: string;
  expectedHash: string;
  resultHash: string;
}

/**
 * Which files Undo may restore: only those whose current text is exactly the planned result and whose original is the
 * text the plan was computed on. `current` is the text now (undefined: the file is not open, nothing to undo there).
 */
export function undoDecision(entry: UndoEntry, current: string | undefined): { restore: true } | { restore: false; why: string } {
  if (current === undefined) return { restore: false, why: 'is not open; nothing was undone' };
  if (sha256(entry.original) !== entry.expectedHash) return { restore: false, why: 'has no exact original; nothing was undone' };
  if (sha256(current) !== entry.resultHash) return { restore: false, why: 'changed after the apply; it was not undone' };
  return { restore: true };
}
