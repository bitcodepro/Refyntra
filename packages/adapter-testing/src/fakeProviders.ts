import type { CommandExecutor, DocumentReader, ProviderValues, ReadResult } from '@refyntra/adapter-vscode-providers';
import { PROVIDER_COMMANDS } from '@refyntra/adapter-vscode-providers';
import { sha256 } from './fixtureEngine';

/**
 * Fake of VS Code's public provider commands for a tiny TS-like language: declarations are
 * `function|class|interface|enum|const|let|var|type NAME`; a reference is any whole-word occurrence of a declared
 * name. It answers with the same *shapes* the public API returns (Uri-like objects, Location, LocationLink,
 * SymbolInformation, DocumentSymbol, WorkspaceEdit with entries()/size) and lets tests inject every failure of
 * Delegated TS cases: provider absent, empty, throwing, edits during preparation, opaque/resource edits.
 */

export interface FakeUri {
  scheme: string;
  path: string;
  toString(): string;
}

export function fakeUri(uri: string): FakeUri {
  const i = uri.indexOf(':');
  return { scheme: uri.slice(0, i), path: uri.slice(i + 1).replace(/^\/\//, ''), toString: () => uri };
}

interface Pos {
  line: number;
  character: number;
}
const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });

const DECL = /\b(function|class|interface|enum|const|let|var|type)\s+([A-Za-z_$][\w$]*)/g;
const KIND: Record<string, number> = { function: 11, class: 4, interface: 10, enum: 9, const: 13, let: 12, var: 12, type: 25 };
const KEYWORDS = new Set(['function', 'class', 'interface', 'enum', 'const', 'let', 'var', 'type', 'return', 'new', 'export', 'import', 'from']);

/** The declaration syntax of the fake language (default: the tiny TS-like one). */
export interface FakeSyntax {
  /** Global RegExp: group 1 is the declaration keyword, group 2 the name. */
  decl: RegExp;
  kinds: Record<string, number>;
  /** Global RegExp of a word (a possible name) on a line. */
  word: RegExp;
  keywords: ReadonlySet<string>;
}

