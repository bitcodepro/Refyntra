import type { Location, SymbolRef } from '@refyntra/contracts';
import { type MergedRelation, type RelationGroupView, relationLocation } from '@refyntra/domain';

// Navigate To (Rider's Alt+`): the targets of the symbol at the cursor, computed from existing services (Related,
// code/hierarchy with the 1.12 directions "bases" and "containing", incoming calls). Pure: unit-tested with vitest.

export type NavigateAction = 'locations' | 'usages' | 'callHierarchy' | 'metadata';

export interface NavigateTarget {
  id: string;
  label: string;
  /** Codicon id. */
  icon: string;
  count: number;
  /** "3 usages", "50+ usages": the count in words (screen readers and the QuickPick description). */
  countText: string;
  locations: Location[];
  action: NavigateAction;
  /** action "metadata": the library symbol whose decompiled source opens (protocol 1.17). */
  symbolId?: string;
}

export interface NavigateInputs {
  subject: Pick<SymbolRef, 'name' | 'kind' | 'location'> & Partial<Pick<SymbolRef, 'origin' | 'symbolId'>>;
  /** The document of the cursor. */
  currentUri: string;
  /** Related groups of the subject (declarations, implementations, references, tests, handlers, endpoints, registrations). */
  groups: readonly RelationGroupView[];
  bases: readonly SymbolRef[];
  containing: readonly SymbolRef[];
  /** Number of callers (incoming calls); undefined when the subject is not callable. */
  callers?: number;
  /** Other files of the same name next to the declaration (designer, generated, .razor, .cshtml…). */
  siblingFiles: readonly string[];
}

const TYPE_KINDS = new Set(['class', 'record', 'struct', 'interface', 'enum', 'delegate']);

const group = (groups: readonly RelationGroupView[], name: string): MergedRelation[] => groups.find((g) => g.group === name)?.relations ?? [];

const located = (relations: readonly MergedRelation[]): Location[] => dedupe(relations.map((r) => relationLocation(r)).filter((l): l is Location => !!l));

