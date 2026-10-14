import * as vscode from 'vscode';
import {
  type AdapterDescriptor,
  AdapterRegistry,
  DocumentTracker,
  type EngineClient,
  HttpLinkService,
  type LogLevel,
  ProtocolLanguageAdapter,
  RefyntraEngine,
} from '@refyntra/application';
import { DelegatedProviderAdapter, TS_JS_ROUTE_ID, createVsCodeProviderBridge } from '@refyntra/adapter-vscode-providers';
import { WEB_STYLES_ROUTE_ID, WebStyleService, WebStylesLanguageAdapter, webStylesScriptFramework } from '@refyntra/adapter-web-styles';
import { type LspLanguage, LspLanguageAdapter, PYTHON_LSP_LANGUAGE, RUST_LSP_LANGUAGE } from '@refyntra/adapter-lsp';
import type { Location } from '@refyntra/contracts';
import type { HealthSummary } from '@refyntra/domain';
import { type ProcessLaunch, SinkLogger, createHostTransportFactory, createLspConnectionFactory, systemClock } from '@refyntra/infrastructure';
import { CARGO_NOT_FOUND, LspServerLocator, RUST_ANALYZER_SETTINGS, findCargo, pyrightConfiguration } from './lspServers';
import { runActions } from './actions';
import { BUNDLE_SCHEME, BundlePreviewProvider, DebugBundleExporter } from './debugBundle';
import { LogRing } from './debugBundleModel';
import { CSHARP_CAPABILITIES, capabilityTitleOf, commandForCapability } from './capabilityUi';
import { openLocation } from './convert';
import { registerDocumentSync } from './documentSync';
import { registerRuleDiagnostics } from './diagnostics';
import { VsCodeEditApplier } from './editApplier';
import { type SearchEverywhereState, initSearchEverywhere, runFind, searchEverywhereState } from './find';
import { MAIN_MENU, WALKTHROUGH_ID, type WelcomeVariant, welcomeContext } from './gettingStarted';
import { HEALTH_SCHEME, HEALTH_TEXT_COMMAND, HealthDocument, HealthPage, StatusBar } from './health';
import type { HealthPageModel } from './healthPageModel';
import { HostLocator } from './host';
import { VsCodeClientFiles, httpLinkSettings, registerClientIndexSync } from './httpClientFiles';
import { VsCodeWebFiles, registerWebStyleIndexSync } from './webStyleFiles';
import { setupWebFrameworks } from './webWorker';
import { RelatedViewProvider, runRelatedGroupPick } from './related';
import { PREVIEW_SCHEME, PreviewContentProvider, runNativeRename, runRename } from './rename';
import { runCreateAction, undoCreate } from './createFile';
import { runCleanup, undoCleanup } from './cleanup';
import { runChangeSignature, runDelegatedAction, runExtractMethod, runIntroduceParameter, runSafeDelete, undoCode } from './codeRefactor';
import { CSHARP_GENERATE_HANDLER_ACTION, CSHARP_MOVE_TYPE_ACTION } from '@refyntra/contracts';
import { runRestore } from './restore';
import { registerCodeActions } from './codeActions';
import { registerConstructorActions } from './constructorActions';
import { registerEditActions } from './editActions';
import { registerGenerate } from './generate';
import { registerPostfix } from './postfix';
import { type ImmediateViewProvider, registerImmediate } from './immediate';
import { type DebugExtras, registerDebugExtras } from './debugExtras';
import { type CSharpEvaluatableExpressionProvider, type CSharpInlineValuesProvider, registerInlineValues } from './inlineValues';
import { type RefyntraCodeLensProvider, registerCodeLens } from './codeLens';
import { registerHierarchy } from './hierarchy';
import { registerMediatRHover } from './hover';
import { ChangeSignatureDialog } from './changeSignaturePanel';
import { parseCodeActionTarget, parseDelegatedActionArg } from './codeActionsModel';
import { forwardLspDiagnostics } from './lspDiagnostics';
import { forwardFileRenames } from './lspFileRename';
import { SolutionService } from './solution';
import { STACK_TRACE_VIEW, StackTraceViewProvider, runOpenStackTrace } from './stackTrace';
import { type TaskContextViewProvider, registerTaskContext } from './taskContext';
import { type RunService, registerRun } from './run';
import { type TestingService, registerTesting } from './testing';
import { type EfCoreService, registerEfCore } from './efCore';
import { type NavigateToState, acceptNavigateTarget, navigateToState, runNavigateTo } from './navigateTo';
import { type RecentService, registerRecent } from './recent';
import { type FileStructureState, acceptStructureRow, fileStructureState, runFileStructure, setStructureFilter, setStructureQuery } from './fileStructure';
import type { StructureFilter } from './fileStructureModel';
import { type UsagesViewProvider, registerUsages } from './usages';
import { type MetadataService, registerMetadata } from './metadata';
import { type StructuralSearchService, registerStructuralSearch } from './structuralSearch';
import { type SolutionExplorerApi, registerSolutionExplorer } from './solutionExplorer';

