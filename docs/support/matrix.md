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

The same `linux-e2e.sh` run with `REFYNTRA_TEST_VSCODE_VERSION=stable` (VS Code 1.141.0) passed every step as well (2026-10-09).

Not tested on Linux: VS Code versions other than 1.90.2 and 1.141.0, a desktop session (only Xvfb), other distributions, glibc/musl variants, arm64, a real (non-WSL) kernel, other fixtures. Linux is therefore verified for this one configuration only, not declared supported in general.

Also learned: the unit test `processTree.test.ts` had never run on a POSIX system (a newline escaping bug made its child process fail to start); it is fixed. Inside a container use `docker run --init`, otherwise orphans stay zombies and process-existence checks report them alive.

## Not supported and untested

macOS, Windows ARM64, remote/WSL/Dev Containers, virtual workspaces, non-SDK-style projects, older SDKs, VS Code versions other than the two above.

Known limitations are tracked in [docs/capabilities/alpha.md](../capabilities/alpha.md).