function dedupe(locations: readonly Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((l) => {
    const k = `${l.uri}#${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "1 usage", "3 usages", "50+ usages". */
export function countWords(count: number, noun: string, more = false): string {
  return `${count}${more ? '+' : ''} ${count === 1 && !more ? noun : plural(noun)}`;
}

function plural(noun: string): string {
  if (noun.endsWith('y') && !/[aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/**
 * The number of references of a Related result: Related lists at most 50 and says "Showing 50 of N references" in the
 * limitations of each; that N is the real count.
 */
export function referenceCount(references: readonly MergedRelation[]): { count: number; more: boolean } {
  for (const r of references) {
    for (const l of r.limitations) {
      const m = /Showing \d+ of (\d+) references/.exec(l);
      if (m) return { count: Number(m[1]), more: false };
    }
  }
  return { count: references.length, more: false };
}

/** The stem shared by a file and its companions: Order.cs, Order.Designer.cs, Order.g.cs, Index.cshtml.cs → Order / Index. */
export function fileStem(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const suffix of ['.razor.cs', '.cshtml.cs', '.xaml.cs', '.designer.cs', '.g.i.cs', '.g.cs', '.razor.css', '.cshtml.css', '.razor', '.cshtml', '.xaml', '.resx', '.cs']) {
    if (lower.endsWith(suffix) && fileName.length > suffix.length) return fileName.slice(0, -suffix.length);
  }
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

const COMPANION = /\.(razor\.cs|cshtml\.cs|xaml\.cs|designer\.cs|g\.i\.cs|g\.cs|razor\.css|cshtml\.css|razor|cshtml|xaml|resx|cs)$/i;

/** Companion files of `fileUri` among `candidates` (same stem, a C#/Razor/designer/generated extension, not itself). */
export function companionFiles(fileUri: string, candidates: readonly string[]): string[] {
  const name = baseName(fileUri);
  const stem = fileStem(name).toLowerCase();
  return candidates
    .filter((c) => c !== fileUri && COMPANION.test(baseName(c)) && fileStem(baseName(c)).toLowerCase() === stem)
    .sort((a, b) => baseName(a).localeCompare(baseName(b)));
}

export function baseName(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

const fileLocation = (uri: string): Location => ({ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });

/** The Navigate To list: only targets that exist, in a fixed order, each with its count. */
export function navigateTargets(input: NavigateInputs): NavigateTarget[] {
  const out: NavigateTarget[] = [];
  const isType = TYPE_KINDS.has(input.subject.kind);
  const add = (id: string, label: string, icon: string, noun: string, locations: Location[], action: NavigateAction = 'locations', count = locations.length, more = false) => {
    if (count <= 0) return;
    out.push({ id, label, icon, count, countText: countWords(count, noun, more), locations, action });
  };

  const declarations = located(group(input.groups, 'declarations'));
  add('declaration', declarations.length > 1 ? 'Declarations (partial parts)' : 'Declaration', 'symbol-field', 'declaration', declarations);

  // A library symbol (no source in the solution): its decompiled declaration (go to metadata, protocol 1.17).
  if (input.subject.origin === 'metadata' && input.subject.symbolId && declarations.length === 0) {
    out.push({ id: 'metadata', label: 'Decompiled declaration', icon: 'file-binary', count: 1, countText: countWords(1, 'declaration'), locations: [], action: 'metadata', symbolId: input.subject.symbolId });
  }

  const impls = located(group(input.groups, 'implementations'));
  const implLabel = input.subject.kind === 'interface' ? 'Implementations' : isType ? 'Derived types' : 'Implementations and overrides';
  add('implementations', implLabel, 'symbol-class', isType ? 'type' : 'member', impls);

  const bases = dedupe(input.bases.map((b) => b.location).filter((l): l is Location => !!l));
  add('bases', isType ? 'Base types' : 'Base symbols', 'type-hierarchy-super', isType ? 'type' : 'symbol', bases);

  const refs = group(input.groups, 'references');
  const rc = referenceCount(refs);
  add('usages', 'Usages', 'references', 'usage', located(refs), 'usages', rc.count, rc.more);

  add('tests', 'Related tests', 'beaker', 'test', located(group(input.groups, 'tests')));

  // Related files: other partial parts of the declaration, then companions (designer, generated, .razor, .cshtml).
  const declFile = input.subject.location?.uri ?? input.currentUri;
  const files = [...new Set([...declarations.map((d) => d.uri).filter((u) => u !== input.currentUri), ...input.siblingFiles.filter((u) => u !== input.currentUri)])];
  add('files', 'Related files', 'files', 'file', files.map(fileLocation));

  const containing = dedupe(input.containing.map((c) => c.location).filter((l): l is Location => !!l));
  add('containingType', 'Containing type', 'symbol-class', 'type', containing);
  if (declFile !== input.currentUri) add('containingFile', 'Containing file', 'file', 'file', [fileLocation(declFile)]);

  add('handlers', 'MediatR handler', 'symbol-event', 'handler', located(group(input.groups, 'handlers')));
  add('endpoints', 'Endpoint', 'globe', 'endpoint', located(group(input.groups, 'endpoints')));
  add('registrations', 'DI registration', 'plug', 'registration', located(group(input.groups, 'registrations')));

  if (input.callers !== undefined && input.callers > 0) add('callHierarchy', 'Call hierarchy', 'call-incoming', 'caller', [], 'callHierarchy', input.callers);
  return out;
}

/** What choosing a target does: open one location, peek several, or run a command. */
export function targetOutcome(t: NavigateTarget): { kind: 'open'; location: Location } | { kind: 'peek'; locations: Location[] } | { kind: 'usages' } | { kind: 'callHierarchy' } | { kind: 'metadata'; symbolId: string } {
  if (t.action === 'metadata' && t.symbolId) return { kind: 'metadata', symbolId: t.symbolId };
  if (t.action === 'usages') return { kind: 'usages' };
  if (t.action === 'callHierarchy') return { kind: 'callHierarchy' };
  return t.locations.length === 1 ? { kind: 'open', location: t.locations[0]! } : { kind: 'peek', locations: t.locations };
}
