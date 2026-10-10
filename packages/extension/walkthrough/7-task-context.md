# Keep a task context

The **Refyntra Task Context** view holds what you need for the task at hand: symbols (C#, TypeScript/JavaScript,
Python, Rust), files, endpoints and pinned relations. Keep several named contexts and switch between them.

- **Add Symbol at Cursor** (view title, or the Refyntra editor menu), **Add File** (Explorer or editor menu), the
  **+** button of a Find result, or **Add to Task Context** on a Related item (pins subject, relation and target).
- Each item says in words whether it is **resolved**, **moved** (found again at a new place), **ambiguous** (choose
  which symbol you meant) or **missing** (kept, with the reason). Opening an item always resolves it again first.
- Reorder with drag and drop or **Alt+Up** / **Alt+Down**; add a note to any item.
- **Copy as Markdown** copies names, relative paths and notes (no source code); **Export** and **Import** use a JSON
  file you choose.

Task contexts are stored locally for this workspace. They are never synced and never sent anywhere. Refyntra stores a
description of each item (names, a relative path, the last line and a short hash of that line), not the code itself.
