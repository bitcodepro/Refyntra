import type { HealthSummary } from '@refyntra/domain';

// Onboarding logic (pure: unit-tested with vitest, no vscode import): which welcome text the Related view shows and
// the status bar menu.

export type WelcomeVariant = 'ready' | 'untrusted' | 'noSolution' | 'hostFailed';

/**
 * Context keys for the viewsWelcome when-clauses (package.json). One key with one value, so exactly one welcome
 * variant applies at a time. Loading/Partial show the normal welcome (the view works or will shortly).
 */
export function welcomeContext(h: HealthSummary): { 'refyntra.welcome': WelcomeVariant } {
  const c = h.adapters.find((a) => a.adapterId === 'csharp');
  let v: WelcomeVariant = 'ready';
  if (!h.workspaceTrusted) v = 'untrusted';
  else if (c?.reasonCode === 'NoSolutionFound') v = 'noSolution';
  else if (c && (c.state === 'Failed' || c.state === 'Unsupported')) v = 'hostFailed';
  return { 'refyntra.welcome': v };
}

export interface MenuEntry {
  label: string;
  detail: string;
  command: string;
}

/** Status bar click → QuickPick of the main commands. */
export const MAIN_MENU: readonly MenuEntry[] = [
  { label: '$(search) Find', detail: 'Find a type, member, file, endpoint (filters: type: member: project: route: method: entity: table:)', command: 'refyntra.find' },
  { label: '$(references) Related', detail: 'Callers, implementations, tests, handlers, endpoints and DI registrations of the symbol at the cursor', command: 'refyntra.related' },
  { label: '$(lightbulb) Actions', detail: 'What Refyntra can do at the cursor, and why something is unavailable', command: 'refyntra.actions' },
  { label: '$(edit) Rename', detail: 'Rename the symbol at the cursor: preview first, then Apply', command: 'refyntra.rename' },
  { label: '$(new-file) Move Type to File', detail: 'Move the type at the cursor into its own file: preview first, then Apply', command: 'refyntra.moveTypeToFile' },
  { label: '$(new-file) Generate Handler', detail: 'Create a MediatR handler for the request at the cursor: preview first, then Apply', command: 'refyntra.generateHandler' },
  { label: '$(trash) Safe Delete', detail: 'Delete the symbol at the cursor only when nothing uses it: preview first, then Apply', command: 'refyntra.safeDelete' },
  { label: '$(symbol-method) Extract Method', detail: 'Move the selected statements or expression into a new method: preview first, then Apply', command: 'refyntra.extractMethod' },
  { label: '$(symbol-parameter) Change Signature', detail: 'Add, remove, reorder or rename parameters and update every call: preview first, then Apply', command: 'refyntra.changeSignature' },
  { label: '$(sparkle) Code Cleanup', detail: 'Remove unnecessary usings, sort usings and more for a file, folder or project: preview first, then Apply', command: 'refyntra.cleanup' },
  { label: '$(pulse) Show Health', detail: 'Is Refyntra working, what it means for you, and the fix (for example Restore packages)', command: 'refyntra.showHealth' },
  { label: '$(go-to-file) Find Handler', detail: 'Jump to the request handler of the symbol at the cursor', command: 'refyntra.findHandler' },
  { label: '$(globe) Find Endpoint', detail: 'Search ASP.NET endpoints by route', command: 'refyntra.findEndpoint' },
  { label: '$(symbol-interface) Find DI Registration', detail: 'Jump to where the type at the cursor is registered in dependency injection', command: 'refyntra.findRegistration' },
  { label: '$(markdown) Show Health (text)', detail: 'The Health page as a plain Markdown document', command: 'refyntra.showHealthText' },
  { label: '$(package) Export Debug Bundle', detail: 'Save a redacted report (no source code) to attach to an issue', command: 'refyntra.exportDebugBundle' },
  { label: '$(file-submodule) Select Solution', detail: 'Choose which .sln/.slnx/.csproj Refyntra loads', command: 'refyntra.selectSolution' },
  { label: '$(debug-restart) Restart Backend', detail: 'Restart the C# backend and reload the solution', command: 'refyntra.restartBackend' },
  { label: '$(checklist) Task Context', detail: 'Switch or create the named list of symbols, files and relations for your current task', command: 'refyntra.taskContext.switch' },
  { label: '$(debug-stackframe) Open Stack Trace', detail: 'Paste a .NET, JavaScript/TypeScript, Python or Rust stack trace and open its frames in your code', command: 'refyntra.openStackTrace' },
  { label: '$(book) Get Started', detail: 'Open the Refyntra walkthrough', command: 'refyntra.getStarted' },
  { label: '$(keyboard) Keyboard Shortcuts', detail: 'Choose a keybinding preset (Visual Studio or alternative)', command: 'refyntra.keyboardShortcuts' },
  { label: '$(play) Run Without Debugging', detail: 'Build and run the selected project, script or file in a terminal (Ctrl+F5 without launch.json)', command: 'refyntra.run' },
  { label: '$(debug-alt) Start Debugging', detail: 'Debug the selected project with the bundled netcoredbg or debugpy (F5 without launch.json)', command: 'refyntra.debug' },
  { label: '$(flame) Run with Hot Reload', detail: 'dotnet watch for the selected .NET project', command: 'refyntra.runWatch' },
  { label: '$(list-selection) Select What to Run', detail: 'Project, launch profile, target framework and configuration for Run and Debug', command: 'refyntra.selectRunTarget' },
  { label: '$(play) Open Run', detail: 'The Run tab with every runnable project (Ctrl+Alt+R)', command: 'refyntra.run.open' },
  { label: '$(run-all) Run Group', detail: 'Start several projects together, in order (a web project is waited for before the next)', command: 'refyntra.run.runGroup' },
  { label: '$(debug-alt) Debug Group', detail: 'Debug several projects together; each debug session is named Group › Project', command: 'refyntra.run.debugGroup' },
  { label: '$(add) Create Run Group', detail: 'Choose the projects that start together and name the group', command: 'refyntra.run.createGroup' },
  { label: '$(new-file) Generate launch.json', detail: 'Write the run and debug configurations of this workspace to .vscode/launch.json', command: 'refyntra.generateLaunchJson' },
  { label: '$(terminal) Immediate Window', detail: 'Evaluate expressions and assignments in the stopped frame while debugging (Visual Studio-like)', command: 'refyntra.showImmediate' },
  { label: '$(debug-step-into) Smart Step Into', detail: 'While a .NET debug session is stopped: choose which call of the line to step into', command: 'refyntra.smartStepInto' },
  { label: '$(debug-breakpoint-conditional) Break on Exception Types', detail: 'Stop when .NET exceptions of the chosen types are thrown while debugging', command: 'refyntra.breakOnExceptionTypes' },
  { label: '$(symbol-constructor) Generate Constructor', detail: 'Create a constructor from chosen fields and properties of the class at the cursor', command: 'refyntra.ctor.generate' },
  { label: '$(symbol-parameter) Add Parameters to Constructor', detail: 'Initialise unassigned fields from the existing constructor', command: 'refyntra.ctor.addParameters' },
  { label: '$(symbol-variable) Introduce Variable', detail: 'Move the selected C# expression into a new local variable (checked by Roslyn)', command: 'refyntra.introduceVariable' },
  { label: '$(symbol-variable) Inline Variable', detail: 'Replace the C# local variable at the cursor with its value (checked by Roslyn)', command: 'refyntra.inlineVariable' },
  { label: '$(add) Generate…', detail: 'Constructor, Equals/GetHashCode, ToString, properties, missing, overriding or delegating members (Alt+Insert, checked by Roslyn)', command: 'refyntra.generate' },
  { label: '$(symbol-parameter) Introduce Parameter', detail: 'Turn the selected C# expression into a parameter; every call site passes it: preview first, then Apply', command: 'refyntra.introduceParameter' },
  { label: '$(compass) Navigate To…', detail: 'Declaration, implementations, base symbols, usages, tests, related files, handlers, endpoints and DI registrations of the C# symbol at the cursor (Alt+`)', command: 'refyntra.navigateTo' },
  { label: '$(references) Find Usages (Grouped)', detail: 'Usages of the C# symbol at the cursor in the Refyntra Usages view: grouped by kind, project, file or member, with filters and F4 / Shift+F4', command: 'refyntra.findUsages' },
  { label: '$(file-binary) Go to Metadata / Decompiled Source', detail: 'The read-only C# of a library or framework symbol at the cursor: the source embedded in its PDB, else decompiled (F12 and Shift+F12 work inside it)', command: 'refyntra.goToMetadata' },
  { label: '$(history) Recent Files', detail: 'Recently opened files of this workspace, the previous one first (Ctrl+E)', command: 'refyntra.recentFiles' },
  { label: '$(location) Recent Locations', detail: 'Places where you edited or the cursor rested, with the member and the code line (Ctrl+Shift+E)', command: 'refyntra.recentLocations' },
  { label: '$(list-tree) File Structure', detail: 'Members of the current file grouped by type and #region, with filters and inherited members for C# (Ctrl+F12)', command: 'refyntra.fileStructure' },
  { label: '$(search-fuzzy) Structural Search…', detail: 'Find C# code by its shape with $placeholders$ (type, count, regex constraints) and replace it: preview first, compile-checked', command: 'refyntra.structuralSearch' },
  { label: '$(pulse) Show Change Impact', detail: 'What a change reaches: handlers, endpoints, DI registrations, implementations, uses and tests (symbol, file or uncommitted changes)', command: 'refyntra.changeImpact' },
  { label: '$(run-all) Run Affected Tests', detail: 'Run the tests the last Change Impact found (static references, not coverage)', command: 'refyntra.impact.runTests' },
  { label: '$(beaker) Run Tests for This Code', detail: 'Run the C# test at the cursor, or the tests that reference the symbol (Test Explorer shows the results)', command: 'refyntra.tests.runRelated' },
];

/** Walkthrough id as VS Code addresses it: <publisher>.<name>#<walkthrough id>. */
export const WALKTHROUGH_ID = 'refyntra.refyntra#refyntra.getStarted';
