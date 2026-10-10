import type { RelatedOutcome } from '@refyntra/application';
import type { Location } from '@refyntra/contracts';
import { type MergedRelation, relationLocation } from '@refyntra/domain';

/**
 * State of the Related view (pure, unit-tested). Rules:
 *  - while a request runs the view shows "Loading…", never the previous outcome with its old line numbers;
 *  - an edit of the subject's file or of any target file marks the shown outcome outdated (the view refreshes it);
 *  - a location from an outdated outcome is never opened directly: the relation is resolved again first.
 */
export class RelatedViewState {
  private current: RelatedOutcome | undefined;
  private loadingNow = false;
  private outdated = false;
  private files = new Set<string>();

  get outcome(): RelatedOutcome | undefined {
    return this.current;
  }

  get loading(): boolean {
    return this.loadingNow;
  }

  get stale(): boolean {
    return this.outdated;
  }

  /** What the tree shows: nothing from an older outcome while loading. */
  get visibleOutcome(): RelatedOutcome | undefined {
    return this.loadingNow ? undefined : this.current;
  }

  /** Locations of the shown outcome may be opened without resolving again. */
  get canOpenDirectly(): boolean {
    return !this.loadingNow && !this.outdated && this.current !== undefined;
  }

  begin(): void {
    this.loadingNow = true;
  }

  /** A request ended. `requestUri` is the document the cursor was in (it belongs to the outcome too). */
  complete(outcome: RelatedOutcome, requestUri: string): void {
    this.loadingNow = false;
    this.current = outcome;
    this.outdated = false;
    this.files = new Set([requestUri, ...filesOf(outcome)]);
  }

  /** A request was cancelled by a newer one or failed silently: keep the old outcome but not as current truth. */
  abandon(): void {
    this.loadingNow = false;
    if (this.current) this.outdated = true;
  }

  /** A document changed. Returns true when the shown outcome is affected (it is then outdated). */
  documentChanged(uri: string): boolean {
    if (!this.current || !this.files.has(uri)) return false;
    this.outdated = true;
    return true;
  }

  /** The backend session changed (epoch): every shown id and location is outdated. */
  invalidate(): void {
    if (this.current) this.outdated = true;
  }
}

function filesOf(outcome: RelatedOutcome): string[] {
  if (outcome.kind !== 'related') return [];
  const out: string[] = [];
  const add = (l: Location | undefined) => l && out.push(l.uri);
  add(outcome.subject?.location);
  for (const g of outcome.groups) for (const r of g.relations) addRelation(r, add);
  return out;
}

function addRelation(r: MergedRelation, add: (l: Location | undefined) => void): void {
  add(relationLocation(r));
  add(r.target.symbol?.location);
  add(r.target.location);
  add(r.target.endpoint?.location);
  add(r.target.registration?.location);
  for (const e of r.evidence) add(e.location);
}

/** The same relation in a fresh outcome (kind + label + target identity), used to re-resolve before opening. */
export function findSameRelation(outcome: RelatedOutcome | undefined, r: MergedRelation): MergedRelation | undefined {
  if (outcome?.kind !== 'related') return undefined;
  const key = (x: MergedRelation) => `${x.relationKind}|${x.group}|${x.target.label}|${x.target.symbol?.displayName ?? ''}`;
  const wanted = key(r);
  for (const g of outcome.groups) for (const x of g.relations) if (key(x) === wanted) return x;
  return undefined;
}
