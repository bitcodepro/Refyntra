# Accessibility

Plan section 2.3 asks that every scenario works from the keyboard, that focus after a jump, a cancel and a preview is
predictable, and that screen-reader labels, high contrast and "no meaning by colour alone" are covered, with the same
words in the status bar, Actions, Problems and the rename preview. This page says what Refyntra does, how each point was
checked, and what has **not** been checked by a person with assistive technology yet.

## What is supported

### Keyboard

- Every command is in the Command Palette as **Refyntra: ...**. Only four internal commands are hidden (`openLocation`,
  `runRestore`, `related.open`, `nativeRename`); they are run by buttons and tree items.
- The status bar item is a button (screen-reader role `button`). Focus it (F6 cycles through the workbench parts, or run
  **Focus Status Bar** from the palette; arrow keys move between items) and press Enter for the Refyntra menu. The menu lists Find, Related, Actions,
  Rename, Find Handler, Find Endpoint, Find DI Registration, Show Health, Show Health (text), Select Solution, Restart
  Backend, Export Debug Bundle, Get Started and Keyboard Shortcuts. The Related view's Pin, Unpin and Refresh are in the
  palette and the view toolbar.
- No default keybindings. The Visual Studio and ReSharper-style presets are opt-in
  (`refyntra.keybindings.preset`, **Refyntra: Keyboard Shortcuts Preset**).
- Find, Actions, the status bar menu and the rename preview are QuickPicks: type, arrow keys, Enter, Esc.
- Focus after each step:
  - Find: Enter closes the list and puts the cursor in the opened file; Esc returns focus to where you were.
  - Actions: Esc returns to the editor; a chosen action runs its own command (Rename input box, Related view).
  - Related view: opening an item moves focus to the editor at that line (the same rule as other tree views).
  - Rename: the summary document opens without taking focus, the preview QuickPick has focus (`ignoreFocusOut`, so a
    mouse click elsewhere does not lose it), Esc discards the plan and returns to the editor, Apply closes the list and
    leaves focus in the editor; the result is shown as a notification.
- Health page (webview): a real `<button>` for every action, in reading order; `<details>/<summary>` for every
  collapsible (Space/Enter toggles); the page title is the first focus target when the page opens; after a live update
  the focused button or disclosure keeps focus, and if the focused control disappears (for example Restore packages
  while it runs) focus moves to the page title instead of being lost.

### Screen readers

- Health page: `lang`, `<title>`, one `<main>`, one `<h1>`, `<h2>` per language, `<h3>` Projects, no skipped heading
  levels, labelled `<section>`s, tables with captions and header cells, wide tables in a focusable named region.
  Button hints are read as the accessible description (`aria-describedby` to a visually hidden element), not only as a
  mouse tooltip. Status icons (emoji) are `aria-hidden`; the same meaning is always written next to them.
- A polite live region (`role="status"`) outside the re-rendered content speaks the status headlines and the restore
  banner, only when that sentence changed. A project count ticking up while a solution loads is silent.
- Related view items have `accessibilityInformation`: for example "Handler GetOrderQueryHandler, Shop.Api, proven"; a
  group reads "Handlers, 2 items"; status lines read "Warning: ..." or "Action: Show Health". Limitations are part of the
  label. Evidence (why a relation is shown) is still only in the tooltip, see "Known limits".