export const CSHARP_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'csharp',
  providerRouteId: 'csharp.roslyn',
  displayName: 'C#',
  languageIds: ['csharp'],
  fileExtensions: ['.cs'],
  uriSchemes: ['file'],
  ownership: 'owned-semantic',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'csharp.rename',
  capabilityIds: [...CSHARP_CAPABILITIES],
};

/** Returned from activate() for integration/e2e tests. Not a public API. */
export interface RefyntraTestApi {
  engine: EngineClient;
  health(): HealthSummary;
  statusBarText(): string;
  /** Effective trust as Refyntra sees it. */
  isTrusted(): boolean;
  /** Language servers (Pyright, rust-analyzer) started in this session: command and arguments. */
  lspLaunches(): { command: string; args: string[] }[];
  /** Number of host processes spawned in this extension host session. */
  hostSpawnCount(): number;
  /** Inject the host path (e2e against the real host); takes effect on the next (re)start. */
  setHostPath(path: string | undefined): void;
  hostLaunches(): ProcessLaunch[];
  /** The single EditApplier (fault injection in e2e tests). */
  editApplier: VsCodeEditApplier;
  /** Process ids of spawned hosts (e2e fault injection kills the last one). */
  hostPids(): number[];
  /** Items of the open Search Everywhere (Find) QuickPick, for tests. */
  searchEverywhere(): SearchEverywhereState;
  /** Undo of an applied create-file plan (e2e: the same steps as the "Undo" button). */
  undoCreate(writeSet: readonly import('@refyntra/contracts').PlannedChange[]): Promise<string[]>;
  /** Undo of an applied Safe Delete / Extract Method / Change Signature (e2e: the same steps as the "Undo" button). */
  undoCode(writeSet: readonly import('@refyntra/contracts').PlannedChange[], deletedTexts: ReadonlyMap<string, string>): Promise<string[]>;
  /** Undo of an applied Code Cleanup (e2e: the same steps as the "Undo" button). */
  undoCleanup(entries: readonly import('./cleanupSummary').UndoEntry[]): Promise<string[]>;
  /** Rename preview store (tests read the last preview). */
  previews: PreviewContentProvider;
  /** Title and editor command the UI uses for a capability id (catalogue checks). */
  capabilityUi(capabilityId: string): { title: string; command: string | undefined };
  /** The Related view (state checks in e2e tests). */
  related: RelatedViewProvider;
  /** Export Debug Bundle (tests inject the confirmation and the save target via testHooks). */
  debugBundle: DebugBundleExporter;
  /** Where the extension runs from (install smoke: the installed copy, not the repository). */
  extensionPath: string;
  /** Value of the `refyntra.welcome` context key (which welcome text the Related view shows). */
  welcomeVariant(): WelcomeVariant;
  /** The Health page: its model, and the same message path the webview uses (e2e clicks). */
  healthPage: { model(): HealthPageModel; dispatch(message: unknown): Promise<void>; isOpen(): boolean; html(): string };
  /** The status bar item's screen-reader label. */
  statusBarLabel(): string;
  /** Stack trace navigation (e2e loads a trace, opens frames and injects QuickPick choices). */
  stackTrace: StackTraceViewProvider;
  /** Task context view (e2e adds items, edits code and checks the resolution states). */
  taskContext: TaskContextViewProvider;
  /** React / Next.js / Angular web worker: status and process launches (e2e). */
  webFrameworks: { status(): ReturnType<import('@refyntra/web-frameworks').WebFrameworkService['status']>; launches(): { command: string; args: string[] }[] };
  /** CodeLens provider (e2e resolves lenses and reads scan times). */
  codeLens: RefyntraCodeLensProvider;
  /** The open Change Signature dialog (e2e drives it through the same message path as the page). */
  changeSignatureDialog(): ChangeSignatureDialog | undefined;
  /** Status bar state: loading / ready / problem / idle. */
  statusKind(): string;
  /** Run and Debug (e2e: targets, sessions, opened URLs, debug exit codes, pickers). */
  run: RunService;
  /** Inline debug values / hover chains for C# (e2e: asks the providers directly while stopped). */
  inlineValues: { values: CSharpInlineValuesProvider; hover: CSharpEvaluatableExpressionProvider };
  /** The Immediate Window (e2e: evaluates, expands, reads entries). */
  immediate: ImmediateViewProvider;
  /** Debugger extras for .NET (e2e: Smart Step Into outcome and picks, netcoredbg capabilities, exception types). */
  debugExtras: DebugExtras;
  /** The test runner (Test Explorer, ADR-009): tree, results, runs by id. */
  testing: TestingService;
  /** EF Core tools (ADR-011): the migrations view model, dotnet-ef commands, Show SQL for LINQ. */
  efCore: EfCoreService;
  /** Navigate To (Alt+`): the open list and choosing a target by id (e2e / visual wait on it instead of sleeping). */
  navigateTo: { state(): NavigateToState; accept(id: string): Promise<boolean> };
  /** The Refyntra Usages view (e2e: groupings, filters, Next/Previous, export, pinned tabs). */
  usages: UsagesViewProvider;
  /** Go to metadata (protocol 1.17): open decompiled documents, the store, the command at the cursor (e2e / visual). */
  metadata: MetadataService;
  /** Structural search and replace (protocol 1.19): the panel, the results view and the saved patterns (e2e / visual). */
  structuralSearch: StructuralSearchService;
  /** Recent Files / Recent Locations (e2e: the stored lists, the open list, accept / remove / toggle by id). */
  recent: RecentService;
  /** Solution Explorer, project operations, NuGet panels and project file completion (protocol 1.20, ADR-013). */
  solution: SolutionExplorerApi;
  /** File Structure (Ctrl+F12): the open list, choosing a row, filters and the query (e2e / visual wait on it). */
  fileStructure: { state(): FileStructureState; accept(id: string): Promise<boolean>; setFilter(filter: StructureFilter, on: boolean): Promise<void>; setQuery(text: string): void };
}

