# Structural search: cost on Shop (2026-10-14)

What `code/structuralSearch` (protocol 1.19, ADR-012) costs on the C# host. Same machine as the 2026-10-09 baseline
(Windows 11, .NET SDK 10), Release build, in-process host (`StructuralSearchShopTests.MatchesAndTimingsOnShop`; the
numbers are written to the test output, nothing is asserted on time).

## What runs per search

- The pattern is parsed once; per project it is bound once (a small synthetic tree added to the project's existing
  compilation; the workspace is not changed).
- Each document of the scope is first checked for the words every match must contain (member names of the pattern,
  e.g. `Result` for `$x$.Result`); only documents that contain them get a semantic model and a syntax walk.
- The walk tries the pattern on candidate nodes only (expressions, or statement / member lists); semantic queries
  (symbol, type) run only where the syntax already matched.
- The result stops at the limit (default 200, at most 5000) and reports `truncated`.

## Measured on Shop (2 projects; 15 C# documents including the generated ones, which are skipped)

| Pattern | Matches | First search | Warm median (5 runs) | Warm max |
|---|---:|---:|---:|---:|
| `await $call$`, `$call$: System.Threading.Tasks.Task` | 4 | 6000 ms¹ | 5 ms | 9 ms |
| `await $x$` | 4 | 7 ms | 5 ms | 5 ms |
| `$s$.Send(new $T$($args$))`, `$args$`: 0..3 arguments | 3 | 51 ms | 14 ms | 14 ms |
| `$x$` (every expression; capped) | 200 (truncated) | 12 ms | 13 ms | 30 ms |
| `return $x$;` | 5 | 20 ms | 5 ms | 5 ms |

¹ The first request of the session pays for the projects' compilations and semantic models (the same cost Find,
Related or Rename pay on their first use); the search itself is the warm figure. Times are wall-clock through the
in-process JSON-RPC client, including the snapshot barrier; the host's own `elapsedMs` is a few ms lower.

## Replace

`code/structuralReplace` adds, per document with matches: one rewrite, simplification and formatting of the replaced
nodes, and one compile check of the document (semantic diagnostics, compared with the snapshot). Only when that check
finds a new error is each match checked alone (one more check per match of that document). The plan then runs the
usual project-closure check of `SolutionPlanBuilder`.

## Inspections

Pattern inspections run inside `analysis/run` on the open documents only, with the same word pre-filter; a document
without the pattern's words costs one text scan per pattern.
