# Troubleshooting

Start with **Refyntra: Show Health**. It shows the state of the C# backend (`Ready`, `Partial`, `Loading`,
`Restarting`, `TrustRequired`, `NotStarted`, `Failed`), a reason code, the selected .NET SDK, every project with its
load state and diagnostics, the restart count and the recovery actions you can click. The **Refyntra** output channel
has the log (set `refyntra.trace.level` to `debug` for per-request timings). Logs never contain source text.

## The .NET SDK is not found (`SdkNotFound`, `ExecutableNotFound`)

Refyntra needs an installed .NET SDK 10.0.x; it does not download or bundle one.

1. In a terminal, run `dotnet --list-sdks`. It must list a `10.0.x` SDK. If `dotnet` is not found, install the SDK
   and make sure `dotnet` is on the `PATH` that VS Code was started with (restart VS Code after installing).
2. A `global.json` in the workspace can pin a different SDK version; `dotnet --version` run in the workspace folder
   shows which SDK it selects. Install that SDK or relax the pin.
3. Run **Refyntra: Restart Backend**.

`ExecutableNotFound` means `dotnet` itself could not be started; `SdkNotFound` means `dotnet` runs but no usable SDK
was found for the workspace.

## Status is Partial (`PartialLoad`) or no project loads (`NoProjectsLoaded`)

Some projects could not be loaded. Show Health lists each project as `loaded`, `partial` or `failed` with the reason
from MSBuild. Results that depend on a failed project are incomplete and say so; Rename refuses to plan across a
project it could not load.

Common causes:

- packages are not restored (next section);
- the project targets a framework or uses an SDK/workload that is not installed (`dotnet --info`);
- the project is not SDK-style (old-style `.csproj` is not supported);
- the wrong solution is selected: run **Refyntra: Select Solution**.

## Packages are not restored (missing references, empty results after cloning)

Refyntra never runs `dotnet restore` or `dotnet build` on its own. When assets are missing, Show Health shows the
diagnostic with **Run dotnet restore**. Clicking it (only in a trusted workspace) runs `dotnet restore <solution>` as a
task in the terminal panel; afterwards the backend reloads. You can also run `dotnet restore` yourself and then
**Refyntra: Restart Backend**. Private feeds and credentials are handled by `dotnet`/NuGet, not by Refyntra.

## Restricted Mode (`TrustRequired`)

Loading a project evaluates MSBuild, which can run code from the project. In Restricted Mode Refyntra therefore does
not start the C# host, does not evaluate, restore or build anything and ignores `refyntra.hostPath`. Find, Related,
Actions and Rename explain that the workspace must be trusted. If you accept evaluating the projects, trust the
folder (**Manage Workspace Trust**); Refyntra starts by itself after trust is granted. Trust is not a sandbox.

## The host crashed or stopped restarting (`BackendExited`, `RestartLimitReached`)

When the host process exits unexpectedly Refyntra restarts it with a back-off (0.5 s, 2 s, 5 s, 10 s) and replays
your open, unsaved documents, so no edit is lost. After 4 automatic restarts within 5 minutes it stops
(`RestartLimitReached`) instead of looping; the state is `Failed`.

1. Open Show Health and the **Refyntra** output channel to see the exit reason.
2. Fix the cause if it is visible (SDK, restore, a project that crashes MSBuild evaluation).
3. Run **Refyntra: Restart Backend** to start again manually (this also resets the counter).

When the host stops — VS Code window closed, extension disabled, or a restart — its child processes (Roslyn
BuildHost, MSBuild nodes) are stopped with it. If you ever see a leftover `dotnet` process running
`Refyntra.Host.dll` or `Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.dll` after VS Code has closed, please
report it with a debug bundle.

`ProtocolMismatch` means the extension and the host are from different versions; reinstall the extension (do not
point `refyntra.hostPath` at an older build).

## Export a debug bundle

**Refyntra: Export Debug Bundle** collects what is needed to diagnose a problem into one local JSON file:

- extension, host (engine) and protocol versions, VS Code version, OS and architecture, the .NET SDK version;
- the backend state per adapter: reason code and message, restart count, the duration of the last load, every
  project's load state and diagnostics;
- the last 200 lines of the **Refyntra** output channel and request timings derived from them.

It never contains source text, environment variable values or tokens. Paths are redacted: your home folder becomes
`<home>` and the workspace folder `<workspace>` (in every spelling: `C:\…`, `C:/…`, `file:///c%3A/…`).
Project and solution names are replaced by `project-1`, `solution-1`, … unless you tick **Include project and
solution names**. Unstructured output of child processes (raw MSBuild text) is left out.

Nothing is written or sent before you agree:

1. Choose whether to include project names.
2. The complete bundle opens as a read-only preview — exactly the text that will be saved.
3. Click **Save…** and choose where to save it. Cancel at any point and nothing is written.

Refyntra makes no network request; attach the file to an issue yourself after reviewing it.