let engineRef: RefyntraEngine | undefined;

/** A code action's target ({uri, position}) or undefined (the command then uses the active editor). */
function atTarget(arg: unknown): { uri: string; position: { line: number; character: number } } | undefined {
  const t = parseCodeActionTarget(arg);
  return t ? { uri: t.uri, position: t.position } : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<RefyntraTestApi> {
  const output = vscode.window.createOutputChannel('Refyntra');
  context.subscriptions.push(output);
  // The debug bundle reads the last lines of this channel from a ring (same lines, same redaction).
  const logRing = new LogRing(1000);
  const sink = {
    appendLine: (line: string) => {
      logRing.push(line);
      output.appendLine(line);
    },
  };
  const logger = new SinkLogger(sink, () => vscode.workspace.getConfiguration('refyntra').get<LogLevel>('trace.level', 'info'));
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  logger.log('info', 'extension', 'activating', { version, trusted: vscode.workspace.isTrusted });

  // VS Code always trusts an Extension Development Host workspace, so integration tests simulate Restricted Mode
  // with this switch. It is honoured only when the extension runs in Test mode.
  const forceRestricted = context.extensionMode === vscode.ExtensionMode.Test && process.env.REFYNTRA_TEST_FORCE_RESTRICTED === '1';
  const isTrusted = () => !forceRestricted && vscode.workspace.isTrusted;

  const solutions = new SolutionService(context.workspaceState);
  initSearchEverywhere(context.workspaceState);
  context.subscriptions.push(solutions);
  const hostLocator = new HostLocator(context.extensionPath);
  const launches: ProcessLaunch[] = [];
  const pids: number[] = [];

  const workspaceId = `vscode-${Date.now().toString(36)}-${process.pid}`;
  const tracker = new DocumentTracker();
  const registry = new AdapterRegistry();
  const csharp = new ProtocolLanguageAdapter({
    descriptor: CSHARP_DESCRIPTOR,
    workspaceId,
    transportFactory: createHostTransportFactory({
      resolveLaunch: () => hostLocator.resolve(),
      logger,
      onSpawn: (launch, pid) => {
        launches.push(launch);
        if (pid !== undefined) pids.push(pid);
      },
    }),
    tracker,
    trust: { isTrusted },
    target: solutions,
    clock: systemClock,
    logger,
    client: { name: 'refyntra-vscode', version },
    hostDescription: () => hostLocator.description(),
  });
  // Composition root: adding a language or framework module = registering it here.
  registry.registerLanguage(csharp);
  // TS/JS: delegated route over VS Code's public provider commands; no own process or provider.
  registry.registerLanguage(new DelegatedProviderAdapter({ workspaceId, tracker, logger, ...createVsCodeProviderBridge(vscode) }));
  // Python and Rust: Refyntra's own language-server processes (bundled Pyright and rust-analyzer). No other extension
  // is needed or used; the servers start lazily on the first document in a trusted workspace (never in Restricted Mode).
  const servers = new LspServerLocator(context.extensionPath, context.extensionMode !== vscode.ExtensionMode.Production);
  const lspLaunches: ProcessLaunch[] = [];
  const bridge = createVsCodeProviderBridge(vscode);
  const folders = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const fileChanges = new vscode.EventEmitter<{ uri: string; type: 1 | 2 | 3 }[]>();
  const watcher = vscode.workspace.createFileSystemWatcher('**/{*.py,*.pyi,*.rs,Cargo.toml,Cargo.lock,pyproject.toml,pyrightconfig.json}');
  context.subscriptions.push(
    fileChanges,
    watcher,
    watcher.onDidCreate((u) => fileChanges.fire([{ uri: u.toString(), type: 1 }])),
    watcher.onDidChange((u) => fileChanges.fire([{ uri: u.toString(), type: 2 }])),
    watcher.onDidDelete((u) => fileChanges.fire([{ uri: u.toString(), type: 3 }])),
  );
  const addLsp = (language: LspLanguage, name: string, resolve: () => Promise<ProcessLaunch>, configuration: (section: string | undefined) => unknown, initializationOptions?: unknown, environment?: () => Promise<import('@refyntra/adapter-lsp').EnvironmentNote | undefined>) => {
    const adapter = new LspLanguageAdapter({
      language,
      workspaceId,
      connect: createLspConnectionFactory({
        name,
        resolveLaunch: resolve,
        logger,
        configuration,
        ...(initializationOptions ? { initializationOptions: () => initializationOptions } : {}),
        onSpawn: (launch) => lspLaunches.push(launch),
        clientName: 'refyntra-vscode',
        clientVersion: version,
      }),
      tracker,
      trust: { isTrusted },
      clock: systemClock,
      logger,
      documents: bridge.documents,
      hash: bridge.hash,
      workspaceFolders: () => folders().map((f) => ({ uri: f.uri.toString(), name: f.name })),
      onDidChangeFiles: (listener) => fileChanges.event(listener),
      normalizeUri: (u) => vscode.Uri.parse(u, true).toString(),
      ...(environment ? { environment } : {}),
    });
    registry.registerLanguage(adapter);
    context.subscriptions.push(forwardLspDiagnostics(adapter, name));
    context.subscriptions.push(forwardFileRenames(adapter, language.descriptor.fileExtensions ?? []));
  };
  addLsp(PYTHON_LSP_LANGUAGE, 'pyright', () => servers.pyright(), (section) => pyrightConfiguration(section, folders()));
  addLsp(RUST_LSP_LANGUAGE, 'rust-analyzer', () => servers.rustAnalyzer(), (section) => (section === 'rust-analyzer' ? RUST_ANALYZER_SETTINGS : null), RUST_ANALYZER_SETTINGS, async () => (findCargo() ? undefined : CARGO_NOT_FOUND));

  // Frontend ↔ backend HTTP links (heuristic): TS/JS client calls matched to the C# route's ASP.NET endpoints.
  const clientFiles = new VsCodeClientFiles();
  const httpLinks = new HttpLinkService({ server: csharp, clientRouteIds: [TS_JS_ROUTE_ID], files: clientFiles, settings: httpLinkSettings(), documentText: (uri) => tracker.get(uri)?.text });
  for (const fw of httpLinks.frameworks()) registry.registerFramework(fw);
  context.subscriptions.push(registerClientIndexSync(httpLinks, clientFiles));

  // HTML/CSS/SCSS/LESS ↔ code links: the bundled CSS and HTML language services run in-process (no server, no other
  // extension). A route for stylesheets and HTML pages, and a module on the TS/JS route (CSS Modules, className, ids).
  const webFiles = new VsCodeWebFiles();
  const webStyles = new WebStyleService({ files: webFiles, documentText: (uri) => tracker.get(uri)?.text });
  registry.registerLanguage(new WebStylesLanguageAdapter({ service: webStyles, workspaceId, isTrusted, revision: () => tracker.revision }));
  registry.registerFramework(webStylesScriptFramework(webStyles, [TS_JS_ROUTE_ID], isTrusted));
  context.subscriptions.push(registerWebStyleIndexSync(webStyles.index, webFiles));

  // React / Next.js / Angular: Refyntra's own web worker process (bundled TypeScript + Angular language service,
  // ADR-007). A module on the TS/JS route and, for Angular templates, on the HTML/CSS route (which owns .html).
  const web = setupWebFrameworks({
    extensionPath: context.extensionPath,
    devFallback: context.extensionMode !== vscode.ExtensionMode.Production,
    logger,
    isTrusted,
    openDocuments: () => tracker.openDocuments(),
    routeIds: [TS_JS_ROUTE_ID, WEB_STYLES_ROUTE_ID],
    revision: () => tracker.revision,
  });
  registry.registerFramework(web.service.framework());
  context.subscriptions.push(web.disposable);

  const editApplier = new VsCodeEditApplier();
  const engine = new RefyntraEngine({
    workspaceId,
    registry,
    tracker,
    editApplier,
    settings: { applyRenameEnabled: () => vscode.workspace.getConfiguration('refyntra').get<boolean>('rename.apply', true) },
    logger,
    isTrusted,
    httpLinks,
    webStyles,
    webFrameworks: web.service,
  });
  engineRef = engine;

  // Run and Debug (ADR-008): bundled netcoredbg / debugpy, the host's runnable-project model, js-debug configurations.
  const run = registerRun(context, engine, isTrusted);
  const inlineValues = registerInlineValues();
  const immediate = registerImmediate();
  const debugExtras = registerDebugExtras(engine);
  context.subscriptions.push(run.disposable);
  const testing = registerTesting(engine, run.service.debuggers, isTrusted);
  context.subscriptions.push(testing.disposable);
  // Go to metadata / decompiled sources (protocol 1.17): refyntra-metadata: documents, F12 / hover inside them.
  const metadata = registerMetadata(engine);
  context.subscriptions.push(metadata.disposable);
  // EF Core tools (ADR-011): migrations view, dotnet-ef tasks, Show SQL for LINQ.
  const efCore = registerEfCore(context, engine, isTrusted);
  context.subscriptions.push(efCore.disposable);
  // Solution Explorer, project operations and NuGet (protocol 1.20, ADR-013).
  const solution = registerSolutionExplorer(context, engine, isTrusted, run.service, testing.service, editApplier);
  context.subscriptions.push(solution.disposable);
  const debugStatus = () => ({ ...run.service.debuggers.status(), tests: testing.service.healthText(), decompiler: metadata.service.healthText(), efTools: efCore.service.healthText() });
  const health = new HealthDocument(engine, () => solutions.selected(), debugStatus);
  const healthPage = new HealthPage(engine, () => solutions.selected(), isTrusted, debugStatus);
  const previews = new PreviewContentProvider();
  // Structural Search and Replace (protocol 1.19, ADR-012); its saved inspections feed the rule diagnostics below.
  const structural = registerStructuralSearch(context, engine, previews, editApplier);
  context.subscriptions.push(structural.disposable);
  const bundlePreview = new BundlePreviewProvider();
  const debugBundle = new DebugBundleExporter({
    extensionVersion: version,
    health: () => engine.health(),
    log: logRing,
    preview: bundlePreview,
    testMode: context.extensionMode === vscode.ExtensionMode.Test,
  });
  const statusBar = new StatusBar(engine);
  const related = new RelatedViewProvider(engine, isTrusted);
  const relatedView = vscode.window.createTreeView('refyntra.relatedView', { treeDataProvider: related, showCollapseAll: true });
  related.attach(relatedView);
  const stackTrace = new StackTraceViewProvider(engine);
  const stackTraceView = vscode.window.createTreeView(STACK_TRACE_VIEW, { treeDataProvider: stackTrace, showCollapseAll: true });
  stackTrace.attach(stackTraceView);
  context.subscriptions.push(
    stackTrace,
    stackTraceView,
    vscode.commands.registerCommand('refyntra.openStackTrace', (arg?: unknown) => runOpenStackTrace(stackTrace, arg)),
    vscode.commands.registerCommand('refyntra.stackTrace.openFrame', (arg?: Parameters<StackTraceViewProvider['openFrame']>[0]) => stackTrace.openFrame(arg)),
    vscode.commands.registerCommand('refyntra.stackTrace.related', (arg?: Parameters<StackTraceViewProvider['related']>[0]) => stackTrace.related(arg)),
    vscode.commands.registerCommand('refyntra.stackTrace.clear', () => stackTrace.clear()),
  );
  // Task context: named lists of symbols, files and pinned relations, stored locally in workspaceState (taskContext.ts).
  const taskContext = registerTaskContext(engine, context.workspaceState, related);
  const codeLens = registerCodeLens(engine);
  context.subscriptions.push(codeLens.disposable);
  // Find Usages grouped (protocol 1.12) and Navigate To (Alt+`).
  const usages = registerUsages(engine, context.workspaceState);
  context.subscriptions.push(usages.disposable, vscode.commands.registerCommand('refyntra.navigateTo', () => runNavigateTo(engine)));
  // Recent Files (Ctrl+E) and Recent Locations (Ctrl+Shift+E): local lists per workspace (recent.ts).
  const recent = registerRecent(context.workspaceState);
  context.subscriptions.push(recent.disposable);
  // File Structure (Ctrl+F12): the C# host's code/fileStructure, VS Code's document symbols for other languages.
  context.subscriptions.push(vscode.commands.registerCommand('refyntra.fileStructure', () => runFileStructure(engine, context.workspaceState)));
  context.subscriptions.push(taskContext.disposable);
  void vscode.commands.executeCommand('setContext', 'refyntra.relatedPinned', false);
  // Welcome text of the Related view follows trust / solution / backend state (package.json viewsWelcome).
  let welcome: WelcomeVariant | undefined;
  const updateWelcome = () => {
    const v = welcomeContext(engine.health())['refyntra.welcome'];
    if (v === welcome) return;
    welcome = v;
    void vscode.commands.executeCommand('setContext', 'refyntra.welcome', v);
  };
  updateWelcome();
  context.subscriptions.push(engine.onDidChangeHealth(updateWelcome));

  context.subscriptions.push(
    health,
    healthPage,
    previews,
    statusBar,
    related,
    relatedView,
    vscode.workspace.registerTextDocumentContentProvider(HEALTH_SCHEME, health),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
    bundlePreview,
    vscode.workspace.registerTextDocumentContentProvider(BUNDLE_SCHEME, bundlePreview),
    vscode.commands.registerCommand('refyntra.exportDebugBundle', () => debugBundle.run()),
    registerDocumentSync(engine),
    registerRuleDiagnostics(engine, structural.inspections), // OR1001, the inspections and pattern inspections (diagnostics.ts)
    vscode.commands.registerCommand('refyntra.find', (initial?: unknown) => runFind(engine, typeof initial === 'string' ? initial : '')),
    vscode.commands.registerCommand('refyntra.findEndpoint', () => runFind(engine, 'route:')),
    vscode.commands.registerCommand('refyntra.findHandler', () => runRelatedGroupPick(engine, 'handlers', 'Refyntra: Find Handler')),
    vscode.commands.registerCommand('refyntra.findRegistration', () => runRelatedGroupPick(engine, 'registrations', 'Refyntra: Find DI Registration')),
    vscode.commands.registerCommand('refyntra.related', async () => {
      await vscode.commands.executeCommand('refyntra.relatedView.focus');
      await related.showForActiveEditor();
    }),
    vscode.commands.registerCommand('refyntra.related.pin', () => related.setPinned(true)),
    vscode.commands.registerCommand('refyntra.related.unpin', () => {
      related.setPinned(false);
      void related.showForActiveEditor();
    }),
    vscode.commands.registerCommand('refyntra.related.refresh', () => related.refresh()),
    vscode.commands.registerCommand('refyntra.actions', () => runActions(engine)),
    vscode.commands.registerCommand('refyntra.rename', () => runRename(engine, previews)),
    // Code actions (lightbulb, Ctrl+., Refactor…) pass a {uri, position, range?} target; the palette passes nothing.
    vscode.commands.registerCommand('refyntra.moveTypeToFile', (arg?: unknown) => runCreateAction(engine, previews, editApplier, CSHARP_MOVE_TYPE_ACTION, atTarget(arg))),
    vscode.commands.registerCommand('refyntra.generateHandler', (arg?: unknown) => runCreateAction(engine, previews, editApplier, CSHARP_GENERATE_HANDLER_ACTION, atTarget(arg))),
    vscode.commands.registerCommand('refyntra.cleanup', (uri?: unknown) => runCleanup(engine, previews, editApplier, uri)),
    vscode.commands.registerCommand('refyntra.safeDelete', (arg?: unknown) => runSafeDelete(engine, previews, editApplier, atTarget(arg))),
    vscode.commands.registerCommand('refyntra.delegatedAction', (arg?: unknown) => {
      const r = parseDelegatedActionArg(arg);
      return r ? runDelegatedAction(engine, previews, editApplier, r) : undefined;
    }),
    vscode.commands.registerCommand('refyntra.extractMethod', (arg?: unknown) => {
      const t = parseCodeActionTarget(arg);
      return runExtractMethod(engine, previews, editApplier, t?.range ? { uri: t.uri, range: t.range } : undefined);
    }),
    vscode.commands.registerCommand('refyntra.introduceParameter', (arg?: unknown) => {
      const t = parseCodeActionTarget(arg);
      return runIntroduceParameter(engine, previews, editApplier, t?.range ? { uri: t.uri, range: t.range } : undefined);
    }),
    vscode.commands.registerCommand('refyntra.changeSignature', (arg?: unknown) => runChangeSignature(engine, previews, editApplier, atTarget(arg))),
    registerCodeActions(engine),
    registerConstructorActions(engine, previews, editApplier), // constructor / DI helpers computed by Roslyn (protocol 1.11)
    registerEditActions(engine, previews, editApplier), // Convert / Inline / Introduce edit actions computed by Roslyn (protocol 1.9)
    registerPostfix(engine), // C# postfix templates after a dot (protocol 1.10)
    registerGenerate(engine, editApplier), // Generate… / Alt+Insert (protocol 1.10)
    inlineValues.disposable, // C# inline debug values and hover member chains (inlineValues.ts)
    immediate.disposable, // Refyntra Immediate panel (immediate.ts)
    debugExtras.disposable, // Smart Step Into, Break on Exception Types, notes on unsupported breakpoint options (debugExtras.ts)
    registerHierarchy(engine), // built-in Call / Type Hierarchy for C# (protocol 1.7)
    registerMediatRHover(engine),
    vscode.commands.registerCommand('refyntra.statusMenu', () => statusBar.showMenu()),
    vscode.commands.registerCommand('refyntra.nativeRename', (uri?: unknown, position?: unknown) => runNativeRename(uri, position)),
    vscode.commands.registerCommand('refyntra.runRestore', (target: unknown) => runRestore(isTrusted, target)),
    vscode.commands.registerCommand('refyntra.showHealth', () => healthPage.show()),
    vscode.commands.registerCommand(HEALTH_TEXT_COMMAND, () => health.show()),
    vscode.commands.registerCommand('refyntra.restartBackend', async () => {
      if (!isTrusted()) {
        void vscode.window.showWarningMessage('Refyntra does not start the C# host in Restricted Mode. Trust the workspace first.', 'Manage Workspace Trust').then((p) => p && vscode.commands.executeCommand('workbench.trust.manage'));
        return;
      }
      await engine.restart();
      await web.service.restart();
    }),
    vscode.commands.registerCommand('refyntra.selectSolution', async () => {
      if (await solutions.pick()) await engine.inputsChanged('solution selected');
    }),
    vscode.commands.registerCommand('refyntra.showMenu', async () => {
      const pick = await vscode.window.showQuickPick(MAIN_MENU.map((m) => ({ ...m })), { title: 'Refyntra', placeHolder: 'Choose a Refyntra command' });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
    vscode.commands.registerCommand('refyntra.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false)),
    vscode.commands.registerCommand('refyntra.keyboardShortcuts', () => vscode.commands.executeCommand('workbench.action.openSettings', 'refyntra.keybindings.preset')),
    vscode.commands.registerCommand('refyntra.openLocation', (loc: Location) => openLocation(loc)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (!isTrusted()) return;
      logger.log('info', 'extension', 'workspace trust granted');
      void engine.inputsChanged('workspace trusted');
    }),
  );

  // Status bar only where Refyntra has something to say (a C# workspace).
  void solutions.candidates().then((c) => statusBar.setVisible(c.length > 0 || vscode.workspace.textDocuments.some((d) => d.languageId === 'csharp')));
  // Start in the background: never block activation on the host.
  void engine.start();

  return {
    engine,
    health: () => engine.health(),
    statusBarText: () => statusBar.text(),
    isTrusted,
    hostSpawnCount: () => launches.length,
    lspLaunches: () => lspLaunches.map((l) => ({ command: l.command, args: [...l.args] })),
    setHostPath: (p) => hostLocator.setOverride(p),
    hostLaunches: () => [...launches],
    editApplier,
    undoCreate: (writeSet) => undoCreate(engine, editApplier, writeSet),
    undoCleanup: (entries) => undoCleanup(editApplier, entries),
    undoCode: (writeSet, deletedTexts) => undoCode(engine, editApplier, writeSet, deletedTexts),
    previews,
    hostPids: () => [...pids],
    searchEverywhere: () => searchEverywhereState(),
    capabilityUi: (id) => ({ title: capabilityTitleOf(id), command: commandForCapability(id) }),
    related,
    debugBundle,
    extensionPath: context.extensionPath,
    welcomeVariant: () => welcome ?? 'ready',
    healthPage: { model: () => healthPage.model(), dispatch: (m) => healthPage.dispatch(m), isOpen: () => healthPage.isOpen(), html: () => healthPage.renderedHtml() },
    statusBarLabel: () => statusBar.accessibleLabel(),
    stackTrace,
    taskContext: taskContext.provider,
    webFrameworks: { status: () => web.service.status(), launches: () => web.launches.map((l) => ({ command: l.command, args: [...l.args] })) },
    codeLens: codeLens.provider,
    changeSignatureDialog: () => ChangeSignatureDialog.current,
    statusKind: () => statusBar.kind(),
    run: run.service,
    inlineValues: { values: inlineValues.values, hover: inlineValues.hover },
    immediate: immediate.provider,
    debugExtras: debugExtras.extras,
    testing: testing.service,
    efCore: efCore.service,
    navigateTo: { state: () => navigateToState(), accept: (id) => acceptNavigateTarget(id) },
    usages: usages.provider,
    metadata: metadata.service,
    structuralSearch: structural.service,
    recent: recent.service,
    solution: solution.api,
    fileStructure: { state: () => fileStructureState(), accept: (id) => acceptStructureRow(id), setFilter: (f, on) => setStructureFilter(f, on), setQuery: (t) => setStructureQuery(t) },
  };
}

export async function deactivate(): Promise<void> {
  const e = engineRef;
  engineRef = undefined;
  await e?.dispose();
}
