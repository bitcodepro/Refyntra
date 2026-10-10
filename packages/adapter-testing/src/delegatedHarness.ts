import { DelegatedProviderAdapter } from '@refyntra/adapter-vscode-providers';
import type { CommandExecutor, DelegatedLanguage } from '@refyntra/adapter-vscode-providers';
import { AdapterRegistry, DocumentTracker, ProtocolLanguageAdapter, RefyntraEngine } from '@refyntra/application';
import { FakeClock, FixtureWiringFramework, MemoryLogger, WorldEditApplier } from './fakes';
import { type FakeSyntax, FakeProviderWorld } from './fakeProviders';
import { sha256 } from './fixtureEngine';
import { FixtureRoute, fixtureDescriptor } from './harness';
import { FixtureWorld } from './fixtureEngine';

export const TS_FILES: Record<string, string> = {
  'file:///ws/src/orders.ts': 'export function getOrder(id: number) {\n  return id;\n}\nexport class OrderService {}\n',
  'file:///ws/src/use.ts': "import { getOrder } from './orders';\nconst order = getOrder(1);\n",
  'file:///ws/src/view.tsx': 'const label = getOrder(2);\n',
  'file:///ws/README.md': 'class OrderNotes\n',
};

export interface DelegatedWorkspaceOptions {
  files?: Record<string, string>;
  applyRenameEnabled?: boolean;
  staleRetries?: number;
  /** Also register the owned fixture route (a stand-in for C#) before the delegated route. */
  withFixtureRoute?: boolean;
  /** Fixture files for the owned route. */
  fixtureFiles?: Record<string, string>;
  /** Wraps the fake command executor (e.g. to duplicate or corrupt results). */
  wrapCommands?: (inner: CommandExecutor) => CommandExecutor;
  /** The delegated language family (default: TypeScript/JavaScript) and the fake provider's syntax for it. */
  language?: DelegatedLanguage;
  syntax?: FakeSyntax;
  /** Provider probe delays after a document opens (languages that report a missing provider). */
}

export interface DelegatedWorkspace {
  world: FakeProviderWorld;
  engine: RefyntraEngine;
  tracker: DocumentTracker;
  registry: AdapterRegistry;
  adapter: DelegatedProviderAdapter;
  applier: WorldEditApplier;
  logger: MemoryLogger;
  settings: { applyRename: boolean };
  fixture?: { route: FixtureRoute; adapter: ProtocolLanguageAdapter; world: FixtureWorld };
  /** Opens a document in the fake editor (buffer + editor event). */
  open(uri: string, languageId?: string): void;
  dispose(): Promise<void>;
}

const languageOf = (uri: string) => (uri.endsWith('.py') || uri.endsWith('.pyi') ? 'python' : uri.endsWith('.rs') ? 'rust' : uri.endsWith('.tsx') ? 'typescriptreact' : uri.endsWith('.jsx') ? 'javascriptreact' : /\.[cm]?js$/.test(uri) ? 'javascript' : 'typescript');

/**
 * Composition root for delegated-route tests: the same RefyntraEngine and registry as production, the real
 * DelegatedProviderAdapter, and a fake of VS Code's public provider commands instead of the editor.
 */
export function createDelegatedWorkspace(o: DelegatedWorkspaceOptions = {}): DelegatedWorkspace {
  const world = new FakeProviderWorld(o.files ?? TS_FILES, o.syntax);
  const tracker = new DocumentTracker();
  const registry = new AdapterRegistry();
  const logger = new MemoryLogger();
  const settings = { applyRename: o.applyRenameEnabled ?? false };
  const workspaceId = 'ws-delegated';

  let fixture: DelegatedWorkspace['fixture'];
  if (o.withFixtureRoute) {
    const fw = new FixtureWorld(o.fixtureFiles ?? {});
    const route = new FixtureRoute(fw, fixtureDescriptor(), 'memory');
    const adapter = new ProtocolLanguageAdapter({
      descriptor: route.descriptor,
      workspaceId,
      transportFactory: route.factory,
      tracker,
      trust: { isTrusted: () => true },
      target: { resolveTarget: async () => ({ kind: 'path', path: 'file:///ws/fixture.sln' }) },
      clock: new FakeClock(),
      logger,
      client: { name: 'refyntra-tests', version: '0.0.0' },
      shutdownTimeoutMs: 50,
    });
    registry.registerLanguage(adapter);
    registry.registerFramework(new FixtureWiringFramework(route.descriptor.providerRouteId));
    fixture = { route, adapter, world: fw };
  }

  const adapter = new DelegatedProviderAdapter({
    ...(o.language ? { language: o.language } : {}),
    workspaceId,
    commands: o.wrapCommands ? o.wrapCommands(world.commands) : world.commands,
    values: world.values,
    documents: world.documents,
    hash: sha256,
    tracker,
    logger,
  });
  registry.registerLanguage(adapter);

  const applier = new WorldEditApplier(
    { files: world.files },
    (uri) => world.buffers.get(uri) ?? fixture?.world.files.get(uri),
    (uri, text) => {
      // VS Code's applyEdit loads closed targets into (dirty) buffers.
      world.buffers.set(uri, text);
      const open = tracker.get(uri);
      tracker.change(uri, open?.languageId ?? languageOf(uri), (open?.version ?? 0) + 1, text, true);
    },
  );

  const engine = new RefyntraEngine({
    workspaceId,
    registry,
    tracker,
    editApplier: applier,
    settings: { applyRenameEnabled: () => settings.applyRename },
    logger,
    isTrusted: () => true,
    ...(o.staleRetries !== undefined ? { staleRetries: o.staleRetries } : {}),
  });

  world.onBufferEdit = (uri, text) => {
    const open = tracker.get(uri);
    engine.documentChanged(uri, open?.languageId ?? languageOf(uri), (open?.version ?? 0) + 1, text, true);
  };

  return {
    world,
    engine,
    tracker,
    registry,
    adapter,
    applier,
    logger,
    settings,
    ...(fixture ? { fixture } : {}),
    open(uri: string, languageId = languageOf(uri)) {
      const text = world.text(uri) ?? '';
      world.buffers.set(uri, text);
      engine.documentOpened(uri, languageId, 1, text, false);
    },
    dispose: () => engine.dispose(),
  };
}
