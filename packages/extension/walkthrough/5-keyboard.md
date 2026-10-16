# Keyboard presets

Refyntra keeps VS Code's keys by default (its actions are in Ctrl+. and the editor context menu); the first start offers the Visual Studio or the alternative (`resharper`) preset. Change **refyntra.keybindings.preset** to switch, or to `none` to turn shortcuts off:

| Preset | Find | Actions | Rename | Related | Navigate To (C#) | Recent Files | Recent Locations | File Structure |
|---|---|---|---|---|---|---|---|---|
| `visualStudio` | Ctrl+, | Ctrl+. | Ctrl+R Ctrl+R | Ctrl+Shift+Alt+F12 | Alt+` | Ctrl+E | Ctrl+Shift+E | Ctrl+F12 |
| `resharper` | Ctrl+T | Alt+Enter | Ctrl+Shift+R | Ctrl+Shift+G | Alt+` | Ctrl+E | Ctrl+Shift+E | Ctrl+F12 |

**Navigate To** (Rider's Alt+`) lists the declaration, implementations, base symbols, usages, tests, related files,
containing type, MediatR handler, endpoint, DI registration and call hierarchy of the C# symbol at the cursor, with
counts. VS Code has no default for Alt+` on Windows and Linux (Ctrl+` is the terminal). On macOS the key is
**Ctrl+Alt+`** because Option+` types a grave accent. On some Linux desktops (GNOME) Alt+` switches between windows of
the same application before VS Code sees it; change the binding there or turn that shortcut off.

**Recent Files / Recent Locations** (Ctrl+E / Ctrl+Shift+E, Rider-style): the files you opened, the previous one first
(Enter switches back), and the places where you edited or the cursor rested, with the member and the code line. In a
preset these keys replace VS Code's Quick Open (still on Ctrl+P) and Show Explorer (still in the Activity Bar); not in
the terminal. On macOS: **Cmd+Alt+E** / **Cmd+Alt+Shift+E** (Cmd+E is Use Selection for Find, Cmd+Shift+E the Explorer).

**File Structure** (Ctrl+F12, Cmd+F12 on macOS): the members of the current file by type and `#region`, with filter
buttons (methods, properties, fields, events, nested types, inherited members for C#) and camel-hump filtering. In a
preset it replaces VS Code's Go to Implementations key (the command stays in the context menu).

**Next / Previous Usage**: F4 / Shift+F4 in a C# editor while the **Refyntra Usages** view has results (both presets).
They give way to VS Code's own F4 while its reference peek is open.

Find is Search Everywhere: Types, Symbols, Files, Commands and Settings in one list, with camel humps (`OSvc` finds
OrderService). Start the query with `#` for symbols only, `/` files, `>` commands or `@` settings.

On macOS, Cmd replaces Ctrl (Navigate To: Ctrl+Alt+`; Recent Files / Locations: Cmd+Alt+E / Cmd+Alt+Shift+E). A preset overrides some VS Code defaults (for example Ctrl+T, Ctrl+., Ctrl+E, Ctrl+Shift+E, Ctrl+F12). If you use another
keymap extension (for example a Visual Studio or IntelliJ keymap), the same keys may be bound twice; check
**Preferences: Open Keyboard Shortcuts** and keep the one you want.
