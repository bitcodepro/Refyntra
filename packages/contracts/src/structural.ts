import type { Position, Range, WorkspaceParams } from './protocol';

// Structural search and replace (protocol 1.19, ADR-012): `code/structuralSearch`, `code/structuralReplace` and the
// pattern inspections of `analysis/run` (`structuralPatterns`, rule ids "ORS-<name>").

/** The action id of a structural replace plan (code/structuralReplace answers like refactor/prepare). */
export const CSHARP_STRUCTURAL_REPLACE_ACTION = 'csharp.structuralReplace';
/** Quick fix of a pattern inspection: this prefix + the rule id ("csharp.edit.fix.structural.ORS-empty-string"). */
export const STRUCTURAL_FIX_PREFIX = 'csharp.edit.fix.structural.';
export const STRUCTURAL_PLACEHOLDER_KINDS = ['any', 'expression', 'statement', 'identifier', 'type', 'argument', 'member'] as const;
export type StructuralPlaceholderKind = (typeof STRUCTURAL_PLACEHOLDER_KINDS)[number];
export type StructuralScope = 'document' | 'project' | 'solution';

export interface StructuralPlaceholder {
  name: string;
  /** Default "any". "argument" / "statement" with a count stand for a run of arguments / statements. */
  kind?: StructuralPlaceholderKind;
  /** The expression's type is this type or derives from / implements it ("System.Threading.Tasks.Task", "IEnumerable<T>"). */
  type?: string;
  /** Exactly the type (no derived types). */
  exactType?: boolean;
  minCount?: number;
  maxCount?: number;
  /** The matched text (an identifier's name) must match this whole regular expression (.NET syntax). */
  regex?: string;
}

export interface StructuralPattern {
  /** C# code (an expression, statements or members) with placeholders `$name$`. */
  text: string;
  placeholders: StructuralPlaceholder[];
  /** The replacement template (same kind of code, the same placeholders). */
  replacement?: string;
  /** Namespaces the pattern and the replacement use (default System, System.Collections.Generic, System.Linq, System.Threading.Tasks). */
  imports?: string[];
  /** Pattern inspections (analysis/run): rule id "ORS-<name>", severity, message and quick fix title. */
  ruleId?: string;
  severity?: 'error' | 'warning' | 'information' | 'hint';
  message?: string;
  fixTitle?: string;
}

export interface StructuralSearchParams extends WorkspaceParams {
  snapshotId: string;
  pattern: StructuralPattern;
  scope: StructuralScope;
  /** The document of scope "document" / "project". */
  uri?: string;
  /** At most this many matches (default 200, at most 5000). */
  limit?: number;
}

export interface StructuralMatch {
  uri: string;
  range: Range;
  lineText: string;
  /** What each placeholder matched (one line, shortened). */
  values: Record<string, string>;
}

export interface StructuralSearchResult {
  /** "expression" | "statements" | "members"; absent when the pattern is invalid (reasonCode / message). */
  patternKind?: 'expression' | 'statements' | 'members' | null;
  matches: StructuralMatch[];
  truncated: boolean;
  filesSearched: number;
  filesWithMatches: number;
  notes: string[];
  reasonCode?: string | null;
  message?: string | null;
  elapsedMs: number;
  snapshotId: string;
}

export interface StructuralMatchRef {
  uri: string;
  start: Position;
}

/** code/structuralReplace: answers like refactor/prepare (a plan of action `csharp.structuralReplace`). */
export interface StructuralReplaceParams extends WorkspaceParams {
  snapshotId: string;
  pattern: StructuralPattern;
  scope: StructuralScope;
  uri?: string;
  /** Only these matches (absent: every match of the scope). */
  matches?: StructuralMatchRef[];
}
