# ADR-009: Test runner on VS Code's Testing API

Status: Accepted (alpha)

## Context

Refyntra already relates code and tests (Related, the "N tests" CodeLens) and runs and debugs projects with bundled
debuggers (ADR-008). Running the tests still needed another extension (C# Dev Kit, the Python extension, a Rust test
adapter). The goal: a Rider-like test runner with no other extension — discovery with exact locations, run, debug,
data rows, failure locations, rerun failed, continuous run — on VS Code's native Testing API
(`vscode.tests.createTestController`), so the Test Explorer, gutter icons, Test Results, "Rerun Failed" and
"Run on save" are VS Code's own.

Constraints:

- No new bundled component and no package added to user projects (coverage only when the project already references
  coverlet.collector).
- Running and debugging tests build and execute workspace code: trusted workspaces only (ADR-005).
- Debugging must work with the bundled netcoredbg (vsdbg cannot be used, ADR-008), also on Linux in Docker.

## Decision

1. **C# discovery in the host (protocol 1.15, `code/tests`).** The host knows every test method already (attribute
   identity of xUnit, NUnit and MSTest, `TestNavigation`). `TestDiscovery` lists, for every project that references a
   test framework assembly (one instance per project file), the test methods with their namespace, containing classes
   (nested classes as `Outer+Inner`), exact ranges, framework, skip reason and data cases written in source
   (`[InlineData]`, `[TestCase]`, `[DataRow]`: the arguments as written plus a normalised form for matching results).
   `[MemberData]`, `[ClassData]`, `[TestCaseSource]`, `[DynamicData]` and theories without data are marked
   `dynamicCases`: their cases exist only at run time. Syntax first (methods with attributes), semantic model only
   for those. Abstract and generic classes are left out (the tests run through derived or constructed types, whose
   names the source does not show). **Incremental**: with `uris`, only those documents are scanned; the client replaces
   their tests (after the last edit, 600 ms debounce). The tree: project → namespace → class → nested class → method →
   data cases.
