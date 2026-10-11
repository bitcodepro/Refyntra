import type { Availability, Position, PrepareResult, RefactorPlanDto, RelatedResult, RevalidateResult, SearchResult, SymbolRef } from '@refyntra/contracts';
import type { AdapterHealth } from '@refyntra/domain';
import {
  type AdapterDescriptor,
  AdapterUnavailableError,
  type CancellationToken,
  type CapabilityTarget,
  type DocumentEvent,
  Emitter,
  type FrameworkAdapter,
  type LanguageAdapter,
  type RelatedTarget,
  type RouteResult,
  RouteUnavailableError,
} from '@refyntra/application';
import { WEB_STYLES_ROUTE_ID, type WebStyleService, type WebSubject } from './webStyles';

// The HTML/CSS route (stylesheets and HTML pages) and the framework module on the TS/JS route. Both answer from the
// in-process index (no server, no process). Read-only: no rename of CSS classes in this version (see capabilities).

export const WEB_STYLES_CAPABILITIES = ['css.related', 'css.renameClass'] as const;

export const WEB_STYLES_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'web',
  providerRouteId: WEB_STYLES_ROUTE_ID,
  displayName: 'HTML/CSS',
  languageIds: ['css', 'scss', 'less', 'html'],
  fileExtensions: ['.css', '.scss', '.less', '.html', '.htm'],
  uriSchemes: ['file'],
  ownership: 'owned-semantic',
  operations: ['related', 'actions'],
  capabilityIds: [...WEB_STYLES_CAPABILITIES],
};

export const RENAME_CLASS_UNAVAILABLE = "Rename CSS class: unavailable — class names in strings can't be proven";
export const RENAME_CLASS_REASON =
  'A class name is plain text in HTML, templates and code (className strings, classList, clsx, server templates, other libraries). Refyntra cannot prove that it finds every use, so it does not offer a rename that could leave some of them behind.';
export const RENAME_MODULE_UNAVAILABLE = 'Rename CSS Module class: unavailable in this version';
export const RENAME_MODULE_REASON =
  'CSS Module classes are reached through the imported object (styles.foo). A rename would also have to change TypeScript/JavaScript members, typings and any dynamic access (styles[name]); this version does not edit across languages.';

export interface WebStylesRouteOptions {
  service: WebStyleService;
  workspaceId: string;
  isTrusted(): boolean;
  /** The application's workspace revision (results are bound to it). */
  revision(): number;
}

function subjectRef(s: WebSubject, uri: string): SymbolRef | null {
  if (s.kind === 'file' || s.kind === 'moduleUse' || s.kind === 'import') return null;
  const sign = s.kind === 'class' || s.kind === 'classUse' ? '.' : s.kind === 'id' || s.kind === 'idUse' ? '#' : s.kind === 'variable' ? '$' : '@mixin ';
  return {
    name: s.name,
    displayName: `${sign}${s.name}`,
    kind: 'other',
    location: { uri, range: s.range },
    origin: 'source',
    provenance: { kind: 'heuristic', providerRouteId: WEB_STYLES_ROUTE_ID, sessionEpoch: 'web', snapshotId: 'web', projectContextId: 'unknown', basis: 'parsed by the bundled CSS/HTML language services' },
  };
}

export class WebStylesLanguageAdapter implements LanguageAdapter {
  readonly descriptor = WEB_STYLES_DESCRIPTOR;
  private readonly healthEmitter = new Emitter<AdapterHealth>();
  private readonly epochEmitter = new Emitter<string | undefined>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  readonly onDidChangeEpoch = this.epochEmitter.event;

  constructor(private readonly o: WebStylesRouteOptions) {
    o.service.index.onChange.add(() => this.epochEmitter.fire(this.currentEpoch()));
  }