- Status bar: the visible text stays short ("Refyntra: C# Partial 7/8"); the screen-reader label is a sentence ("Refyntra:
  C# works partially, 7 of 8 projects loaded; TS/JS ready. Press Enter for the Refyntra menu.").
- QuickPick rows never rely on the codicon: Actions rows say "available", "limited" or "Unavailable: reason"; Find errors
  and limitations are prefixed "Error:" and "Limitation:"; rename preview diff rows say "open diff".

### High contrast and colour

- The Health page has rules for `body.vscode-high-contrast` and `body.vscode-high-contrast-light` (borders from
  `--vscode-contrastBorder`, focus ring from `--vscode-contrastActiveBorder`) and for `forced-colors: active`.
- Colour is never the only carrier: banners and sections have an icon **and** text; tree items use a different icon shape
  for non-proven relations **and** the word "likely" or "heuristic"; the status bar background colour is paired with the
  words in the item text ("Partial", "Failed").
- Focus is visible everywhere on the page (`:focus-visible`, 2px, `--vscode-focusBorder`).
- Motion: the page has no animations; a `prefers-reduced-motion` rule disables any that a future change adds. The spinning
  codicons (`loading~spin`) are VS Code's own and follow its reduced-motion setting.
- Reflow: text wraps (`overflow-wrap:anywhere`), buttons wrap in a flex row, tables scroll inside their own region, sizes
  are in `em`. The layout has no fixed widths, so zoom to 200 % keeps a single column. Buttons and disclosure rows are at
  least 24 px high (WCAG 2.2 target size).

## Glossary (the same word on every surface)

Defined once in `packages/extension/src/terminology.ts` (`GLOSSARY`, `STATE_PHRASE`, `REASON_PHRASE`,
`CONFIDENCE_PHRASE`, `RELATION_KIND_LABEL`). A unit test fails if this table and the code drift apart.

| Term | Meaning | Where it appears |
|---|---|---|
| **ready** | The backend runs and the whole solution is loaded. | Status bar, Health headline, Actions |
| **works partially** | Some projects did not load completely (for example missing NuGet packages). Results may be incomplete. | Status bar ("Partial 7/8"), Health, Related scope note |
| **Restricted Mode** | The workspace is not trusted; the C# backend is not started. | Status bar, Health, Related welcome, Actions |
| **not running** | The backend could not start or stopped. | Status bar ("Failed"), Health, Actions |
| **proven** | Refyntra can show the evidence; the relation or rule result is certain. | Related, Actions, OR1001 (proof path) |
| **likely** | Probably right, but not proven (for example a framework version that was not verified). | Related, scope note |
| **heuristic** | Found by a naming or shape rule, no proof. | Related |
| **limited** | Validation could not check everything; applying asks for an extra confirmation. | Actions, rename preview ("Validation is limited") |
| **incomplete** | Results may miss something because projects did not load completely. | Related scope note, Find notes, rename preview |
| **unavailable** | A feature cannot run now; the reason and the recovery action are shown. | Actions, Rename, Health |
| **not checked** | OR1001 stayed silent because it could not prove a path. Not a problem. | OR1001 explanation (abstentions), Problems "Explain" action |
| **preview** | Rename shows files, edits, project contexts and limits first. Nothing changes until Apply rename. | Rename preview, walkthrough |
| **Client call** | A fetch/axios/HttpClient call in TypeScript or JavaScript whose literal URL matches an ASP.NET route. Always heuristic. | Related (Endpoints from the call, Clients from the endpoint), Find client: |
| **Clients** | The Related group of an endpoint or action that lists its client calls (heuristic). | Related |
| **Styles** | The Related group of a class, id, CSS Module member, variable or mixin that lists the rules or definitions it uses. Global classes are heuristic; CSS Modules and SCSS/LESS imports are proven. | Related, Find css: |
| **Used by** | The Related group of a CSS rule, variable, mixin or stylesheet that lists its uses in HTML, code and other stylesheets. | Related |
| **Possibly unused** | Selectors of a stylesheet without a static use. Information only (never a problem): the class may be used dynamically. | Related |
| **resolved** | A task context item was found again where it was stored (or followed a rename made in Refyntra). | Task Context |
| **moved** | A task context item was found again at a new place by its name; the stored place is updated. | Task Context |
| **ambiguous** | Several symbols could be the task context item (or one with another kind or container); you choose, Refyntra never picks one silently. | Task Context ("Choose Symbol") |
| **missing** | A task context item was not found (deleted, or renamed outside Refyntra). It is kept with the reason. | Task Context |
| **not checked yet** | A task context item waits for its language support to be ready (loading or Restricted Mode). | Task Context |

A reason code has exactly one phrase (`REASON_PHRASE`), used by Health (page and text), the Actions list and the Related
tooltip, always followed by the raw code in brackets for support: for example "no solution or project found
(NoSolutionFound)". The raw protocol ids of relations (`mediatr.handler`) are shown as "Handler".

## How it was checked

Automated (run in CI with `pnpm run test:unit` and `pnpm run test:integration`):

- `packages/extension/test/unit/accessibility.test.ts`: an axe-like checker over the generated Health HTML in seven
  states (ready, partial with restore running, restore failed, Restricted Mode, SDK missing, no solution, loading):
  every button is a `<button type="button">` with a name, no inline event handlers or style attributes, one `h1` and no
  skipped heading levels, details have summaries, tables have captions and headers, ids are unique and references
  resolve, the live region exists and sits outside `<main>`, emoji appear only inside `aria-hidden` spans with adjacent
  text, a strict CSP. It also checks the stylesheet for focus, high-contrast, forced-colors, reduced-motion and reflow
  rules, `accessibilityInformation` for every Related item kind (with the vscode API mocked), the status bar label, the
  terminology (same reason code, same phrase in Health, Actions and Related), and that every command is in the palette
  and the status bar menu.
- Extension Host scenario `high-contrast` (`workbench.colorTheme` = "Default High Contrast"): the theme kind is High
  Contrast, the Health page opens and its HTML has the landmarks, live region and HC rules, a page action (Get started)
  works through the same message path as a click, the status bar item has its screen-reader label, and every contributed
  command is registered and visible in the palette.
- E2E `shop` scenario: the Related items for `GetOrderQuery` have a label like "Handler GetOrderQueryHandler, Shop.Api,
  proven".

**Not** checked by software, and not claimed: how NVDA, JAWS, Narrator or VoiceOver actually speak these pages and
lists, whether tooltips or the live region are too chatty in practice, real colour contrast of every theme, and zoom to
200 % in a real window. The webview HTML is not rendered in a browser by the unit tests (there is no DOM library in the
repository), so the checks are structural. No screen-reader session was run when this page was written.

## Manual check (NVDA or Narrator) to do

Setup: Windows 11, VS Code with `editor.accessibilitySupport` = `on` (or `Open Accessibility Help` Alt+F1), the Refyntra
extension, the repository fixture `tests/fixtures/Shop` opened. NVDA 2024.x or later (free) or Narrator (Win+Ctrl+Enter).

1. **Status bar.** Press F6 until the status bar is focused, then arrow to the Refyntra item. Expected: it reads "Refyntra: C# ready, N projects loaded; TS/JS ready. Press
   Enter for the Refyntra menu, button". Press Enter: a list of commands opens; arrow through all rows, each reads its
   name without the word "dollar" or an icon name.
2. **Health page.** Run "Refyntra: Show Health". Expected: "Refyntra Health, heading level 1" is announced first. Press
   Tab: first button is announced with its hint. Press H (NVDA browse mode) to walk the headings: Refyntra Health,
   C# ..., Projects, Technical details. Press Space on "Show technical details": it reads "expanded".
3. **Live update.** Open the Shop fixture without restoring (delete `tests/fixtures/Shop/**/obj`, or use a clone): Health
   says "C# works partially". Tab to "Restore packages", press Enter. Expected: one announcement "Restoring NuGet packages
   for Shop.sln..." and, when it finishes, one announcement of the new status. It must not read the page repeatedly while
   projects load. Focus must not jump to the top of the document except when the focused button disappears (then it lands
   on the title).
4. **High contrast.** Select "Default High Contrast" and "Default High Contrast Light" (Ctrl+K Ctrl+T). Check the Health
   page: every button has a visible border, focus is a clear 2px ring, banners have an outline, nothing depends on a colour.
5. **Related view.** Open `Shop.Contracts/Orders/OrderRequests.cs`, put the cursor on `GetOrderQuery`, run "Refyntra:
   Related". Arrow through the tree. Expected: "Handler GetOrderQueryHandler, Shop.Api, proven, ..." (and the position
   in the group, which VS Code adds). A group reads "Handlers, 1 item". Press Enter on a relation: focus moves to the editor
   at the target line.
