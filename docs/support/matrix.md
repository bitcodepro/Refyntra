# Support matrix

Only combinations that have been tested may be listed as verified (support is declared by result, not because .NET and TypeScript are portable).

| OS / architecture | VS Code | .NET SDK | Projects | Status |
|---|---|---|---|---|
| Windows 11 x64 | 1.90.2 (minimum) | 10.0.300 | SDK-style | Verified: extension e2e against the real host |
| Windows 11 x64 | 1.141.0 | 10.0.300 | SDK-style | Verified: extension e2e against the real host |
| Linux x64 (Docker, Ubuntu 24.04.5, WSL2 kernel 6.18) | 1.90.2 (minimum), 1.141.0 | 10.0.401 | SDK-style | Verified in a container under Xvfb: extension integration + e2e against the Linux-built host, installed-VSIX smoke; **not yet declared supported** (see below) |

Verified results are from 2026-10-09 on one machine (i7-10750H, 32 GB). Performance numbers for the Windows run are in [docs/performance](../performance/).

## Linux: what was run

2026-10-09, `bash scripts/test/linux-e2e.sh` (how-to: [linux-smoke.md](linux-smoke.md)): image `mcr.microsoft.com/dotnet/sdk:10.0` (Ubuntu 24.04.5 LTS, x64, Docker Desktop WSL2 kernel 6.18), .NET SDK 10.0.401, Node 22.23.3, pnpm 12.10.1, VS Code 1.90.2 Linux x64 build (downloaded by `@vscode/test-electron`) under Xvfb. All steps PASS:

- `pnpm install --frozen-lockfile`, `pnpm -r run build`, `pnpm test:unit` 186/186, `pnpm test:architecture`.
- `dotnet test src/dotnet/Refyntra.sln -c Release`: 117/117, including `HostProcessTests.NoChildProcessOutlivesTheHost(abrupt: True)` (host SIGKILLed while BuildHost runs; fixed by the watchdog in `ChildProcessGuard`, see linux-smoke.md).
- `xvfb-run -a pnpm test:integration`: 4/4 scenarios (restricted, no-solution, no-host, ts-absent).
- `xvfb-run -a pnpm test:e2e` against the Linux-built Release host: 7/7 scenarios (e2e, shop, rename-apply, restore-recovery, ts-delegated, di-rules, rename-nonutf8).
- `pnpm package:vsix` in the container, then `xvfb-run -a pnpm test:install`: Shop and DiRules journeys from the installed VSIX, host started from `<installed>/host`, no host/BuildHost left after VS Code exits.
- No `Refyntra.Host`/BuildHost/watchdog process left after the e2e and at the end.

Linux bugs found and fixed: `test:install` could not list processes on POSIX and hit an interactive WSL prompt in VS Code's `bin/code` (details in linux-smoke.md); a SIGKILLed host left BuildHost running.

2026-10-11, after the web frameworks (React/Next.js/Angular) and HTML/CSS work, the same `bash scripts/test/linux-e2e.sh` (Ubuntu 24.04.5, .NET SDK 10.0.401, Node 22.23.3, pnpm 12.10.1, VS Code 1.90.2 under Xvfb, no cargo in the container): all 12 steps PASS — `pnpm test:unit` 503/503, `dotnet test` 262/262, `test:integration` (incl. pyrust-lsp, pyrust-restricted, web-frameworks, web-frameworks-restricted, web-styles, high-contrast), `test:e2e` against the Linux-built host (incl. create-file, rename-file, task-context, efcore, mvc, full-stack), `package:vsix` (linux-x64 rust-analyzer fetched and SHA-256 verified in the container), `test:install` (Shop, DiRules, PyRust from the installed VSIX), no host/BuildHost left. Bugs found and fixed (details in linux-smoke.md): a partial Pyright staging copy crashed Pyright at start; the no-cargo Rust tests and Health text claimed open-file results that rust-analyzer does not give without cargo; the e2e image lacked `gio` for moving files to the trash; the first Angular unit query timed out under load. Rust across files with cargo is verified on Windows only.