  handles(uri: string, languageId?: string): boolean {
    if (!this.descriptor.uriSchemes.includes(uri.slice(0, uri.indexOf(':')).toLowerCase())) return false;
    if (languageId && this.descriptor.languageIds.includes(languageId)) return true;
    return /\.(css|scss|less|html?)$/i.test(uri.split(/[?#]/)[0] ?? uri);
  }

  health(): AdapterHealth {
    const trusted = this.o.isTrusted();
    return {
      adapterId: this.descriptor.adapterId,
      providerRouteId: this.descriptor.providerRouteId,
      displayName: this.descriptor.displayName,
      state: trusted ? 'Ready' : 'TrustRequired',
      ...(trusted ? {} : { reasonCode: 'TrustRequired', message: 'Restricted Mode: HTML/CSS links are shown once the workspace is trusted.' }),
      recoveryActions: [],
      projects: [],
      diagnostics: [],
      restartCount: 0,
    };
  }

  currentEpoch(): string {
    return `web-${this.o.service.index.version}`;
  }

  async start(): Promise<void> {}
  async restart(): Promise<void> {
    this.o.service.index.reset();
  }

  documentEvent(e: DocumentEvent): void {
    if (e.kind === 'close') return; // the watcher and save events keep the disk state
    if (e.text !== undefined) this.o.service.index.fileChanged(e.uri, e.text);
  }

  private result<T>(value: T): RouteResult<T> {
    return { value, providerRouteId: WEB_STYLES_ROUTE_ID, sessionEpoch: this.currentEpoch(), snapshotId: this.currentEpoch(), workspaceRevision: this.o.revision() };
  }

  private requireTrust(): void {
    if (!this.o.isTrusted()) throw new AdapterUnavailableError(this.health());
  }

  async search(): Promise<RouteResult<SearchResult>> {
    return this.result({ items: [], truncated: false, snapshotId: this.currentEpoch() });
  }

  async symbolAt(): Promise<RouteResult<SymbolRef | null>> {
    return this.result(null);
  }

  async related(target: RelatedTarget, token?: CancellationToken): Promise<RouteResult<RelatedResult>> {
    this.requireTrust();
    if (!('uri' in target)) throw new RouteUnavailableError('NoSymbol', 'HTML/CSS Related works on a document position.');
    // The first request scans the workspace (the epoch moves): bind the result to the state after the scan.
    await this.o.service.index.ensureScanned(token);
    const revision = this.o.revision();
    const { subject, relations } = await this.o.service.relationsAt(target.uri, target.position, token);
    const epoch = this.currentEpoch();
    const notes = ['HTML/CSS: parsed by the bundled CSS and HTML language services. Global class and id links are heuristic (matched by name); CSS Module links and SCSS/LESS variables and mixins follow resolved imports.'];
    if (this.o.service.index.truncated) notes.push('HTML/CSS: the workspace has more files than the scan limit; some uses may be missing.');
    return {
      value: { subject: subjectRef(subject, target.uri), relations: relations as RelatedResult['relations'], completeness: 'unknown', scopeNotes: notes, snapshotId: epoch },
      providerRouteId: WEB_STYLES_ROUTE_ID,
      sessionEpoch: epoch,
      snapshotId: epoch,
      workspaceRevision: revision,
    };
  }

  async capabilities(target: CapabilityTarget, token?: CancellationToken): Promise<RouteResult<Availability[]>> {
    this.requireTrust();
    let module = false;
    if (target.uri && target.position) {
      const facts = await this.o.service.factsFor(target.uri, token);
      if (facts) {
        const s = this.o.service.subjectAt(facts, target.uri, target.position as Position);
        module = s.kind === 'class' && s.module;
      }
    }
    const scope = { workspaceId: this.o.workspaceId, ...(target.uri ? { documentUri: target.uri } : {}) };
    return this.result<Availability[]>([
      { capabilityId: 'css.related', providerRouteId: WEB_STYLES_ROUTE_ID, scope, state: 'available', recoveryActions: [], requiredTrust: 'workspace', guarantee: 'heuristic', limitations: [] },
      {
        capabilityId: 'css.renameClass',
        providerRouteId: WEB_STYLES_ROUTE_ID,
        scope,
        state: 'unavailable',
        reasonCode: module ? 'CssModuleRenameNotSupported' : 'ClassNamesInStrings',
        message: module ? `${RENAME_MODULE_UNAVAILABLE} — ${RENAME_MODULE_REASON}` : `${RENAME_CLASS_UNAVAILABLE}. ${RENAME_CLASS_REASON}`,
        recoveryActions: [],
        requiredTrust: 'workspace',
        guarantee: 'heuristic',
        limitations: [],
      },
    ]);
  }

  async prepare(): Promise<RouteResult<PrepareResult>> {
    throw new RouteUnavailableError('ClassNamesInStrings', RENAME_CLASS_UNAVAILABLE);
  }

  async revalidate(_plan: RefactorPlanDto): Promise<RevalidateResult> {
    throw new RouteUnavailableError('ClassNamesInStrings', RENAME_CLASS_UNAVAILABLE);
  }

  discard(): void {}

  async dispose(): Promise<void> {
    this.healthEmitter.dispose();
    this.epochEmitter.dispose();
  }
}

/** Framework module on the TS/JS route: CSS Module members, className strings and ids in code → their rules. */
export function webStylesScriptFramework(service: WebStyleService, scriptRouteIds: readonly string[], isTrusted: () => boolean): FrameworkAdapter {
  const at = async (target: { uri: string; position: Position }, token?: CancellationToken) => {
    if (!isTrusted()) return [];
    const r = await service.relationsAt(target.uri, target.position, token);
    return r.relations;
  };
  return {
    descriptor: { frameworkId: 'web.styles.script', displayName: 'HTML/CSS links', providerRouteIds: scriptRouteIds },
    related: (input) => (input.target ? at(input.target, input.token) : Promise.resolve([])),
    relatedWithoutLanguage: (target, token) => at(target, token),
  };
}
