import type {
  Availability,
  Position,
  PrepareResult,
  RefactorPlanDto,
  RelatedResult,
  RevalidateResult,
  SearchFilters,
  SearchResult,
  SymbolRef,
} from '@refyntra/contracts';
import type { AdapterHealth, AnyRelation, DelegatedRefactorPlan } from '@refyntra/domain';
import type { CancellationToken } from './cancellation';
import type { DocumentEvent } from './documents';
import type { Disposable } from './util';

export type AdapterOperation = 'find' | 'related' | 'actions' | 'rename';

export interface AdapterDescriptor {
  /** Stable id, e.g. "csharp". */
  adapterId: string;
  /** Route id used in provenance and availability, e.g. "csharp.roslyn". */
  providerRouteId: string;
  /** Short user-facing name, e.g. "C#". */
  displayName: string;
  languageIds: readonly string[];
  /** Lower-case file extensions including the dot, e.g. ".cs". */
  fileExtensions: readonly string[];
  /** URI schemes this route serves; the C# route serves `file` only. */
  uriSchemes: readonly string[];
  ownership: 'owned-semantic' | 'delegated';
  operations: readonly AdapterOperation[];
  /** Action id used for `refactor/prepare` rename. */
  renameActionId?: string;
  /** Capability ids the route can report (used to explain unavailability when the route is down). */
  capabilityIds: readonly string[];
}

/** A semantic result bound to the backend state it was computed on. */
export interface RouteResult<T> {
  value: T;
  providerRouteId: string;
  sessionEpoch: string;
  snapshotId: string;
  workspaceRevision: number;
}

export interface SearchRequest {
  query: string;
  filters: SearchFilters;
  limit: number;
}

export type RelatedTarget = { uri: string; position: Position } | { symbolId: string };

export interface CapabilityTarget {
  uri?: string;
  position?: Position;
  symbolId?: string;
}

export interface PrepareRequest {
  symbolId: string;
  newName: string;
  actionId: string;
  /** File rename: ask for the rename of the files named after the type (included only when proven safe). */
  renameFile?: boolean;
  /** Generate handler: one of the offered folder choices. */
  targetFolderUri?: string;
  /** Move Type to File: the document of the cursor. */
  documentUri?: string;
}

export interface DelegatedRenameRequest {
  uri: string;
  position: Position;
  newName: string;
}

export type DelegatedPrepareResult =
  | { kind: 'prepared'; plan: DelegatedRefactorPlan }
  /** `nativeFallback`: Refyntra cannot confirm safety, but the editor's own Rename may still work. */
  | { kind: 'unavailable'; reasonCode: string; message: string; nativeFallback: boolean };

/**
 * Rename of a delegated route: the edit comes from a public provider dispatch whose project context,
 * snapshot and read set are unknown. The application keeps the shared lifecycle, preview and EditApplier.
 */
export interface DelegatedRenamePort {
  /** Steps 1–3: fixes fingerprints, asks the provider, refuses resource/opaque/non-file edits. */
  prepare(req: DelegatedRenameRequest, token?: CancellationToken): Promise<RouteResult<DelegatedPrepareResult>>;
  /**
   * Step 5: asks the provider again on the current state. `limited` only when the returned edit is identical to the
   * preview and every observed fingerprint is unchanged; `stale` otherwise. Never `valid`.
   */
  revalidate(plan: DelegatedRefactorPlan, token?: CancellationToken): Promise<RevalidateResult>;
}

