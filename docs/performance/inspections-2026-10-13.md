# Inspections OR1002–OR1010: cost (2026-10-13)

What the inspections cost on the C# host, and why typing does not trigger solution-wide work. Same machine as the
2026-10-09 baseline (Windows 11, .NET SDK 10).

## What runs when

- The extension sends `analysis/run` after typing pauses (700 ms debounce, `diagnostics.ts`) with the URIs of the C#
  files **open in the editor** (`documents`, protocol 1.16). Closed files are never inspected.
- The host analyses each requested document on its own: one walk of its syntax tree with semantic queries on the
  candidate nodes only (`CodeInspections.Analyze`). No rule looks outside the method it reports in; nothing
  enumerates the solution.
- Results are cached per document and reused while the document's **text version** and its project's **dependent
  semantic version** (signature-level changes of the project or the projects it references) are unchanged. A keystroke
  in one file re-analyses that file only; a body edit in another file does not invalidate anything.
- Quick fixes are computed only when invoked (the lightbulb lists them from the published results); Fix in scope reads
  every document of its scope once, on request.

## Measured (`InspectionsTests.ShopDocumentsAreAnalysedQuickly`, Debug build, in-process host)

Shop fixture (`tests/fixtures/Shop`, 3 projects), every `.cs` file passed as `documents`:

| Step | Documents analysed | Wall time |
|---|---|---|
| First request (cold: includes creating the compilations of the projects) | 8 | 4.1–4.2 s |
| One file edited (comment appended), all files requested again | 1 (7 reused) | 0.26 s |

The test asserts that the edit re-analyses exactly one document and finishes under 10 s; Shop has no inspection result
(its screenshots are unchanged).

This repository's own C# sources (`src/dotnet`, 107 files, a throwaway local run): 38.7 s for the cold request of all
107 files at once — dominated by building the compilations of eight large projects for semantic models, which the other
features share. In the editor only the open files are requested, so the cold cost is that of a few documents.

## Not done

- No background inspection of closed files (a "whole solution" mode would need a scheduler with priorities and is
  deliberately absent).
- The cache key is per project version: a signature change in a project re-analyses its open documents (a few files).
