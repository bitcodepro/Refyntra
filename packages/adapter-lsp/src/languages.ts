import type { AdapterDescriptor } from '@refyntra/application';
import { type DelegatedLanguage, PYTHON_LANGUAGE, RUST_LANGUAGE } from '@refyntra/adapter-vscode-providers';

/** One language family served by a language server process Refyntra starts itself. */
export interface LspLanguage {
  descriptor: AdapterDescriptor;
  /** Long name in messages, e.g. "Python". */
  name: string;
  /** Capability id prefix: `<prefix>.find`, `.related`, `.references`, `.rename`, `.frameworkRelations`. */
  capabilityPrefix: string;
  /** Name of the bundled server, e.g. "Pyright". */
  serverName: string;
  /** LSP languageId of a document of this family. */
  languageId: string;
  readyMessage: string;
  /** Health message before the first document of this language was opened (the server starts lazily). */
  notStartedMessage: string;
  findLimitation: string;
  frameworkRelationsUnavailable: string;
  renameLimitations: readonly string[];
  /** Identifier rules and refusal heuristics shared with the delegated routes. */
  rules: Pick<DelegatedLanguage, 'identifierPattern' | 'validateNewName' | 'positionRefusal' | 'editRefusal'>;
  /** Waits for the server's `experimental/serverStatus` quiescent signal before reporting Ready (rust-analyzer). */
  waitForQuiescence?: boolean;
}

const capabilityIds = (prefix: string) => [`${prefix}.find`, `${prefix}.related`, `${prefix}.references`, `${prefix}.rename`, `${prefix}.frameworkRelations`];

const commonRenameLimitations = (server: string): string[] => [
  `Server-computed semantic coverage: the edits come from the bundled ${server} language server that Refyntra runs itself; Refyntra did not compute them semantically.`,
  `Refyntra owns the text ${server} sees for open documents and records the document versions the rename was computed on. Before the apply ${server} is asked again on the current versions and must return the identical edit.`,
  'No compilation check is run (compilation delta: not-run).',
  'File operations (renaming, creating or deleting files) in a rename are refused in this version; only text edits are applied.',
];

export const PYTHON_LSP_ROUTE_ID = 'python.pyright';
export const RUST_LSP_ROUTE_ID = 'rust.rust-analyzer';

export const PYTHON_LSP_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'python',
  providerRouteId: PYTHON_LSP_ROUTE_ID,
  displayName: 'Python',
  languageIds: ['python'],
  fileExtensions: ['.py', '.pyi'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'python.rename',
  capabilityIds: capabilityIds('python'),
};

export const RUST_LSP_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'rust',
  providerRouteId: RUST_LSP_ROUTE_ID,
  displayName: 'Rust',
  languageIds: ['rust'],
  fileExtensions: ['.rs'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'rust.rename',
  capabilityIds: capabilityIds('rust'),
};

export const PYTHON_LSP_LANGUAGE: LspLanguage = {
  descriptor: PYTHON_LSP_DESCRIPTOR,
  name: 'Python',
  capabilityPrefix: 'python',
  serverName: 'Pyright',
  languageId: 'python',
  readyMessage: 'Served by the Pyright language server bundled with Refyntra (no other extension needed). Results are computed by Pyright, not by Refyntra; completeness unknown.',
  notStartedMessage: 'Pyright (bundled) starts when you open a Python file in a trusted workspace.',
  findLimitation: 'Results come from the bundled Pyright language server; completeness unknown.',
  frameworkRelationsUnavailable: 'Framework relations (handlers, endpoints, registrations) are not available for Python: Refyntra has no Python framework module.',
  renameLimitations: [
    ...commonRenameLimitations('Pyright'),
    'Imports of installed packages resolve only when a Python environment is found (python.defaultInterpreterPath or a .venv/venv folder in the workspace); otherwise those names stay unresolved and are not renamed.',
    'Dynamic code is not covered: getattr/setattr/__getattr__, names in strings (such as __all__ entries or string annotations Pyright does not resolve), keys of keyword-argument dictionaries and other runtime lookups may keep the old name.',
    'Renames that touch a module path in an import are refused (they may rename or move a file).',
  ],
  rules: PYTHON_LANGUAGE,
};

export const RUST_LSP_LANGUAGE: LspLanguage = {
  descriptor: RUST_LSP_DESCRIPTOR,
  name: 'Rust',
  capabilityPrefix: 'rust',
  serverName: 'rust-analyzer',
  languageId: 'rust',
  readyMessage: 'Served by the rust-analyzer language server bundled with Refyntra (no other extension needed). Results are computed by rust-analyzer, not by Refyntra; completeness unknown.',
  notStartedMessage: 'rust-analyzer (bundled) starts when you open a Rust file in a trusted workspace.',
  findLimitation: 'Results come from the bundled rust-analyzer language server; completeness unknown.',
  frameworkRelationsUnavailable: 'Framework relations (handlers, endpoints, registrations) are not available for Rust: Refyntra has no Rust framework module.',
  renameLimitations: [
    ...commonRenameLimitations('rust-analyzer'),
    'Macros: edits inside macro_rules! definitions are refused; names used inside macro invocations are renamed only as far as rust-analyzer resolves the expansion.',
    'Code disabled by cfg attributes or Cargo features rust-analyzer does not analyse may keep the old name.',
    'Renames that touch a `mod name;` declaration are refused (they rename the module file).',
    'Without cargo (the Rust toolchain) rust-analyzer cannot load the Cargo project: references across files and crates are then incomplete.',
  ],
  rules: RUST_LANGUAGE,
  waitForQuiescence: true,
};
