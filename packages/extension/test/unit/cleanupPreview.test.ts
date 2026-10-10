import { describe, expect, it } from 'vitest';
import type { PlannedChange, RefactorPlanDto } from '@refyntra/contracts';
import { validatePlanStructure } from '@refyntra/domain';
import { CLEANUP_FIXES, cleanupPreviewSummary, fixTotals, profileFromSetting, undoDecision } from '../../src/cleanupSummary';
import { previewFile, sha256 } from '../../src/textEdits';

const label = (uri: string) => uri.replace('file:///ws/', '');
const original = 'using System.Text;\nusing System;\n\nnamespace App;\n\npublic class A   \n{\n}';
const result = 'using System;\n\nnamespace App;\n\npublic class A\n{\n}\n';

const change: PlannedChange = {
  kind: 'text',
  uri: 'file:///ws/App/A.cs',
  expectedHash: sha256(original),
  resultHash: sha256(result),
  edits: [
    { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: '' },
    { range: { start: { line: 5, character: 14 }, end: { line: 5, character: 17 } }, newText: '' },
    { range: { start: { line: 7, character: 1 }, end: { line: 7, character: 1 } }, newText: '\n' },
  ],
};

function plan(extra: Partial<RefactorPlanDto> = {}): RefactorPlanDto {
  return {
    planId: 'p1', actionId: 'csharp.cleanup', providerRouteId: 'csharp.roslyn', protocolMajor: 1, workspaceId: 'ws', kind: 'owned-semantic', sessionEpoch: 'e', baseWorkspaceRevision: 0,
    baseSnapshotId: 's', projectContextIds: ['pc'], writeSet: [change], readSet: [], evidence: [{ description: 'Semantic fingerprint unchanged' }],
    validation: { status: 'valid', checkedContexts: ['pc'], uncheckedContexts: [], compilationDelta: 'passed' },
    limitations: ['Files using #if keep their usings and namespaces.'], title: 'Code Cleanup: 1 file(s)',
    cleanup: {
      fixes: [{ id: 'removeUnnecessaryUsings', title: 'Remove unnecessary usings' }, { id: 'whitespace', title: 'Trailing whitespace and final newline (.editorconfig)' }],
      files: [{ uri: change.uri, fixes: [{ fixId: 'removeUnnecessaryUsings', count: 1 }, { fixId: 'whitespace', count: 2 }] }],
      skipped: [
        { uri: 'file:///ws/App/Gen.g.cs', reasonCode: 'GeneratedCode', message: 'Generated code.' },
        { uri: 'file:///ws/App/Cond.cs', fixId: 'removeUnnecessaryUsings', reasonCode: 'ConditionalCompilation', message: 'The file uses #if.' },
        { fixId: 'editorConfigCodeStyle', reasonCode: 'NotOffered', message: 'Not available: internal Roslyn APIs.' },
      ],
      filesInScope: 4,
    },
    ...extra,
  };
}

describe('Code Cleanup plan and preview', () => {
  it('a cleanup plan is an ordinary text-only plan for the shared pipeline', () => {
    expect(validatePlanStructure(plan())).toEqual([]);
    const f = previewFile(change as Extract<PlannedChange, { kind: 'text' }>, original);
    expect(f.problem).toBeUndefined();
    expect(f.modified).toBe(result);
  });

  it('totals per fix: files and changes', () => {
    expect(fixTotals(plan().cleanup!)).toEqual([
      { id: 'removeUnnecessaryUsings', title: 'Remove unnecessary usings', files: 1, changes: 1 },
      { id: 'whitespace', title: 'Trailing whitespace and final newline (.editorconfig)', files: 1, changes: 2 },
    ]);
  });

  it('summary: counts per fix and per file, skipped files grouped by reason, not-offered fixes, not saved', () => {
    const p = plan();
    const text = cleanupPreviewSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: true }, [previewFile(change as never, original)], false, label);
    expect(text).toContain('# Code Cleanup: 1 file(s)');
    expect(text).toContain('1 of 4 C# file(s) in the scope change.');
    expect(text).toContain('| Remove unnecessary usings | 1 | 1 |');
    expect(text).toContain('- App/A.cs — Remove unnecessary usings: 1, Trailing whitespace and final newline: 2');
    expect(text).toContain('- **generated code** (GeneratedCode), 1:');
    expect(text).toContain('  - App/Cond.cs — Remove unnecessary usings: The file uses #if.');
    expect(text).toContain('- .editorconfig code-style fixes (IDExxxx): Not available: internal Roslyn APIs.');
    expect(text).toContain('**not saved**');
  });

  it('summary: invalid preview and preview-only', () => {
    const p = plan();
    const bad = previewFile(change as never, original + ' ');
    expect(cleanupPreviewSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: true }, [bad], true, label)).toContain('**This preview is invalid**');
    expect(cleanupPreviewSummary({ plan: p, state: 'Previewing', issues: [], applyEnabled: false }, [], false, label)).toContain('**Preview only.**');
  });

  it('profile: known ids in run order; empty or invalid settings give the conservative default', () => {
    expect(profileFromSetting(['whitespace', 'sortUsings', 'nope'])).toEqual(['sortUsings', 'whitespace']);
    expect(profileFromSetting([])).toEqual(['removeUnnecessaryUsings', 'sortUsings', 'whitespace']);
    expect(profileFromSetting('x')).toEqual(['removeUnnecessaryUsings', 'sortUsings', 'whitespace']);
    expect(CLEANUP_FIXES.filter((f) => !f.offered).map((f) => f.id)).toEqual(['editorConfigCodeStyle']);
  });

  it('Undo restores a file only while it is exactly the planned result', () => {
    const entry = { uri: change.uri, original, expectedHash: change.expectedHash, resultHash: change.resultHash };
    expect(undoDecision(entry, result)).toEqual({ restore: true });
    expect(undoDecision(entry, result + '// typed')).toEqual({ restore: false, why: 'changed after the apply; it was not undone' });
    expect(undoDecision(entry, undefined).restore).toBe(false);
    expect(undoDecision({ ...entry, original: 'x' }, result).restore).toBe(false);
  });
});
