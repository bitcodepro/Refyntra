import type { Evidence, Location, Provenance, Relation, RelationGroup, RelationKind } from '@refyntra/contracts';
import { RELATION_GROUP_ORDER } from '@refyntra/contracts';
import { compareLocations, compareStrings, locationKey } from './location';

/**
 * Relation as the application handles it: the contract relation kinds plus namespaced kinds contributed by
 * TS-side framework modules (e.g. "fixture.wiredBy"). The UI renders kinds generically.
 */
export type AnyRelationKind = RelationKind | `${string}.${string}`;
export type AnyRelation = Omit<Relation, 'relationKind'> & { relationKind: AnyRelationKind };

/** A relation merged from one or more providers. */
export interface MergedRelation extends AnyRelation {
  /** Every provenance that reported this exact relation (first = primary). */
  provenances: Provenance[];
}

export interface RelationGroupView {
  group: RelationGroup;
  relations: MergedRelation[];
}

export function relationLocation(r: AnyRelation): Location | undefined {
  return r.target.location ?? r.target.symbol?.location ?? r.target.endpoint?.location ?? r.target.registration?.location;
}

/** Key for exact-location dedupe across providers. Relations without a location dedupe by label. */
export function relationKey(r: AnyRelation): string {
  const loc = relationLocation(r);
  return `${r.group}|${r.relationKind}|${loc ? locationKey(loc) : `label:${r.target.label}`}`;
}

const CONFIDENCE_ORDER = { proven: 0, likely: 1, heuristic: 2 } as const;

export function compareRelations(a: AnyRelation, b: AnyRelation): number {
  return (
    compareStrings(a.relationKind, b.relationKind) ||
    CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
    compareLocations(relationLocation(a), relationLocation(b)) ||
    compareStrings(a.target.label, b.target.label)
  );
}

function evidenceKey(e: Evidence): string {
  return `${e.description}|${e.location ? locationKey(e.location) : ''}`;
}

function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set(a.map(evidenceKey));
  const out = [...a];
  for (const e of b) {
    const k = evidenceKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

/** Merge read-only relations from several providers: keep every provenance, dedupe exact locations. */
export function mergeRelations(lists: readonly (readonly AnyRelation[])[]): MergedRelation[] {
  const byKey = new Map<string, MergedRelation>();
  for (const list of lists) {
    for (const r of list) {
      const key = relationKey(r);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...r, evidence: [...r.evidence], limitations: [...r.limitations], provenances: [r.provenance] });
        continue;
      }
      existing.provenances.push(r.provenance);
      existing.evidence = mergeEvidence(existing.evidence, r.evidence);
      existing.limitations = [...new Set([...existing.limitations, ...r.limitations])];
      if (CONFIDENCE_ORDER[r.confidence] < CONFIDENCE_ORDER[existing.confidence]) existing.confidence = r.confidence;
    }
  }
  return [...byKey.values()];
}

/** Group relations in the single product-wide order (RELATION_GROUP_ORDER); empty groups are omitted. */
export function groupRelations(relations: readonly MergedRelation[]): RelationGroupView[] {
  const groups: RelationGroupView[] = [];
  for (const group of RELATION_GROUP_ORDER) {
    const items = relations.filter((r) => r.group === group).sort(compareRelations);
    if (items.length > 0) groups.push({ group, relations: items });
  }
  // Groups unknown to this client (newer backend) are not dropped silently: appended in name order.
  const known = new Set<string>(RELATION_GROUP_ORDER);
  const extra = [...new Set(relations.map((r) => r.group).filter((g) => !known.has(g)))].sort(compareStrings);
  for (const group of extra) groups.push({ group, relations: relations.filter((r) => r.group === group).sort(compareRelations) });
  return groups;
}

export function relationGroupTitle(group: string): string {
  return group.length > 0 ? group[0]!.toUpperCase() + group.slice(1) : group;
}
