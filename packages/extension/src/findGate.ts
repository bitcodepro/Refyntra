/**
 * Find QuickPick consistency (pure, unit-tested): the items on screen always belong to the current query. While the
 * query changed and its results have not arrived (debounce or request in flight), Enter is ignored instead of opening
 * a result of the previous query, and late results of an older query are dropped.
 */
export class FindResultsGate {
  private value: string;
  private shownFor: string | undefined;

  constructor(initialValue = '') {
    this.value = initialValue;
  }

  /** The query text changed: the shown items are outdated until results for this value arrive. */
  setValue(value: string): void {
    this.value = value;
  }

  get currentValue(): string {
    return this.value;
  }

  /** Results for `forValue` arrived. Returns false (drop them) when they are not for the current value. */
  resultsArrived(forValue: string): boolean {
    if (forValue !== this.value) return false;
    this.shownFor = forValue;
    return true;
  }

  /** True while the shown items do not belong to the current value. */
  get outdated(): boolean {
    return this.shownFor !== this.value;
  }

  /** The item to open on Enter, or undefined while the shown items are outdated. */
  accept<T>(selected: T | undefined): T | undefined {
    return this.outdated ? undefined : selected;
  }
}

/** Find item description with its route label (Find merges C# and delegated TS/JS results). */
export function findItemDescription(item: { providerRouteId: string; description: string }, routeLabels: Readonly<Record<string, string>> | undefined): string {
  const route = routeLabels?.[item.providerRouteId];
  return [route, item.description].filter((x) => !!x).join(' · ');
}
