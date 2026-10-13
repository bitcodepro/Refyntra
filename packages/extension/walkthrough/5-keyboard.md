# Keyboard presets

Refyntra uses the Visual Studio preset by default. Change **refyntra.keybindings.preset** to switch, or to `none` to turn shortcuts off:

| Preset | Find | Actions | Rename | Related |
|---|---|---|---|---|
| `visualStudio` | Ctrl+, | Ctrl+. | Ctrl+R Ctrl+R | Ctrl+Shift+Alt+F12 |
| `resharper` | Ctrl+T | Alt+Enter | Ctrl+Shift+R | Ctrl+Shift+G |

Find is Search Everywhere: Types, Symbols, Files, Commands and Settings in one list, with camel humps (`OSvc` finds
OrderService). Start the query with `#` for symbols only, `/` files, `>` commands or `@` settings.

On macOS, Cmd replaces Ctrl. A preset overrides some VS Code defaults (for example Ctrl+T, Ctrl+.). If you use another
keymap extension (Visual Studio Keymap, ReSharper/IntelliJ keymaps), the same keys may be bound twice; check
**Preferences: Open Keyboard Shortcuts** and keep the one you want.
