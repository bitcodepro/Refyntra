# See how code is connected

Put the cursor on a class, interface or method in a C# file and run **Refyntra: Related** (also in the editor context
menu under **Refyntra**). The Related view lists:

- declarations, implementations and references,
- callers and tests,
- MediatR request handlers and `Send` call sites,
- ASP.NET Core endpoints,
- DI registrations, per composition root.

The view follows the cursor; pin it to keep a result. Items marked *likely* are not proven. If some projects did not
load completely, a warning under the results says so and offers the fix.
