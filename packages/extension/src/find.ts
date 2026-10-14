import * as vscode from 'vscode';
import { CancelledError, type EngineClient, FIND_FILTER_HINT } from '@refyntra/application';
import type { SymbolKind } from '@refyntra/contracts';
import type { FindItem } from '@refyntra/domain';
import { openLocation, shortPath } from './convert';
import { metadataService } from './metadata';
import { FindResultsGate, findItemDescription } from './findGate';
import { MatchRank, type RankedCandidate, type SearchCandidate, SECTION_TITLES, commandTitles, groupSections, parseQuery, pushRecent, rankCandidates, recentKey } from './searchEverywhereModel';

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

type LocalPayload = { kind: 'file'; uri: vscode.Uri } | { kind: 'command'; id: string } | { kind: 'setting'; key: string };

interface FindPickItem extends vscode.QuickPickItem {
  item?: FindItem;
  local?: RankedCandidate<LocalPayload>;
}

const RECENT_KEY = 'refyntra.searchEverywhere.recent';
const LOCAL_LIMIT = 15;
let recentState: vscode.Memento | undefined;
/** Called once at activation so Search Everywhere can rank recently picked items first (per workspace). */
export function initSearchEverywhere(state: vscode.Memento): void {
  recentState = state;
}

const recentList = (): string[] => recentState?.get<string[]>(RECENT_KEY) ?? [];
const remember = (key: string): void => void recentState?.update(RECENT_KEY, pushRecent(recentList(), key));

/** Commands of all installed extensions (built-in ones included) with their contributed titles. */
function commandCandidates(): SearchCandidate<LocalPayload>[] {
  const out: SearchCandidate<LocalPayload>[] = [];
  const seen = new Set<string>();
  for (const ext of vscode.extensions.all) {
    for (const [id, title] of commandTitles(ext.packageJSON ?? {})) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ section: 'commands', name: title, alt: id, payload: { kind: 'command', id } });
    }
  }
  return out;
}

function settingCandidates(): SearchCandidate<LocalPayload>[] {
  const own = vscode.extensions.all.find((e) => e.packageJSON?.name === 'refyntra' && e.packageJSON?.publisher === 'refyntra');
  const conf = own?.packageJSON?.contributes?.configuration;
  const props: Record<string, { description?: string; markdownDescription?: string }> = Object.assign({}, ...(Array.isArray(conf) ? conf : [conf ?? {}]).map((c: { properties?: object }) => c.properties ?? {}));
  return Object.entries(props).map(([key, v]) => ({ section: 'settings' as const, name: key, alt: v.description ?? v.markdownDescription, payload: { kind: 'setting' as const, key } }));
}

async function fileCandidates(): Promise<SearchCandidate<LocalPayload>[]> {
  const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,bin,obj,.git,dist,out}/**', 20000);
  return uris.map((uri) => ({ section: 'files' as const, name: uri.path.slice(uri.path.lastIndexOf('/') + 1), alt: vscode.workspace.asRelativePath(uri), payload: { kind: 'file' as const, uri } }));
}

const TYPE_KINDS: readonly string[] = ['class', 'record', 'interface', 'struct', 'enum', 'delegate'];
const isTypeItem = (it: FindItem): boolean => !!it.symbolKind && TYPE_KINDS.includes(it.symbolKind);

const TYPE_CACHE_LIMIT = 5000;
const ENGINE_FILTER = /(^|\s)(type|member|project|route|method|entity|table|client|css|component|page):/i;

/** Types the engine did not return that match the query by camel humps (e.g. `OSvc` → OrderService). */
function camelHumpTypes(query: string, types: SearchCandidate<FindItem>[], engineItems: readonly FindItem[]): FindItem[] {
  if (!query) return [];
  const have = new Set(engineItems.map((i) => i.label));
  return (rankCandidates(query, types, { recent: recentList(), limitPerSection: 20 }) ?? [])
    .filter((r) => r.rank === MatchRank.CamelHump && !have.has(r.name))
    .map((r) => r.payload);
}

export interface SearchEverywhereState {
  value: string;
  /** Files and the type list for camel humps are loaded. */
  ready: boolean;
  generation: number;
  items: { label: string; separator: boolean; section?: string }[];
}
let searchState: SearchEverywhereState = { value: '', ready: false, generation: 0, items: [] };
/** Test hook: the items of the open Search Everywhere QuickPick (tests wait on it instead of sleeping). */
export const searchEverywhereState = (): SearchEverywhereState => searchState;

