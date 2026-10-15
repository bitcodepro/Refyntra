import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { EMPTY_RUN_SETTINGS, MessageReader, VSTEST_PROTOCOL_VERSION, type VsTestCase, type VsTestMessage, type VsTestProcessStartInfo, type VsTestResult, encodeMessage } from './vstestProtocol';

/**
 * One vstest.console process in design mode (the server mode IDEs use), started from the .NET SDK on demand. Discovery
 * returns every test case with its id — data rows included — and a run takes exactly the chosen cases, so a single
 * [InlineData] / [TestCase] / [DataRow] row runs alone. Requests are serialised; the process stays for later requests
 * and is stopped by dispose().
 */
export class VsTestSession {
  private child: ChildProcess | undefined;
  private socket: net.Socket | undefined;
  private server: net.Server | undefined;
  private ready: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private listener: ((m: VsTestMessage) => void) | undefined;

  constructor(
    private readonly locate: () => string | undefined,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** The vstest.console.dll of the newest installed SDK next to `dotnet`, or undefined. */
  static findConsole(dotnetRoot: string | undefined): string | undefined {
    if (!dotnetRoot) return undefined;
    const sdk = path.join(dotnetRoot, 'sdk');
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(sdk).filter((v) => /^\d+\.\d+\.\d+/.test(v));
    } catch {
      return undefined;
    }
    const key = (v: string) => v.split(/[.-]/).slice(0, 3).map((x) => x.padStart(6, '0')).join('.');
    for (const v of versions.sort((a, b) => key(b).localeCompare(key(a)))) {
      const f = path.join(sdk, v, 'vstest.console.dll');
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const consoleDll = this.locate();
      if (!consoleDll) return reject(new Error('vstest.console.dll was not found in the .NET SDK'));
      const server = net.createServer();
      this.server = server;
      const timer = setTimeout(() => reject(new Error('vstest.console did not connect')), 30000);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        const child = spawn('dotnet', [consoleDll, `--port:${port}`, `--parentprocessid:${process.pid}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
        this.child = child;
        child.stderr?.on('data', (d: Buffer) => this.log(d.toString()));
        child.on('exit', () => this.reset(new Error('vstest.console exited')));
        server.once('connection', (sock) => {
          this.socket = sock;
          const reader = new MessageReader();
          sock.on('data', (d: Buffer) => {
            let msgs: VsTestMessage[];
            try {
              msgs = reader.push(d);
            } catch (e) {
              this.reset(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            for (const m of msgs) {
              if (m.MessageType === 'TestSession.Connected') this.send({ MessageType: 'ProtocolVersion', Payload: VSTEST_PROTOCOL_VERSION });
              else if (m.MessageType === 'ProtocolVersion') {
                clearTimeout(timer);
                resolve();
              } else this.listener?.(m);
            }
          });
          sock.on('close', () => this.reset(new Error('vstest.console closed the connection')));
        });
      });
    });
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  private send(m: VsTestMessage): void {
    this.socket?.write(encodeMessage(m));
  }

  /** Stops the current request (it fails with this reason) and the process; the next request starts a new one. */
  abort(reason: string): void {
    this.reset(new Error(reason));
  }

  private reset(error?: Error): void {
    if (error) this.listener?.({ MessageType: 'Refyntra.Error', Payload: error.message });
    this.listener = undefined;
    this.ready = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.server?.close();
    this.server = undefined;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = undefined;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Every test case of the test assemblies. */
  discover(sources: readonly string[], onMessage?: (text: string) => void): Promise<VsTestCase[]> {
    return this.exclusive(async () => {
      await this.start();
      const found: VsTestCase[] = [];
      return new Promise<VsTestCase[]>((resolve, reject) => {
        this.listener = (m) => {
          if (m.MessageType === 'TestDiscovery.TestFound') found.push(...((m.Payload as VsTestCase[]) ?? []));
          else if (m.MessageType === 'TestDiscovery.Completed') {
            found.push(...(((m.Payload as { LastDiscoveredTests?: VsTestCase[] } | undefined)?.LastDiscoveredTests) ?? []));
            this.listener = undefined;
            resolve(found);
          } else if (m.MessageType === 'TestSession.Message') onMessage?.((m.Payload as { Message?: string })?.Message ?? '');
          else if (m.MessageType === 'Refyntra.Error') reject(new Error(String(m.Payload)));
        };
        this.send({ MessageType: 'TestDiscovery.Start', Version: VSTEST_PROTOCOL_VERSION, Payload: { Sources: sources, RunSettings: EMPTY_RUN_SETTINGS } });
      });
    });
  }

  /** Runs exactly these test cases; results arrive through onResult while the run goes on. */
  run(cases: readonly VsTestCase[], onResult: (r: VsTestResult) => void, onMessage?: (text: string) => void, cancel?: { onCancellationRequested(cb: () => void): unknown }): Promise<void> {
    return this.exclusive(async () => {
      await this.start();
      return new Promise<void>((resolve, reject) => {
        cancel?.onCancellationRequested(() => this.send({ MessageType: 'TestExecution.Cancel' }));
        this.listener = (m) => {
          if (m.MessageType === 'TestExecution.StatsChange') for (const r of (m.Payload as { NewTestResults?: VsTestResult[] })?.NewTestResults ?? []) onResult(r);
          else if (m.MessageType === 'TestExecution.Completed') {
            for (const r of (m.Payload as { LastRunTests?: { NewTestResults?: VsTestResult[] } })?.LastRunTests?.NewTestResults ?? []) onResult(r);
            this.listener = undefined;
            resolve();
          } else if (m.MessageType === 'TestSession.Message') onMessage?.((m.Payload as { Message?: string })?.Message ?? '');
          else if (m.MessageType === 'Refyntra.Error') reject(new Error(String(m.Payload)));
        };
        this.send({ MessageType: 'TestExecution.RunAllWithDefaultHost', Version: VSTEST_PROTOCOL_VERSION, Payload: { Sources: [...new Set(cases.map((c) => c.Source))], TestCases: cases, RunSettings: EMPTY_RUN_SETTINGS, KeepAlive: false, DebuggingEnabled: false } });
      });
    });
  }

  /**
   * Debugs exactly these test cases: vstest.console asks the editor to start the test host (CustomTestHostLaunch) —
   * `launch` starts it and returns its process id — or, in newer versions, to attach to a host it started
   * (EditorAttachDebugger) — `attach`. Results arrive like in run().
   */
  debug(
    cases: readonly VsTestCase[],
    launch: (info: VsTestProcessStartInfo) => Promise<number>,
    attach: (pid: number) => Promise<boolean>,
    onResult: (r: VsTestResult) => void,
    onMessage?: (text: string) => void,
    cancel?: { onCancellationRequested(cb: () => void): unknown },
  ): Promise<void> {
    return this.exclusive(async () => {
      await this.start();
      return new Promise<void>((resolve, reject) => {
        cancel?.onCancellationRequested(() => this.send({ MessageType: 'TestExecution.Cancel' }));
        this.listener = (m) => {
          if (m.MessageType === 'TestExecution.CustomTestHostLaunch') {
            launch(m.Payload as VsTestProcessStartInfo).then(
              (pid) => this.send({ MessageType: 'TestExecution.CustomTestHostLaunchCallback', Version: VSTEST_PROTOCOL_VERSION, Payload: { HostProcessId: pid, ErrorMessage: null } }),
              (e) => this.send({ MessageType: 'TestExecution.CustomTestHostLaunchCallback', Version: VSTEST_PROTOCOL_VERSION, Payload: { HostProcessId: -1, ErrorMessage: String(e) } }),
            );
          } else if (m.MessageType === 'TestExecution.EditorAttachDebugger' || m.MessageType === 'TestExecution.EditorAttachDebugger2') {
            const p = m.Payload as { ProcessID?: number; ProcessId?: number } | number;
            const pid = typeof p === 'number' ? p : (p?.ProcessID ?? p?.ProcessId ?? -1);
            attach(pid).then(
              (ok) => this.send({ MessageType: 'TestExecution.EditorAttachDebuggerCallback', Version: VSTEST_PROTOCOL_VERSION, Payload: { Attached: ok, ErrorMessage: ok ? null : 'The debugger did not attach.' } }),
              (e) => this.send({ MessageType: 'TestExecution.EditorAttachDebuggerCallback', Version: VSTEST_PROTOCOL_VERSION, Payload: { Attached: false, ErrorMessage: String(e) } }),
            );
          } else if (m.MessageType === 'TestExecution.StatsChange') for (const r of (m.Payload as { NewTestResults?: VsTestResult[] })?.NewTestResults ?? []) onResult(r);
          else if (m.MessageType === 'TestExecution.Completed') {
            for (const r of (m.Payload as { LastRunTests?: { NewTestResults?: VsTestResult[] } })?.LastRunTests?.NewTestResults ?? []) onResult(r);
            this.listener = undefined;
            resolve();
          } else if (m.MessageType === 'TestSession.Message') onMessage?.((m.Payload as { Message?: string })?.Message ?? '');
          else if (m.MessageType === 'Refyntra.Error') reject(new Error(String(m.Payload)));
        };
        this.send({
          MessageType: 'TestExecution.GetTestRunnerProcessStartInfoForRunSelected',
          Version: VSTEST_PROTOCOL_VERSION,
          Payload: { Sources: [...new Set(cases.map((c) => c.Source))], TestCases: cases, RunSettings: EMPTY_RUN_SETTINGS, KeepAlive: false, DebuggingEnabled: true },
        });
      });
    });
  }

  dispose(): void {
    if (this.socket) this.send({ MessageType: 'TestSession.Terminate' });
    setTimeout(() => this.reset(), 300).unref();
  }
}