/** Port for one language owner. One instance per route. */
export interface LanguageAdapter {
  readonly descriptor: AdapterDescriptor;
  handles(uri: string, languageId?: string): boolean;
  health(): AdapterHealth;
  readonly onDidChangeHealth: (listener: (h: AdapterHealth) => void) => Disposable;
  /** Fires with the new epoch (or undefined while no session exists) whenever the backend session changes. */
  readonly onDidChangeEpoch: (listener: (epoch: string | undefined) => void) => Disposable;
  currentEpoch(): string | undefined;
  start(): Promise<void>;
  restart(reason: string): Promise<void>;
  /** Already routed to this adapter. Sent immediately with full text. */
  documentEvent(e: DocumentEvent): void;
  search(req: SearchRequest, token?: CancellationToken): Promise<RouteResult<SearchResult>>;
  symbolAt(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<SymbolRef | null>>;
  related(target: RelatedTarget, token?: CancellationToken): Promise<RouteResult<RelatedResult>>;
  capabilities(target: CapabilityTarget, token?: CancellationToken): Promise<RouteResult<Availability[]>>;
  prepare(req: PrepareRequest, token?: CancellationToken): Promise<RouteResult<PrepareResult>>;
  revalidate(plan: RefactorPlanDto, token?: CancellationToken): Promise<RevalidateResult>;
  discard(planId: string): void;
  /**
   * File rename host resync: files renamed by an applied plan (in the document sequence). Returns false when the backend
   * cannot take it (older protocol, no session); the caller then restarts the route so nothing stays stale.
   */
  filesRenamed?(files: readonly { oldUri: string; newUri: string }[], workspaceRevision: number): boolean;
  /**
   * Created files host resync: files created by an applied plan (in the document sequence). Returns false when the
   * backend cannot take it (protocol minor < 3, no session); the caller then restarts the route.
   */
  filesCreated?(uris: readonly string[], workspaceRevision: number): boolean;
  dispose(): Promise<void>;
  /** Present on delegated routes (descriptor.ownership 'delegated') that offer rename. */
  readonly delegatedRename?: DelegatedRenamePort;
  /** Optional: rule analysis (`analysis/run`, e.g. OR1001) on the current snapshot. */
  analyze?(params: { uri?: string }, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').AnalysisRunResult>>;
}

export interface FrameworkDescriptor {
  frameworkId: string;
  displayName: string;
  /** Language routes this module runs on top of. */
  providerRouteIds: readonly string[];
}

export interface FrameworkRelatedInput {
  subject: SymbolRef | null;
  languageResult: RouteResult<RelatedResult>;
  language: LanguageAdapter;
  token?: CancellationToken;
}

/**
 * TS-side framework module over language facts. (C# framework modules run inside the .NET host and arrive as
 * ordinary relations of the C# route.)
 */
export interface FrameworkAdapter {
  readonly descriptor: FrameworkDescriptor;
  related(input: FrameworkRelatedInput): Promise<AnyRelation[]>;
}

function extensionOf(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? uri;
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function schemeOf(uri: string): string {
  const i = uri.indexOf(':');
  return i > 0 ? uri.slice(0, i).toLowerCase() : '';
}

/** Default `handles` implementation shared by adapters. */
export function descriptorHandles(d: AdapterDescriptor, uri: string, languageId?: string): boolean {
  if (!d.uriSchemes.includes(schemeOf(uri))) return false;
  if (languageId && d.languageIds.includes(languageId)) return true;
  return d.fileExtensions.includes(extensionOf(uri));
}

/**
 * Registry + router: exactly one owning language route per document; framework modules attach to
 * routes. Adding a language = registering an adapter here (the composition root), nothing else.
 */
export class AdapterRegistry {
  private readonly languages: LanguageAdapter[] = [];
  private readonly frameworks: FrameworkAdapter[] = [];

  registerLanguage(adapter: LanguageAdapter): void {
    if (this.languages.some((a) => a.descriptor.providerRouteId === adapter.descriptor.providerRouteId)) {
      throw new Error(`Route ${adapter.descriptor.providerRouteId} is already registered`);
    }
    this.languages.push(adapter);
  }

  registerFramework(framework: FrameworkAdapter): void {
    this.frameworks.push(framework);
  }

  languageAdapters(): readonly LanguageAdapter[] {
    return this.languages;
  }

  /** The single owning route for a document (first registered wins; registration order is the priority). */
  routeFor(uri: string, languageId?: string): LanguageAdapter | undefined {
    return this.languages.find((a) => a.handles(uri, languageId));
  }

  byRoute(providerRouteId: string): LanguageAdapter | undefined {
    return this.languages.find((a) => a.descriptor.providerRouteId === providerRouteId);
  }

  frameworksFor(providerRouteId: string): FrameworkAdapter[] {
    return this.frameworks.filter((f) => f.descriptor.providerRouteIds.includes(providerRouteId));
  }
}
