# Overlap inventory

Every new rule starts with an overlap review: what the compiler, the .NET and ASP.NET Core analyzers
and the framework's own tooling already report, and the concrete extra value of a Refyntra rule. This page covers the
three early rule candidates that touch existing diagnostics (CancellationToken forwarding, route conflicts) and the
one rule Refyntra ships in Stage D, OR1001 "scoped service captured by a singleton".

How each statement was checked:

- **verified locally** — checked in this repository's environment (.NET SDK 10.0.300, ASP.NET Core targeting pack
  10.0.8, Microsoft.Extensions.DependencyInjection 10.0) on 2026-10-09, with the method named next to it.
- **documented** — taken from the Microsoft Learn page linked; not re-run here.
- **not verified** — stated as an assumption.

## Summary

| Area | Existing tool | What it already covers | Refyntra decision |
|---|---|---|---|
| CancellationToken forwarding | CA2016 (.NET analyzers in the SDK) | A method with a `CancellationToken` parameter calls a method that accepts a token and does not pass it | No Refyntra rule (dropped before shipping as candidate ids OR1003/OR1004; those ids now name the inspections below). Navigation only. |
| Minimal API route conflicts | ASP0022 (ASP.NET Core analyzers) | Two route handlers with the same route and method | No Refyntra rule (dropped candidate id OR1005, since reused). Endpoints in Find/Related explain routes. |
| MVC route conflicts | ASP0023 (ASP.NET Core analyzers) | Two controller actions with the same route | No Refyntra rule. |
| Scoped service in a singleton | Compiler | Nothing (DI lifetimes are runtime data) | — |
| Scoped service in a singleton | `ServiceProviderOptions.ValidateScopes` / `ValidateOnBuild` (Microsoft.Extensions.DependencyInjection) | At run time: resolving a scoped service from a singleton or from the root provider throws; at `Build()` every descriptor with an implementation type is validated | OR1001 (experimental): the same finding **statically, in the editor, before the app runs**, with the proof path. |

## CA2016 — forward the CancellationToken

- The rule exists and is shipped with the SDK analyzers. **Verified locally**: the SDK's
  `Sdks/Microsoft.NET.Sdk/analyzers/build/config/analysislevel_10_minimum|recommended|all.globalconfig` set
  `dotnet_diagnostic.CA2016.severity = warning`; `analysislevel_10_default.globalconfig` does not mention it, so with the
  default analysis level the rule's own default severity applies, which Microsoft Learn documents as *suggestion*
  (**documented**, [CA2016](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016)).
- It covers a CancellationToken-forwarding rule completely, including an endpoint calling `Send` without the
  token: `ISender.Send(request, CancellationToken)` is an ordinary method with an optional token parameter, which is
  the shape CA2016 checks (**documented**; not exercised by a Refyntra fixture).
- Extra value Refyntra could add: none as a diagnostic. Related already shows the endpoint ↔ `Send` ↔ handler chain, which
  is where the reader looks after CA2016 fires.

## ASP0022 / ASP0023 — route conflicts