2. **Run: `dotnet test` per project with a TRX logger** into a fresh temp directory (`--logger trx
   --results-directory <tmp>`; every `.trx` there is read, so multi-targeted projects work). `dotnet test` builds
   once per project and run. Filters (`--filter`) are built per selection and measured against the adapters:
   - xUnit and MSTest method: `FullyQualifiedName=Ns.C.M` (their names carry no arguments; a theory runs all rows).
   - NUnit method: its names carry the arguments (`M(1,2)`), and the escaped parenthesis that would make
     `FullyQualifiedName~Ns.C.M\(` precise is rejected by xUnit's filter parser ("Empty parenthesis") — so
     `FullyQualifiedName~Ns.C.M` minus the sibling methods whose names start with `M` (`&FullyQualifiedName!~Ns.C.MX`).
   - Class: `FullyQualifiedName~Ns.C.|FullyQualifiedName~Ns.C+` (nested classes); namespace: `~Ns.`; project: no
     filter. A data case runs its method (adapters cannot select one data row); all rows report.
   Results: TRX `UnitTestResult` (outcome, duration, `ErrorInfo/Message`, `StackTrace`, `StdOut`) mapped through
   `TestMethod className + name` to the method and, by normalised arguments, to the source case; a result whose
   arguments match no source case (MemberData, TestCaseSource) becomes a run-time case item under its method.
   Failures become `TestMessage`s at the first stack frame in the test's file (else the first frame in an existing
   file), with expected/actual for "Expected: / Actual:" messages (VS Code's diff). Cancelling kills the process tree.
3. **Debug: build, then `dotnet test --no-build` with `VSTEST_HOST_DEBUG=1` and `VSTEST_DEBUG_NOBP=1`, attach
   netcoredbg.** The test host prints `Process Id: N, Name: testhost` and waits until a debugger is attached; Refyntra
   starts a `refyntra-dotnet` attach session to N (the bundled netcoredbg, ADR-008); the host continues by itself
   (`VSTEST_DEBUG_NOBP=1` leaves out the `Debugger.Break()` inside the test host, which would stop in framework code).
   Breakpoints in the test and in the code under test bind as the assemblies load. The TRX results of the debugged
   run are reported like a normal run. Chosen over `VSTEST_HOST_DEBUG` with `dotnet test` building (a build inside the
   debugged run could not be shown as a task and its errors would only be text) and over `dotnet vstest` (needs the
   output assembly path per target framework; `dotnet test --no-build` resolves it). Verified with netcoredbg 3.2.0
   in Docker (Linux x64): the e2e stops at a breakpoint in the library a test calls.
4. **Continuous run** (`supportsContinuousRun` on the Run profile, VS Code's "Turn on Continuous Run"): on save of a
   C#, Python or Rust file, the test classes in the saved file run (within the requested scope); a save elsewhere runs
   the whole requested scope. Runs queue: one test run at a time.
5. **Rerun Failed, Run at Cursor, gutter icons, Test Results, filters** are VS Code's own. Refyntra adds **CodeLens
   "Run | Debug"** over C# test classes and methods with the last outcome (`refyntra.tests.codeLens`, default on) and
   **Run Tests for This Code** (editor context menu, Command Palette): the test itself when the cursor is in a test,
   else the tests that Related lists for the symbol (static references, so "tests that reference it", not coverage).
6. **Python: pytest**, only when it is installed for the user's interpreter (`python -m pytest --version`):
   discovery with `python -m pytest --collect-only -q` (file → class → function → parameter cases), runs with
   `--junitxml` into a temp file; debugging launches `pytest` as a module under the bundled debugpy. Without pytest the
   Python tests are not listed and Health says why. Discovery of Python and Rust starts when the Test Explorer opens
   (or Refresh), because it imports or compiles project code.
7. **Rust: `cargo test -- --list`** when cargo exists (module → test), runs with `cargo test` (exact names, or module
   prefixes) and parses `test … ok|FAILED|ignored` with the failure output. Debugging Rust tests is not offered
   (no bundled Rust debugger, ADR-008). Source locations of Rust tests are not known (`--list` prints names only).
8. **Coverage** (VS Code's Coverage profile and TestCoverage API): only for .NET test projects that **already
   reference coverlet.collector** (MIT; the project file or its restored `obj/project.assets.json`). The run adds
   `--collect "XPlat Code Coverage"`; every `coverage.cobertura.xml` in the results directory is read (line hits,
   merged across classes and reports) and reported as `FileCoverage` with statement (line) details for workspace files.
   Without coverlet.collector the tests run without coverage and the output and a notification say why: Refyntra
   never adds packages to user projects. No branch or declaration coverage; Python and Rust tests run without
   coverage.

## Consequences

- No size change: nothing new is bundled.
- Visual tests leave durations out (`REFYNTRA_TEST_NO_DURATIONS`, test-only) and mask the run time in the Test
  Explorer header: both differ from run to run.
- Data rows: VS Code shows source rows from discovery before the first run; run-time rows appear after a run and stay
  until their method disappears. A single data row cannot run alone (the adapters cannot filter it): its method runs.
- `dotnet test` output goes to the Test Results terminal; xUnit v2 does not capture `Console` output per test (MSTest
  and NUnit do), so per-test output depends on the framework.
- Microsoft Testing Platform-only projects (no VSTest adapter) are not supported: they do not write TRX through
  `--logger trx`.
- New protocol method (1.15): older hosts make the client show no C# tests (`ProtocolTooOld`).

## Amendment 1 (2026-10-14): framework versions and Microsoft Testing Platform

- Verified in Docker on `tests/fixtures/TestMatrix` (scenario `test-matrix`) next to `TestRunner` (xUnit 2, NUnit 3,
  MSTest 3): xUnit v3 on VSTest and on Microsoft Testing Platform (MTP), NUnit 4 and 5, MSTest 2 and 4, MSTest.Sdk (MTP).
  Each: discovery with data rows, run all (pass / fail / skip), one test.
- Test projects are also recognised without a restore: from the project file (xunit*, NUnit, MSTest*,
  Microsoft.NET.Test.Sdk, IsTestProject) and the written attribute names, so the Test Explorer is not empty before the
  first `dotnet restore`.
- MTP projects (`MSTest.Sdk`, `UseMicrosoftTestingPlatformRunner`, `EnableMSTestRunner`, `EnableNUnitRunner`, or a
  global.json test runner): on .NET 10 `dotnet test` refuses them in VSTest mode, so Refyntra builds the project and runs
  the test application (`dotnet exec <dll> --report-trx`, xUnit v3: `--report-xunit-trx`, `--results-directory`,
  `--filter` in VSTest syntax). `xunit.v3.mtp-off` stays on VSTest.
- Debugging MTP tests: netcoredbg launches the test application. Works for xUnit v3. **Known limitation:** for
  MSTest.Sdk netcoredbg verifies the breakpoint and the test runs, but it does not stop (cause not found yet); Run works.
- Coverage is collected for VSTest projects with coverlet.collector only; an MTP run says so in its output.
