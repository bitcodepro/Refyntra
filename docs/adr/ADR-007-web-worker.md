# ADR-007: A Refyntra web worker for React, Next.js and Angular

Status: Accepted (alpha)

## Context

TS/JS is a delegated route: Refyntra calls VS Code's public provider commands (definitions, references, symbols) of
the built-in TypeScript features (ADR-002). That is enough for navigation, but not for framework relations:

- **React props.** "This attribute sets that member of the props type" needs the type checker (contextual JSX
  attribute types, aliases, `memo`/`forwardRef` wrappers, class components). The provider commands return locations,
  not types; reconstructing props from hover text would be guessing.
- **Angular templates.** Template ↔ class bindings, selector ↔ component and NgModule scopes are known only to the
  Angular compiler's template type-checker. VS Code has no built-in Angular support, and Refyntra must not depend on
  another extension.
- **Next.js** routes are file-system conventions that differ by major version; they need no checker, but the boundary
  and client analysis shares the same file scan.

## Decision

1. **One worker process** (`dist/webWorker.js`, package `packages/web-frameworks`) runs on the Node runtime VS Code
   runs extensions on (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`), like the bundled Pyright. It hosts tsserver's
   `ProjectService` from the **bundled, exactly pinned TypeScript** and, per Angular project, the **bundled, exactly
   pinned `@angular/language-service`** as the only TypeScript plugin. Projects are read from the workspace's own
   `tsconfig.json` / `jsconfig.json`.
2. **Never runs project code.** The worker host never writes files, has no typings installer, refuses every plugin a
   tsconfig names (`ServerHost.require` returns only the bundled Angular plugin), and does not evaluate
   `next.config.*`, middleware or route guards: those are listed as limitations.
3. **When it runs.** Lazily, on the first Related / Find that needs it, only in a **trusted** workspace that contains a
   `package.json` depending on `react`, `next` or `@angular/core` (bounded scan, no `node_modules`). Restricted Mode
   never starts it; Related and Find say why.
4. **Memory and lifecycle.** `--max-old-space-size=3072`; the worker exits with code 3 after a request when its heap
   passes 2560 MB and is restarted on the next request. Requests time out after 60 s. Three crashes within 5 minutes
   stop automatic restarts until "Restart Backend". The process stops after 10 minutes without a request and on
   deactivation (`shutdown`, then kill). A new process gets a new session epoch; results of an older one are dropped.
   At most 64 files are kept open in a project service. Unsaved editor text of TS/JS/HTML documents is sent with each
   request (only what changed); file changes come from VS Code's watcher (the worker watches nothing itself).
5. **Version policy.**
   - TypeScript: one pinned version (`6.0.3`) — the version the pinned Angular language service requires (>=6.0
     <6.1). Upgrading TypeScript and the Angular language service is one reviewed change with the fixtures green.
   - Angular: the bundled language service (`22.2.1`) gates template features by the project's `@angular/core`
     version from 17 on. Supported majors: **17–22** (22 verified by fixtures). Older or newer majors are refused with a
     reason, never answered approximately.
   - React: any version with a `react` dependency; relations come from the checker, not version rules.
   - Next.js: conventions table by major (pages router ≥ 9, app router, route handlers, parallel and intercepting
     routes ≥ 13); unknown versions get a limitation.
6. **Ownership.** The worker owns no documents. The `web.styles` route (HTML/CSS package) owns `.html`; the delegated
   TS/JS route owns `.ts/.tsx/.js/.jsx`. The worker contributes a **framework module** attached to both routes, so
   Related merges its relations with theirs (provenance kept, exact duplicates merged). Stylesheet links of Angular
   components (`styleUrl(s)`, `styles`) are left to `web.styles` and not duplicated.
7. **Guarantees.** proven = resolved by the TypeScript checker or the Angular language service (JSX tag → component,
   attribute → props member, template element / binding → class member, provider arrays, injection sites). likely =
   conventions and runtime-dependent structure (Next.js routes, Angular route definitions, React context
   providers/consumers). heuristic = literal paths matched to routes (`<Link href>`, `router.push`, `redirect`,
   `fetch('/api/…')`). Unused / missing props are information on the relation, never diagnostics.

## Consequences

- VSIX grows by the TypeScript compiler (`typescript.js` + `lib.*.d.ts`) and the Angular language service bundle
  (both without source maps); the audit allows exactly these files and the worker entry.
- A full routing graph is never claimed: middleware, rewrites, redirects, basePath, i18n, guards and lazy child
  prefixes from other files are limitations.
- The worker is the only process outside infrastructure (`src/host/workerProcess.ts`, enforced by
  `pnpm test:architecture`).

## Rejected alternatives

- Provider dispatch (`vscode.execute*Provider`) only: no types, no Angular template knowledge.
- The project's own `node_modules/typescript` or Angular language service: runs workspace code, unknown versions.
- Depending on the Angular Language Service extension: forbidden (no dependency on other extensions).
- Running the compiler in the extension host: an unbounded heap next to the UI; a separate process can be limited
  and restarted.

## Revisit criteria

A new Angular major (bump the pin and the window), TypeScript 6.1+, or the worker's memory exceeding the limit on
real projects.