- **Verified locally**: `Microsoft.AspNetCore.App.Analyzers.dll` of the ASP.NET Core 10.0.8 targeting pack contains the
  titles "Route conflict detected between route handlers" (ASP0022, Minimal APIs) and "Route conflict detected between
  controller actions" (ASP0023, MVC). The ids are taken from Microsoft Learn (**documented**,
  [ASP0022](https://learn.microsoft.com/en-us/aspnet/core/diagnostics/asp0022),
  [ASP0023](https://learn.microsoft.com/en-us/aspnet/core/diagnostics/asp0023)); their exact matching rules (constraints,
  optional parameters, groups from other methods) were **not verified**.
- Extra value Refyntra could add: navigation (`route:` in Find, endpoints in Related) — no new warning id.

## OR1001 — scoped service captured by a singleton

### What already exists

- **Compiler**: no check. Lifetimes are arguments of `AddScoped`/`AddSingleton` calls, not types.
- **Microsoft.Extensions.DependencyInjection** — **verified locally** with a throw-away console that registers each case
  of the `tests/fixtures/DiRules` corpus into a fresh `ServiceCollection` and calls
  `BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true })`:
  - `ValidateOnBuild` throws `Cannot consume scoped service 'X' from singleton 'Y'` at build time for **every** corpus
    case whose singleton has an implementation type: direct, transitive (the message names the first edge, the transient
    `IReportBuilder`, not the scoped service at the end), `typeof`, two roots in one container, a conditional registration
    that ran, a factory-registered scoped dependency, `IEnumerable<T>`, `TryAdd`, an open generic consumed as a closed
    type, a keyed service, and a class with two constructors.
  - A singleton **registered with a factory** (`AddSingleton<IFactCache>(sp => new FactCache(sp.GetRequiredService<IFactRepository>()))`)
    is *not* detected by `ValidateOnBuild`; resolving it with `ValidateScopes = true` throws
    `Cannot resolve scoped service 'IFactRepository' from root provider`.
  - `WebApplication.CreateBuilder` turns both validations on in the **Development** environment only: the direct case
    throws in `builder.Build()` with `EnvironmentName = "Development"`; with `"Production"` the build succeeds and the
    singleton silently holds the scoped instance (verified by resolving it from the root provider).
- **Other analyzers**: we know of no SDK or ASP.NET Core analyzer for DI lifetimes (ASP0000 is about calling
  `BuildServiceProvider` in application code); this was **not verified** exhaustively. Third-party analyzers on NuGet were
  **not reviewed**.

### Exact additional value of OR1001

The runtime validation is more complete than OR1001 (it sees every registration, including framework ones and
registrations made by libraries). OR1001 does not replace it. What it adds:

1. **Static, before running**: the warning appears in the Problems view while editing, without building, starting the
   app or reaching the code path; it also works when the app is only ever started in Production, where the runtime
   check is off by default.
2. **The proof path**: the warning lists every step with a location — the singleton registration, each constructor
   parameter, each intermediate registration, the scoped registration — as related information. The runtime message names
   the singleton and one service only (for a transitive case: the first edge, not the scoped service at the end).
3. **Explained silence**: when it cannot prove a path (factory, conditional, keyed, …) it says why on demand, instead of
   publishing a guess.

What it does **not** add: coverage beyond the runtime check. Its scope is deliberately narrower (one composition root,
constructor edges only); see [OR1001.md](OR1001.md) for the corpus numbers.

### Decision

Ship OR1001 as **experimental**, default severity `warning`, setting `refyntra.rules.OR1001` (`off|information|warning`),
no code fix. No second rule in Stage D: the other candidates are covered by CA2016/ASP0022/ASP0023 (navigation only).

## Inspections OR1002–OR1010 (2026-10-13)

What the SDK already reports was **verified locally** (.NET SDK 10, default analysis level, a console project with
every candidate pattern, built with `-p:ErrorLog=…sarif`): the only analyzer results were **CA1827** (`Count() > 0` →
`Any()`), **CA1829** (`Count()` → `Length`/`Count`) and **CA1860**; the compiler reported **CS4014** for every unawaited
`Task`/`ValueTask`-returning call in an async method (plain, async and interface methods, `Task.Delay`, `Task.Run`). Not
reported by default (verified in the same build): CA2000 (dispose before losing scope), CA1851 (possible multiple
enumeration), anything about `.Result`/`.Wait()`, `async void`, `Where(…).First()`, `ToList()` before an operator,
`string.Format` without arguments. The Microsoft.VisualStudio.Threading analyzers (VSTHRD002/100/110) cover some of
this but are a separate NuGet package (**documented**, not part of the SDK).

| Candidate | Existing default diagnostic | Decision |
|---|---|---|
| `.Result` / `.Wait()` / `GetAwaiter().GetResult()` | none | **OR1002** with *Use 'await'* (+ async for Task-returning methods) |
| `async void` (not an event handler) | none | **OR1003** with *Change to async Task* |
| Unawaited task in an async method | **CS4014** (compiler) | No duplicate: OR1004 reports only what CS4014 misses (non-async methods, `?.` calls); Refyntra adds *Add 'await'* / *Discard* quick fixes to CS4014 |
| Missing `ConfigureAwait(false)` | none (CA2007 exists, off by default) | **No rule**: a project policy, not a defect |
| Disposable local never disposed | CA2000 exists, off by default | **OR1005**, narrower than CA2000 (only proven non-escaping locals), with *using var* |
| Multiple enumeration | CA1851 exists, off by default | **OR1006**, path-aware (exclusive branches, early returns), with *ToList()* |
| `s += x` in a loop | none | **OR1007**, only strings the loop never reads, with *StringBuilder* |
| `Count() > 0` / `Count() == 0` | **CA1827 / CA1829 / CA1860** (on by default) | **No rule** (would duplicate) |
| `Where(p).First()` … | none | **OR1008** (hint) with the predicate overload |
| `ToList()` / `ToArray()` enumerated once | none | **OR1009** (hint) |
| `string.Format` without arguments | none | **OR1010** |
| Unused private members | IDE0051/IDE0052 (IDE) | **No rule** |

The exact value over the off-by-default CA rules: they are not on by default, and Refyntra's versions are scoped to what
can be proven from one method (fewer results, each with a compile-checked fix and Fix in scope). Each rule page lists
its false-positive guards; the fixture `tests/fixtures/Inspections` keeps every guard as a test
(`InspectionsTests.EveryMarkedCaseIsReportedAndNothingElse`).
