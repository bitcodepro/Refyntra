// Go to metadata / decompiled sources (protocol 1.17): the VS Code-free parts, unit tested.
import type { MetadataDocument, MetadataSourceResult, Range, SymbolRef } from '@refyntra/contracts';
import { METADATA_SCHEME, metadataDocumentRef } from '@refyntra/application';

export { METADATA_SCHEME, metadataDocumentRef };

/** Setting refyntra.metadata.sourceLink: embedded PDB sources first ("embeddedOnly", default) or always decompile ("off"). */
export type SourcePolicySetting = 'embeddedOnly' | 'off';

export function sourcePolicy(value: unknown): SourcePolicySetting {
  return value === 'off' ? 'off' : 'embeddedOnly';
}

/**
 * The URI string of a metadata document: "refyntra-metadata:/<assembly>/<Namespace.Type>.cs". Each segment is
 * percent-encoded the way vscode.Uri prints paths, so the string round-trips through vscode.Uri.parse.
 */
export function metadataUriString(path: string): string {
  const [assembly, ...rest] = path.split('/');
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${METADATA_SCHEME}:/${enc(assembly ?? '')}/${enc(rest.join('/'))}`;
}

/** Documents shown in this window, by URI string (newest last); old ones are dropped beyond `limit`. */
export class MetadataDocumentStore {
  private readonly docs = new Map<string, MetadataDocument>();
  constructor(private readonly limit = 64) {}

  set(uri: string, doc: MetadataDocument): void {
    this.docs.delete(uri);
    this.docs.set(uri, doc);
    while (this.docs.size > this.limit) this.docs.delete(this.docs.keys().next().value!);
  }

  get(uri: string): MetadataDocument | undefined {
    return this.docs.get(uri);
  }

  get size(): number {
    return this.docs.size;
  }

  uris(): string[] {
    return [...this.docs.keys()];
  }
}

/** What to do with a code/metadataSource answer. */
export type MetadataAction =
  | { kind: 'document'; uri: string; document: MetadataDocument; selection?: Range }
  | { kind: 'location'; uri: string; range: Range }
  | { kind: 'message'; severity: 'info' | 'warning'; text: string };

const REASON_TEXT: Record<string, string> = {
  NoSymbol: 'There is no symbol at the cursor that Refyntra can resolve.',
  SymbolNotFound: 'The symbol is not referenced by the loaded solution.',
  AssemblyNotFound: 'The assembly file of the symbol is not available on this machine.',
  DecompilerFailed: 'The decompiler could not decompile this type.',
  NotMetadata: 'The symbol has no declaration in a referenced assembly.',
};

export function metadataAction(r: MetadataSourceResult, what: string): MetadataAction {
  if (r.reasonCode === 'InSource' && r.location) return { kind: 'location', uri: r.location.uri, range: r.location.range };
  if (r.document) return { kind: 'document', uri: metadataUriString(r.document.path), document: r.document, ...(r.symbolRange ? { selection: r.symbolRange } : {}) };
  const text = r.message || REASON_TEXT[r.reasonCode ?? ''] || 'No decompiled source is available.';
  return { kind: 'message', severity: r.reasonCode === 'NoSymbol' || r.reasonCode === 'NotMetadata' ? 'info' : 'warning', text: `Refyntra Go to Metadata (${what}): ${text}` };
}

/** One line that says where the text comes from (status bar tooltip, Health). */
export function originLine(doc: MetadataDocument, decompilerVersion: string): string {
  const file = baseName(doc.implementationPath);
  if (doc.origin === 'embeddedSource') return `Source embedded in the PDB of ${file}${doc.sourceDocument ? ` (${doc.sourceDocument})` : ''}; read-only.`;
  return `Decompiled from ${file} with ICSharpCode.Decompiler ${decompilerVersion || '(unknown version)'}; read-only.${doc.note ? ` ${doc.note}` : ''}`;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * A .NET stack frame type ("Ns.Outer+Inner`1", "Ns.Type") as the documentation id of its top-level type ("T:Ns.Outer")
 * and, for nested types, the nested type's id. Generic arguments in brackets are dropped.
 */
export function frameTypeDocumentationId(typeName: string): { documentationId: string; topLevel: string } | undefined {
  const clean = typeName.replace(/\[.*$/, '').trim();
  if (!/^[A-Za-z_][\w.`+<>]*$/.test(clean) || /[<>]/.test(clean)) return undefined;
  const nested = clean.split('+');
  return { documentationId: `T:${nested.join('.')}`, topLevel: `T:${nested[0]}` };
}

/** Hover text (Markdown, no links) for a symbol inside a metadata document. */
export function metadataHoverMarkdown(symbol: SymbolRef, summary: string | null | undefined): string {
  const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
  const where = symbol.origin === 'metadata' ? 'library (metadata)' : symbol.projectName ? `project ${symbol.projectName}` : 'source';
  const lines = [`**${esc(symbol.displayName || symbol.name)}** — ${esc(symbol.kind)} in ${esc(where)}`];
  if (summary) lines.push('', esc(summary));
  return lines.join('\n');
}

/** A short description for File Structure / Step Into rows that can be opened as decompiled source. */
export const OPEN_DECOMPILED = 'Open Decompiled Source';

/** The Health paragraph on go to metadata (decompiler version once the host answered, policy, documents, last problem). */
export function metadataHealthText(h: { decompilerVersion: string; policy: SourcePolicySetting; documents: number; lastError?: string }): string {
  const version = h.decompilerVersion ? `ICSharpCode.Decompiler ${h.decompilerVersion} (MIT)` : 'ICSharpCode.Decompiler (MIT; its version is shown after the first decompiled document)';
  const policy = h.policy === 'off' ? 'always decompiled' : 'sources embedded in the PDB are shown first, everything else is decompiled';
  const docs = h.documents === 1 ? '1 document opened' : `${h.documents} documents opened`;
  return `${version} in the C# host (protocol 1.17); ${policy}; nothing is downloaded (Source Link URLs are not followed); ${docs} in this window.${h.lastError ? ` Last problem: ${h.lastError}` : ''}`;
}
