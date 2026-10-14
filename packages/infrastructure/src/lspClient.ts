import {
  type CancellationToken,
  type Disposable,
  Emitter,
  type LspConnection,
  type LspConnectionFactory,
  type LspStartContext,
  type Logger,
  RpcError,
  StartupError,
  TransportError,
  raceCancellation,
} from '@refyntra/application';
import { DEFAULT_MAX_MESSAGE_BYTES } from './framing';
import { JsonRpcConnection } from './jsonRpc';
import { type ProcessLaunch, ProcessStartError, SupervisedProcess } from './process';

// A small LSP client on the existing Content-Length framing and JSON-RPC peer. It only speaks the protocol: it never
// registers VS Code providers. The server process is started without a shell and supervised (process-tree kill).

export interface LspClientOptions {
  /** Short name for logs, e.g. "pyright". */
  name: string;
  /** Resolves how to start the server; throw StartupError (e.g. ServerNotFound) when it cannot be started. */
  resolveLaunch: (ctx: LspStartContext) => Promise<ProcessLaunch>;
  logger: Logger;
  /** `initializationOptions` of the initialize request. */
  initializationOptions?: (ctx: LspStartContext) => unknown;
  /** Answers `workspace/configuration` items by section (undefined → null). */
  configuration?: (section: string | undefined, scopeUri: string | undefined) => unknown;
  /** Observes every successful spawn (tests: Restricted Mode never spawns). */
  onSpawn?: (launch: ProcessLaunch, pid: number | undefined) => void;
  /** Timeout of the initialize request (default 60 s). */
  initializeTimeoutMs?: number;
  maxMessageBytes?: number;
  clientName?: string;
  clientVersion?: string;
}

/** LSP error codes that mean "the document moved on while the request ran" (RequestCancelled, ContentModified, ServerCancelled). */
export const LSP_STALE_CODES: ReadonlySet<number> = new Set([-32800, -32801, -32802]);

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|private|mnt|opt|root)\/|file:\/\/\/?)[^\s"'`<>|]*/g;

/** A server log line as it may be written to the output channel: paths replaced, length capped (never source text). */
export function redactServerLine(line: string): string {
  const s = line.replace(ABSOLUTE_PATH, '<path>');
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** The client capabilities Refyntra announces: only what its adapter uses (no diagnostics, no edits applied by the server). */
export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: { dynamicRegistration: false, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'], failureHandling: 'abort' },
    didChangeWatchedFiles: { dynamicRegistration: false },
    // File renames from VS Code: the server may update imports / `mod` declarations first (willRename).
    fileOperations: { dynamicRegistration: false, willRename: true, didRename: true },
    applyEdit: false,
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    rename: { prepareSupport: true, honorsChangeAnnotations: false },
    // Refactorings: CodeAction literals with kinds (a server without this answers bare Commands, which Refyntra
    // cannot preview), resolved lazily through codeAction/resolve. No snippet edits are advertised.
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } },
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit'] },
    },
    publishDiagnostics: { relatedInformation: false },
  },
  window: { workDoneProgress: true },
  // rust-analyzer: experimental/serverStatus tells when the workspace is loaded (quiescent).
  experimental: { serverStatusNotification: true },
};

class LspSession implements LspConnection {
  serverCapabilities: Record<string, unknown> = {};
  serverInfo?: { name: string; version?: string };
  private readonly notifications = new Emitter<{ method: string; params: unknown }>();
  private shuttingDown = false;

  constructor(
    private readonly proc: SupervisedProcess,
    private readonly conn: JsonRpcConnection,
    private readonly name: string,
    private readonly logger: Logger,
  ) {
    proc.onExit((e) => conn.fail(new TransportError(`${name} exited (code ${e.code ?? 'none'}${e.signal ? `, ${e.signal}` : ''})`, 'BackendExited'), !this.shuttingDown));
    conn.onNotification((method, params) => {
      if (method === 'window/logMessage' || method === 'window/showMessage') {
        const p = params as { type?: number; message?: unknown } | undefined;
        if (typeof p?.message === 'string') this.logger.log(p.type === 1 ? 'warn' : 'debug', `lsp:${name}`, redactServerLine(p.message));
      }
      this.notifications.fire({ method, params });
    });
  }

  request(method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
    return this.conn.sendRequest(method, params, token);
  }

  notify(method: string, params: unknown): void {
    this.conn.sendNotification(method, params);
  }

  onClose(listener: (error?: Error) => void): Disposable {
    return this.conn.onClose(listener);
  }

