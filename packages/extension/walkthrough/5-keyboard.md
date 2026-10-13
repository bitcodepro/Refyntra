# Keyboard presets

Refyntra uses the Visual Studio preset by default. Change **refyntra.keybindings.preset** to switch, or to `none` to turn shortcuts off:

| Preset | Find | Actions | Rename | Related | Navigate To (C#) |
|---|---|---|---|---|---|
| `visualStudio` | Ctrl+, | Ctrl+. | Ctrl+R Ctrl+R | Ctrl+Shift+Alt+F12 | Alt+` |
| `resharper` | Ctrl+T | Alt+Enter | Ctrl+Shift+R | Ctrl+Shift+G | Alt+` |

**Navigate To** (Rider's Alt+`) lists the declaration, implementations, base symbols, usages, tests, related files,
containing type, MediatR handler, endpoint, DI registration and call hierarchy of the C# symbol at the cursor, with
counts. VS Code has no default for Alt+` on Windows and Linux (Ctrl+` is the terminal). On macOS the key is
**Ctrl+Alt+`** because Option+` types a grave accent. On some Linux desktops (GNOME) Alt+` switches between windows of
the same application before VS Code sees it; change the binding there or turn that shortcut off.

**Next / Previous Usage**: F4 / Shift+F4 in a C# editor while the **Refyntra Usages** view has results (both presets).
They give way to VS Code's own F4 while its reference peek is open.

Find is Search Everywhere: Types, Symbols, Files, Commands and Settings in one list, with camel humps (`OSvc` finds
OrderService). Start the query with `#` for symbols only, `/` files, `>` commands or `@` settings.

On macOS, Cmd replaces Ctrl (Navigate To: Ctrl+Alt+`). A preset overrides some VS Code defaults (for example Ctrl+T, Ctrl+.). If you use another
keymap extension (Visual Studio Keymap, ReSharper/IntelliJ keymaps), the same keys may be bound twice; check
**Preferences: Open Keyboard Shortcuts** and keep the one you want.