The same `linux-e2e.sh` run with `REFYNTRA_TEST_VSCODE_VERSION=stable` (VS Code 1.141.0) passed every step as well (2026-10-09).

Not tested on Linux: VS Code versions other than 1.90.2 and 1.141.0, a desktop session (only Xvfb), other distributions, glibc/musl variants, arm64, a real (non-WSL) kernel, other fixtures. Linux is therefore verified for this one configuration only, not declared supported in general.

Also learned: the unit test `processTree.test.ts` had never run on a POSIX system (a newline escaping bug made its child process fail to start); it is fixed. Inside a container use `docker run --init`, otherwise orphans stay zombies and process-existence checks report them alive.

## Python and Rust: bundled language servers per package

No other VS Code extension is needed for Python or Rust. Every package ships Pyright 1.1.414; the platform packages also
ship the official rust-analyzer 2026-09-21 binary of their target (downloaded at packaging time only, SHA-256 from
`scripts/package/rust-analyzer.json`). Sizes measured 2026-10-10 (`pnpm package:vsix -- --all-targets --universal`):

| Package (`vsce --target`) | rust-analyzer | VSIX size |
|---|---|---|
| win32-x64 | x86_64-pc-windows-msvc | 24.58 MiB |
| win32-arm64 | aarch64-pc-windows-msvc | 23.95 MiB |
| linux-x64 | x86_64-unknown-linux-gnu | 25.08 MiB |
| linux-arm64 | aarch64-unknown-linux-gnu | 24.78 MiB |
| alpine-x64 | x86_64-unknown-linux-musl | 25.20 MiB |
| darwin-x64 | x86_64-apple-darwin | 24.82 MiB |
| darwin-arm64 | aarch64-apple-darwin | 24.33 MiB |
| universal (no target) | none: Health says Rust is not available on this platform | 10.60 MiB |

Before the bundled servers the (single) VSIX was 9.10 MiB. Pyright adds about 1.5 MiB compressed (6.5 MiB unpacked:
language server JavaScript and the typeshed standard-library stubs; third-party stubs are not bundled), rust-analyzer
13–15 MiB compressed (34–42 MiB unpacked).

Verified on Windows 11 x64 (2026-10-10): Python Find, Related, Rename apply + Undo on the bundled Pyright and Rust
Related/Rename preview on the bundled rust-analyzer in an Extension Host with **no other extension** (integration
scenario `pyrust-lsp`), and from the installed win32-x64 VSIX (`test:install`, scenario `pyrust`). This machine has no
Rust toolchain, so the Rust runs covered the *cargo not found* path (route Partial, Health **Install Rust**);
rust-analyzer still resolved definitions, references and the rename inside the crate. The other packages were built
and audited but not run on their platforms.

## Run and debug per package (ADR-008)

Measured 2026-10-12 (`pnpm package:vsix -- --all-targets --universal`, every package passed `audit:vsix --strict-binary`).
debugpy 1.8.22 (pure Python) is in every package; netcoredbg 3.2.0-1092 only where Samsung publishes a build.

| Package | .NET run | .NET debug (netcoredbg) | Python debug (debugpy) | VSIX size |
|---|---|---|---|---|
| win32-x64 | yes | yes | yes | 32.36 MiB |
| win32-arm64 | yes | **no** (no official build) | yes | 28.29 MiB |
| linux-x64 | yes | yes | yes | 32.83 MiB |
| linux-arm64 | yes | yes | yes | 32.45 MiB |
| alpine-x64 | yes | **no** (no musl build) | yes | 29.54 MiB |
| darwin-x64 | yes | **no** (no build in 3.2.0) | yes | 29.15 MiB |
| darwin-arm64 | yes | yes | yes | 31.98 MiB |
| universal | yes | **no** | yes | 14.93 MiB |

Where netcoredbg is missing, Health says ".NET debugging is unavailable on this platform" and Debug explains it; Run
(`dotnet run`) still works. Windows Forms and WPF run and debug on Windows only. MAUI and Blazor WebAssembly are not run
or debugged. Rust debugging needs an installed `lldb-dap` (not bundled). Verified 2026-10-12 in Docker (linux-x64,
VS Code 1.90.2, Xvfb): e2e scenario `run-debug` (netcoredbg breakpoint, locals, evaluate, exit code; web app on its
profile URL; debugpy breakpoint with the system Python 3.12). Debugging on Windows, macOS and arm64 was not run.

