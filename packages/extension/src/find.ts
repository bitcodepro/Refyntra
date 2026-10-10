import * as vscode from 'vscode';
import { CancelledError, type EngineClient, FIND_FILTER_HINT } from '@refyntra/application';
import type { SymbolKind } from '@refyntra/contracts';
import type { FindItem } from '@refyntra/domain';
import { openLocation, shortPath } from './convert';
import { FindResultsGate, findItemDescription } from './findGate';

const ICONS: Partial<Record<SymbolKind, string>> = {
  namespace: 'symbol-namespace',
  class: 'symbol-class',
  record: 'symbol-class',
  interface: 'symbol-interface',
  struct: 'symbol-struct',
  enum: 'symbol-enum',
  delegate: 'symbol-event',
  method: 'symbol-method',
  constructor: 'symbol-method',
  property: 'symbol-property',
  field: 'symbol-field',
  event: 'symbol-event',
};

interface FindPickItem extends vscode.QuickPickItem {
  item?: FindItem;
}

export const FIND_DEBOUNCE_MS = 200;

/** Find QuickPick: debounced, each new query cancels the previous one; results keep backend order. */
export async function runFind(engine: EngineClient, initialValue = ''): Promise<void> {
  const qp = vscode.window.createQuickPick<FindPickItem>();
  qp.title = 'Refyntra: Find';
  qp.placeholder = `Symbol, endpoint or role — ${FIND_FILTER_HINT}`;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.value = initialValue;
  let cts: vscode.CancellationTokenSource | undefined;
  let timer: NodeJS.Timeout | undefined;
  const gate = new FindResultsGate(initialValue);

  const showHint = () => {
    qp.items = [{ label: '$(info) Type to search', detail: FIND_FILTER_HINT, alwaysShow: true }];
  };

  const search = (value: string) => {
    cts?.cancel();
    cts?.dispose();
    const source = new vscode.CancellationTokenSource();
    cts = source;
    // An empty query lists the solution's types (sorted, limited) instead of nothing.
    const empty = !value.trim();
    qp.busy = true;
    engine.find(empty ? 'type:' : value, source.token).then(
      (r) => {
        if (source.token.isCancellationRequested || !gate.resultsArrived(value)) return;
        const items: FindPickItem[] = [];
        if (empty) items.push({ label: 'Types in the solution — type to search', kind: vscode.QuickPickItemKind.Separator });
        for (const e of r.query.errors) items.push({ label: `$(error) Error: ${e}`, detail: FIND_FILTER_HINT, alwaysShow: true });
        for (const it of r.items) {
          const icon = it.kind === 'endpoint' ? 'globe' : it.kind === 'client' ? 'link' : (it.symbolKind && ICONS[it.symbolKind]) || 'symbol-misc';
          items.push({
            label: `$(${icon}) ${it.label}`,
            description: findItemDescription(it, r.routeLabels),
            detail: [it.detail, it.location ? shortPath(it.location.uri) : undefined, it.provenances.length > 1 ? `${it.provenances.length} providers` : undefined].filter(Boolean).join(' · '),
            alwaysShow: true,
            item: it,
          });
        }
        if (r.truncated) items.push({ label: '$(ellipsis) More results — refine the query', alwaysShow: true });
        if (r.items.length === 0 && r.query.errors.length === 0) items.push({ label: '$(search-stop) No results', detail: FIND_FILTER_HINT, alwaysShow: true });
        if (r.notes.length) {
          items.push({ label: 'Limitations', kind: vscode.QuickPickItemKind.Separator });
          for (const n of r.notes) items.push({ label: `$(warning) Limitation: ${n}`, alwaysShow: true });
        }
        qp.items = items;
        qp.busy = false;
      },
      (e: unknown) => {
        if (e instanceof CancelledError || source.token.isCancellationRequested || !gate.resultsArrived(value)) return;
        qp.items = [{ label: `$(error) Error: ${e instanceof Error ? e.message : String(e)}`, alwaysShow: true }];
        qp.busy = false;
      },
    );
  };

  qp.onDidChangeValue((v) => {
    if (timer) clearTimeout(timer);
    // The shown items belong to the previous query: replace them at once, Enter waits for the new results.
    gate.setValue(v);
    qp.items = [{ label: '$(loading~spin) Searching…', alwaysShow: true }];
    qp.busy = true;
    timer = setTimeout(() => search(v), FIND_DEBOUNCE_MS);
  });
  qp.onDidAccept(() => {
    const picked = gate.accept(qp.selectedItems[0]?.item);
    if (!picked?.location) return;
    qp.hide();
    void openLocation(picked.location);
  });
  qp.onDidHide(() => {
    if (timer) clearTimeout(timer);
    cts?.cancel();
    cts?.dispose();
    qp.dispose();
  });
  showHint();
  search(initialValue);
  qp.show();
}
