import type { AdapterState, RelationKind } from '@refyntra/contracts';
import type { HealthSummary } from '@refyntra/domain';
import { projectCounts } from '@refyntra/domain';

// One vocabulary for status bar, Health, Related, Actions, Problems (OR1001) and the rename preview:
// same terminology. Pure (no vscode import): unit-tested, and documented in docs/accessibility.md (glossary).
// Rule: a reason code or a state has exactly one phrase; every surface uses it instead of the raw code.

/** The phrase for an adapter state in the status bar label, Health headline, Related and Actions. */
export const STATE_PHRASE: Readonly<Record<AdapterState, string>> = {
  Ready: 'ready',
  Partial: 'works partially',
  Loading: 'loading',
  Restarting: 'restarting',
  NotStarted: 'not started',
  Failed: 'not running',
  TrustRequired: 'Restricted Mode',
  Unsupported: 'not supported',
};

/** How sure a relation or a rule result is. The same three words in Related, Actions and the OR1001 explanation. */
export const CONFIDENCE_PHRASE = { proven: 'proven', likely: 'likely', heuristic: 'heuristic' } as const;

/** One phrase per reason code (host and extension reason codes). Unknown codes fall back to the code itself. */
export const REASON_PHRASE: Readonly<Record<string, string>> = {
  TrustRequired: 'Restricted Mode: the workspace is not trusted',
  NoSolutionFound: 'no solution or project found',
  SdkNotFound: '.NET SDK not found',
  PartialLoad: 'some projects loaded only partially',
  NoProjectsLoaded: 'no project could be loaded',
  WorkspaceNotLoaded: 'the solution is not loaded yet',
  RestartRequested: 'restarting',
  NoLanguageRoute: 'no Refyntra language support for this file',
  RenameNotSupported: 'rename is not provided for this file',
  NoSymbol: 'no symbol at the cursor',
  DocumentChanged: 'the code changed meanwhile',
  Stale: 'the result is outdated',
  StaleSnapshot: 'the result is outdated',
  StartupFailed: 'the backend could not start',
  TransportFailed: 'the backend connection failed',
  RequestFailed: 'the request failed',
  InternalError: 'internal error in the backend',
  ProtocolMismatch: 'backend version does not match',
  Cancelled: 'cancelled',
  // Code Cleanup (per-file skip reasons are in cleanupSummary.ts)
  NoChanges: 'nothing to change',
  NoFilesInScope: 'no C# file of the loaded solution in the scope',
  ScopeTooLarge: 'the scope has too many files',
  NoFixes: 'no supported fix selected',
  // Delegated routes (TS/JS, Python, Rust).
  ServerNotFound: 'the bundled language server is not available for this platform',
  CargoNotFound: 'cargo (the Rust toolchain) was not found; Rust results are limited to open files',
  ServerCrashed: 'the language server stopped repeatedly',
  ServerViewMismatch: 'the language server saw a different file content than Refyntra',
  ProviderUnavailable: 'no language provider answered for this file',
  InvalidName: 'the new name is not valid for this language',
  InsideString: 'the cursor is inside a string',
  PossibleFileOperation: 'the rename may rename or move a file',
  MacroDefinition: 'the rename changes a macro definition',
};

/** The phrase for a reason code, or undefined when the code is unknown. */
export function reasonPhrase(code: string | undefined): string | undefined {
  return code ? REASON_PHRASE[code] : undefined;
}

/** "no solution or project found (NoSolutionFound)": phrase first, the raw code kept for support and debugging. */
export function describeReason(code: string): string {
  const p = reasonPhrase(code);
  return p ? `${p} (${code})` : code;
}