## Target frameworks and SDKs

The machine needs the .NET 10 SDK (the C# host runs on .NET 10 and loads projects with MSBuild). The projects it loads
may target older frameworks: their targeting packs come from NuGet during restore, so **loading and analysing** needs no
other SDK or runtime. **Running and debugging** an app needs the runtime of its target framework. Verified 2026-10-14
with the Compat fixture (`tests/fixtures/Compat`: net8.0 web API with MediatR 12.5, DI and EF Core 8.0.8, net8.0 and
net9.0 consoles, netstandard2.0 and netstandard2.1 libraries referenced from both, a net8.0;net10.0 library, a net8.0
xUnit project) and `tests/fixtures/CompatPinned` (global.json pinning SDK 8.0.426, rollForward disable):

| Target / case | Default C# | Load, Find, Related (MediatR, DI), Rename, inspections | Edit actions / postfix / Generate fit the C# version | Run | Debug (netcoredbg) | Tests (xUnit) | Where verified |
|---|---|---|---|---|---|---|---|
| net10.0 | 14 | yes (all other fixtures) | yes | yes | yes | yes | Windows 11 + Docker (existing suites) |
| net9.0 | 13 | yes | yes | yes (console) | not run | not run | load: Windows + Docker; run: Docker (.NET 9.0.21 runtime) |
| net8.0 | 12 | yes | yes | yes (web API, console) | yes (console, breakpoint) | yes (discover + run) | load: Windows + Docker; run/debug/tests: Docker (SDK 8.0.426 runtimes), console run also on Windows where a .NET 8 runtime happened to be installed |
| netstandard2.1 | 8.0 | yes | yes | n/a (library) | n/a | n/a | Windows + Docker |
| netstandard2.0 | 7.3 | yes | yes | n/a (library) | n/a | n/a | Windows + Docker |
| net8.0;net10.0 (multi-target) | per TFM | yes: one project context per TFM, Find/references once, Rename checks both contexts | yes | n/a (library) | n/a | n/a | Windows + Docker |
| global.json pins SDK 8.0.426, installed | — | yes: loaded with SDK 8.0.426's MSBuild (`sdk.version` 8.0.426), like `dotnet build` | — | — | — | — | Docker only (`GlobalJsonTests`) |
| global.json pins an SDK that is not installed | — | Health: *C# is not running*, the global.json path, its rollForward policy, the installed SDKs; **Install .NET SDK**, **Open global.json** | — | — | — | — | Windows (.NET test) + Docker (.NET test, e2e `compat-sdk-missing`) |
| net6.0, net7.0, .NET Framework, non-SDK-style | — | **not supported, not tested** | | | | | — |

How it is tested: .NET `CompatTests` and `GlobalJsonTests` (Windows with SDK 10 only: the run tests skip with a reason
where a runtime is missing; Docker: all run), e2e scenarios `compat` and `compat-sdk-missing` (Docker only). The Docker
e2e image `refyntra-linux-e2e-sdks` adds the .NET 8 SDK 8.0.426 and the .NET 9 runtime 9.0.21 to SDK 10 with Microsoft's
`dotnet-install.sh` (`scripts/test/linux-e2e.sh`); nothing is installed on the host. The image grows from 2.26 GB to
3.2 GB.

A global.json that pins an SDK older than 8.0 (unsupported) is not honoured for loading: the newest installed SDK's
MSBuild loads the solution instead (`MsBuildBootstrap.PickInstance`).

## Not supported and untested

macOS, Windows ARM64, remote/WSL/Dev Containers, virtual workspaces, non-SDK-style projects, net6.0 / net7.0 / .NET Framework targets, SDKs older than 8.0, VS Code versions other than the two above.

Known limitations are tracked in [docs/capabilities/alpha.md](../capabilities/alpha.md).
