import type { Location, Position, Range } from '@refyntra/contracts';

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

export function compareRanges(a: Range, b: Range): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

/** Ordinal comparison: stable across locales and runs. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareLocations(a: Location | undefined, b: Location | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareStrings(a.uri, b.uri) || compareRanges(a.range, b.range);
}

/** Exact identity of a location; used for dedupe of merged read-only results. */
export function locationKey(loc: Location): string {
  const r = loc.range;
  return `${loc.uri}#${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
}

export function rangeContains(range: Range, pos: Position): boolean {
  return comparePositions(range.start, pos) <= 0 && comparePositions(pos, range.end) <= 0;
}