/** Reader-friendly name of a relation kind (the protocol ids like "mediatr.handler" are not shown to users). */
export const RELATION_KIND_LABEL: Readonly<Record<RelationKind, string>> = {
  declaration: 'Declaration',
  'mediatr.handler': 'Handler',
  'mediatr.request': 'Request',
  'mediatr.response': 'Response',
  'mediatr.send': 'Send call',
  'mediatr.notificationHandler': 'Notification handler',
  'mediatr.behavior': 'Pipeline behavior',
  'aspnet.endpoint': 'Endpoint',
  'di.registration': 'DI registration',
  'di.implementation': 'DI implementation',
  'di.service': 'DI service',
  'di.openGenericUsage': 'Open generic usage',
  'efcore.entity': 'Entity',
  'efcore.dbContext': 'DbContext',
  'efcore.configuration': 'Entity configuration',
  'efcore.navigation': 'Navigation',
  'efcore.table': 'Table',
  'efcore.query': 'Query',
  'efcore.migration': 'Migration (read-only)',
  implementation: 'Implementation',
  reference: 'Reference',
  test: 'Test',
};

/**
 * Namespaced kinds contributed by TS-side modules. HTTP links (heuristic): "Client call" is a fetch/axios/HttpClient
 * call site matched to an endpoint (shown under Endpoints from the call, under Clients from the endpoint).
 */
export const MODULE_RELATION_KIND_LABEL: Readonly<Record<string, string>> = {
  'http.call': 'Client call',
  'http.handler': 'Handler (via HTTP route)',
};

export function relationKindLabel(kind: string): string {
  return (RELATION_KIND_LABEL as Readonly<Record<string, string>>)[kind] ?? MODULE_RELATION_KIND_LABEL[kind] ?? kind;
}

export interface RelationLabelInput {
  relationKind: string;
  confidence: 'proven' | 'likely' | 'heuristic';
  target: { label: string; symbol?: { projectName?: string | undefined } | undefined };
  limitations: readonly string[];
}

/**
 * Screen-reader label of a Related item: "Handler GetOrderQueryHandler, Shop.Api, proven". The project (or, without
 * one, the file and line) comes second; limitations are part of the label because the tooltip is not reachable by
 * keyboard.
 */
export function relationAccessibleLabel(r: RelationLabelInput, place?: string): string {
  const where = r.target.symbol?.projectName ?? place;
  const parts = [`${relationKindLabel(r.relationKind)} ${r.target.label}`, where, CONFIDENCE_PHRASE[r.confidence]].filter((p): p is string => !!p);
  const label = parts.join(', ');
  return r.limitations.length ? `${label}. Limitations: ${r.limitations.join('; ')}` : label;
}

/** Visible description of a Related item (same words as the accessible label, no raw protocol ids). */
export function relationDescription(r: RelationLabelInput, place?: string): string {
  return [relationKindLabel(r.relationKind), r.confidence !== 'proven' ? CONFIDENCE_PHRASE[r.confidence] : undefined, r.limitations.length ? 'limited' : undefined, place].filter(Boolean).join(' · ');
}

export function groupAccessibleLabel(title: string, count: number): string {
  return `${title}, ${count} ${count === 1 ? 'item' : 'items'}`;
}

export type MessageIcon = 'warning' | 'info' | 'tools' | 'pulse' | 'sync' | 'loading~spin' | 'error';

const MESSAGE_PREFIX: Readonly<Record<string, string>> = { warning: 'Warning', info: 'Information', tools: 'Action', pulse: 'Action', sync: 'Refreshing', 'loading~spin': 'Loading', error: 'Error' };

