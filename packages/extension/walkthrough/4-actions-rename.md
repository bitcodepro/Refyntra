# Actions and safe Rename

**Refyntra: Actions** shows what Refyntra can do at the cursor. When something is unavailable, it says why (for example
a project that did not load).

**Refyntra: Rename** first shows a preview of every change. Review it, then choose **Apply**. Before applying, Refyntra
checks again that the code has not changed since the preview; the edit goes into the editor buffers (not saved) and
Undo works as usual.

Refyntra's refactorings are also where VS Code keeps its own: press **Ctrl+.** (or right-click → **Refactor…**) on a
symbol or a selection for Extract Method, Change Signature, Move Type to File, Safe Delete and Rename, or use the
**Refyntra** submenu of the editor context menu. Text-only changes open in VS Code's **Refactor Preview** panel, where
you apply or discard them; Refyntra has checked the plan before the panel opens and checks every file again afterwards.

Above C# types and methods, **CodeLens** shows references, implementations and tests (and MediatR handlers, endpoints
and EF Core configuration); **Shift+Alt+H** shows the call hierarchy.
