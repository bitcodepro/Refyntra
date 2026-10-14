# ADR-012: Structural search and replace — pattern language and matching semantics

Status: Accepted (alpha)

## Context

Rider and ReSharper let a user describe code by its shape ("`$x$.Result` where `$x$` is a `Task`") instead of by its
text, find it in a scope, replace it with a template, and keep such patterns as custom inspections. Text search with
regular expressions cannot do this: `Console.WriteLine(x)` is also written `System.Console.WriteLine(x)`, `C.WriteLine(x)`
behind `using C = System.Console;` or `WriteLine(x)` behind `using static System.Console;`, and a `Count()` on a custom
class is not `Enumerable.Count()`.

Refyntra already has a Roslyn host with snapshots, compile-checked edits and a multi-file plan pipeline (prepare →
preview → revalidate → EditApplier, ADR-004), and inspections in a diagnostics channel with quick fixes (protocol
1.16). Structural search must reuse them, use only public Roslyn APIs, and stay out of shared code where possible.

## Decision

### 1. Pattern language

- A pattern is C# code in which **placeholders** `$name$` stand for code. The text is parsed, after replacing each
  placeholder by an identifier `__ssr_name`, as an **expression**, else as **statements**, else as **type members**.
  Anything else is refused with the parser's first error (reason `InvalidPattern`). A `$` that does not start a
  placeholder is refused, except in interpolated strings.
- Placeholder constraints (all optional):
  - **kind**: `any` (default), `expression`, `statement`, `identifier`, `type`, `argument`, `member`;
  - **type**: the expression's type is this type or derives from / implements it (`exactType`: exactly it). Names are
    C# keywords (`string`), metadata names (`System.Collections.Generic.IEnumerable`1`), or C# names with type
    arguments (`IEnumerable<T>`: a single capital letter or an unknown argument means "any construction";
    `Task<int>`: exactly that construction). Simple names are looked up in the pattern's imports. A type the project
    does not have matches nothing there and is reported as a note;
  - **count** `min..max` for an `argument` placeholder that is a whole argument, or a statement placeholder written
    as a statement (`$body$;`): it stands for a run of arguments / statements (default 1..1; a `min` without `max`
    means "no upper bound");
  - **regex**: the matched text (an identifier's name; a member's declared name) matches the whole .NET regular
    expression (200 ms timeout per match).
- A pattern may have **imports** (namespaces the pattern and its replacement are written against; default `System`,
  `System.Collections.Generic`, `System.Linq`, `System.Threading.Tasks`).
- A **replacement template** is the same kind of code with the same placeholders; it may not use a placeholder the
  pattern does not define (`InvalidReplacement`). An empty replacement deletes matched statements or members.

### 2. Binding the pattern

The pattern is compiled once per project inside a synthetic class added to that project's compilation (never to the
workspace): placeholders become parameters of their constraint type (an open generic constraint is constructed with
`object`), else `dynamic`. This gives every name in the pattern a symbol where one exists, without any knowledge of the
target file's usings. Constraint types resolve against the project's own compilation.

### 3. Matching semantics

A pattern node matches a target node when:

1. **Parentheses** are ignored on both sides; **trivia** (whitespace, comments, directives) never takes part.
2. A **placeholder** binds the target node if it satisfies kind, type, count and regex; a placeholder used **twice**
   must match **equivalent** code: equal syntax (Roslyn `AreEquivalent`, parentheses ignored) and the same symbol for
   every name (`this.x` is not `x`; `s` in two scopes binding to different symbols is not the same).
3. A **name** of the pattern that binds to a namespace, a type or a static member (also constants) matches **any
   spelling of the same symbol**: simple, qualified, `global::`, an alias, or a bare name behind `using static`.
   Methods compare by containing type and name (all overloads are one symbol for matching), extension methods by their
   static definition, generic types by their definition.
