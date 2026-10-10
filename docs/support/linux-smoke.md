# Linux smoke how-to

A headless check that the TypeScript packages and the .NET host build, pass their tests and answer requests on Linux. It does not involve VS Code and does not make Linux supported (see [matrix.md](matrix.md)).

Requirements: Docker with Linux containers and the images `node:22-bookworm` and `mcr.microsoft.com/dotnet/sdk:10.0` (Ubuntu 24.04; pulled automatically; network needed for pnpm packages).

```
bash scripts/test/linux.sh
```

On Windows run it from Git Bash with the Docker CLI on `PATH` (for example `C:\Users\<you>\AppData\Local\Programs\DockerDesktop\resources\bin`). Takes about 4 minutes.

What it does:

1. Builds a throw-away image: .NET SDK 10 plus Node 22 (copied from the node image) and rsync. pnpm comes from corepack at the version in `package.json`.
2. Runs the container with the repo mounted **read-only** at `/src` and `--init` (a real init reaps orphans; without it killed grandchildren stay zombies and the process-tree unit test fails).
3. Copies the repo to `/work` without `node_modules`, `bin`, `obj`, `dist`, `out`, `*.tsbuildinfo`, `.git`, `.vscode-test`, so the Windows tree gets no Linux artifacts.
4. Runs, one after another and without stopping at the first failure: `pnpm install --frozen-lockfile`, `pnpm -r run build`, `pnpm test:unit`, `pnpm test:architecture`, `dotnet build` + `dotnet test src/dotnet/Refyntra.sln -c Release --no-build`, and `node scripts/test/benchmark.mjs` against a copy of `tests/fixtures/Shop`.
5. Checks that no `Refyntra.Host`/BuildHost process remains and prints a PASS/FAIL summary; the exit code is non-zero if any step failed.

Known result today: everything passes, including `HostProcessTests.NoChildProcessOutlivesTheHost(abrupt: True)` (see "No orphans on Linux" below).

Pitfall: a single `dotnet test` of the cold tree (build and test in one command) stalled for more than 10 minutes in this container, in three runs; build first, then `--no-build`. The cause was not analysed.

## Real VS Code on Linux (end-to-end)

```
bash scripts/test/linux-e2e.sh
```

Builds `refyntra-linux-e2e` on top of the smoke image (Xvfb, xauth, dbus and the Electron libraries; on Ubuntu 24.04 several carry a `t64` suffix: `libatk1.0-0t64`, `libatk-bridge2.0-0t64`, `libgtk-3-0t64`, `libasound2t64`, `libcups2t64`, plus `libnss3`, `libgbm1`, `libxkbfile1`, `libsecret-1-0`, ...). Same read-only mount and copy to `/work` as above. Two Docker volumes make reruns fast: `refyntra-vscode-test` (the Linux VS Code that `@vscode/test-electron` downloads, linked as `/work/.vscode-test`) and `refyntra-nuget`. `REFYNTRA_TEST_VSCODE_VERSION` is passed through (default 1.90.2).

It runs everything the smoke runs, then `xvfb-run -a pnpm test:integration`, `xvfb-run -a pnpm test:e2e` with `REFYNTRA_HOST_PATH` = the Release host built in the container, `pnpm package:vsix`, `xvfb-run -a pnpm test:install`, and checks that no host/BuildHost/watchdog process is left. About 10 minutes with warm volumes.

Expected noise in the log, not failures: Electron GPU errors (`viz_main_impl`, `GpuControl.CreateCommandBuffer`; no GPU under Xvfb), dbus warnings, "Failed to fetch chat participant registry" (no network service in the test profile).

Linux-specific fixes this found (2026-10-09):

- `test:install` could not work on POSIX: its process-listing self-check looked for `process.execPath` in `ps` output (POSIX shows argv as typed, `node`) and dropped every line containing `install-smoke`, so it always reported "process listing does not work". It now spawns a probe process with a unique marker and skips its own line by pid.
- `test:install` on Linux called VS Code's `bin/code` shell script, which stops at an interactive "VS Code in WSL?" prompt when the kernel is a WSL2 one (Docker Desktop). It now runs the executable as Node with `resources/app/out/cli.js`, as on Windows.

## No orphans on Linux (abrupt kill)

Windows uses a Job Object. On Linux/macOS a host killed with SIGKILL cannot run code, and Roslyn starts BuildHost itself (`BuildHostProcessManager` is internal: no hook to set `PR_SET_PDEATHSIG` or change the start), BuildHost's stdin is `/dev/null`, and, observed with Roslyn 5.9, it stays alive re-parented to init. So the host (`ChildProcessGuard`):

1. becomes a process-group leader (`setpgid(0,0)`; already one when the extension starts it detached) — BuildHost and MSBuild children inherit the group;
2. starts a watchdog `/bin/sh -c 'read _; kill -s KILL 0'` whose stdin pipe only the host holds (close-on-exec, so BuildHost does not inherit it). When the host ends for any reason the kernel closes the pipe, `read` returns and the watchdog kills its own process group, i.e. the host's whole tree.

A graceful exit additionally kills the descendants found in `/proc`, and the extension kills the host's group when it disposes the host. If the extension host itself is SIGKILLed, the host sees EOF on stdin and exits gracefully, and the watchdog covers the rest.

Residual cases (not covered): a descendant that leaves the process group (`setsid`/`setpgid`; none observed for BuildHost); the watchdog being killed while the host keeps running (the host then has no abrupt-kill guard until restart; a graceful exit still cleans up); if `setpgid` fails the host logs a warning and runs without the watchdog. Note: the watchdog uses `kill -s KILL 0` because dash (Ubuntu's `/bin/sh`) rejects `kill -KILL -- -PGID`.
