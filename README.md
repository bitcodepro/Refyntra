# Refyntra

> **Alpha.** Commands and settings may still change.

A free (MIT) VS Code extension for understanding, navigating, refactoring, running and debugging code. It is
self-contained: **no other extension is needed**. C# is analysed by a local Roslyn host; Python and Rust use bundled
language servers (Pyright, rust-analyzer); TypeScript and JavaScript use VS Code's built-in features. Everything runs
locally: no telemetry, no account, your code is not sent anywhere.

Full documentation: **[docs/guide.md](docs/guide.md)**.

## Features

**Find and navigate**
- **Find** (search everywhere): types, members, files, endpoints, EF Core entities and tables, with filters (`type:`, `route:/path`, `method:GET`, …)
- **Related**: callers, implementations, tests, request handlers, endpoints, DI registrations, EF Core entities and queries of the symbol under the cursor
- **Usages** grouped by kind; Navigate To; File Structure; Recent Files and Recent Locations; Go to Definition, Implementation and decompiled metadata (Ctrl+click opens the implementation)
- **Stack traces**: paste one and jump to its frames; **Task Context**: keep the symbols and files of a task together
- Framework-aware: MediatR, ASP.NET Core Minimal APIs and MVC, EF Core, dependency injection; frontend calls ↔ backend endpoints (heuristic)

**Refactor (always with a preview)**
- Rename (also the file and EF Core migrations), Safe Delete, Extract Method, Change Signature, Move Type to File
- Introduce / Inline Variable and other edit actions, Generate (constructor, Equals/GetHashCode, …), constructor and DI helpers, postfix templates
- Code Cleanup; Structural Search and Replace (find code by its shape)

**Inspections (C#)**
- Singleton capturing a scoped service (OR1001), sync over async, `async void`, discarded tasks, undisposed locals, multiple enumeration, possible N+1 queries and more, each with a quick fix

**Run and debug**
- Run and debug .NET projects (bundled netcoredbg), Python (bundled debugpy), package.json scripts and Cargo binaries
- Several projects in one window: every project of the folder, grouped by solution; **run groups** start or debug several projects together (a web project is waited for before the next one), each debugger named `Group › Project`
- Values next to the lines while stopped, Immediate Window, Smart Step Into, Hot Reload (`dotnet watch`)
- Test Explorer for xUnit, NUnit and MSTest: run and debug tests, affected tests on save, Change Impact

**Project tools**
- Solution Explorer, project file editing, NuGet packages, EF Core tools (migrations, update database, SQL script)
- **Health** page: is it working, what it means, the one-click fix (for example *Restore packages*)

**Other languages**
- Python and Rust (navigation, diagnostics, run and debug), HTML and CSS/SCSS/LESS, React, Next.js and Angular

## Requirements

- VS Code 1.90 or newer; Windows x64 (main target), Linux
- For C#: a .NET 10 SDK; SDK-style projects for net8.0, net9.0, net10.0, netstandard2.0/2.1
- For Rust: the Rust toolchain (`cargo`)
- A trusted workspace: loading projects evaluates MSBuild, so Refyntra does nothing with project code in Restricted Mode, and never restores or builds on its own

## Getting started

1. Open a folder with a `.sln`, `.slnx` or `.csproj` and trust it. The status bar shows **Refyntra: C# Ready**; click it for a menu of all commands.
2. Put the cursor on a symbol and run **Refyntra: Related**, or search with **Refyntra: Find**.
3. Run or debug from the **Refyntra Run** tab (its own icon in the activity bar, **Ctrl+Alt+R**), or press F5 without a launch.json.
4. Keyboard: VS Code's keys stay by default; **Refyntra: Keyboard Shortcuts Preset** switches to the Visual Studio or the alternative preset.
5. If something is missing, open **Refyntra: Show Health**.

**Refyntra: Get Started** shows the same as a walkthrough.

## Development

`pnpm test:unit`, `pnpm test:architecture`, `pnpm test:host`; extension tests in Docker with
`bash scripts/test/linux-e2e.sh` and `bash scripts/test/linux-visual.sh`. Details in [docs/guide.md](docs/guide.md#testing)
and [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Releases

Successful main CI runs publish versioned VSIX packages to GitHub Releases. See
[release versions, safeguards and recovery](docs/releases.md).

## License

MIT, see [LICENSE](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

