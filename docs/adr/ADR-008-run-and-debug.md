# ADR-008: Run and debug without other extensions

Status: Accepted (alpha)

## Context

Refyntra navigates and refactors .NET, TS/JS, Python and Rust code without other VS Code extensions. Running and
debugging a project still needed one (the C# extension for .NET, the Python extension for Python, CodeLLDB for Rust).
The goal: Refyntra runs and debugs projects itself, using only VS Code's built-in features and well-maintained
third-party tools with licenses that allow redistribution, bundled inside the VSIX.

Constraints:

- **vsdbg** (Microsoft's .NET debugger used by the C# extension) may only be used with Microsoft's own products; third
  parties may not redistribute it. It is not an option.
- Building and running execute project code (MSBuild targets, the program itself): only in trusted workspaces.
- Users who have a `launch.json` keep VS Code's F5 behaviour; Refyntra must not take over F5.
- No downloads at run time (ADR-005): everything is pinned and hash-verified at packaging time.

## Decision

1. **.NET: Samsung netcoredbg (MIT)**, pinned to release `3.2.0-1092`, bundled per platform in `debuggers/netcoredbg`
   of the platform VSIX (`scripts/package/debuggers.json`: official GitHub release URL and SHA-256 per target, verified
   in `scripts/package/servers.mjs` before anything is staged). Official builds exist for win32-x64, linux-x64,
   linux-arm64 and darwin-arm64. **win32-arm64, darwin-x64 (no build in this release) and alpine-x64 ship without it**:
   Health and the support matrix say that debugging .NET is unavailable there; running still works. netcoredbg ships
   Roslyn (`Microsoft.CodeAnalysis*.dll`, MIT) for expression evaluation and dbgshim (MIT); it links nlohmann/json and
   libelfin (MIT) and linenoise-ng (BSD-style). All texts ship in `legal/` and next to the binary.
   - Debug type `refyntra-dotnet`: a `DebugAdapterDescriptorFactory` runs `netcoredbg --interpreter=vscode` behind
     Refyntra's in-process DAP proxy (`DebugAdapterInlineImplementation`, see "Debugger capabilities"). Launch (program, args, cwd, env, stopAtEntry, justMyCode; `project` +
     `framework` + `configuration` build first with `dotnet build` as a VS Code task), attach (process picker command
     `refyntra.pickDotnetProcess`), exception breakpoints (netcoredbg's `all` and `user-unhandled` filters),
     `contributes.breakpoints` for C#.
   - `console`: netcoredbg starts the program itself and has no `runInTerminal`, so program output always goes to the
     Debug Console; `integratedTerminal` is accepted but behaves like `internalConsole` (Run uses a terminal).
     Reading stdin while debugging is therefore not supported.
2. **Project model from the host (protocol 1.8, `workspace/runnableProjects`).** The Roslyn host classifies every
   loaded project from the MSBuild evaluation it already has (output kind, output path and target framework per Roslyn
   project instance, resolved metadata references) plus the project file (SDK, `UseWPF`, `UseWindowsForms`,
   `UseMaui`, `IsTestProject`, test packages, also from `Directory.Build.props` above it): console, web, worker,
   WinForms/WPF (Windows only), test (not runnable: Test Explorer / Related), library, MAUI and Blazor WebAssembly
   (reported as unsupported with the reason). The client reads `Properties/launchSettings.json` profiles
   (`commandName: Project`) itself at run time: `applicationUrl`, `environmentVariables`, `commandLineArgs`,
   `launchBrowser`, `launchUrl`.
3. **Run without debugging** goes through a VS Code task with a custom execution (a pseudoterminal): `dotnet run
   --project … -c … [-f …] [--launch-profile …]` (it builds first and applies the profile), `dotnet watch run` for hot
   reload, `npm|pnpm|yarn run <script>`, `python <file>`, `cargo run`. Stop kills the process tree; Restart starts it
   again. Web profiles with `launchBrowser` open the browser when the app prints `Now listening on:` (also while
   debugging, through a debug adapter tracker, so it works with VS Code's built-in extensions disabled).
4. **Python: debugpy (MIT)**, pinned `1.8.22`, the pure-Python files of the official `py2.py3-none-any` wheel (SHA-256
   pinned) in `debuggers/debugpy` of every VSIX. Debug type `refyntra-python` runs `python -m debugpy.adapter` with the
   user's interpreter (`python.defaultInterpreterPath`, a `.venv`/`venv`, else `python3`/`python` on PATH) and the
   bundled debugpy on `PYTHONPATH`. Left out: compiled speed-ups (debugpy falls back to pure Python, slower stepping on
   large programs), the native attach-to-process helpers (attach by process id is not supported; attach by
   `connect` host/port is), symbols, C/Cython sources, vendored tests and protocol schemas only its code generator reads.
5. **Rust: run only by default; debug with an installed lldb-dap.** Decided by size:

   | Option | Size | License | Decision |
   |---|---|---|---|
   | CodeLLDB 1.12.3 (bundles LLDB) | 45–56 MB per platform VSIX (darwin-arm64 45.4 MB, win32-x64 50.9 MB, linux-x64 55.6 MB, compressed) | MIT (CodeLLDB) + Apache-2.0 with LLVM exception (LLDB) | Rejected: would more than double the 32 MB package for one language |
   | lldb-dap from an installed LLVM | 0 MB (detected on PATH / usual LLVM folders, never bundled) | Apache-2.0 with LLVM exception | Accepted |
   | Nothing | 0 MB | — | Run only, when no lldb-dap is installed |

   `cargo run` works wherever cargo is installed. Debug type `refyntra-lldb` starts the detected `lldb-dap`
   (`lldb-dap`, `lldb-dap-18…21`, `lldb-vscode`) after `cargo build`; without it, Debug explains why and Health says so.
6. **Node and web front ends**: configurations for VS Code's built-in JavaScript debugger (`node` with
   `runtimeExecutable` npm/pnpm/yarn and `runtimeArgs: ["run", script]`; `msedge`/`chrome` with the dev-server URL of
   Vite, Next.js, Create React App, Angular, webpack-dev-server). Generated, not reimplemented.
7. **F5 stays VS Code's.** Refyntra contributes no F5/Ctrl+F5 keybinding. With a `launch.json`, VS Code runs it as
   always. Without one, VS Code asks the debugger of the active editor's language (`languages` of the contributed
   debuggers) to resolve an empty configuration; Refyntra then uses the selected run target (Ctrl+F5 = `noDebug`: the
   .NET target runs in a terminal). Dynamic configurations (`DebugConfigurationProviderTriggerKind.Dynamic`) list every
   runnable target in VS Code's Run and Debug view and debug dropdown. "Generate launch.json" writes them out.
8. **Trust**: every run, debug, build and dynamic configuration requires a trusted workspace; Restricted Mode explains
   instead (Run view welcome, warnings, Health).

9. **Debugger capabilities (netcoredbg 3.2.0-1092).** Measured, not assumed: the DAP `initialize` response of the
   bundled linux-x64 build in Docker, then each request tried on a console program (2026-10-13). The Run and Debug e2e
   compares the live `initialize` response with this table on every run (`NETCOREDBG_CAPABILITIES` in
   `debugExtrasModel.ts`).

   | DAP capability | netcoredbg | Probe | Refyntra |
   |---|---|---|---|
   | supportsConfigurationDoneRequest | yes | — | used |
   | supportsConditionalBreakpoints | yes | `i == 3` in a loop stops once, with i = 3 | VS Code's condition editor; e2e |
   | supportsHitConditionalBreakpoints | no | `hitCondition: "3"` ignored: stops every time | **supported via Refyntra emulation** (proxy, below); e2e |
   | supportsLogPoints | no | `logMessage` ignored: stops like a breakpoint, logs nothing | **supported via Refyntra emulation** (proxy, below); e2e |
   | supportsFunctionBreakpoints | yes | accepted (bound when the method is loaded) | VS Code's function breakpoints |
   | supportsDataBreakpoints | no (absent) | — | not offered |
   | supportsExceptionFilterOptions | yes | `all` + `condition` = comma-separated full type names: breaks only on those types; exact type only (base types, short names, `System.*` do not match); `!Type` excludes a type | **Break on Exception Types** (below) |
   | supportsExceptionOptions | no (false) | — (the capability says no) | not used |
   | exceptionBreakpointFilters | `all`, `user-unhandled` | — | VS Code's checkboxes |
   | supportsExceptionInfoRequest | yes | `CLR/System.InvalidOperationException` | VS Code's exception widget |
   | supportsSetVariable / supportsSetExpression | yes / yes | `total = 5` | Immediate Window assignments |
   | supportsTerminateRequest, supportsCancelRequest | yes | — | — |
   | supportsStepInTargetsRequest | no (absent) | `stepInTargets` fails: `0x80004001` (E_NOTIMPL) | **Smart Step Into** through the C# host (below) |
   | supportsGotoTargetsRequest | no (absent) | `gotoTargets` fails: E_NOTIMPL; no `goto`/`gotoTargets` handler in netcoredbg's current source either (checked 2026-10-14) | **Set Next Statement / Jump to Cursor not available** (VS Code hides Jump to Cursor; Health and README say so). Not emulated: moving the instruction pointer can only be done inside the debugger |
   | supportsRestartFrame | no (absent) | `restartFrame` fails: E_NOTIMPL | not offered |
   | supportsCompletionsRequest | no (absent) | — | Immediate Window shows no C# completions |
   | supportsStepBack, supportsInstructionBreakpoints, supportsReadMemoryRequest | no (absent) | — | — |

   - **Logpoints and hit counts: Refyntra's DAP proxy.** The `refyntra-dotnet` descriptor factory returns a
     `DebugAdapterInlineImplementation` that runs netcoredbg as a child process (DAP over stdio) behind an in-process
     proxy (`dapProxyModel.ts`, unit-tested with a fake adapter). It adds `supportsLogPoints` and
     `supportsHitConditionalBreakpoints` to netcoredbg's `initialize` response; `setBreakpoints` reaches netcoredbg
     without `logMessage`/`hitCondition` (the condition stays), and the proxy remembers them per breakpoint id. When
     netcoredbg stops with reason `breakpoint` at one of them (matched by `hitBreakpointIds`, else by the top frame's file
     and line), the proxy counts the hit (only hits where the condition held: netcoredbg evaluates it first). Hit
     conditions: `N`/`== N` (Visual Studio's "equal to"), `>= N`, `> N`, `< N`, `<= N`, `% N`. A logpoint whose hit
     condition holds evaluates each `{expression}` with `evaluate` (context `watch`) in the top frame and emits an
     `output` event (category `console`, with source and line); then the proxy sends `continue` and VS Code never sees
     the stop. Events are handled one at a time in order (netcoredbg stops all threads, `allThreadsStopped`), so hits on
     several threads are handled one after the other. Stops for other reasons, plain breakpoints (also one reported
     together with an emulated one), exceptions, Smart Step Into's temporary breakpoints and pauses pass through
     untouched; a Pause asked for while a hidden stop is handled shows that stop as a pause. A hidden hit during Step
     Over / Step Out (netcoredbg ends a step at any breakpoint) is finished the way the step would have gone: step out
     of the deeper frames, then (Step Over) finish the line; during Step Into the step ends there. **Timing cost**: each
     hit is a real stop, a `stackTrace`, one `evaluate` per expression and a `continue` (milliseconds per hit), so
     logpoints in hot loops slow the program down.
   - **Hot Reload / Edit and Continue: not possible with netcoredbg.** netcoredbg 3.2.0 (and its current source) has no
     request to apply code changes, so changing code while paused is not possible and there is no "Debug with Hot
     Reload". *Run with Hot Reload* (`dotnet watch run`, no debugger) is first-class instead: a status bar item reads
     watch's output (building, watching, applied, restart needed, failed, waiting). Rude edits: Refyntra's terminal is a
     pipe, and `dotnet watch` reads its `y/n` prompt and Ctrl+R only from a real console (measured with SDK 10 in
     Docker: the key is never read, the old code keeps running), so forwarding input cannot answer it.
     `refyntra.run.hotReload.rudeEdit`: `restart` (default, `dotnet watch --non-interactive`, which restarts the app by
     itself, measured) or `ask` (Refyntra asks and restarts the run).
   - **Run to Cursor** is VS Code's own command: a temporary breakpoint and Continue, so it works with any adapter
     that binds breakpoints (e2e). Ctrl+F10 in the `visualStudio` preset (C# editors, while stopped).
   - **Smart Step Into** (Refyntra: Smart Step Into; Alt+Shift+F11 in the `visualStudio` preset, Shift+F7 in the
     `resharper` preset, while a `refyntra-dotnet` session is stopped): netcoredbg has no `stepInTargets`, so VS
     Code's *Step Into Target* is not offered. The host lists the calls of the stopped statement (`code/stepIntoTargets`,
     protocol 1.14) in the order they run; the user picks one; Refyntra sets temporary breakpoints at the start of the
     callee's body and at the next statement of the stopped block (where execution goes if the call is not made),
     waits until netcoredbg has them, continues, and removes them at the next stop or when the session ends. A
     breakpoint the user already had there is left alone. Honest limits: calls without source (framework, NuGet),
     abstract/interface calls and delegates are listed but refused with the reason; a virtual call stops only if that
     implementation runs; another breakpoint, another thread or a recursive call that reaches one of the temporary
     breakpoints first stops there (the temporary breakpoints are removed all the same); when the statement is the last
     one of a loop body there is no next-statement guard, so a call that is not made lets the program run on to the
     next breakpoint.
   - **Break on Exception Types** (Refyntra: Break on Exception Types…, setting
     `refyntra.debug.dotnet.breakOnExceptionTypes`): netcoredbg ORs its filters, so the types cannot be added to a
     ticked `all`; Refyntra sends, right behind VS Code's own `setExceptionBreakpoints` (seen by a debug adapter
     tracker, before `configurationDone`), the ticked filters plus `all` with the type names as its condition. With
     `all` ticked every exception breaks anyway and nothing is added. Changing the setting updates running sessions.
   - **Breakpoint condition completion** is not possible: VS Code's breakpoint condition input has no completion API for
     extensions (and netcoredbg has no `completions`). Not implemented.

## Consequences

- VSIX size (win32-x64): 27.89 MiB → 32.36 MiB compressed (+4.47 MiB); unpacked +13.1 MiB (netcoredbg 8.4 MiB, debugpy
  4.6 MiB). The universal VSIX and targets without a netcoredbg build grow by debugpy only.
- New pinned third-party components to keep current: netcoredbg (release cadence of a few months) and debugpy.
  Upgrading = new version + SHA-256 in `debuggers.json`, then `pnpm notices`, the Docker e2e (it debugs the Runnable
  fixture with netcoredbg and a Python file with debugpy) and the audit.
- Limitations stated in the support matrix: no .NET debugging on win32-arm64, darwin-x64 and Alpine; no stdin while
  debugging .NET; no Set Next Statement, Edit and Continue or Restart Frame with netcoredbg (hit counts and logpoints are
  emulated by Refyntra, at the cost of a real stop per hit); no Python attach by process id; Rust debugging only with an installed LLVM; MAUI and Blazor
  WebAssembly not run or debugged; WinForms/WPF only on Windows.