/** The icon of a status line says nothing to a screen reader: the label says it in words. */
export function messageAccessibleLabel(icon: string, text: string, isAction: boolean): string {
  const prefix = isAction ? 'Action' : MESSAGE_PREFIX[icon];
  return prefix && !text.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix}: ${text}` : text;
}

/** Status bar label for assistive technology: whole sentences instead of "Partial 7/8". */
export function statusBarLabel(h: HealthSummary): string {
  if (h.adapters.length === 0) return 'Refyntra: no language support registered';
  const parts = h.adapters.map((a) => {
    const { loaded, total } = projectCounts(a);
    const counts = (a.state === 'Partial' || a.state === 'Ready') && total > 0 ? `, ${loaded} of ${total} projects loaded` : '';
    return `${a.displayName} ${STATE_PHRASE[a.state]}${counts}`;
  });
  return `Refyntra: ${parts.join('; ')}. Press Enter for the Refyntra menu.`;
}

/** Glossary rows for docs/accessibility.md (the doc is generated from and checked against this list). */
export const GLOSSARY: ReadonlyArray<{ term: string; meaning: string; where: string }> = [
  { term: 'ready', meaning: 'The backend runs and the whole solution is loaded.', where: 'Status bar, Health headline, Actions' },
  { term: 'works partially', meaning: 'Some projects did not load completely (for example missing NuGet packages). Results may be incomplete.', where: 'Status bar ("Partial 7/8"), Health, Related scope note' },
  { term: 'Restricted Mode', meaning: 'The workspace is not trusted; the C# backend is not started.', where: 'Status bar, Health, Related welcome, Actions' },
  { term: 'not running', meaning: 'The backend could not start or stopped.', where: 'Status bar ("Failed"), Health, Actions' },
  { term: 'proven', meaning: 'Refyntra can show the evidence; the relation or rule result is certain.', where: 'Related, Actions, OR1001 (proof path)' },
  { term: 'likely', meaning: 'Probably right, but not proven (for example a framework version that was not verified).', where: 'Related, scope note' },
  { term: 'heuristic', meaning: 'Found by a naming or shape rule, no proof.', where: 'Related' },
  { term: 'limited', meaning: 'Validation could not check everything; applying asks for an extra confirmation.', where: 'Actions, rename preview ("Validation is limited")' },
  { term: 'incomplete', meaning: 'Results may miss something because projects did not load completely.', where: 'Related scope note, Find notes, rename preview' },
  { term: 'unavailable', meaning: 'A feature cannot run now; the reason and the recovery action are shown.', where: 'Actions, Rename, Health' },
  { term: 'not checked', meaning: 'OR1001 stayed silent because it could not prove a path. Not a problem.', where: 'OR1001 explanation (abstentions), Problems "Explain" action' },
  { term: 'preview', meaning: 'Rename shows files, edits, project contexts and limits first. Nothing changes until Apply rename.', where: 'Rename preview, walkthrough' },
  { term: 'Client call', meaning: 'A fetch/axios/HttpClient call in TypeScript or JavaScript whose literal URL matches an ASP.NET route. Always heuristic.', where: 'Related (Endpoints from the call, Clients from the endpoint), Find client:' },
  { term: 'Clients', meaning: 'The Related group of an endpoint or action that lists its client calls (heuristic).', where: 'Related' },
];

/** The Actions QuickPick row of a feature that cannot run: always starts with the word "Unavailable" (the icon is only decoration). */
export function unavailableDescription(a: { reasonCode?: string | undefined; message?: string | undefined; state: string }): string {
  return `Unavailable: ${reasonPhrase(a.reasonCode) ?? a.message ?? a.reasonCode ?? a.state}`;
}

/** The detail line of an unavailable Actions row: the backend's own message when it adds something, then the recovery. */
export function unavailableDetail(a: { reasonCode?: string | undefined; message?: string | undefined }, recoveryTitle: string | undefined): string | undefined {
  const phrase = reasonPhrase(a.reasonCode);
  const msg = a.message && a.message !== phrase ? a.message : undefined;
  return [msg, recoveryTitle ? `Select to: ${recoveryTitle}` : undefined].filter(Boolean).join(' — ') || undefined;
}

/** Stack trace frames: one phrase per frame status (tree description and screen-reader label). */
export type FrameStatus = 'user' | 'external' | 'ambiguous' | 'missing' | 'bySymbol';
export const FRAME_STATUS_PHRASE: Readonly<Record<FrameStatus, string>> = {
  user: 'your code',
  external: 'external',
  ambiguous: 'several files match',
  missing: 'file not in workspace',
  bySymbol: 'find by symbol',
};
