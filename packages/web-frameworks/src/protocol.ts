import type { Position, RelationGroup } from '@refyntra/contracts';

// Messages between Refyntra (extension host) and its web worker process (src/worker/main.ts). One JSON object per
// line on stdin/stdout. Pure types: no node, no vscode. Locations travel as file URIs (the worker converts paths).

export const WEB_WORKER_PROTOCOL_VERSION = 1;

export interface WorkerLocation {
  uri: string;
  range: { start: Position; end: Position };
}

export type WebEndpointKind = 'next-page' | 'next-route-handler' | 'next-api' | 'angular-route';

export interface WorkerEndpoint {
  kind: WebEndpointKind;
  /** e.g. "/orders/[id]" (Next.js) or "/orders/:id" (Angular). */
  route: string;
  routeIsDynamic: boolean;
  /** Route handlers / API routes: exported HTTP methods; empty = page or unknown. */
  httpMethods: string[];
  location: WorkerLocation;
}

export interface WorkerSymbol {
  name: string;
  /** "class", "function", "property", "variable", ... (SymbolKind words of the contracts). */
  kind: 'class' | 'function' | 'property' | 'variable' | 'method' | 'field' | 'interface' | 'module';
  containerName?: string;
  location?: WorkerLocation;
}

/** One relation as the worker reports it; the client turns it into an AnyRelation with provenance. */
export interface WorkerRelation {
  /** Namespaced kind: react.*, next.*, angular.* (labels in packages/extension/src/terminology.ts). */
  kind: string;
  group: RelationGroup;
  label: string;
  location?: WorkerLocation;
  symbol?: WorkerSymbol;
  endpoint?: WorkerEndpoint;
  confidence: 'proven' | 'likely' | 'heuristic';
  /** How the relation was established ("TypeScript checker", "Angular language service", "Next.js 15 file convention"). */
  basis: string;
  evidence: { description: string; location?: WorkerLocation }[];
  limitations: string[];
}

export interface WorkerFindItem {
  kind: 'component' | 'page';
  label: string;
  description: string;
  detail: string;
  location: WorkerLocation;
  symbol?: WorkerSymbol;
  endpoint?: WorkerEndpoint;
  confidence: 'proven' | 'likely' | 'heuristic';
  basis: string;
}

/** A framework found in a folder with a package.json (versions from node_modules, else the declared range). */
export interface WebProjectInfo {
  /** Folder URI of the package.json. */
  rootUri: string;
  react?: FrameworkVersion;
  next?: FrameworkVersion;
  angular?: FrameworkVersion & { supported: boolean; reason?: string };
}

export interface FrameworkVersion {
  /** Installed version (node_modules) or the declared range. */
  version: string;
  /** Major version, when it can be read. */
  major?: number;
  source: 'installed' | 'declared';
}

/** Unsaved editor text (dirty documents); `text: null` = the document is saved or closed again: use the disk. */
export interface DocumentSync {
  uri: string;
  text: string | null;
}

export interface FileChange {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

export interface InitializeParams {
  protocolVersion: number;
  /** Workspace folder URIs. */
  roots: string[];
}
export interface InitializeResult {
  protocolVersion: number;
  typescriptVersion: string;
  angularLanguageServiceVersion?: string;
  projects: WebProjectInfo[];
  truncated: boolean;
}

export interface RelatedParams {
  uri: string;
  position: Position;
  documents: DocumentSync[];
}
export interface RelatedResult {
  /** Label of the symbol or file the relations are about (absent when nothing web-specific is at the position). */
  subject?: string;
  relations: WorkerRelation[];
  notes: string[];
}

export interface FindParams {
  kind: 'component' | 'page';
  text: string;
  limit: number;
  documents: DocumentSync[];
}
export interface FindResult {
  items: WorkerFindItem[];
  truncated: boolean;
  notes: string[];
}

export interface WorkerMethods {
  initialize: [InitializeParams, InitializeResult];
  related: [RelatedParams, RelatedResult];
  find: [FindParams, FindResult];
  filesChanged: [{ changes: FileChange[] }, { ok: true }];
  memory: [Record<string, never>, { heapUsedMB: number; rssMB: number }];
  shutdown: [Record<string, never>, { ok: true }];
}
export type WorkerMethod = keyof WorkerMethods;

export interface WorkerRequestMessage {
  id: number;
  method: WorkerMethod;
  params: unknown;
}
export interface WorkerResponseMessage {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}
