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
import { DelegatedProviderAdapter, PYTHON_LANGUAGE, RUST_LANGUAGE, TS_JS_ROUTE_ID, createVsCodeProviderBridge } from '@refyntra/adapter-vscode-providers';
import type { Location } from '@refyntra/contracts';
import type { HealthSummary } from '@refyntra/domain';
import { type ProcessLaunch, SinkLogger, createHostTransportFactory, systemClock } from '@refyntra/infrastructure';
import { runActions } from './actions';
import { BUNDLE_SCHEME, BundlePreviewProvider, DebugBundleExporter } from './debugBundle';
import { LogRing } from './debugBundleModel';
import { CSHARP_CAPABILITIES, capabilityTitleOf, commandForCapability } from './capabilityUi';
import { openLocation } from './convert';
import { registerDocumentSync } from './documentSync';
import { registerRuleDiagnostics } from './diagnostics';
import { VsCodeEditApplier } from './editApplier';
import { runFind } from './find';
import { MAIN_MENU, WALKTHROUGH_ID, type WelcomeVariant, welcomeContext } from './gettingStarted';
import { HEALTH_SCHEME, HEALTH_TEXT_COMMAND, HealthDocument, HealthPage, StatusBar } from './health';
import type { HealthPageModel } from './healthPageModel';
import { HostLocator } from './host';
import { VsCodeClientFiles, httpLinkSettings, registerClientIndexSync } from './httpClientFiles';
import { RelatedViewProvider, runRelatedGroupPick } from './related';
import { PREVIEW_SCHEME, PreviewContentProvider, runNativeRename, runRename } from './rename';
import { runCreateAction, undoCreate } from './createFile';
import { runCleanup, undoCleanup } from './cleanup';
import { CSHARP_GENERATE_HANDLER_ACTION, CSHARP_MOVE_TYPE_ACTION } from '@refyntra/contracts';
import { runRestore } from './restore';
import { SolutionService } from './solution';
import { STACK_TRACE_VIEW, StackTraceViewProvider, runOpenStackTrace } from './stackTrace';

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
  /** Number of host processes spawned in this extension host session. */
  hostSpawnCount(): number;
  /** Inject the host path (e2e against the real host); takes effect on the next (re)start. */
  setHostPath(path: string | undefined): void;
  hostLaunches(): ProcessLaunch[];
  /** The single EditApplier (fault injection in e2e tests). */
  editApplier: VsCodeEditApplier;
  /** Process ids of spawned hosts (e2e fault injection kills the last one). */
  hostPids(): number[];
  /** Undo of an applied create-file plan (e2e: the same steps as the "Undo" button). */
  undoCreate(writeSet: readonly import('@refyntra/contracts').PlannedChange[]): Promise<string[]>;
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
}

let engineRef: RefyntraEngine | undefined;

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
  // Python and Rust: the same delegated route over whatever language extension is installed (none is required or bundled).
  for (const language of [PYTHON_LANGUAGE, RUST_LANGUAGE]) registry.registerLanguage(new DelegatedProviderAdapter({ language, workspaceId, tracker, logger, ...createVsCodeProviderBridge(vscode) }));

  // Frontend ↔ backend HTTP links (heuristic): TS/JS client calls matched to the C# route's ASP.NET endpoints.
  const clientFiles = new VsCodeClientFiles();
  const httpLinks = new HttpLinkService({ server: csharp, clientRouteIds: [TS_JS_ROUTE_ID], files: clientFiles, settings: httpLinkSettings(), documentText: (uri) => tracker.get(uri)?.text });
  for (const fw of httpLinks.frameworks()) registry.registerFramework(fw);
  context.subscriptions.push(registerClientIndexSync(httpLinks, clientFiles));

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
  });
  engineRef = engine;

  const health = new HealthDocument(engine, () => solutions.selected());
  const healthPage = new HealthPage(engine, () => solutions.selected(), isTrusted);
  const previews = new PreviewContentProvider();
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
    registerRuleDiagnostics(engine), // OR1001 in the "refyntra" DiagnosticCollection (diagnostics.ts)
    vscode.commands.registerCommand('refyntra.find', () => runFind(engine)),
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
    vscode.commands.registerCommand('refyntra.moveTypeToFile', () => runCreateAction(engine, previews, editApplier, CSHARP_MOVE_TYPE_ACTION)),
    vscode.commands.registerCommand('refyntra.generateHandler', () => runCreateAction(engine, previews, editApplier, CSHARP_GENERATE_HANDLER_ACTION)),
    vscode.commands.registerCommand('refyntra.cleanup', (uri?: unknown) => runCleanup(engine, previews, editApplier, uri)),
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
    setHostPath: (p) => hostLocator.setOverride(p),
    hostLaunches: () => [...launches],
    editApplier,
    undoCreate: (writeSet) => undoCreate(engine, editApplier, writeSet),
    undoCleanup: (entries) => undoCleanup(editApplier, entries),
    previews,
    hostPids: () => [...pids],
    capabilityUi: (id) => ({ title: capabilityTitleOf(id), command: commandForCapability(id) }),
    related,
    debugBundle,
    extensionPath: context.extensionPath,
    welcomeVariant: () => welcome ?? 'ready',
    healthPage: { model: () => healthPage.model(), dispatch: (m) => healthPage.dispatch(m), isOpen: () => healthPage.isOpen(), html: () => healthPage.renderedHtml() },
    statusBarLabel: () => statusBar.accessibleLabel(),
    stackTrace,
  };
}

export async function deactivate(): Promise<void> {
  const e = engineRef;
  engineRef = undefined;
  await e?.dispose();
}
