import * as vscode from 'vscode';
import { CancelledError, type EngineClient } from '@refyntra/application';
import type { HierarchyDirection, HierarchyItem, SymbolRef } from '@refyntra/contracts';
import { fromRange } from './convert';
import { hierarchyDetail, symbolKindName } from './hierarchyModel';

// VS Code's built-in Call Hierarchy and Type Hierarchy (views, peek, Shift+Alt+H) for C#, answered by Refyntra's own
// Roslyn host (protocol 1.7, code/hierarchy). No other extension is used. Items carry their declaration position only:
// every expansion resolves the symbol again on the current snapshot (symbol ids are valid for one snapshot only).

const KIND: Record<string, vscode.SymbolKind> = {
  class: vscode.SymbolKind.Class,
  struct: vscode.SymbolKind.Struct,
  interface: vscode.SymbolKind.Interface,
  enum: vscode.SymbolKind.Enum,
  record: vscode.SymbolKind.Class,
  delegate: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  constructor: vscode.SymbolKind.Constructor,
  property: vscode.SymbolKind.Property,
  field: vscode.SymbolKind.Field,
  event: vscode.SymbolKind.Event,
  namespace: vscode.SymbolKind.Namespace,
  local: vscode.SymbolKind.Variable,
  parameter: vscode.SymbolKind.Variable,
};

function toKind(s: SymbolRef): vscode.SymbolKind {
  return KIND[symbolKindName(s.kind)] ?? vscode.SymbolKind.Object;
}

interface ItemShape {
  name: string;
  kind: vscode.SymbolKind;
  detail: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

/** A hierarchy item for a symbol with a source file location (anything else is skipped). */
function shape(s: SymbolRef): ItemShape | undefined {
  const loc = s.location;
  if (!loc) return undefined;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(loc.uri, true);
  } catch {
    return undefined;
  }
  if (uri.scheme !== 'file') return undefined;
  const range = fromRange(loc.range);
  return { name: s.name, kind: toKind(s), detail: hierarchyDetail(s), uri, range, selectionRange: range };
}

async function query(engine: EngineClient, uri: vscode.Uri, position: vscode.Position, direction: HierarchyDirection | 'subject', token: vscode.CancellationToken) {
  const source = new vscode.CancellationTokenSource();
  const sub = token.onCancellationRequested(() => source.cancel());
  try {
    const r = await engine.hierarchy({ uri: uri.toString(), position: { line: position.line, character: position.character } }, direction, source.token);
    return r.kind === 'hierarchy' ? r : undefined;
  } catch (e) {
    if (e instanceof CancelledError) return undefined;
    throw e;
  } finally {
    sub.dispose();
    source.dispose();
  }
}

export class RefyntraCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private readonly engine: EngineClient) {}

  async prepareCallHierarchy(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CallHierarchyItem | undefined> {
    const r = await query(this.engine, doc.uri, position, 'subject', token);
    const s = r && shape(r.subject);
    return s ? new vscode.CallHierarchyItem(s.kind, s.name, s.detail, s.uri, s.range, s.selectionRange) : undefined;
  }

  async provideCallHierarchyIncomingCalls(item: vscode.CallHierarchyItem, token: vscode.CancellationToken): Promise<vscode.CallHierarchyIncomingCall[]> {
    const r = await query(this.engine, item.uri, item.selectionRange.start, 'incoming', token);
    return (r?.items ?? []).flatMap((i) => {
      const s = shape(i.symbol);
      return s ? [new vscode.CallHierarchyIncomingCall(new vscode.CallHierarchyItem(s.kind, s.name, s.detail, s.uri, s.range, s.selectionRange), i.fromRanges.map(fromRange))] : [];
    });
  }

  async provideCallHierarchyOutgoingCalls(item: vscode.CallHierarchyItem, token: vscode.CancellationToken): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const r = await query(this.engine, item.uri, item.selectionRange.start, 'outgoing', token);
    return (r?.items ?? []).flatMap((i: HierarchyItem) => {
      const s = shape(i.symbol);
      return s ? [new vscode.CallHierarchyOutgoingCall(new vscode.CallHierarchyItem(s.kind, s.name, s.detail, s.uri, s.range, s.selectionRange), i.fromRanges.map(fromRange))] : [];
    });
  }
}

export class RefyntraTypeHierarchyProvider implements vscode.TypeHierarchyProvider {
  constructor(private readonly engine: EngineClient) {}

  async prepareTypeHierarchy(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const r = await query(this.engine, doc.uri, position, 'subject', token);
    const s = r && shape(r.subject);
    return s ? [new vscode.TypeHierarchyItem(s.kind, s.name, s.detail, s.uri, s.range, s.selectionRange)] : undefined;
  }

  provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
    return this.neighbours(item, 'supertypes', token);
  }

  provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem, token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
    return this.neighbours(item, 'subtypes', token);
  }

  private async neighbours(item: vscode.TypeHierarchyItem, direction: 'supertypes' | 'subtypes', token: vscode.CancellationToken): Promise<vscode.TypeHierarchyItem[]> {
    const r = await query(this.engine, item.uri, item.selectionRange.start, direction, token);
    return (r?.items ?? []).flatMap((i) => {
      const s = shape(i.symbol);
      return s ? [new vscode.TypeHierarchyItem(s.kind, s.name, s.detail, s.uri, s.range, s.selectionRange)] : [];
    });
  }
}

export function registerHierarchy(engine: EngineClient): vscode.Disposable {
  const selector: vscode.DocumentSelector = { scheme: 'file', language: 'csharp' };
  return vscode.Disposable.from(
    vscode.languages.registerCallHierarchyProvider(selector, new RefyntraCallHierarchyProvider(engine)),
    vscode.languages.registerTypeHierarchyProvider(selector, new RefyntraTypeHierarchyProvider(engine)),
  );
}