  onNotification(listener: (method: string, params: unknown) => void): Disposable {
    return this.notifications.event((n) => listener(n.method, n.params));
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.conn.isClosed) {
      try {
        await Promise.race([this.conn.sendRequest('shutdown', null), new Promise((r) => setTimeout(r, 2000).unref?.())]);
        this.conn.sendNotification('exit', null);
      } catch {
        // The server is already gone or does not answer: the process tree is killed below.
      }
    }
    await this.proc.dispose(1500);
    await this.conn.dispose();
    this.notifications.dispose();
  }
}

function pipeStderr(proc: SupervisedProcess, logger: Logger, name: string): void {
  let rest = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    rest += chunk;
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) logger.log('debug', `lsp:${name}:stderr`, redactServerLine(line));
    }
    if (rest.length > 64 * 1024) rest = '';
  });
}

/** Server → client requests. Refyntra answers only what a read-only client needs; the server never edits files. */
function answerServerRequest(options: LspClientOptions, ctx: LspStartContext) {
  return async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items?: { section?: string; scopeUri?: string }[] } | undefined)?.items ?? [];
        return items.map((i) => options.configuration?.(i.section, i.scopeUri) ?? null);
      }
      case 'workspace/workspaceFolders':
        return ctx.workspaceFolders.map((f) => ({ uri: f.uri, name: f.name }));
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/diagnostic/refresh':
        return null;
      case 'workspace/applyEdit':
        // Edits reach files only through Refyntra's own preview and EditApplier.
        return { applied: false, failureReason: 'Refyntra applies edits only through its own preview.' };
      default:
        throw new RpcError(-32601, `Method ${method} is not handled by this client`);
    }
  };
}

/** Creates the LspConnectionFactory for one server kind. */
export function createLspConnectionFactory(options: LspClientOptions): LspConnectionFactory {
  return async (ctx) => {
    const launch = await options.resolveLaunch(ctx);
    let proc: SupervisedProcess;
    try {
      proc = await SupervisedProcess.start(launch);
    } catch (e) {
      if (e instanceof ProcessStartError && (e.code === 'ENOENT' || e.code === 'EACCES')) {
        throw new StartupError('ServerNotFound', `Cannot start the ${options.name} language server (${e.code}).`, false);
      }
      throw new StartupError('ServerStartFailed', `Cannot start the ${options.name} language server: ${(e as Error).message}`, true);
    }
    options.onSpawn?.(launch, proc.pid);
    options.logger.log('info', `lsp:${options.name}`, 'language server started', { pid: proc.pid });
    pipeStderr(proc, options.logger, options.name);
    const conn = new JsonRpcConnection(proc.stdout, proc.stdin, { maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, logger: options.logger, name: `lsp:${options.name}` });
    conn.onRequest(answerServerRequest(options, ctx));
    conn.onClose(() => void proc.dispose(500));
    const session = new LspSession(proc, conn, options.name, options.logger);
    const first = ctx.workspaceFolders[0];
    const init = {
      processId: process.pid,
      clientInfo: { name: options.clientName ?? 'refyntra', ...(options.clientVersion ? { version: options.clientVersion } : {}) },
      locale: 'en',
      rootUri: first?.uri ?? null,
      workspaceFolders: ctx.workspaceFolders.length ? ctx.workspaceFolders.map((f) => ({ uri: f.uri, name: f.name })) : null,
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: options.initializationOptions?.(ctx) ?? null,
      trace: 'off',
    };
    const timeoutMs = options.initializeTimeoutMs ?? 60000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StartupError('ServerStartFailed', `The ${options.name} language server did not answer initialize within ${Math.round(timeoutMs / 1000)} s.`, true)), timeoutMs);
      });
      const result = (await raceCancellation(Promise.race([conn.sendRequest('initialize', init), timeout]), undefined)) as { capabilities?: unknown; serverInfo?: { name?: unknown; version?: unknown } } | null;
      if (!result || typeof result !== 'object' || !result.capabilities || typeof result.capabilities !== 'object') {
        throw new StartupError('ServerStartFailed', `The ${options.name} language server sent a malformed initialize result.`, true);
      }
      session.serverCapabilities = result.capabilities as Record<string, unknown>;
      if (result.serverInfo && typeof result.serverInfo.name === 'string') {
        session.serverInfo = { name: result.serverInfo.name, ...(typeof result.serverInfo.version === 'string' ? { version: result.serverInfo.version } : {}) };
      }
      conn.sendNotification('initialized', {});
    } catch (e) {
      await session.shutdown().catch(() => undefined);
      if (e instanceof StartupError) throw e;
      throw new StartupError('ServerStartFailed', `The ${options.name} language server failed to initialize: ${(e as Error).message}`, true);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return session;
  };
}
