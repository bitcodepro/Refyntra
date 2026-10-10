# Open a stack trace

Run **Refyntra: Open Stack Trace** and choose where the trace is: the clipboard, the editor selection, the terminal
selection, or a new editor to paste into. From the Debug Console, copy the trace first and choose **Clipboard**.

The **Refyntra Stack Trace** view lists the frames by exception (inner exceptions are nested). Each frame says in words
whether it is **your code**, **external** (framework or package code, collapsed), matched **several files**, or will be
found **by symbol**.

- Click a frame (or press Enter) to open the file at the line. Paths from another machine or a build server are
  matched to workspace files by their path suffix; when several files match, you choose.
- When the line is past the end of the file, Refyntra says the line may have moved and, for .NET, looks the method up
  by symbol instead.
- .NET frames without a file (or whose file is missing) are looked up by type, method and parameter types:
  **proven** when the exact type and parameter types match, **likely** when only the name matches. Async methods,
  lambdas and local functions are mapped back to the method you wrote.
- The **Related** button of a frame opens it and shows Related for that code.

Refyntra never runs anything and never debugs: it reads the text you give it. A symbol that is not in the loaded
code (removed, renamed, or from a package) is reported as not found.
