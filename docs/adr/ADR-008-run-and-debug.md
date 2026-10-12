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
   - Debug type `refyntra-dotnet`: a `DebugAdapterDescriptorFactory` returns a `DebugAdapterExecutable` running
     `netcoredbg --interpreter=vscode`. Launch (program, args, cwd, env, stopAtEntry, justMyCode; `project` +
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

## Consequences

- VSIX size (win32-x64): 27.89 MiB → 32.36 MiB compressed (+4.47 MiB); unpacked +13.1 MiB (netcoredbg 8.4 MiB, debugpy
  4.6 MiB). The universal VSIX and targets without a netcoredbg build grow by debugpy only.
- New pinned third-party components to keep current: netcoredbg (release cadence of a few months) and debugpy.
  Upgrading = new version + SHA-256 in `debuggers.json`, then `pnpm notices`, the Docker e2e (it debugs the Runnable
  fixture with netcoredbg and a Python file with debugpy) and the audit.
- Limitations stated in the support matrix: no .NET debugging on win32-arm64, darwin-x64 and Alpine; no stdin while
  debugging .NET; no Python attach by process id; Rust debugging only with an installed LLVM; MAUI and Blazor
  WebAssembly not run or debugged; WinForms/WPF only on Windows.