4. A name that binds to an **instance member** matches a target name only if the target binds to the same member or
   to a member that overrides or implements it (`ICollection<T>.Count` matches `List<int>.Count`). A pattern name that
   does not bind (e.g. a member of a `dynamic` placeholder) compares by text.
5. `var` matches `var`; it is never compared with the inferred type.
6. Otherwise node kinds must be equal and all children must match in order; tokens compare by kind and value.
   Argument lists and blocks are matched as sequences, so count placeholders can take 0..n elements (backtracking,
   fewest first).
7. A **statement** pattern also matches a block holding exactly that one statement (`if (c) { return true; }` matches
   `if ($c$) return true; …`), and the other way round.

Search order: expression patterns are tried on every expression (the parenthesised form and the right part of a
qualified name are skipped, so a match is reported once); statement and member patterns are matched against runs of
consecutive statements of blocks and switch sections and of members of types (non-overlapping per list), and one-
statement patterns also against embedded statements. Generated code is skipped; a linked file is searched once.
Documents that lack a word every match must contain (member names of the pattern that are not types or namespaces)
are skipped without building a semantic model.

### 4. Replacement

For each match, the template is instantiated with the matched code: an expression is parenthesised when it is not
primary and sits inside another expression (Roslyn's simplifier removes parentheses that are not needed), the whole
replacement is parenthesised under the same rule, list placeholders expand into argument lists and statement lists,
identifier placeholders keep the matched name. Replaced nodes are formatted with the document's options (and nothing
else is). Namespaces of the pattern's imports that the replacement needs (a type named without qualification, an
extension method) are added as using directives; added usings nothing uses are removed again. Overlapping matches keep
the outermost.

Every changed document is **compile-checked** against the snapshot: when the replaced document has a compiler error it
did not have before, each match is checked alone and the matches that introduce an error are **refused and listed**
(file, line, first error) in the plan's limitations; if all are refused, the request is unavailable with the list.
The plan then goes through `SolutionPlanBuilder` (the project closure must compile without new errors, read set,
revalidation) and the client's existing preview → revalidate → EditApplier pipeline with Undo.

### 5. Protocol (minor 19)

- `code/structuralSearch` → matches with ranges, the start line text and the placeholder values (one line), files
  searched / with matches, a result cap (`limit`, default 200, at most 5000; `truncated` → the client asks again with a
  larger limit), notes, `elapsedMs`. Invalid patterns answer with `reasonCode` / `message`, not an error. Cancellable.
- `code/structuralReplace` answers like `refactor/prepare` (action `csharp.structuralReplace`), optionally only for
  given matches (document + start). `refactor/prepare` with that action and `structural` params is equivalent.
- `analysis/run` `structuralPatterns`: pattern inspections, rule id `ORS-<name>`, severity, message and quick fix title,
  run on the requested (open) documents. Their quick fix is the edit action `csharp.edit.fix.structural.ORS-<name>`
  (code/editActions; compile-checked, one undo step) and works with `csharp.fixAll` in a document, project or
  solution. The host remembers the patterns of the latest run for these actions.

### 6. Client

Patterns are stored by the client: the workspace in `.refyntra/patterns.json` (meant to be committed), the user's in
the extension's global storage, both as `{ "version": 1, "patterns": [...] }`; built-in examples are read-only.
Saved patterns marked "show as inspection" are sent with every inspection run; `refyntra.rules.ORS-<name>` can turn one
off or override its severity.

## Consequences

- Matching is syntactic with symbol checks, not data-flow: `a == null || a == ""` does not match
  `string.IsNullOrEmpty(a) || a.Length == 0`; commutative operators are not reordered; `x.Count()` written as
  `Enumerable.Count(x)` is a different shape.
- A pattern whose names do not resolve (a misspelt type) still matches by text: the user sees matches and the
  type-checking note rather than nothing.
- Comments inside matched code that is not a placeholder are dropped by a replacement (the preview shows it).
- The pattern host compiles a small synthetic tree per project and search; costs are measured in
  `docs/performance/structural-search-2026-10-14.md`.