const LOCAL_ICONS = { file: 'file', command: 'terminal-cmd', setting: 'settings-gear' } as const;

function localItems(query: string, candidates: SearchCandidate<LocalPayload>[], only: 'files' | 'commands' | 'settings' | undefined): FindPickItem[] {
  const ranked = rankCandidates(query, only ? candidates.filter((c) => c.section === only) : candidates, { recent: recentList(), limitPerSection: only ? 200 : LOCAL_LIMIT }) ?? [];
  const items: FindPickItem[] = [];
  for (const g of groupSections(ranked)) {
    items.push({ label: SECTION_TITLES[g.section], kind: vscode.QuickPickItemKind.Separator });
    for (const r of g.items) {
      items.push({
        label: `$(${LOCAL_ICONS[r.payload.kind]}) ${r.name}`,
        description: r.payload.kind === 'command' ? r.payload.id : r.alt,
        detail: r.recent ? 'recent' : undefined,
        alwaysShow: true,
        local: r,
      });
    }
  }
  return items;
}

export const FIND_DEBOUNCE_MS = 200;

const ADD_TO_TASK_CONTEXT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: 'Add to Task Context' };

/** Find QuickPick: debounced, each new query cancels the previous one; results keep backend order. */
export async function runFind(engine: EngineClient, initialValue = ''): Promise<void> {
  const qp = vscode.window.createQuickPick<FindPickItem>();
  qp.title = 'Refyntra: Find (Search Everywhere)';
  qp.placeholder = `Types, symbols, files, commands, settings — # symbols, / files, > commands, @ settings — ${FIND_FILTER_HINT}`;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.value = initialValue;
  let cts: vscode.CancellationTokenSource | undefined;
  let timer: NodeJS.Timeout | undefined;
  const gate = new FindResultsGate(initialValue);
  // Search Everywhere: local sections (files, commands, settings) next to the engine's types and symbols.
  let local: SearchCandidate<LocalPayload>[] = [...commandCandidates(), ...settingCandidates()];
  let localItemsShown: FindPickItem[] = [];
  // Types for camel-hump matching (the engine matches substrings only): fetched once per QuickPick.
  let typeCandidates: SearchCandidate<FindItem>[] = [];
  let pending = 2;
  const loaded = () => {
    if (--pending === 0 && !disposed && qp.value.trim()) search(qp.value);
  };
  void fileCandidates().then((f) => {
    local = [...f, ...local];
  }, () => undefined).finally(loaded);
  void engine.find('type:', undefined, TYPE_CACHE_LIMIT).then((r) => {
    typeCandidates = r.items.filter(isTypeItem).map((it) => ({ section: 'types' as const, name: it.label, payload: it }));
  }, () => undefined).finally(loaded);
  let disposed = false;
  const publish = (items: FindPickItem[]) => {
    qp.items = items;
    qp.busy = false;
    searchState = { value: qp.value, ready: pending === 0, generation: searchState.generation + 1, items: items.map((i) => ({ label: i.label, separator: i.kind === vscode.QuickPickItemKind.Separator, ...(i.local ? { section: i.local.section } : {}) })) };
  };

  const showHint = () => {
    qp.items = [{ label: '$(info) Type to search', detail: FIND_FILTER_HINT, alwaysShow: true }];
  };

  const search = (value: string) => {
    const parsed = parseQuery(value);
    // Engine filters (type:, member:, …) keep the classic Find; prefixes /, >, @ search locally only.
    const engineFilter = !parsed.only && ENGINE_FILTER.test(value);
    const onlyLocal = parsed.only === 'files' || parsed.only === 'commands' || parsed.only === 'settings';
    localItemsShown = engineFilter || parsed.only === 'symbols' || !parsed.text ? [] : localItems(parsed.text, local, onlyLocal ? (parsed.only as 'files' | 'commands' | 'settings') : undefined);
    if (onlyLocal) {
      cts?.cancel();
      gate.resultsArrived(value);
      publish(localItemsShown.length ? localItemsShown : [{ label: '$(search-stop) No results', alwaysShow: true }]);
      return;
    }
    const engineQuery = parsed.only === 'symbols' ? parsed.text : value;
    cts?.cancel();
    cts?.dispose();
    const source = new vscode.CancellationTokenSource();
    cts = source;
    // An empty query lists the solution's types (sorted, limited) instead of nothing.
    const empty = !engineQuery.trim();
    qp.busy = true;
    engine.find(empty ? 'type:' : engineQuery, source.token).then(
      (r) => {
        if (source.token.isCancellationRequested || !gate.resultsArrived(value)) return;
        const items: FindPickItem[] = [];
        if (empty) items.push({ label: 'Types in the solution — type to search', kind: vscode.QuickPickItemKind.Separator });
        for (const e of r.query.errors) items.push({ label: `$(error) Error: ${e}`, detail: FIND_FILTER_HINT, alwaysShow: true });
        let section = '';
        const humpTypes = empty || engineFilter || parsed.only === 'symbols' ? [] : camelHumpTypes(parsed.text, typeCandidates, r.items);
        const ordered = empty ? r.items : [...r.items.filter(isTypeItem), ...humpTypes, ...r.items.filter((x) => !isTypeItem(x))];
        for (const it of ordered) {
          const isType = isTypeItem(it);
          const next = isType ? 'Types' : 'Symbols';
          if (!empty && next !== section) {
            section = next;
            items.push({ label: next, kind: vscode.QuickPickItemKind.Separator });
          }
          const icon = it.kind === 'endpoint' ? 'globe' : it.kind === 'client' ? 'link' : it.kind === 'style' ? 'symbol-color' : (it.symbolKind && ICONS[it.symbolKind]) || 'symbol-misc';
          items.push({
            label: `$(${icon}) ${it.label}`,
            description: findItemDescription(it, r.routeLabels),
            detail: [it.detail, it.location ? shortPath(it.location.uri) : undefined, it.provenances.length > 1 ? `${it.provenances.length} providers` : undefined].filter(Boolean).join(' · '),
            alwaysShow: true,
            item: it,
            ...(it.location ? { buttons: [ADD_TO_TASK_CONTEXT] } : {}),
          });
        }
        if (r.truncated) items.push({ label: '$(ellipsis) More results — refine the query', alwaysShow: true });
        if (ordered.length === 0 && localItemsShown.length === 0 && r.query.errors.length === 0) items.push({ label: '$(search-stop) No results', detail: FIND_FILTER_HINT, alwaysShow: true });
        items.push(...localItemsShown);
        if (r.notes.length) {
          items.push({ label: 'Limitations', kind: vscode.QuickPickItemKind.Separator });
          for (const n of r.notes) items.push({ label: `$(warning) Limitation: ${n}`, alwaysShow: true });
        }
        publish(items);
      },
      (e: unknown) => {
        if (e instanceof CancelledError || source.token.isCancellationRequested || !gate.resultsArrived(value)) return;
        publish([{ label: `$(error) Error: ${e instanceof Error ? e.message : String(e)}`, alwaysShow: true }]);
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
    const sel = qp.selectedItems[0]?.local;
    if (sel) {
      qp.hide();
      remember(recentKey(sel));
      const p = sel.payload;
      if (p.kind === 'file') void vscode.window.showTextDocument(p.uri);
      else if (p.kind === 'command') void vscode.commands.executeCommand(p.id);
      else void vscode.commands.executeCommand('workbench.action.openSettings', p.key);
      return;
    }
    const picked = gate.accept(qp.selectedItems[0]?.item);
    if (picked && !picked.location && picked.symbol?.origin === 'metadata' && picked.symbol.symbolId) {
      // A library symbol: its decompiled source (go to metadata, protocol 1.16).
      qp.hide();
      void metadataService()?.openSymbol(picked.symbol, 'Find');
      return;
    }
    if (!picked?.location) return;
    qp.hide();
    remember(`${isTypeItem(picked) ? 'types' : 'symbols'}:${picked.label}`);
    void openLocation(picked.location);
  });
  qp.onDidTriggerItemButton((e) => {
    if (e.item.item) void vscode.commands.executeCommand('refyntra.taskContext.addFindItem', e.item.item);
  });
  qp.onDidHide(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    cts?.cancel();
    cts?.dispose();
    qp.dispose();
  });
  showHint();
  search(initialValue);
  qp.show();
}
