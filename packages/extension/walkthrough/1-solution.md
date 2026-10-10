# Open a C# solution and check Health

1. Open a folder that contains a `.sln`, `.slnx` or `.csproj`. With several solutions, run **Refyntra: Select Solution**.
2. Trust the workspace when VS Code asks. In Restricted Mode Refyntra does not start its C# backend.
3. Wait until the status bar shows **Refyntra: C# Ready**. Click it for a menu of every Refyntra command.

**Refyntra: Show Health** tells you in one line whether C# works (*✅ C# is ready*, *⚠ C# works partially*,
*⛔ C# is not running*), what that means for Find, Related and Rename, and offers one button to fix it. The most common
case after cloning is *Needs packages*: click **Restore packages**, and Refyntra reloads the solution by itself when the
restore finishes. Technical details are collapsed at the bottom of the page.