6. **Actions and rename preview.** Run "Refyntra: Actions": rows read "available" or "Unavailable: <reason>". Run
   "Refyntra: Rename" on a symbol, type a new name, Enter. Expected: the preview list has focus and reads
   "Apply rename" first, then each file as "open diff, N edit(s)". Press Esc: focus is back in the editor and the file is
   unchanged.
7. **Problems (OR1001).** In `tests/fixtures/DiRules` open the Problems panel (Ctrl+Shift+M): each OR1001 entry reads
   with its code and message; Ctrl+. offers "Refyntra: explain OR1001 (proof path)"; the explanation document uses the
   words "proven" and "not checked".
8. **Zoom.** Ctrl+= five times (200 %) with the Health page open: no horizontal page scroll; the project table scrolls
   by itself and is reachable with Tab.
9. **Task Context view.** Put the cursor on `OrderService` in `Shop.Api/Services/OrderServices.cs` and run "Refyntra: Add
   Symbol at Cursor to Task Context". Focus the Refyntra Task Context view and arrow to the item. Expected: "OrderService,
   class, resolved, in Shop.Api/Services/OrderServices.cs line N". Shift+F10 opens the menu with Open, Show Related,
   Edit Note, Move Up, Move Down and Remove (no drag needed). Add three lines at the top of the file and wait a moment:
   the item reads "moved". The view's description (read with the view title) names the active context.

Write down anything that is spoken twice, not spoken, or spoken with a raw id or a codicon name; each of these is a bug
in `terminology.ts` or `healthPageHtml.ts`.

## Known limits

- The evidence of a Related item ("why is this a handler") is in the hover tooltip only. VS Code does not show tree
  tooltips on keyboard focus. The label carries kind, name, project, confidence and limitations; a keyboard-reachable
  "explain" command for Related items is not implemented.
- The Health page cannot be focused by a keybinding of its own; use the palette or the status bar menu.
- QuickPick item labels still start with a codicon (`$(lightbulb)`, `$(diff)`). VS Code removes the icon text for screen
  readers in its own lists; this was not verified for every VS Code version in the support matrix.
- The rename preview summary and OR1001 explanation are Markdown documents: they are as accessible as the editor
  (headings, lists). They are read-only virtual documents; the diff editors use VS Code's accessible diff viewer (F7).
