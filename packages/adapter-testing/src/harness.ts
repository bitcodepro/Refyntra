import {
  type AdapterDescriptor,
  AdapterRegistry,
  DocumentTracker,
  ProtocolLanguageAdapter,
  RefyntraEngine,
  type RestartPolicy,
  type TransportFactory,
} from '@refyntra/application';
import { FixtureEngine, FixtureWorld } from './fixtureEngine';
import { FakeClock, FixtureWiringFramework, MemoryLogger, WorldEditApplier } from './fakes';
import { type CrashableTransport, type FixtureTransportKind, InMemoryTransport, LoopbackTransport } from './transports';

export function fixtureDescriptor(adapterId = 'fixture', ext = '.fixture', displayName = 'Fixture'): AdapterDescriptor {
  return {
    adapterId,
    providerRouteId: `${adapterId}.engine`,
    displayName,
    languageIds: [adapterId],
    fileExtensions: [ext],
    uriSchemes: ['file'],
    ownership: 'owned-semantic',
    operations: ['find', 'related', 'actions', 'rename'],
    renameActionId: 'fixture.rename',
    capabilityIds: ['fixture.rename'],
  };
}

/** Owns the fake "processes" of one route; tests reach the live engine/transport through it. */
export class FixtureRoute {
  readonly transports: CrashableTransport[] = [];
  /** Hook installed on every new engine (e.g. to inject edits during requests). */
  configureEngine: ((engine: FixtureEngine) => void) | undefined;
  failNextStarts = 0;
  protocolMajor: number | undefined;
  /** Message size limit of the client side of the transport and of initialize.limits (loopback enforces it). */
  maxMessageBytes: number | undefined;

  constructor(
    readonly world: FixtureWorld,
    readonly descriptor: AdapterDescriptor,
    readonly kind: FixtureTransportKind,
  ) {}

  get current(): CrashableTransport | undefined {
    return this.transports[this.transports.length - 1];
  }

  get engine(): FixtureEngine | undefined {
    return this.current?.engine;
  }

  readonly factory: TransportFactory = async () => {
    if (this.failNextStarts > 0) {
      this.failNextStarts -= 1;
      throw new Error('fixture backend failed to start');
    }
    const engine = new FixtureEngine(this.world, {
      routeId: this.descriptor.providerRouteId,
      languageId: this.descriptor.languageIds[0] ?? 'fixture',
      ...(this.protocolMajor !== undefined ? { protocolMajor: this.protocolMajor } : {}),
      ...(this.maxMessageBytes !== undefined ? { maxMessageBytes: this.maxMessageBytes } : {}),
    });
    this.configureEngine?.(engine);
    const t = this.kind === 'memory' ? new InMemoryTransport(engine) : new LoopbackTransport(engine, this.maxMessageBytes);
    this.transports.push(t);
    return t;
  };
}

export interface FixtureWorkspaceOptions {
  transport: FixtureTransportKind;
  files: Record<string, string>;
  /** Register the fake framework module on the fixture route. */
  withFramework?: boolean;
  /** Second, independent route (".fx2") to prove isolation between routes. */
  withSecondRoute?: boolean;
  trusted?: boolean;
  applyRenameEnabled?: boolean;
  staleRetries?: number;
  restartPolicy?: RestartPolicy;
  /** Frame limit of the transport (loopback) and of initialize.limits.maxMessageBytes. */
  maxMessageBytes?: number;
}

export interface FixtureWorkspace {
  world: FixtureWorld;
  engine: RefyntraEngine;
  tracker: DocumentTracker;
  registry: AdapterRegistry;
  clock: FakeClock;
  logger: MemoryLogger;
  applier: WorldEditApplier;
  route: FixtureRoute;
  adapter: ProtocolLanguageAdapter;
  second?: { route: FixtureRoute; adapter: ProtocolLanguageAdapter };
  settings: { applyRename: boolean; trusted: boolean };
  dispose(): Promise<void>;
}

/**
 * Composition root for tests: the only fixture-specific code is the registry composition below — the same
 * RefyntraEngine, use cases, ProtocolLanguageAdapter and plan validator as production.
 */
export function createFixtureWorkspace(o: FixtureWorkspaceOptions): FixtureWorkspace {
  const world = new FixtureWorld(o.files);
  const tracker = new DocumentTracker();
  const registry = new AdapterRegistry();
  const clock = new FakeClock();
  const logger = new MemoryLogger();
  const settings = { applyRename: o.applyRenameEnabled ?? false, trusted: o.trusted ?? true };
  const workspaceId = 'ws-test';

  const makeAdapter = (route: FixtureRoute) =>
    new ProtocolLanguageAdapter({
      descriptor: route.descriptor,
      workspaceId,
      transportFactory: route.factory,
      tracker,
      trust: { isTrusted: () => settings.trusted },
      target: { resolveTarget: async () => ({ kind: 'path', path: 'file:///ws/fixture.sln' }) },
      clock,
      logger,
      client: { name: 'refyntra-tests', version: '0.0.0' },
      shutdownTimeoutMs: 50,
      ...(o.restartPolicy ? { restartPolicy: o.restartPolicy } : {}),
    });

  const route = new FixtureRoute(world, fixtureDescriptor(), o.transport);
  route.maxMessageBytes = o.maxMessageBytes;
  const adapter = makeAdapter(route);
  registry.registerLanguage(adapter);
  if (o.withFramework) registry.registerFramework(new FixtureWiringFramework(route.descriptor.providerRouteId));

  let second: FixtureWorkspace['second'];
  if (o.withSecondRoute) {
    const r2 = new FixtureRoute(world, fixtureDescriptor('fixture2', '.fx2', 'Fixture2'), o.transport);
    const a2 = makeAdapter(r2);
    registry.registerLanguage(a2);
    second = { route: r2, adapter: a2 };
  }

  const applier = new WorldEditApplier(
    world,
    (uri) => tracker.get(uri)?.text,
    (uri, text) => {
      const open = tracker.get(uri);
      if (open) tracker.change(uri, open.languageId, open.version + 1, text, true);
      else world.files.set(uri, text);
    },
  );

  const engine = new RefyntraEngine({
    workspaceId,
    registry,
    tracker,
    editApplier: applier,
    settings: { applyRenameEnabled: () => settings.applyRename },
    logger,
    isTrusted: () => settings.trusted,
    ...(o.staleRetries !== undefined ? { staleRetries: o.staleRetries } : {}),
  });

  return {
    world,
    engine,
    tracker,
    registry,
    clock,
    logger,
    applier,
    route,
    adapter,
    ...(second ? { second } : {}),
    settings,
    dispose: () => engine.dispose(),
  };
}