export const TS_SYNTAX: FakeSyntax = { decl: DECL, kinds: KIND, word: /[A-Za-z_$][\w$]*/g, keywords: KEYWORDS };
/** Python-like: `def NAME` / `class NAME`, Unicode names. */
export const PYTHON_SYNTAX: FakeSyntax = {
  decl: /\b(def|class)\s+([\p{XID_Start}_]\p{XID_Continue}*)/gu,
  kinds: { def: 11, class: 4 },
  word: /[\p{XID_Start}_]\p{XID_Continue}*/gu,
  keywords: new Set(['def', 'class', 'return', 'import', 'from', 'as', 'self']),
};
/** Rust-like: `fn|struct|enum|trait|mod|const|static NAME`, raw identifiers `r#name`. */
export const RUST_SYNTAX: FakeSyntax = {
  decl: /\b(fn|struct|enum|trait|mod|const|static)\s+((?:r#)?[A-Za-z_]\w*)/g,
  kinds: { fn: 11, struct: 22, enum: 9, trait: 10, mod: 1, const: 13, static: 12 },
  word: /(?:r#)?[A-Za-z_]\w*/g,
  keywords: new Set(['fn', 'struct', 'enum', 'trait', 'mod', 'const', 'static', 'let', 'pub', 'use', 'crate', 'macro_rules', 'return']),
};

interface Decl {
  uri: string;
  name: string;
  kind: number;
  line: number;
  start: number;
}

export interface FakeEdit {
  entries(): [FakeUri, { range: ReturnType<typeof range>; newText: string; snippet?: unknown; newEol?: unknown }[]][];
  readonly size: number;
}

export class FakeProviderWorld {
  /** Disk content (closed files). */
  readonly files = new Map<string, string>();
  /** Editor buffers (open documents). */
  readonly buffers = new Map<string, string>();
  /** Files whose bytes are not UTF-8 (the reader refuses them). */
  readonly notUtf8 = new Set<string>();
  /** No provider registered: commands answer like VS Code without a provider. */
  absent = false;
  /** Commands that throw (command id → error message). */
  readonly throwOn = new Map<string, string>();
  /** Commands that answer with an empty result. */
  readonly emptyOn = new Set<string>();
  /** Rewrites the rename edit (resource ops, snippets, other files, a different edit on the second call ...). */
  renameMutator: ((edit: FakeEdit, call: number) => FakeEdit) | undefined;
  /** Runs before every command (e.g. an edit while the provider is preparing). */
  beforeCommand: ((command: string, args: unknown[]) => void | Promise<void>) | undefined;
  /** Every executed command id, in order. */
  readonly calls: string[] = [];
  /** Called when a test edits a buffer, so the harness can forward the editor event. */
  onBufferEdit: ((uri: string, text: string) => void) | undefined;
  private renameCalls = 0;

  constructor(
    files: Record<string, string> = {},
    private readonly syntax: FakeSyntax = TS_SYNTAX,
  ) {
    for (const [uri, text] of Object.entries(files)) this.files.set(uri, text);
  }

  text(uri: string): string | undefined {
    return this.buffers.get(uri) ?? this.files.get(uri);
  }

  hash(uri: string): string | undefined {
    const t = this.text(uri);
    return t === undefined ? undefined : sha256(t);
  }

  /** Simulates the user typing in an open buffer. */
  editBuffer(uri: string, text: string): void {
    this.buffers.set(uri, text);
    this.onBufferEdit?.(uri, text);
  }

  private uris(): string[] {
    return [...new Set([...this.files.keys(), ...this.buffers.keys()])].sort();
  }

  private decls(uri?: string): Decl[] {
    const out: Decl[] = [];
    for (const u of uri ? [uri] : this.uris()) {
      const lines = (this.text(u) ?? '').split(/\r\n|\n|\r/);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(this.syntax.decl)) {
          const name = m[2]!;
          out.push({ uri: u, name, kind: this.syntax.kinds[m[1]!]!, line: i, start: (m.index ?? 0) + m[0].length - name.length });
        }
      });
    }
    return out;
  }

  private wordAt(uri: string, p: Pos): string | undefined {
    const line = (this.text(uri) ?? '').split(/\r\n|\n|\r/)[p.line];
    if (line === undefined) return undefined;
    for (const m of line.matchAll(this.syntax.word)) {
      const a = m.index ?? 0;
      if (a <= p.character && p.character <= a + m[0].length) return this.syntax.keywords.has(m[0]) ? undefined : m[0];
    }
    return undefined;
  }

  private occurrences(name: string): { uri: string; line: number; start: number }[] {
    const out: { uri: string; line: number; start: number }[] = [];
    const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    for (const u of this.uris()) {
      (this.text(u) ?? '').split(/\r\n|\n|\r/).forEach((line, i) => {
        for (const m of line.matchAll(re)) out.push({ uri: u, line: i, start: m.index ?? 0 });
      });
    }
    return out;
  }

  private declOf(name: string): Decl | undefined {
    return this.decls().find((d) => d.name === name);
  }

  readonly values: ProviderValues = {
    uri: (uri) => fakeUri(uri),
    position: (p) => ({ line: p.line, character: p.character }),
  };

  readonly documents: DocumentReader = {
    read: async (uri): Promise<ReadResult> => {
      if (!uri.startsWith('file:')) return { ok: false, reason: 'not-file' };
      if (this.notUtf8.has(uri) && !this.buffers.has(uri)) return { ok: false, reason: 'not-utf8' };
      const open = this.buffers.get(uri);
      if (open !== undefined) return { ok: true, text: open, open: true };
      const disk = this.files.get(uri);
      return disk === undefined ? { ok: false, reason: 'unreadable' } : { ok: true, text: disk, open: false };
    },
  };

  readonly commands: CommandExecutor = {
    executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T> => {
      this.calls.push(command);
      await this.beforeCommand?.(command, args);
      const failure = this.throwOn.get(command);
      if (failure !== undefined) throw new Error(failure);
      return this.answer(command, args) as T;
    },
  };

  private answer(command: string, args: unknown[]): unknown {
    const empty = this.emptyOn.has(command);
    const uriArg = () => String(args[0]);
    const posArg = () => args[1] as Pos;
    switch (command) {
      case PROVIDER_COMMANDS.workspaceSymbols: {
        if (this.absent || empty) return [];
        const q = String(args[0] ?? '').toLowerCase();
        if (!q) return [];
        return this.decls()
          .filter((d) => d.name.toLowerCase().includes(q))
          .map((d) => ({ name: d.name, kind: d.kind, containerName: '', location: { uri: fakeUri(d.uri), range: range(d.line, d.start, d.start + d.name.length) } }));
      }
      case PROVIDER_COMMANDS.documentSymbols: {
        if (this.absent) return undefined;
        if (empty) return [];
        return this.decls(uriArg()).map((d) => ({ name: d.name, detail: '', kind: d.kind, range: range(d.line, 0, d.start + d.name.length), selectionRange: range(d.line, d.start, d.start + d.name.length), children: [] }));
      }
      case PROVIDER_COMMANDS.definitions: {
        if (this.absent || empty) return [];
        const name = this.wordAt(uriArg(), posArg());
        const d = name ? this.declOf(name) : undefined;
        if (!d) return [];
        const r = range(d.line, d.start, d.start + d.name.length);
        return [{ targetUri: fakeUri(d.uri), targetRange: range(d.line, 0, d.start + d.name.length), targetSelectionRange: r, originSelectionRange: r }];
      }
      case PROVIDER_COMMANDS.references: {
        if (this.absent || empty) return [];
        const name = this.wordAt(uriArg(), posArg());
        if (!name || !this.declOf(name)) return [];
        return this.occurrences(name).map((o) => ({ uri: fakeUri(o.uri), range: range(o.line, o.start, o.start + name.length) }));
      }
      case PROVIDER_COMMANDS.prepareRename: {
        if (this.absent) return undefined;
        const p = posArg();
        const name = this.wordAt(uriArg(), p);
        if (!name || !this.declOf(name)) throw new Error('You cannot rename this element.');
        const occ = this.occurrences(name).find((o) => o.uri === uriArg() && o.line === p.line && o.start <= p.character && p.character <= o.start + name.length)!;
        return { range: range(occ.line, occ.start, occ.start + name.length), placeholder: name };
      }
      case PROVIDER_COMMANDS.rename: {
        if (this.absent) return undefined;
        const name = this.wordAt(uriArg(), posArg());
        const newName = String(args[2]);
        const byUri = new Map<string, { range: ReturnType<typeof range>; newText: string }[]>();
        if (!empty && name && this.declOf(name)) {
          for (const o of this.occurrences(name)) {
            const list = byUri.get(o.uri) ?? [];
            list.push({ range: range(o.line, o.start, o.start + name.length), newText: newName });
            byUri.set(o.uri, list);
          }
        }
        let edit: FakeEdit = fakeEdit([...byUri.entries()].map(([u, e]) => [fakeUri(u), e]));
        this.renameCalls += 1;
        if (this.renameMutator) edit = this.renameMutator(edit, this.renameCalls);
        return edit;
      }
      default:
        throw new Error(`command '${command}' not found`);
    }
  }
}

export function fakeEdit(entries: ReturnType<FakeEdit['entries']>, extraResources = 0): FakeEdit {
  return { entries: () => entries.map(([u, e]) => [u, [...e]]), size: entries.length + extraResources };
}
